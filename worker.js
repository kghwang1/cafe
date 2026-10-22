// 우지커피 근무관리 Worker (Cloudflare Workers + D1)
// 필요한 설정
//   D1 바인딩: 변수명 DB
//   환경변수: ADMIN_PIN (필수, 6자리 이상 권장)
//            STORE_LAT, STORE_LNG, RADIUS (선택: 넣으면 매장 근처에서만 출퇴근 가능, RADIUS 기본 150m)

const KST = 9 * 3600e3, DAY = 864e5, HOUR = 3600e3, MIN = 60e3;
// 요일별 영업시간 [시작, 끝]  일 월 화 수 목 금 토 (getUTCDay 순서)
const OPEN_HOURS = [[7, 22], [7, 22], [7, 22], [7, 22], [7, 22], [7, 22], [7, 22]];
const GRACE_MIN = 30;          // 오픈 전/마감 후 준비시간 허용(분)
const STALE_H = 12;            // 이 시간 넘게 퇴근 안 찍으면 '퇴근누락'
const LONG_SHIFT_H = 8;        // 이보다 길면 경고
const SCHEDULE_DIFF_MIN = 30;  // 스케줄과 이만큼 차이나면 경고
const WEEK_LIMIT_MIN = 15 * 60;// 주 15시간
const LATE_GRACE_MIN = 5;      // 이 분 이내 지각은 예정 시각으로 기록
const EXTRA_WINDOW_H = 12;     // 예정 퇴근으로 자동 처리된 뒤 이 시간 안에는 '연장근무' 가능

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Pin,X-Token',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const err = (m, s = 400) => json({ error: m }, s);

const k = ts => { const d = new Date(ts + KST); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const hm = ts => { const x = k(ts); return String(x.h).padStart(2, '0') + ':' + String(x.mi).padStart(2, '0'); };
const fmtH = m => `${Math.floor(m / 60)}시간${m % 60 ? ' ' + Math.round(m % 60) + '분' : ''}`;
const dayStart = ts => Math.floor((ts + KST) / DAY) * DAY - KST;
const weekStart = ts => dayStart(ts) - ((k(ts).dow + 6) % 7) * DAY;
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : NaN;

function outside(ts) {
  const x = k(ts);
  const [o, c] = OPEN_HOURS[x.dow];
  const t = x.h * 60 + x.mi;
  return t < o * 60 - GRACE_MIN || t > c * 60 + GRACE_MIN;
}
// 휴게 차감 (출근~퇴근 시간 m분 기준). 법: 일한 시간 4시간 이상 30분, 8시간 이상 1시간
// 30분 쉬고도 일한 시간이 8시간 미만이면 30분으로 충분 → 출근~퇴근 8시간 30분 이상일 때만 1시간
const breakMin = (m, use = 1) => !use ? 0 : m >= 510 ? 60 : m >= 240 ? 30 : 0; // use=0: 휴게 없이 전부 유급
function dist(a, b, c, d) {
  const R = 6371e3, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function checkGps(env, b) {
  if (!env.STORE_LAT || !env.STORE_LNG) return null;
  if (b.lat == null || b.lng == null) return '위치 정보를 허용해 주세요. 매장에서만 출퇴근할 수 있습니다.';
  const d = dist(+env.STORE_LAT, +env.STORE_LNG, +b.lat, +b.lng);
  const r = +(env.RADIUS || 150);
  if (d - Math.min(+b.acc || 0, 100) > r) return `매장에서 약 ${Math.round(d)}m 떨어져 있습니다. 매장에서 눌러주세요.`;
  return null;
}

// 같은 사람의 기록끼리 겹치는지
async function overlap(env, table, staffId, s, e, exclude = 0) {
  if (table === 'punch') {
    return env.DB.prepare("SELECT id,start,end FROM punch WHERE staff_id=? AND id!=? AND status!='missing' AND start<? AND COALESCE(end,?)>?")
      .bind(staffId, exclude || 0, e, Date.now(), s).first();
  }
  return env.DB.prepare('SELECT id,start,end FROM schedule WHERE staff_id=? AND id!=? AND start<? AND end>?')
    .bind(staffId, exclude || 0, e, s).first();
}
// 퇴근을 안 누르면 예정 퇴근 시각으로 자동 기록, 예정이 없는 근무는 오래되면 '퇴근누락'
const closeStale = env => env.DB.batch([
  env.DB.prepare("UPDATE punch SET end=plan_end, status='done', end_type='auto' WHERE status='open' AND plan_end IS NOT NULL AND plan_end<=?").bind(Date.now()),
  env.DB.prepare("UPDATE punch SET status='missing' WHERE status='open' AND plan_end IS NULL AND start<?").bind(Date.now() - STALE_H * HOUR),
]);
const log = (env, id, action, before, after) => env.DB.prepare('INSERT INTO punch_log(punch_id,action,before,after,at) VALUES(?,?,?,?,?)')
  .bind(id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, Date.now()).run();

// ===== 로그인: 이름 + 비밀번호, 한 번 로그인한 기기는 토큰으로 바로 들어감 =====
const ADMIN_NAME_DEFAULT = '황승유';                 // 관리자 이름 (Cloudflare 변수 ADMIN_NAME 이 있으면 그 값)
const APP_KEYS = ['work', 'store', 'recipe', 'ledger', 'coffee'];   // 근무급여, 매장관리, 레시피, 카페운영, 커피회사
const STAFF_DEFAULT_APPS = ['work', 'store', 'recipe'];
const appsOf = s => s.apps == null ? STAFF_DEFAULT_APPS.slice() : String(s.apps).split(',').filter(k => APP_KEYS.includes(k));
const adminName = env => String(env.ADMIN_NAME || ADMIN_NAME_DEFAULT).trim();
async function auth(req, env) {
  const tok = (req.headers.get('X-Token') || '').trim();
  if (tok) {
    const d = await env.DB.prepare('SELECT * FROM device WHERE token=?').bind(tok).first();
    if (!d) return null;
    if (d.role === 'admin') return { role: 'admin', token: tok };
    const s = await env.DB.prepare('SELECT id,name,wage,color,apps FROM staff WHERE id=? AND active=1 AND deleted=0').bind(d.staff_id).first();
    return s ? { role: 'staff', staff: s, token: tok } : null;
  }
  const pin = (req.headers.get('X-Pin') || '').trim();
  if (!pin) return null;
  if (env.ADMIN_PIN && pin === String(env.ADMIN_PIN)) return { role: 'admin' };
  const s = await env.DB.prepare('SELECT id,name,wage,color,apps FROM staff WHERE pin=? AND active=1 AND deleted=0').bind(pin).first();
  return s ? { role: 'staff', staff: s } : null;
}

// ---------- 근무표(주간 템플릿) ----------
// grid: { "요일-시": [직원id..] 또는 ["O"](사장) }  요일 0=월 … 6=일, 시 0~23 (그 시각부터 1시간)
const READY = {}; // 실제 DB / 연습 DB 각각 한 번만 준비
const BASE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin TEXT NOT NULL UNIQUE, wage INTEGER NOT NULL DEFAULT 10320, color TEXT NOT NULL DEFAULT '#4f7cff', active INTEGER NOT NULL DEFAULT 1)",
  'CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS punch (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER, status TEXT NOT NULL DEFAULT 'open', note TEXT, edited INTEGER NOT NULL DEFAULT 0, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS edit_request (id INTEGER PRIMARY KEY AUTOINCREMENT, punch_id INTEGER, staff_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created INTEGER)",
  'CREATE TABLE IF NOT EXISTS punch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, punch_id INTEGER, action TEXT, before TEXT, after TEXT, at INTEGER)',
];
async function ensureSettings(env) {
  const key = env.PRACTICE ? 'p' : 'r';
  if (READY[key]) return;
  if (env.PRACTICE) await env.DB.batch(BASE_SCHEMA.map(q => env.DB.prepare(q)));   // 연습 DB는 표도 자동 생성
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS payslip (staff_id INTEGER NOT NULL, month TEXT NOT NULL, data TEXT, at INTEGER, PRIMARY KEY(staff_id, month))').run();
  // 출퇴근 방식 변경으로 추가된 칸 (이미 있으면 무시)
  for (const col of ['plan_start INTEGER', 'plan_end INTEGER', 'raw_start INTEGER', 'raw_end INTEGER', 'end_type TEXT', 'brk_min INTEGER', 'memo TEXT']) {   // brk_min: 기록한 휴게(분), 비어 있으면 자동 계산
    try { await env.DB.prepare('ALTER TABLE punch ADD COLUMN ' + col).run(); } catch (e) { }
  }
  try { await env.DB.prepare('ALTER TABLE staff ADD COLUMN use_break INTEGER NOT NULL DEFAULT 1').run(); } catch (e) { } // 휴게시간 사용 여부
  try { await env.DB.prepare('ALTER TABLE staff ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { } // 삭제한 직원 (지난 기록만 남김)
  try { await env.DB.prepare('ALTER TABLE staff ADD COLUMN apps TEXT').run(); } catch (e) { }   // 쓸 수 있는 앱 (비어 있으면 기본)
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS contract (staff_id INTEGER NOT NULL, month TEXT NOT NULL, weekly_min INTEGER NOT NULL, PRIMARY KEY(staff_id, month))').run();   // 주 계약시간 (그 달부터 적용)
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS device (token TEXT PRIMARY KEY, role TEXT NOT NULL, staff_id INTEGER, ua TEXT, created INTEGER, seen INTEGER)').run();
  READY[key] = true;
  if (env.PRACTICE && !(await env.DB.prepare('SELECT COUNT(*) c FROM staff').first()).c) await seedPractice(env);
}

// ---------- 연습 모드 ----------
// 연습 때는 이 파일을 휴대폰 브라우저가 직접 불러와 실행하고, 기록은 그 휴대폰 안에만 저장됨 (서버와 무관)
// 연습용 데이터: 사장 PIN 0000, 알바 연습A 1111 / 연습B 2222 / 연습C 3333
async function seedPractice(env) {
  await env.DB.batch(['staff', 'schedule', 'punch', 'edit_request', 'punch_log', 'payslip', 'settings'].map(t => env.DB.prepare('DELETE FROM ' + t)));
  const ids = [];
  for (const [n, pin, c] of [['연습A', '1111', '#e4572e'], ['연습B', '2222', '#1d8a4b'], ['연습C', '3333', '#3a6ea5']]) {
    const r = await env.DB.prepare('INSERT INTO staff(name,pin,wage,color) VALUES(?,?,10320,?)').bind(n, pin, c).run();
    ids.push(r.meta.last_row_id);
  }
  const [A, B, C] = ids, g = defaultTemplate().grid, put = (d, a, z, id) => { for (let h = a; h < z; h++) (g[d + '-' + h] = g[d + '-' + h] || []).push(id); };
  for (let d = 0; d < 5; d++) { put(d, 7, 13, A); put(d, 16, 19, B); }
  for (const d of [5, 6]) { put(d, 9, 15, C); put(d, 15, 21, B); }
  await env.DB.prepare("INSERT INTO settings(k,v) VALUES('template',?)").bind(JSON.stringify({ grid: g, updated: Date.now() })).run();
  const now = Date.now(), ws = weekStart(now), today = Math.floor((dayStart(now) - ws) / DAY);
  const stmts = [];
  for (let d = 0; d < 7; d++) for (const id of ids) {
    let s = -1;
    for (let h = 0; h <= 24; h++) {
      const on = h < 24 && (g[d + '-' + h] || []).includes(id);
      if (on && s < 0) s = h;
      if (!on && s >= 0) {
        const st = ws + d * DAY + s * HOUR, en = ws + d * DAY + h * HOUR;
        if (d !== today) stmts.push(env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(id, st, en));
        if (d < today) { // 지난 날은 실제 근무 기록도 만들어 둠 (출근 0~7분 차이, 예정 퇴근 자동)
          const late = ((id * 7 + d * 3) % 8) * MIN, rs = late > 5 * MIN ? st + late : st;
          stmts.push(env.DB.prepare("INSERT INTO punch(staff_id,start,end,status,created,plan_start,plan_end,raw_start,end_type) VALUES(?,?,?,'done',?,?,?,?,'auto')").bind(id, rs, en, st + late, st, en, st + late));
        }
        s = -1;
      }
    }
  }
  // 오늘은 지금 바로 출퇴근 연습이 되도록: 연습A 지금 시작(정시 출근), 연습B 20분 뒤 시작(일찍 출근), 연습C는 예정 없음
  const t0 = Math.floor(now / (5 * MIN)) * 5 * MIN;
  stmts.push(env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(A, t0, t0 + 3 * HOUR));
  stmts.push(env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(B, t0 + 20 * MIN, t0 + 20 * MIN + 4 * HOUR));
  await env.DB.batch(stmts);
}
function defaultTemplate() { // 엑셀 근무표의 사장님 칸
  const g = {}, add = (d, hs) => hs.forEach(h => g[d + '-' + h] = ['O']);
  add(0, [13, 14, 15, 19, 20]); add(1, [13, 14, 15, 19, 20]);
  for (const d of [2, 3, 4]) add(d, [14, 15, 19, 20]);
  return { grid: g, saved: false };
}
function parseTemplate(row) {
  if (!row || !row.v) return defaultTemplate();
  try { const t = JSON.parse(row.v); return { grid: t.grid || {}, saved: true, updated: t.updated }; } catch { return defaultTemplate(); }
}
function cleanGrid(g) {
  const out = {};
  if (!g || typeof g !== 'object') return out;
  for (const [key, val] of Object.entries(g)) {
    if (!/^[0-6]-(\d|1\d|2[0-3])$/.test(key) || !Array.isArray(val)) continue;
    const v = val.includes('O') ? ['O'] : [...new Set(val.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 6);
    if (v.length) out[key] = v;
  }
  return out;
}
const ownerKeys = grid => Object.keys(grid).filter(k => grid[k].includes('O'));

// 퇴근을 안 눌러 예정 퇴근으로 자동 처리된 마지막 근무 — 연장근무·나가기 대상
async function lastExtendable(env, id, now) {
  const r = await env.DB.prepare("SELECT * FROM punch WHERE staff_id=? AND status='done' ORDER BY start DESC LIMIT 1").bind(id).first();
  if (!r || !r.plan_end || r.end_type !== 'auto' || r.end > now || now - r.end > EXTRA_WINDOW_H * HOUR) return null;
  return r;
}

// 월 급여 계산 (onlyId가 있으면 그 직원만)
// 출근하기 버튼: 관리자가 켜기 전까지 잠김 (연습 모드는 켜짐)
async function punchEnabled(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='punch_on'").first();
  return r ? r.v === '1' : !!env.PRACTICE;
}
async function computePay(env, month, onlyId) {
  const mm = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!mm) return { error: 'month=YYYY-MM 형식이 필요합니다.' };
  const y = +mm[1], mo = +mm[2];
  const from = Date.UTC(y, mo - 1, 1) - KST, to = Date.UTC(y, mo, 1) - KST;
  const wFrom = weekStart(from), wTo = weekStart(to - 1) + 7 * DAY;
  const one = onlyId ? ' AND staff_id=' + (+onlyId) : '';
  const staff = (await env.DB.prepare('SELECT * FROM staff' + (onlyId ? ' WHERE id=' + (+onlyId) : '')).all()).results;
  const rows = (await env.DB.prepare("SELECT * FROM punch WHERE status='done' AND start>=? AND start<?" + one + " ORDER BY start").bind(wFrom, wTo).all()).results;
  const pending = (await env.DB.prepare("SELECT staff_id, COUNT(*) c FROM punch WHERE status IN ('open','missing') AND start>=? AND start<?" + one + " GROUP BY staff_id").bind(from, to).all()).results;
  const sched = (await env.DB.prepare('SELECT staff_id,start FROM schedule WHERE start>=? AND start<?' + one).bind(wFrom, wTo).all()).results;
  const lastWork = (await env.DB.prepare("SELECT staff_id, MAX(start) t FROM punch WHERE status='done'" + one + " GROUP BY staff_id").all()).results;
  const nowT = Date.now();
  const contracts = (await env.DB.prepare('SELECT * FROM contract' + (onlyId ? ' WHERE staff_id=' + (+onlyId) : '') + ' ORDER BY month').all()).results;
  const contractAt = (sid, ym) => { let c = null; contracts.forEach(r => { if (r.staff_id === sid && r.month <= ym) c = r; }); return c; };
  const out = staff.map(s => {
    const mine = rows.filter(r => r.staff_id === s.id);
    const weeks = {}, shifts = [];
    for (const r of mine) {
      const min = Math.round((r.end - r.start) / MIN), brk = r.brk_min != null ? Math.min(+r.brk_min, min) : breakMin(min, s.use_break), paid = min - brk;
      const w = weekStart(r.start);
      weeks[w] = (weeks[w] || 0) + paid;
      if (r.start >= from && r.start < to) shifts.push({ id: r.id, start: r.start, end: r.end, min, brk, paid, edited: r.edited, end_type: r.end_type, memo: r.memo || null });
    }
    const total = shifts.reduce((a, x) => a + x.min, 0), brk = shifts.reduce((a, x) => a + x.brk, 0), paid = total - brk;
    // 주휴수당: 그 주 일요일이 이달에 속한 주만. 주 15시간 이상 + 예정일 개근 + 주가 끝났고 다음 주에도 근로관계가 이어질 때
    const juhuWeeks = []; let juhu = 0;
    const lw = (lastWork.find(x => x.staff_id === s.id) || {}).t || 0;
    for (const [wk, mins] of Object.entries(weeks)) {
      const w = +wk, we = w + 7 * DAY, sun = we - DAY;
      if (sun < from || sun >= to) continue;
      const worked = new Set(mine.filter(r => r.start >= w && r.start < we).map(r => dayStart(r.start)));
      const planned = [...new Set(sched.filter(r => r.staff_id === s.id && r.start >= w && r.start < we).map(r => dayStart(r.start)))];
      const missed = planned.filter(d => d < nowT && !worked.has(d)).length;
      // 주휴 기준 시간: 그 주(일요일이 속한 달)의 주 계약시간, 없으면 실제 근무시간
      const c = contractAt(s.id, new Date(sun + KST).toISOString().slice(0, 7));
      const base = c ? c.weekly_min : mins, basis = c ? 'contract' : 'actual';
      let reason = '';
      if (we > nowT) reason = '이번 주 진행 중 (주가 끝나면 계산)';
      else if (base < WEEK_LIMIT_MIN) reason = c ? '계약 주 15시간 미만' : '주 15시간 미만';
      else if (missed) reason = `예정일 결근 ${missed}일`;
      else if ((!s.active || s.deleted) && lw < we) reason = '퇴사 (다음 주 근로 없음)';
      const ok = !reason, amount = ok ? Math.floor(Math.min(base, 40 * 60) / (40 * 60) * 8 * s.wage) : 0;
      juhuWeeks.push({ week: w, minutes: mins, base, basis, ok, reason, amount }); juhu += amount;
    }
    juhuWeeks.sort((a, b) => a.week - b.week);
    const days = new Set(shifts.map(x => dayStart(x.start))).size;
    const overWeeks = Object.entries(weeks).filter(([, v]) => v >= WEEK_LIMIT_MIN).map(([w, v]) => ({ week: +w, minutes: v }));
    const pc = pending.find(x => x.staff_id === s.id);
    return { id: s.id, name: s.name, wage: s.wage, color: s.color, active: s.active, useBreak: s.use_break !== 0, days, total, brk, paid, pay: Math.floor(paid * s.wage / 60), juhu, juhuWeeks, payTotal: Math.floor(paid * s.wage / 60) + juhu, shifts, overWeeks, unresolved: pc ? pc.c : 0 };
  }).filter(x => onlyId || x.shifts.length || x.unresolved || x.active || x.juhu);
  return { month: `${y}-${String(mo).padStart(2, '0')}`, staff: out };
}

function validRange(s, e) {
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '시간 값이 올바르지 않습니다.';
  if (e <= s) return '퇴근 시간이 출근 시간보다 늦어야 합니다.';
  if (e - s > 16 * HOUR) return '한 번 근무가 16시간을 넘을 수 없습니다.';
  return null;
}

async function route(req, env) {
  const url = new URL(req.url), p = url.pathname, m = req.method;
  const b = m === 'POST' ? await req.json().catch(() => ({})) : {};
  await ensureSettings(env);
  if (p === '/practice/reset' && m === 'POST') {
    if (!env.PRACTICE) return err('연습 모드에서만 됩니다.', 403);
    await seedPractice(env);
    return json({ ok: true });
  }
  if (p === '/auth/login' && m === 'POST') {             // 이름 + 비밀번호 → 이 기기 토큰
    const name = String(b.name || '').trim(), pin = String(b.pin || '').trim();
    if (!name || !pin) return err('이름과 비밀번호를 넣으세요.');
    let row = null;
    if (env.ADMIN_PIN && name === adminName(env) && pin === String(env.ADMIN_PIN)) row = { role: 'admin', staff_id: null, name, apps: APP_KEYS.concat('admin') };
    else {
      const s = await env.DB.prepare('SELECT * FROM staff WHERE name=? AND pin=? AND active=1 AND deleted=0').bind(name, pin).first();
      if (s) row = { role: 'staff', staff_id: s.id, name: s.name, apps: appsOf(s) };
    }
    if (!row) return err('이름 또는 비밀번호가 맞지 않습니다.', 401);
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();
    const t = Date.now();
    await env.DB.prepare('INSERT INTO device(token,role,staff_id,ua,created,seen) VALUES(?,?,?,?,?,?)')
      .bind(token, row.role, row.staff_id, String(req.headers.get('User-Agent') || '').slice(0, 200), t, t).run();
    return json({ token, role: row.role, name: row.name, apps: row.apps });
  }
  const me = await auth(req, env);
  if (!me) return err('PIN이 올바르지 않습니다.', 401);
  if (p === '/auth/me') {
    if (me.token) await env.DB.prepare('UPDATE device SET seen=? WHERE token=?').bind(Date.now(), me.token).run();
    return json(me.role === 'admin' ? { role: 'admin', name: adminName(env), apps: APP_KEYS.concat('admin') }
                                    : { role: 'staff', name: me.staff.name, apps: appsOf(me.staff) });
  }
  if (p === '/auth/logout' && m === 'POST') {
    if (me.token) await env.DB.prepare('DELETE FROM device WHERE token=?').bind(me.token).run();
    return json({ ok: true });
  }
  // 퇴근누락 정리는 기록을 다루는 요청에서만 (조회 속도 위해 /week, /login 제외)
  if (p !== '/week' && p !== '/login') await closeStale(env);
  const now = Date.now();

  if (p === '/login') return json(me.role === 'admin' ? { role: 'admin', name: adminName(env) } : { role: 'staff', id: me.staff.id, name: me.staff.name });

  // ---------- 공통: 주간표 ----------
  if (p === '/week') {
    const from = +url.searchParams.get('from'), to = from + 7 * DAY;
    if (!Number.isFinite(from)) return err('from 값이 필요합니다.');
    // 3개 조회를 한 번에 보내서 왕복 횟수 줄이기
    const [a, b2, c, t] = await env.DB.batch([
      env.DB.prepare('SELECT id,name,color,active FROM staff'),
      env.DB.prepare('SELECT * FROM schedule WHERE start<? AND end>? ORDER BY start').bind(to, from),
      env.DB.prepare(`SELECT id,staff_id,start,
          CASE WHEN status='open' AND plan_end IS NOT NULL AND plan_end<=? THEN plan_end ELSE end END AS end,
          CASE WHEN status='open' AND plan_end IS NOT NULL AND plan_end<=? THEN 'done'
               WHEN status='open' AND plan_end IS NULL AND start<? THEN 'missing' ELSE status END AS status,
          end_type, plan_end
        FROM punch WHERE start<? AND COALESCE(end,plan_end,?)>? ORDER BY start`)
        .bind(now, now, now - STALE_H * HOUR, to, now, from),
      env.DB.prepare("SELECT v FROM settings WHERE k='template'"),
    ]);
    const owner = ownerKeys(parseTemplate(t.results[0]).grid);
    return json({ staff: a.results, schedules: b2.results, punches: c.results, owner });
  }

  // ---------- 직원 ----------
  if (me.role === 'staff') {
    if (!appsOf(me.staff).includes('work') && p !== '/week') return err('근무·급여를 쓸 권한이 없습니다. 관리자에게 문의하세요.', 403);
    const id = me.staff.id;

    if (p === '/status') {
      const punchOn = await punchEnabled(env);
      const open = await env.DB.prepare("SELECT * FROM punch WHERE staff_id=? AND status='open'").bind(id).first();
      const recent = (await env.DB.prepare('SELECT * FROM punch WHERE staff_id=? ORDER BY start DESC LIMIT 20').bind(id).all()).results;
      const requests = (await env.DB.prepare("SELECT * FROM edit_request WHERE staff_id=? AND status='pending' ORDER BY created DESC").bind(id).all()).results;
      const last = open ? null : await lastExtendable(env, id, now);
      return json({ open, recent, requests, last, punchOn });
    }

    if (p === '/punch/in' && m === 'POST') {
      if (!await punchEnabled(env)) return err('지금은 출근하기 버튼이 잠겨 있습니다. 관리자에게 문의하세요.', 403);
      const open = await env.DB.prepare("SELECT id FROM punch WHERE staff_id=? AND status='open'").bind(id).first();
      if (open) return err('이미 출근 상태입니다.', 409);
      const last = await env.DB.prepare('SELECT MAX(COALESCE(raw_end,created)) t FROM punch WHERE staff_id=?').bind(id).first();
      if (last && last.t && now - last.t < MIN) return err('방금 기록되었습니다. 잠시 후 다시 시도하세요.', 409);
      const g = checkGps(env, b); if (g) return err(g, 403);

      // 지금 해당하는 예정 스케줄: 아직 끝나지 않은 것 중 가장 이른 것 (3시간 전부터 인정)
      const sch = await env.DB.prepare('SELECT * FROM schedule WHERE staff_id=? AND end>? AND start<? ORDER BY start LIMIT 1').bind(id, now, now + 3 * HOUR).first();
      const warns = [];
      let start = now;
      if (sch) {
        const late = (now - sch.start) / MIN;
        if (late <= LATE_GRACE_MIN) start = sch.start;               // 일찍 오거나 5분 이내 → 예정 시각
        else warns.push(`예정 출근(${hm(sch.start)})보다 ${Math.round(late)}분 늦어 실제 시각 ${hm(now)}로 기록됩니다.`);
        if (late < -SCHEDULE_DIFF_MIN) warns.push(`예정 출근(${hm(sch.start)})보다 ${Math.round(-late)}분 일찍 눌렀습니다. ${hm(sch.start)}부터 기록됩니다.`);
      } else {
        warns.push('지금 시간에 예정된 스케줄이 없습니다. 실제 시각으로 기록되고, 퇴근 버튼을 꼭 눌러야 합니다.');
        if (outside(now)) warns.push('지금은 영업시간 밖입니다.');
      }
      if (await overlap(env, 'punch', id, start, start + 1)) return err('이 시간에 이미 근무 기록이 있습니다. 사장님께 문의하세요.', 409);
      if (warns.length && !b.confirm) return json({ needConfirm: true, warns });
      const r = await env.DB.prepare("INSERT INTO punch(staff_id,start,status,note,created,plan_start,plan_end,raw_start) VALUES(?,?, 'open', ?, ?, ?, ?, ?)")
        .bind(id, start, warns.join(' / ') || null, now, sch ? sch.start : null, sch ? sch.end : null, now).run();
      await log(env, r.meta.last_row_id, 'in', null, { start, raw: now });
      return json({ ok: true, at: start, raw: now, planEnd: sch ? sch.end : null });
    }

    // 퇴근: type = normal(나가기·정시) / early(조기퇴근) / extra(연장근무)
    if (p === '/punch/out' && m === 'POST') {
      const type = ['normal', 'early', 'extra'].includes(b.type) ? b.type : 'normal';
      let row = await env.DB.prepare("SELECT * FROM punch WHERE staff_id=? AND status='open'").bind(id).first();
      if (!row && type !== 'early') row = await lastExtendable(env, id, now);   // 예정 퇴근으로 자동 처리된 뒤 연장근무·나가기
      if (!row) return err(type === 'early' ? '근무 중인 기록이 없습니다. 이미 예정 퇴근 시각으로 기록되었을 수 있습니다.' : '출근 기록이 없습니다. 출근을 안 찍었다면 "누락 기록 추가 요청"을 해주세요.', 409);
      if (now - (row.raw_start || row.start) < MIN) return err('방금 출근했습니다. 잠시 후 다시 시도하세요.', 409);
      const g = checkGps(env, b); if (g) return err(g, 403);
      const pe = row.plan_end, warns = [];
      let end = now;
      if (type === 'normal') {
        if (pe) {
          end = pe;
          if (now < pe - 10 * MIN) warns.push(`예정 퇴근(${hm(pe)})보다 ${Math.round((pe - now) / MIN)}분 이릅니다. 일찍 가는 거라면 '조기퇴근'을 눌러주세요. 그래도 ${hm(pe)} 정시퇴근으로 기록할까요?`);
          if (now > pe + 10 * MIN) warns.push(`예정 퇴근(${hm(pe)})보다 ${Math.round((now - pe) / MIN)}분 늦었습니다. 더 일했다면 '연장근무'를 눌러주세요. 그래도 ${hm(pe)}로 기록할까요?`);
        }
      } else if (type === 'early') {
        if (pe && now >= pe) return err(`예정 퇴근(${hm(pe)})이 지났습니다. '나가기'를 누르세요.`, 409);
      } else {
        if (pe && now <= pe) return err(`아직 예정 퇴근(${hm(pe)}) 전입니다. 예정 시간이 지난 뒤 눌러주세요.`, 409);
      }
      if (end <= row.start) return err(`출근 기록(${hm(row.start)})보다 이른 시각으로는 퇴근할 수 없습니다.`, 409);
      const len = (end - row.start) / MIN;
      if (len > LONG_SHIFT_H * 60) warns.push(`이번 근무가 ${fmtH(Math.round(len))}입니다. 맞나요?`);
      if (warns.length && !b.confirm) return json({ needConfirm: true, warns });
      const note = [row.note, ...(type === 'normal' ? warns : [])].filter(Boolean).join(' / ') || null;
      await env.DB.prepare("UPDATE punch SET end=?, status='done', end_type=?, raw_end=?, note=? WHERE id=?").bind(end, type, now, note, row.id).run();
      await log(env, row.id, 'out_' + type, { end: row.end }, { end, raw: now });
      return json({ ok: true, at: end, type, minutes: Math.round(len) });
    }

    // 내 급여: 현재까지(실시간) / 확정 명세서 목록 / 확정 명세서 하나
    if (p === '/my/pay') {
      const r = await computePay(env, url.searchParams.get('month'), id);
      if (r.error) return err(r.error);
      return json({ month: r.month, slip: r.staff[0] || null });
    }
    if (p === '/my/payslips') {
      const rows = (await env.DB.prepare('SELECT month, at, data FROM payslip WHERE staff_id=? ORDER BY month DESC').bind(id).all()).results;
      return json(rows.map(r => { let d = {}; try { d = JSON.parse(r.data); } catch (e) { } return { month: r.month, at: r.at, slip: d }; }));
    }

    if (p === '/request' && m === 'POST') {
      const s = num(b.start), e = num(b.end);
      const v = validRange(s, e); if (v) return err(v);
      if (e > now + 10 * MIN) return err('아직 지나지 않은 시간은 요청할 수 없습니다.');
      const pid = b.punch_id ? +b.punch_id : 0;
      if (pid) {
        const own = await env.DB.prepare('SELECT id FROM punch WHERE id=? AND staff_id=?').bind(pid, id).first();
        if (!own) return err('본인 기록만 수정 요청할 수 있습니다.', 403);
      }
      if (await overlap(env, 'punch', id, s, e, pid)) return err('본인의 다른 근무 기록과 시간이 겹칩니다. 시간을 확인해 주세요.', 409);
      const dup = await env.DB.prepare("SELECT id FROM edit_request WHERE staff_id=? AND status='pending' AND start<? AND end>?").bind(id, e, s).first();
      if (dup) return err('같은 시간대에 이미 보낸 요청이 있습니다.', 409);
      await env.DB.prepare('INSERT INTO edit_request(punch_id,staff_id,start,end,reason,created) VALUES(?,?,?,?,?,?)')
        .bind(pid || null, id, s, e, String(b.reason || '').slice(0, 200), now).run();
      return json({ ok: true });
    }
    return err('권한이 없습니다.', 403);
  }

  // ---------- 관리자 ----------
  if (p === '/admin/staff' && m === 'GET') {
    const st = (await env.DB.prepare('SELECT * FROM staff WHERE deleted=0 ORDER BY active DESC, id').all()).results;
    const ct = (await env.DB.prepare('SELECT * FROM contract ORDER BY month').all()).results;
    st.forEach(s => { s.contracts = ct.filter(c => c.staff_id === s.id).map(c => ({ month: c.month, min: c.weekly_min })); });
    return json(st);
  }
  // 직원 삭제: 기록이 없으면 완전히 지우고, 출퇴근·급여 기록이 있으면 기록은 남기고 목록에서만 뺀다
  if (p === '/admin/staff/delete' && m === 'POST') {
    const sid = +b.id;
    const s = await env.DB.prepare('SELECT * FROM staff WHERE id=?').bind(sid).first();
    if (!s) return err('직원을 찾을 수 없습니다.', 404);
    const np = (await env.DB.prepare('SELECT COUNT(*) c FROM punch WHERE staff_id=?').bind(sid).first()).c;
    const ns = (await env.DB.prepare('SELECT COUNT(*) c FROM payslip WHERE staff_id=?').bind(sid).first()).c;
    const keep = np + ns > 0;
    // 근무표에서 이 직원 빼기
    const t = await env.DB.prepare("SELECT v FROM settings WHERE k='template'").first();
    const stmts = [];
    if (t && t.v) { try { const o = JSON.parse(t.v), g = o.grid || {};
      for (const k of Object.keys(g)) { g[k] = (g[k] || []).filter(x => x !== sid); if (!g[k].length) delete g[k]; }
      stmts.push(env.DB.prepare("UPDATE settings SET v=? WHERE k='template'").bind(JSON.stringify({ grid: g, updated: now }))); } catch (e) { } }
    stmts.push(env.DB.prepare("DELETE FROM edit_request WHERE staff_id=? AND status='pending'").bind(sid));
    if (keep) {
      stmts.push(env.DB.prepare('DELETE FROM schedule WHERE staff_id=? AND start>=?').bind(sid, now));   // 앞으로의 예정만 지움
      stmts.push(env.DB.prepare('UPDATE staff SET active=0, deleted=1, pin=? WHERE id=?').bind('del-' + sid + '-' + now, sid));
    } else {
      stmts.push(env.DB.prepare('DELETE FROM schedule WHERE staff_id=?').bind(sid));
      stmts.push(env.DB.prepare('DELETE FROM edit_request WHERE staff_id=?').bind(sid));
      stmts.push(env.DB.prepare('DELETE FROM staff WHERE id=?').bind(sid));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, kept: keep, punches: np });
  }
  if (p === '/admin/staff' && m === 'POST') {
    const name = String(b.name || '').trim(), pin = String(b.pin || '').trim();
    const wage = Math.round(+b.wage || 0);
    if (!name) return err('이름을 입력하세요.');
    if (!/^\d{4,6}$/.test(pin)) return err('PIN은 숫자 4~6자리입니다.');
    if (pin === String(env.ADMIN_PIN)) return err('관리자 PIN과 같은 번호는 쓸 수 없습니다.');
    if (wage < 1000) return err('시급을 확인하세요.');
    const dup = await env.DB.prepare('SELECT id FROM staff WHERE pin=? AND id!=?').bind(pin, +b.id || 0).first();
    if (dup) return err('다른 직원이 쓰는 PIN입니다.');
    const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#4f7cff';
    const active = b.active === false || b.active === 0 ? 0 : 1;
    const ub = b.use_break === false || b.use_break === 0 ? 0 : 1;
    if (b.id) await env.DB.prepare('UPDATE staff SET name=?,pin=?,wage=?,color=?,active=?,use_break=? WHERE id=?').bind(name, pin, wage, color, active, ub, +b.id).run();
    let sid = +b.id;
    if (!sid) sid = (await env.DB.prepare('INSERT INTO staff(name,pin,wage,color,active,use_break) VALUES(?,?,?,?,?,?)').bind(name, pin, wage, color, active, ub).run()).meta.last_row_id;
    // 주 계약시간: 적용 월부터 (빈칸이면 그 달 기록 지움)
    if (b.contract && /^\d{4}-\d{2}$/.test(b.contract.month || '')) {
      const hrs = b.contract.hours;
      if (hrs === '' || hrs == null) await env.DB.prepare('DELETE FROM contract WHERE staff_id=? AND month=?').bind(sid, b.contract.month).run();
      else {
        const mins = Math.round(+hrs * 60);
        if (!(mins >= 0 && mins <= 52 * 60)) return err('주 계약시간을 확인하세요 (0~52시간).');
        await env.DB.prepare('INSERT INTO contract(staff_id,month,weekly_min) VALUES(?,?,?) ON CONFLICT(staff_id,month) DO UPDATE SET weekly_min=excluded.weekly_min').bind(sid, b.contract.month, mins).run();
      }
    }
    return json({ ok: true, id: sid });
  }

  if (p === '/admin/schedule' && m === 'POST') {
    const sid = +b.staff_id, s = num(b.start), e = num(b.end), myId = +b.id || 0;
    const v = validRange(s, e); if (v) return err(v);
    const warns = [];
    // 다른 알바와 겹치는 건 그대로 허용. 같은 사람이 겹치면 하나로 합침
    const same = (await env.DB.prepare('SELECT * FROM schedule WHERE staff_id=? AND id!=? AND start<? AND end>?').bind(sid, myId, e, s).all()).results;
    let ms = s, me = e;
    same.forEach(r => { ms = Math.min(ms, r.start); me = Math.max(me, r.end); });
    if (same.length) {
      const v2 = validRange(ms, me); if (v2) return err('같은 직원의 스케줄과 합치면 ' + v2);
      const nm = (await env.DB.prepare('SELECT name FROM staff WHERE id=?').bind(sid).first() || {}).name || '이 직원';
      warns.push(`${nm}은(는) 이미 ${same.map(r => hm(r.start) + '~' + hm(r.end)).join(', ')} 스케줄이 있어 겹칩니다. 저장하면 ${hm(ms)}~${hm(me)} 하나로 합쳐집니다.`);
    }
    if (outside(ms) || outside(me)) warns.push('영업시간 밖이 포함되어 있습니다.');
    const ws = weekStart(ms), skip = new Set([myId, ...same.map(r => r.id)]);
    const rows = (await env.DB.prepare('SELECT id,start,end FROM schedule WHERE staff_id=? AND start>=? AND start<?').bind(sid, ws, ws + 7 * DAY).all()).results.filter(r => !skip.has(r.id));
    rows.push({ start: ms, end: me });
    const ub = ((await env.DB.prepare('SELECT use_break FROM staff WHERE id=?').bind(sid).first()) || {}).use_break;
    const total = rows.reduce((a, r) => { const mm = (r.end - r.start) / MIN; return a + mm - breakMin(mm, ub); }, 0);
    if (total >= WEEK_LIMIT_MIN) warns.push(`이 직원의 이번 주 스케줄이 ${ub === 0 ? '' : '휴게 제외 '}${fmtH(Math.round(total))}이 됩니다. 주 15시간 이상이면 주휴수당이 발생합니다.`);
    if (warns.length && !b.confirm) return json({ needConfirm: true, warns });
    const stmts = same.map(r => env.DB.prepare('DELETE FROM schedule WHERE id=?').bind(r.id));
    stmts.push(myId ? env.DB.prepare('UPDATE schedule SET staff_id=?,start=?,end=? WHERE id=?').bind(sid, ms, me, myId)
                    : env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(sid, ms, me));
    await env.DB.batch(stmts);
    return json({ ok: true, merged: same.length });
  }
  if (p === '/admin/template' && m === 'GET') {
    return json(parseTemplate(await env.DB.prepare("SELECT v FROM settings WHERE k='template'").first()));
  }
  if (p === '/admin/template' && m === 'POST') {
    const grid = cleanGrid(b.grid);
    await env.DB.prepare("INSERT INTO settings(k,v) VALUES('template',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .bind(JSON.stringify({ grid, updated: now })).run();
    if (!b.apply) return json({ ok: true });
    // 근무표 → 선택한 주들의 예정 스케줄로 변환 (기존 예정 스케줄은 교체)
    const from = num(b.apply.from);
    if (!Number.isFinite(from)) return err('적용할 시작 주가 필요합니다.');
    const weeks = Math.min(12, Math.max(1, Math.round(+b.apply.weeks || 1)));
    const ws0 = weekStart(from);
    const ids = (await env.DB.prepare('SELECT id FROM staff WHERE active=1').all()).results.map(r => r.id);
    const stmts = []; let count = 0;
    for (let w = 0; w < weeks; w++) {
      const base = ws0 + w * 7 * DAY;
      stmts.push(env.DB.prepare('DELETE FROM schedule WHERE start>=? AND start<?').bind(base, base + 7 * DAY));
      for (let d = 0; d < 7; d++) for (const id of ids) {
        let s = -1;
        for (let h = 0; h <= 24; h++) {
          const on = h < 24 && (grid[d + '-' + h] || []).includes(id);
          if (on && s < 0) s = h;
          if (!on && s >= 0) {
            stmts.push(env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(id, base + d * DAY + s * HOUR, base + d * DAY + h * HOUR));
            count++; s = -1;
          }
        }
      }
    }
    await env.DB.batch(stmts);
    return json({ ok: true, from: ws0, weeks, count });
  }
  if (p === '/admin/schedule/delete' && m === 'POST') {
    await env.DB.prepare('DELETE FROM schedule WHERE id=?').bind(+b.id).run();
    return json({ ok: true });
  }
  if (p === '/admin/schedule/copy' && m === 'POST') {
    const from = num(b.from); if (!Number.isFinite(from)) return err('from 값이 필요합니다.');
    const rows = (await env.DB.prepare('SELECT * FROM schedule WHERE start>=? AND start<?').bind(from, from + 7 * DAY).all()).results;
    let copied = 0, skipped = 0;
    for (const r of rows) {
      const s = r.start + 7 * DAY, e = r.end + 7 * DAY;
      if (await overlap(env, 'schedule', r.staff_id, s, e)) { skipped++; continue; }
      await env.DB.prepare('INSERT INTO schedule(staff_id,start,end) VALUES(?,?,?)').bind(r.staff_id, s, e).run();
      copied++;
    }
    return json({ ok: true, copied, skipped });
  }

  // 직원별 쓸 수 있는 앱
  if (p === '/admin/staff/apps' && m === 'POST') {
    const list = (Array.isArray(b.apps) ? b.apps : []).filter(k => APP_KEYS.includes(k));
    await env.DB.prepare('UPDATE staff SET apps=? WHERE id=?').bind(list.join(','), +b.id).run();
    return json({ ok: true, apps: list });
  }
  // 직원 출근하기 버튼 사용 여부
  // 전체 백업: 모든 표를 한 번에 (로그인 기기 목록은 빼고)
  if (p === '/admin/backup' && m === 'GET') {
    const tables = ['staff', 'schedule', 'punch', 'edit_request', 'punch_log', 'payslip', 'settings'];
    const res = await env.DB.batch(tables.map(t => env.DB.prepare('SELECT * FROM ' + t)));
    const out = { app: 'oozy-work', version: 1, at: Date.now() };
    tables.forEach((t, i) => { out[t] = res[i].results; });
    return json(out);
  }
  if (p === '/admin/settings' && m === 'GET') return json({ punchOn: await punchEnabled(env) });
  if (p === '/admin/settings' && m === 'POST') {
    await env.DB.prepare("INSERT INTO settings(k,v) VALUES('punch_on',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(b.punchOn ? '1' : '0').run();
    return json({ ok: true, punchOn: !!b.punchOn });
  }
  if (p === '/admin/punches' && m === 'GET') {
    const from = +url.searchParams.get('from'), to = +url.searchParams.get('to');
    const rows = (await env.DB.prepare(`SELECT p.*, s.name FROM punch p JOIN staff s ON s.id=p.staff_id
      WHERE (p.start<? AND COALESCE(p.end,?)>?) OR p.status IN ('missing','open') ORDER BY p.start DESC`).bind(to, now, from).all()).results;
    return json(rows);
  }
  if (p === '/admin/punch' && m === 'POST') {
    const sid = +b.staff_id, s = num(b.start), e = num(b.end);
    const bm = b.brk_min === '' || b.brk_min == null ? null : Math.max(0, Math.round(+b.brk_min) || 0);   // 휴게(분)
    const v = validRange(s, e); if (v) return err(v);
    if (bm != null && bm >= (e - s) / MIN) return err('휴게시간이 근무시간보다 깁니다.');
    if (await overlap(env, 'punch', sid, s, e, +b.id || 0)) return err('이 직원의 다른 근무 기록과 시간이 겹칩니다.', 409);
    if (b.id) {
      const before = await env.DB.prepare('SELECT * FROM punch WHERE id=?').bind(+b.id).first();
      await env.DB.prepare("UPDATE punch SET staff_id=?,start=?,end=?,brk_min=?,status='done',edited=1 WHERE id=?").bind(sid, s, e, bm, +b.id).run();
      await log(env, +b.id, 'admin_edit', before, { staff_id: sid, start: s, end: e, brk_min: bm });
    } else {
      const r = await env.DB.prepare("INSERT INTO punch(staff_id,start,end,brk_min,status,edited,created,note) VALUES(?,?,?,?,'done',1,?, '관리자 추가')").bind(sid, s, e, bm, now).run();
      await log(env, r.meta.last_row_id, 'admin_add', null, { staff_id: sid, start: s, end: e, brk_min: bm });
    }
    return json({ ok: true });
  }
  if (p === '/admin/punch/memo' && m === 'POST') {          // 관리자 기록(메모)
    const memo = String(b.memo || '').trim().slice(0, 300);
    await env.DB.prepare('UPDATE punch SET memo=? WHERE id=?').bind(memo || null, +b.id).run();
    return json({ ok: true, memo });
  }
  if (p === '/admin/punch/delete' && m === 'POST') {
    const before = await env.DB.prepare('SELECT * FROM punch WHERE id=?').bind(+b.id).first();
    await env.DB.prepare('DELETE FROM punch WHERE id=?').bind(+b.id).run();
    await log(env, +b.id, 'admin_delete', before, null);
    return json({ ok: true });
  }

  if (p === '/admin/requests' && m === 'GET') {
    const rows = (await env.DB.prepare(`SELECT r.*, s.name, p.start AS old_start, p.end AS old_end FROM edit_request r
      JOIN staff s ON s.id=r.staff_id LEFT JOIN punch p ON p.id=r.punch_id WHERE r.status='pending' ORDER BY r.created`).all()).results;
    return json(rows);
  }
  if (p === '/admin/requests/resolve' && m === 'POST') {
    const r = await env.DB.prepare("SELECT * FROM edit_request WHERE id=? AND status='pending'").bind(+b.id).first();
    if (!r) return err('이미 처리된 요청입니다.');
    if (b.approve) {
      if (await overlap(env, 'punch', r.staff_id, r.start, r.end, r.punch_id || 0)) return err('승인하면 다른 기록과 겹칩니다. 기록 탭에서 직접 수정하세요.', 409);
      if (r.punch_id) {
        const before = await env.DB.prepare('SELECT * FROM punch WHERE id=?').bind(r.punch_id).first();
        await env.DB.prepare("UPDATE punch SET start=?,end=?,status='done',edited=1 WHERE id=?").bind(r.start, r.end, r.punch_id).run();
        await log(env, r.punch_id, 'request_approve', before, { start: r.start, end: r.end, reason: r.reason });
      } else {
        const ins = await env.DB.prepare("INSERT INTO punch(staff_id,start,end,status,edited,created,note) VALUES(?,?,?,'done',1,?,?)")
          .bind(r.staff_id, r.start, r.end, now, '요청 승인: ' + (r.reason || '')).run();
        await log(env, ins.meta.last_row_id, 'request_add', null, { start: r.start, end: r.end, reason: r.reason });
      }
    }
    await env.DB.prepare('UPDATE edit_request SET status=? WHERE id=?').bind(b.approve ? 'approved' : 'rejected', r.id).run();
    return json({ ok: true });
  }

  if (p === '/admin/pay' && m === 'GET') {
    const r = await computePay(env, url.searchParams.get('month'));
    if (r.error) return err(r.error);
    const conf = (await env.DB.prepare('SELECT staff_id, at FROM payslip WHERE month=?').bind(r.month).all()).results;
    r.staff.forEach(s => { const c = conf.find(x => x.staff_id === s.id); s.confirmedAt = c ? c.at : null; });
    return json(r);
  }
  // 급여 확정: 그 달 명세서를 그대로 저장 → 알바가 '확정급여'에서 봄
  if (p === '/admin/pay/confirm' && m === 'POST') {
    const r = await computePay(env, b.month);
    if (r.error) return err(r.error);
    const list = r.staff.filter(s => s.shifts.length);
    if (!list.length) return err('이 달에 근무 기록이 있는 직원이 없습니다.');
    await env.DB.batch(list.map(s => env.DB.prepare('INSERT INTO payslip(staff_id,month,data,at) VALUES(?,?,?,?) ON CONFLICT(staff_id,month) DO UPDATE SET data=excluded.data, at=excluded.at')
      .bind(s.id, r.month, JSON.stringify(s), now)));
    return json({ ok: true, count: list.length, month: r.month });
  }
  if (p === '/admin/pay/unconfirm' && m === 'POST') {
    await env.DB.prepare('DELETE FROM payslip WHERE month=?').bind(String(b.month || '')).run();
    return json({ ok: true });
  }

  return err('알 수 없는 요청입니다.', 404);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try { return await route(req, env); }
    catch (e) { return err('서버 오류: ' + (e && e.message || e), 500); }
  },
};
