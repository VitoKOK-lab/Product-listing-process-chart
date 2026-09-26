// TZG 商品上架跟進 — Cloudflare Worker API（v3）
// 資料：D1（DB）；照片與首圖：R2（PHOTOS）；前端：public/
import { localYmd } from './worktime.js';
import {
  STEP_LABEL, STEP_ROLE, FLOW, stintHours, overviewRows, buildRadar, attributionFor, ranking, metrics,
  rushInfo, compare, teamAverages, stepTimes, currentReturn,
} from './analytics.js';
import { sheetRows, planSync, extractOgImage, normalizeLink, sheetKey } from './sheet.js';

const SCHEMA_VERSION = '3';
// 在 v3 之後加上的欄位：舊資料庫補上
const ADDED_COLUMNS = { products: [['sheet_row', 'INTEGER'], ['rename_pending', 'INTEGER NOT NULL DEFAULT 0']] };

const TABLES = [
  `CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0, is_external INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    device_hash TEXT, bound_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_roles (member_id INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY (member_id, role))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, action TEXT NOT NULL,
    product_id INTEGER, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, link TEXT NOT NULL DEFAULT '',
    sheet_key TEXT UNIQUE, source TEXT NOT NULL DEFAULT 'sheet', sheet_status TEXT NOT NULL DEFAULT '', status_code TEXT NOT NULL DEFAULT '',
    step TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, marketer_id INTEGER, sl_url TEXT NOT NULL DEFAULT '',
    rush_date TEXT, return_to TEXT, thumb_src TEXT, thumb_ver INTEGER NOT NULL DEFAULT 0, thumb_checked_at INTEGER, thumb_error TEXT,
    delisted_at INTEGER, done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    sheet_row INTEGER, rename_pending INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, kind TEXT NOT NULL,
    r2_key TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    uploaded_by INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stints (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, step TEXT NOT NULL,
    member_id INTEGER, role TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    start_reason TEXT NOT NULL, end_reason TEXT, note TEXT, by_id INTEGER, end_note TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, member_id INTEGER,
    body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_stints_product ON stints(product_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_stints_open ON stints(ended_at)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_product ON photos(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_product ON comments(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_member ON mentions(member_id, resolved_at)`,
];

// v2 → v3：流程整個換掉（線上還沒有商品），清掉舊流程資料，身分改名
const MIGRATE_V3 = [
  'DROP TABLE IF EXISTS products', 'DROP TABLE IF EXISTS stints', 'DROP TABLE IF EXISTS optimizations',
  'DROP TABLE IF EXISTS photos', 'DROP TABLE IF EXISTS comments', 'DROP TABLE IF EXISTS mentions', 'DROP TABLE IF EXISTS batches',
  'DELETE FROM activity WHERE product_id IS NOT NULL',
  "UPDATE member_roles SET role = 'designer' WHERE role = 'external'",
  "DELETE FROM member_roles WHERE role NOT IN ('marketing', 'editor', 'lister', 'designer')",
  'UPDATE members SET is_external = 0',
  "DELETE FROM settings WHERE key IN ('sla_days', 'rush_review_hours', 'capacity_ratio')",
];

export const ROLES = { marketing: '行銷', editor: '美編', lister: '上架人員', designer: '設計師' };
const SEED = [['marketing', '行銷', 2], ['editor', '美編', 2], ['lister', '上架', 2], ['designer', '設計師', 1]];
const COLORS = ['#1E4E8C', '#0E7C5A', '#6B3FA0', '#1B7F8C', '#B8741A', '#8C2F6B', '#4A6B1E', '#3D4F7A'];

const DEFAULT_SETTINGS = {
  work: { days: [1, 2, 3, 4, 5], start: 9, end: 18, holidays: [], tz: 480 },
  rush_threshold_days: 2,
  sheet_api_url: '',
  sheet_api_key: '',
  last_sheet_sync: null,
  last_thumb_sync: null,
};

const NEXT = { open: 'cutout', cutout: 'listing', listing: 'optimizing', optimizing: 'mkt_check', mkt_check: 'done' };
const PREV = { cutout: 'open', listing: 'cutout', optimizing: 'listing' };
const PHOTO_STEP = { pick: 'open', cutout: 'cutout', opt: 'optimizing' };
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const THUMBS_PER_CALL = 8; // 每次最多處理幾件，避免超過 Worker 對外連線上限

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(TABLES.map((sql) => db.prepare(sql)));
  const v = await db.prepare("SELECT value FROM settings WHERE key = 'schema_v'").first();
  if (v?.value !== SCHEMA_VERSION) {
    await db.batch([
      ...MIGRATE_V3.map((sql) => db.prepare(sql)),
      ...TABLES.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO settings (key, value) VALUES ('schema_v', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(SCHEMA_VERSION),
    ]);
  }
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map((c) => c.name));
    for (const [name, type] of cols) {
      if (!have.has(name)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run().catch(() => {});
    }
  }
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
  if (n === 0) await seedMembers(db);
  schemaReady = true;
}

// 預設成員：管理員 1、行銷 2、美編 2、上架 2、設計師 1
async function seedMembers(db) {
  const t = Date.now();
  const stmts = [db.prepare('INSERT INTO members (name, color, is_admin, created_at) VALUES (?, ?, 1, ?)').bind('管理員', '#23283A', t)];
  let i = 0;
  for (const [role, prefix, count] of SEED) {
    for (let k = 1; k <= count; k++) {
      const name = count === 1 ? prefix : `${prefix} ${k}`;
      stmts.push(db.prepare('INSERT INTO members (name, color, created_at) VALUES (?, ?, ?)').bind(name, COLORS[i++ % COLORS.length], t));
      stmts.push(db.prepare('INSERT INTO member_roles (member_id, role) SELECT id, ? FROM members WHERE name = ?').bind(role, name));
    }
  }
  await db.batch(stmts);
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const now = () => Date.now();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, '資料格式錯誤'); }
}

function text(v, field, max = 200) {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `請填寫${field}`);
  if (s.length > max) throw new HttpError(400, `${field}超過 ${max} 字`);
  return s;
}

function intId(v, field = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field}錯誤`);
  return n;
}

function cookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const deviceCookie = (token) => `dt=${token}; Path=/; Max-Age=315360000; SameSite=Lax; HttpOnly; Secure`;

async function loadSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of results) { try { s[r.key] = JSON.parse(r.value); } catch { /* 保留預設 */ } }
  s.day_hours = s.work.end - s.work.start;
  s.rush_threshold_hours = s.rush_threshold_days * s.day_hours;
  return s;
}

function saveSetting(db, key, value) {
  return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value));
}

async function memberRoles(db, id) {
  const { results } = await db.prepare('SELECT role FROM member_roles WHERE member_id = ?').bind(id).all();
  return results.map((r) => r.role);
}

async function currentMember(db, request) {
  const token = cookie(request, 'dt');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const m = await db.prepare('SELECT id, name, color, is_admin FROM members WHERE device_hash = ? AND active = 1')
    .bind(await sha256(token)).first();
  if (!m) return null;
  m.roles = await memberRoles(db, m.id);
  return m;
}

const requireMe = (me) => { if (!me) throw new HttpError(401, '請先選擇你的名字登入'); return me; };
const requireAdmin = (me) => { requireMe(me); if (!me.is_admin) throw new HttpError(403, '只有管理員可以執行這個操作'); return me; };
const hasRole = (me, role) => me.roles.includes(role);
const canSync = (me) => !!me && (me.is_admin || hasRole(me, 'designer'));
const requireSync = (me) => { requireMe(me); if (!canSync(me)) throw new HttpError(403, '只有設計師和管理員可以同步'); };
const isMkt = (me) => me.is_admin || hasRole(me, 'marketing');

function log(db, memberId, action, productId = null, detail = '') {
  return db.prepare('INSERT INTO activity (member_id, action, product_id, detail, at) VALUES (?, ?, ?, ?, ?)')
    .bind(memberId, action, productId, detail, now());
}

async function getProduct(db, id) {
  const p = await db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!p) throw new HttpError(404, '找不到這個商品');
  return p;
}

// 一件商品可能同時有兩段在進行（做圖、文案），所以要指定哪一步
async function openStint(db, productId, step) {
  return db.prepare('SELECT * FROM stints WHERE product_id = ? AND step = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(productId, step).first();
}

const ACTION_TEXT = {
  product_add: '新增商品', claim: '認領', release: '放回待認領', complete: '完成這一步', return: '退回',
  check_pass: '檢查通過', admin_advance: '手動推進', reassign: '改派', comment_add: '留言', rush_set: '設定插隊',
  rush_clear: '取消插隊', sheet_sync: '同步試算表',
};

// 送出時比對狀態，已被別人改過就拒絕
async function checkVersion(db, p, version) {
  if (Number(version) === p.version) return;
  const last = await db.prepare(`SELECT a.action, a.at, m.name FROM activity a LEFT JOIN members m ON m.id = a.member_id
    WHERE a.product_id = ? ORDER BY a.id DESC LIMIT 1`).bind(p.id).first();
  const mins = last ? Math.max(1, Math.round((now() - last.at) / 60000)) : 0;
  const what = last ? (ACTION_TEXT[last.action] || '更新') : '更新';
  throw new HttpError(409, last?.name ? `${last.name} ${mins} 分鐘前已${what}，畫面已更新` : '這件商品已被更新，畫面已更新');
}

async function memberHasRole(db, memberId, role) {
  if (!memberId) return false;
  const r = await db.prepare(`SELECT 1 AS ok FROM member_roles mr JOIN members m ON m.id = mr.member_id
    WHERE mr.member_id = ? AND mr.role = ? AND m.active = 1`).bind(memberId, role).first();
  return !!r;
}

// 輪到某一步時交給誰：行銷檢查 → 負責的行銷；其他 → 上次做這一步的人（退回、改好交回）；都沒有就放著等人認領
async function holderFor(db, p, step) {
  if (step === 'open' || step === 'mkt_check') {
    return (await memberHasRole(db, p.marketer_id, 'marketing')) ? p.marketer_id : null;
  }
  const last = await db.prepare('SELECT member_id FROM stints WHERE product_id = ? AND step = ? AND member_id IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1')
    .bind(p.id, step).first();
  if (last && await memberHasRole(db, last.member_id, STEP_ROLE[step])) return last.member_id;
  return null; // 第一次輪到：不預設給人，自己認領
}

// 換關：關閉目前這段、開下一段、更新商品、寫紀錄
function transition(db, p, open, me, { endReason, endNote = null, to, member = null, startReason = 'advance', note = null, updates = {}, action, detail = '', skipStint = false }) {
  const t = now();
  const stmts = [];
  if (open) {
    stmts.push(db.prepare('UPDATE stints SET ended_at = ?, end_reason = ?, end_note = COALESCE(?, end_note) WHERE id = ?').bind(t, endReason, endNote, open.id));
  }
  if (to && to !== 'done' && !skipStint) {
    stmts.push(db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, start_reason, note, by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, to, member, STEP_ROLE[to], t, startReason, note, me.id));
  }
  const cols = { ...updates, updated_at: t };
  if (to) cols.step = to;
  if (to === 'done') cols.done_at = t;
  const keys = Object.keys(cols);
  stmts.push(db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ?`)
    .bind(...keys.map((k) => cols[k]), p.id));
  stmts.push(db.prepare('UPDATE mentions SET resolved_at = ? WHERE product_id = ? AND member_id = ? AND resolved_at IS NULL').bind(t, p.id, me.id));
  stmts.push(log(db, me.id, action, p.id, detail));
  return stmts;
}

// 同一段換人（認領、放回、改派）：時間照算在這一步
function handOver(db, p, open, me, { member, reason, updates = {}, action, detail = '' }) {
  const t = now();
  const cols = { ...updates, updated_at: t };
  const keys = Object.keys(cols);
  return [
    db.prepare('UPDATE stints SET ended_at = ?, end_reason = ? WHERE id = ?').bind(t, reason, open.id),
    db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, start_reason, by_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(p.id, open.step, member, open.role, t, reason, me.id),
    db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ?`).bind(...keys.map((k) => cols[k]), p.id),
    log(db, me.id, action, p.id, detail),
  ];
}

// ---------- route table ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/version', async ({ db }) => {
  const row = await db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM activity').first();
  return json({ v: row.v, now: now() });
});

route('GET', '/api/bootstrap', async ({ db, me, settings }) => {
  const [members, roles] = await Promise.all([
    db.prepare(`SELECT id, name, color, is_admin, active, bound_at, CASE WHEN device_hash IS NULL THEN 0 ELSE 1 END AS bound FROM members ORDER BY id`).all(),
    db.prepare('SELECT member_id, role FROM member_roles').all(),
  ]);
  const rolesBy = {};
  for (const r of roles.results) (rolesBy[r.member_id] ||= []).push(r.role);
  let list = members.results.map((m) => ({ ...m, roles: rolesBy[m.id] || [] }));
  if (!me) {
    // 未登入只給登入頁需要的：未綁定、啟用中的名字
    list = list.filter((m) => m.active && !m.bound).map(({ id, name, color, roles: rs, is_admin }) => ({ id, name, color, roles: rs, is_admin }));
    return json({ me: null, members: list });
  }
  const { sheet_api_url, sheet_api_key, ...pub } = settings;
  return json({
    me: { ...me, can_sync: canSync(me) }, members: list,
    settings: { ...pub, ...(canSync(me) ? { sheet_api_url, sheet_api_key } : {}) },
    roles: ROLES, step_label: STEP_LABEL, step_role: STEP_ROLE, now: now(),
  });
});

route('POST', '/api/claim', async ({ db, request, me }) => {
  if (me) throw new HttpError(400, `這台裝置已綁定「${me.name}」`);
  const id = intId((await body(request)).member_id);
  const token = newToken();
  const res = await db.prepare('UPDATE members SET device_hash = ?, bound_at = ? WHERE id = ? AND active = 1 AND device_hash IS NULL')
    .bind(await sha256(token), now(), id).run();
  if (!res.meta.changes) throw new HttpError(409, '這個名字已被其他裝置綁定，請找管理員重設');
  await log(db, id, 'member_bind').run();
  return json({ ok: true }, 200, { 'set-cookie': deviceCookie(token) });
});

// ---------- 成員（管理員） ----------

async function setRoles(db, id, roles) {
  const clean = [...new Set((roles || []).filter((r) => ROLES[r]))];
  return [
    db.prepare('DELETE FROM member_roles WHERE member_id = ?').bind(id),
    ...clean.map((r) => db.prepare('INSERT INTO member_roles (member_id, role) VALUES (?, ?)').bind(id, r)),
  ];
}

route('POST', '/api/members', async ({ db, request, me }) => {
  requireAdmin(me);
  const b = await body(request);
  const name = text(b.name, '名字', 30);
  if (await db.prepare('SELECT id FROM members WHERE name = ?').bind(name).first()) throw new HttpError(409, '這個名字已經存在');
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
  const res = await db.prepare('INSERT INTO members (name, color, created_at) VALUES (?, ?, ?)').bind(name, COLORS[n % COLORS.length], now()).run();
  const id = res.meta.last_row_id;
  await db.batch([...(await setRoles(db, id, b.roles)), log(db, me.id, 'member_add', null, name)]);
  return json({ id });
});

route('PATCH', '/api/members/:id', async ({ db, request, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const m = await db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
  if (!m) throw new HttpError(404, '找不到這位成員');
  const b = await body(request);
  const name = b.name !== undefined ? text(b.name, '名字', 30) : m.name;
  const isAdmin = b.is_admin !== undefined ? (b.is_admin ? 1 : 0) : m.is_admin;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : m.active;
  if (m.is_admin && (!isAdmin || !active)) {
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE is_admin = 1 AND active = 1').first();
    if (n <= 1) throw new HttpError(400, '至少要保留一位管理員');
  }
  if (name !== m.name && await db.prepare('SELECT id FROM members WHERE name = ? AND id != ?').bind(name, id).first()) {
    throw new HttpError(409, '這個名字已經存在');
  }
  const stmts = [db.prepare('UPDATE members SET name = ?, is_admin = ?, active = ? WHERE id = ?').bind(name, isAdmin, active, id)];
  if (b.roles !== undefined) stmts.push(...(await setRoles(db, id, b.roles)));
  stmts.push(log(db, me.id, 'member_edit', null, name));
  await db.batch(stmts);
  return json({ ok: true });
});

route('POST', '/api/members/:id/reset', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const m = await db.prepare('SELECT name FROM members WHERE id = ?').bind(id).first();
  if (!m) throw new HttpError(404, '找不到這位成員');
  await db.batch([
    db.prepare('UPDATE members SET device_hash = NULL, bound_at = NULL WHERE id = ?').bind(id),
    log(db, me.id, 'member_reset', null, m.name),
  ]);
  return json({ ok: true });
});

// ---------- 設定 ----------

route('PUT', '/api/settings', async ({ db, request, me }) => {
  requireAdmin(me);
  const b = await body(request);
  const w = b.work;
  const validDays = Array.isArray(w?.days) && w.days.length && w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!validDays || !(Number.isInteger(w.start) && Number.isInteger(w.end) && w.start >= 0 && w.end <= 24 && w.end > w.start)) {
    throw new HttpError(400, '上班時間設定錯誤');
  }
  const holidays = (w.holidays || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const rushDays = Number(b.rush_threshold_days);
  if (!(rushDays > 0 && rushDays <= 20)) throw new HttpError(400, '急件門檻需介於 0 到 20 個上班日');
  await db.batch([
    saveSetting(db, 'work', { days: w.days, start: w.start, end: w.end, holidays, tz: 480 }),
    saveSetting(db, 'rush_threshold_days', rushDays),
    log(db, me.id, 'settings_edit'),
  ]);
  return json({ ok: true });
});

// Apps Script 網頁應用程式網址與密碼（設計師、管理員）
route('PUT', '/api/sheet-source', async ({ db, request, me, settings }) => {
  requireSync(me);
  const b = await body(request);
  const stmts = [];
  if (b.url !== undefined) {
    const url = String(b.url ?? '').trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      throw new HttpError(400, '請貼上部署後的「網頁應用程式」網址（https://script.google.com/macros/s/…/exec）');
    }
    stmts.push(saveSetting(db, 'sheet_api_url', url));
  }
  // 第一次或要求換新時產生密碼；換了之後 Apps Script 裡的密碼也要跟著換
  if (b.new_key || !settings.sheet_api_key) stmts.push(saveSetting(db, 'sheet_api_key', newToken().slice(0, 32)));
  stmts.push(log(db, me.id, 'sheet_source_edit'));
  await db.batch(stmts);
  return json({ ok: true });
});

// ---------- 資料載入 ----------

async function loadAll(db) {
  const [products, stints, mentions] = await Promise.all([
    db.prepare('SELECT * FROM products WHERE deleted_at IS NULL').all(),
    db.prepare('SELECT s.* FROM stints s JOIN products p ON p.id = s.product_id WHERE p.deleted_at IS NULL').all(),
    db.prepare('SELECT * FROM mentions WHERE resolved_at IS NULL').all(),
  ]);
  return { all: products.results, live: products.results.filter((p) => !p.delisted_at), stints: stints.results, mentions: mentions.results };
}

const cfgOf = (settings) => settings.work;

// ---------- 全覽（首頁） ----------

route('GET', '/api/overview', async ({ db, me, url, settings }) => {
  requireMe(me);
  const d = await loadAll(db);
  const t = now();
  const f = url.searchParams.get('filter') || 'all';
  const active = d.live.filter((p) => p.step !== 'done');
  const counts = {
    all: active.length, rush: active.filter((p) => p.rush_date).length,
    A: 0, B: 0, C: 0, D: 0, other: 0, done: d.live.length - active.length, delisted: d.all.length - d.live.length,
  };
  for (const p of active) counts[p.status_code || 'other']++;
  const pick = {
    all: (p) => !p.delisted_at,
    rush: (p) => !p.delisted_at && p.rush_date && p.step !== 'done',
    other: (p) => !p.delisted_at && !p.status_code,
    delisted: (p) => !!p.delisted_at,
  }[f] || ((p) => !p.delisted_at && p.status_code === f);
  const { rows, avgs } = overviewRows({ products: d.all.filter(pick), allProducts: d.all, stints: d.stints, now: t, cfg: cfgOf(settings), settings });
  if (!me.is_admin) {
    // 員工只看進度，不看時間
    for (const r of rows) {
      r.diff = null; r.level = 'ok';
      for (const c of r.cells) Object.assign(c, { held: null, work: null, pool: null, avg: null, total_avg: null, diff: null, level: 'ok' });
    }
  }
  return json({ rows, avgs: me.is_admin ? avgs : null, counts, filter: f, now: t, show_time: !!me.is_admin });
});

// ---------- 我的待辦 ----------

route('GET', '/api/radar', async ({ db, me, url, settings }) => {
  requireMe(me);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'me';
  const d = await loadAll(db);
  return json(buildRadar({
    products: d.live, allProducts: d.all, stints: d.stints, mentions: d.mentions, me: me.id, meRoles: me.roles,
    showTime: !!me.is_admin, scope, now: now(), cfg: cfgOf(settings), settings,
  }));
});

// ---------- 商品 ----------

route('GET', '/api/products/:id', async ({ db, me, params, settings }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const t = now();
  const cfg = cfgOf(settings);
  const [photos, comments, stints, mentions, allProducts, allStints] = await Promise.all([
    db.prepare('SELECT id, kind, filename, uploaded_by, created_at FROM photos WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT id, member_id, body, created_at FROM comments WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT * FROM stints WHERE product_id = ? ORDER BY started_at, id').bind(id).all(),
    db.prepare('SELECT id, member_id, comment_id FROM mentions WHERE product_id = ? AND resolved_at IS NULL').bind(id).all(),
    db.prepare('SELECT id, step FROM products WHERE deleted_at IS NULL').all(),
    db.prepare("SELECT s.id, s.product_id, s.step, s.member_id, s.started_at, s.ended_at, s.start_reason FROM stints s JOIN products p ON p.id = s.product_id WHERE p.deleted_at IS NULL").all(),
  ]);
  const hours = stintHours(stints.results, t, cfg);
  const avgs = teamAverages(allProducts.results, stepTimes(allStints.results, stintHours(allStints.results, t, cfg)));
  const mine = stepTimes(stints.results, hours).get(id) || {};
  // 可能同時有兩段在進行（做圖、文案）
  const retOf = (s) => { const r = currentReturn(stints.results, s); return r ? { note: r.note, by_id: r.by_id, at: r.started_at } : null; };
  const opens = stints.results.filter((s) => s.ended_at == null).map((s) => ({ ...s, returned: retOf(s) }));
  const open = opens.find((s) => s.step === p.step) || opens[0] || null;
  const steps = Object.fromEntries(FLOW.map((s) => {
    const r1 = (x) => Math.round((x || 0) * 10) / 10;
    const work = r1(mine[s]?.work);
    const c = mine[s]?.imported ? { diff: null, level: 'ok' } : compare(work, avgs[s].avg);
    return [s, { held: r1(mine[s]?.held), work, pool: r1(mine[s]?.pool), rounds: mine[s]?.rounds || 0, avg: avgs[s].avg, total_avg: avgs[s].total_avg, imported: !!mine[s]?.imported, ...c }];
  }));
  return json({
    ...p,
    photos: photos.results,
    comments: comments.results,
    my_mentions: mentions.results.filter((m) => m.member_id === me.id),
    stints: stints.results.map((s) => ({ ...s, held: me.is_admin ? Math.round((hours.get(s.id) || 0) * 10) / 10 : null })),
    open, opens, returned: open?.returned ?? null,
    steps: me.is_admin ? steps : null, rush: rushInfo(p, t, cfg, settings),
    attribution: me.is_admin ? attributionFor(id, stints.results, hours) : [],
    now: t,
  });
});

// ---------- 流程動作 ----------

route('POST', '/api/products/:id/action', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const b = await body(request);
  await checkVersion(db, p, b.version);
  if (p.delisted_at) throw new HttpError(400, '這件已下架，試算表加回來才會恢復');
  const open = await openStint(db, id, b.step || p.step);
  const need = () => {
    if (!open) throw new HttpError(409, '這件商品已不在這一步，畫面已更新');
  };
  // 完成、退回只能對商品目前所在的那一步（文案可以先寫，但要等圖做好才能上架）
  const mustBeCurrent = () => {
    if (open.step !== p.step) {
      throw new HttpError(400, open.step === 'listing' && p.step === 'cutout' ? '美編的圖還沒做好，做好才能按「已上架」' : '這件商品已不在這一步，畫面已更新');
    }
  };
  const mustHold = () => {
    need();
    if (open.member_id !== me.id) throw new HttpError(403, open.member_id ? '只有認領的人可以操作' : '請先按「我來做」認領');
  };
  const photoCount = async (kind) => (await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE product_id = ? AND kind = ? AND deleted_at IS NULL').bind(id, kind).first()).n;
  const forward = async (endReason, extra = {}) => {
    // 被後面的人退回、改好了：直接交回退回的那一步
    const to = p.return_to && p.return_to !== p.step ? p.return_to : NEXT[p.step];
    // 文案那一段已經在進行（同時開始的），不用再開一段
    const running = to !== 'done' && await openStint(db, id, to);
    const member = to === 'done' || running ? null : await holderFor(db, p, to);
    return transition(db, p, open, me, {
      endReason, to, member, skipStint: !!running, updates: { return_to: null, ...(extra.updates || {}) }, endNote: extra.endNote,
      action: extra.action || 'complete', detail: `${STEP_LABEL[p.step]} → ${STEP_LABEL[to]}${extra.detail ? `：${extra.detail}` : ''}`,
    });
  };
  let stmts;

  switch (b.action) {
    case 'claim': {
      need();
      if (open.member_id) {
        const who = await db.prepare('SELECT name FROM members WHERE id = ?').bind(open.member_id).first();
        throw new HttpError(409, `已被 ${who?.name ?? '別人'} 認領，畫面已更新`);
      }
      if (!hasRole(me, open.role)) throw new HttpError(403, `需要「${ROLES[open.role]}」身分才能認領`);
      const updates = open.step === 'open' || open.step === 'mkt_check' ? { marketer_id: me.id } : {};
      stmts = handOver(db, p, open, me, { member: me.id, reason: 'claim', updates, action: 'claim', detail: STEP_LABEL[open.step] });
      break;
    }
    case 'release': {
      mustHold();
      stmts = handOver(db, p, open, me, { member: null, reason: 'release', action: 'release', detail: STEP_LABEL[open.step] });
      break;
    }
    case 'complete': {
      mustHold();
      mustBeCurrent();
      if (p.step === 'open' && !(await photoCount('pick'))) throw new HttpError(400, '請至少上傳 1 張選品照片');
      if (p.step === 'cutout' && !(await photoCount('cutout'))) throw new HttpError(400, '請上傳去背圖');
      if (p.step === 'listing') {
        const slUrl = String(b.sl_url ?? '').trim().slice(0, 500);
        if (!/^https?:\/\//.test(slUrl)) throw new HttpError(400, '請貼上 Shopline 商品網址（http 開頭）');
        const updates = { sl_url: slUrl };
        const extra = [];
        if (p.rename_pending) {
          // 名稱改了、網址跟著變：換成新網址，下次同步對得上試算表的新網址；舊網址那列寫「已更名失效」
          if (normalizeLink(slUrl) === normalizeLink(p.link)) throw new HttpError(400, '名稱改了網址也會變，請貼上改名後的新網址');
          Object.assign(updates, { link: slUrl, rename_pending: 0, thumb_checked_at: null });
          if (p.source === 'sheet') {
            const key = sheetKey(p.name, slUrl);
            const dup = await db.prepare('SELECT id, step FROM products WHERE sheet_key = ? AND id != ? AND deleted_at IS NULL').bind(key, id).first();
            if (dup) {
              const pics = await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE product_id = ? AND deleted_at IS NULL').bind(dup.id).first();
              if (dup.step !== 'open' || pics.n) throw new HttpError(409, '這個新網址在系統裡已經是另一件商品，而且已經開始作業，請找管理員處理');
              // 先同步進來的新網址那一件還沒開始，併到這一件
              extra.push(db.prepare('UPDATE products SET sheet_key = NULL, deleted_at = ?, version = version + 1 WHERE id = ?').bind(now(), dup.id));
              extra.push(db.prepare("UPDATE stints SET ended_at = ?, end_reason = 'merged' WHERE product_id = ? AND ended_at IS NULL").bind(now(), dup.id));
            }
            updates.sheet_key = key;
          }
        }
        stmts = [...extra, ...(await forward('complete', { updates, detail: p.rename_pending ? '已換新網址' : '' }))];
        break;
      }
      if (p.step === 'optimizing') {
        const note = String(b.note ?? '').trim().slice(0, 2000);
        if (!note) throw new HttpError(400, '請填寫改了什麼');
        stmts = await forward('complete', { endNote: note, detail: note.slice(0, 60) });
        break;
      }
      stmts = await forward(p.step === 'mkt_check' ? 'pass' : 'complete', { action: p.step === 'mkt_check' ? 'check_pass' : 'complete' });
      break;
    }
    case 'return': {
      // 管理員可以直接退回任何一件；其他人要是認領這一步的人
      const byAdmin = me.is_admin && (!open || open.member_id !== me.id);
      if (byAdmin) need(); else mustHold();
      mustBeCurrent();
      const note = String(b.note ?? '').trim().slice(0, 2000);
      if (!note) throw new HttpError(400, '請寫出哪裡有問題');
      let to;
      let label = '';
      const updates = {};
      if (byAdmin) {
        const before = FLOW.slice(0, Math.max(0, FLOW.indexOf(p.step)));
        to = before.includes(b.target) ? b.target : null;
        if (!to) throw new HttpError(400, '請選要退回哪一步');
        label = '管理員退回';
      } else if (p.step === 'mkt_check') {
        to = ['open', 'cutout', 'listing', 'optimizing'].includes(b.target) ? b.target : null;
        if (!to || to === 'open') throw new HttpError(400, '請選要退回哪一步');
      } else if (p.step === 'optimizing') {
        // 設計師：文案 → 上架人員；去背圖 → 美編。改好直接交回設計師
        to = { listing: 'listing', cutout: 'cutout' }[b.target];
        if (!to) throw new HttpError(400, '請選退回原因：文案或去背圖');
        label = to === 'listing' ? (b.rename ? '文案・名稱要改' : '文案') : '去背圖';
        if (to === 'listing' && b.rename) updates.rename_pending = 1;
      } else {
        to = PREV[p.step];
        if (!to) throw new HttpError(400, '開單沒有上一步可以退回');
      }
      const member = await holderFor(db, p, to);
      stmts = transition(db, p, open, me, {
        endReason: 'return', to, member, startReason: 'return', note: label ? `【${label}】${note}` : note,
        // 行銷檢查、設計師退回：改好直接交回；中間關卡退回：照正常流程往下走
        updates: { ...updates, return_to: ['mkt_check', 'optimizing'].includes(p.step) || byAdmin ? p.step : null },
        action: 'return', detail: `${STEP_LABEL[p.step]} → ${STEP_LABEL[to]}：${label ? `【${label}】` : ''}${note.slice(0, 60)}`,
      });
      break;
    }
    case 'admin_advance': {
      if (!me.is_admin) throw new HttpError(403, '只有管理員可以手動推進');
      if (p.step === 'done') throw new HttpError(400, '這件已完成');
      const note = String(b.note ?? '').trim().slice(0, 200);
      stmts = await forward('admin', { action: 'admin_advance', detail: note });
      break;
    }
    case 'reassign': {
      if (!me.is_admin) throw new HttpError(403, '只有管理員可以改派');
      need();
      const to = b.member_id ? intId(b.member_id, '成員') : null;
      if (to && !(await memberHasRole(db, to, open.role))) throw new HttpError(400, `此人不是「${ROLES[open.role]}」`);
      if (to === open.member_id) return json({ ok: true });
      const updates = to && (open.step === 'open' || open.step === 'mkt_check') ? { marketer_id: to } : {};
      stmts = handOver(db, p, open, me, { member: to, reason: 'reassign', updates, action: 'reassign', detail: STEP_LABEL[open.step] });
      break;
    }
    default:
      throw new HttpError(400, '未知的動作');
  }
  await db.batch(stmts);
  return json({ ok: true });
});

// 插隊：只選日期，不能選當天
route('PUT', '/api/products/:id/rush', async ({ db, request, me, params, settings }) => {
  requireMe(me);
  if (!isMkt(me)) throw new HttpError(403, '只有行銷或管理員可以設定插隊');
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const date = (await body(request)).date || null;
  if (date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new HttpError(400, '請選擇完成日期');
    if (date <= localYmd(now(), cfgOf(settings))) throw new HttpError(400, '完成日期最早只能選明天');
    if (p.step === 'done') throw new HttpError(400, '這件已完成');
  }
  await db.batch([
    db.prepare('UPDATE products SET rush_date = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(date, now(), id),
    log(db, me.id, date ? 'rush_set' : 'rush_clear', id, date || ''),
  ]);
  return json({ ok: true });
});

// ---------- 試算表同步（設計師、管理員） ----------

route('POST', '/api/sync/sheet', async ({ db, request, me, settings }) => {
  requireSync(me);
  const force = !!(await body(request).catch(() => ({}))).force;
  const url = settings.sheet_api_url;
  if (!url || !settings.sheet_api_key) throw new HttpError(400, '還沒設定試算表連線，請先按「連線設定」');
  let res;
  try {
    res = await fetch(`${url}?key=${encodeURIComponent(settings.sheet_api_key)}`, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
  } catch { throw new HttpError(502, '連不到試算表，請稍後再試'); }
  let data;
  try { data = await res.json(); } catch { throw new HttpError(400, '讀不到試算表：請確認 Apps Script 已部署成網頁應用程式，存取權選「所有人」'); }
  if (data.error) throw new HttpError(400, `試算表回覆：${String(data.error).slice(0, 100)}`);
  const rows = sheetRows(data.rows);
  if (!rows.length) throw new HttpError(400, '沒有讀到任何商品，請確認「銷售型-投廣素材」這一頁有資料');
  const { results: existing } = await db.prepare('SELECT id, name, link, sheet_key, source, sheet_status, status_code, sheet_row, step, delisted_at, deleted_at FROM products WHERE sheet_key IS NOT NULL').all();
  const plan = planSync(existing, rows);
  const liveSheet = existing.filter((p) => p.source === 'sheet' && !p.delisted_at && !p.deleted_at).length;
  // 防呆：一次要下架超過一半，多半是讀錯頁或資料被清空
  if (!force && plan.delist.length > 10 && plan.delist.length > liveSheet / 2) {
    throw new HttpError(409, `這次同步會把 ${plan.delist.length} 件標成已下架，確定「銷售型-投廣素材」這一頁的資料是對的嗎？`, { code: 'mass_delist', count: plan.delist.length });
  }
  const t = now();
  const stmts = [];
  for (const r of plan.inserts) {
    // 行銷寫上名稱就算開單完成：美編做圖、上架人員寫文案同時開始
    stmts.push(db.prepare(`INSERT INTO products (name, link, sheet_key, source, sheet_status, status_code, sheet_row, step, created_at, updated_at)
      VALUES (?, ?, ?, 'sheet', ?, ?, ?, 'cutout', ?, ?)`).bind(r.name, r.link, r.key, r.status, r.code, r.row, t, t));
    for (const [step, role] of [['cutout', 'editor'], ['listing', 'lister']]) {
      stmts.push(db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, start_reason, by_id)
        SELECT id, ?, NULL, ?, ?, 'create', ? FROM products WHERE sheet_key = ?`).bind(step, role, t, me.id, r.key));
    }
  }
  for (const u of plan.updates) {
    stmts.push(db.prepare('UPDATE products SET name = ?, link = ?, sheet_status = ?, status_code = ?, sheet_row = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .bind(u.row.name, u.row.link, u.row.status, u.row.code, u.row.row, t, u.id));
  }
  for (const pid of plan.delist) {
    stmts.push(db.prepare('UPDATE products SET delisted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(t, t, pid));
    stmts.push(db.prepare("UPDATE stints SET ended_at = ?, end_reason = 'delisted' WHERE product_id = ? AND ended_at IS NULL").bind(t, pid));
  }
  const stepOf = new Map(existing.map((p) => [p.id, p.step]));
  for (const r of plan.restore) {
    const step = stepOf.get(r.id);
    stmts.push(db.prepare('UPDATE products SET delisted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?').bind(t, r.id));
    if (step === 'open') {
      // 舊資料還在開單：照新流程從做圖、文案開始
      stmts.push(db.prepare("UPDATE products SET step = 'cutout' WHERE id = ?").bind(r.id));
      for (const [st, role] of [['cutout', 'editor'], ['listing', 'lister']]) {
        stmts.push(db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, start_reason, by_id) VALUES (?, ?, NULL, ?, ?, 'create', ?)`)
          .bind(r.id, st, role, t, me.id));
      }
    } else if (step !== 'done') {
      // 下架時進行中的每一段都接回去（做圖、文案可能同時在做）
      stmts.push(db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, start_reason, by_id)
        SELECT product_id, step, member_id, role, ?, 'restore', ? FROM stints WHERE product_id = ? AND end_reason = 'delisted'
          AND ended_at = (SELECT MAX(ended_at) FROM stints WHERE product_id = ? AND end_reason = 'delisted')`)
        .bind(t, me.id, r.id, r.id));
    }
  }
  const summary = { at: t, by: me.id, total: rows.length, added: plan.inserts.length, updated: plan.updates.length, delisted: plan.delist.length, restored: plan.restore.length };
  stmts.push(saveSetting(db, 'last_sheet_sync', summary));
  stmts.push(log(db, me.id, 'sheet_sync', null, `新增 ${summary.added}、更新 ${summary.updated}、下架 ${summary.delisted}、恢復 ${summary.restored}`));
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  return json(summary);
});

// 首圖縮圖：打開商品頁讀 og:image，存進 R2；每次處理幾件，前端接著呼叫直到做完
route('POST', '/api/sync/thumbs', async ({ db, env, request, me }) => {
  requireSync(me);
  const since = Number((await body(request).catch(() => ({}))).since) || now();
  const { results: list } = await db.prepare(`SELECT id, name, link, thumb_src, thumb_ver FROM products
    WHERE deleted_at IS NULL AND delisted_at IS NULL AND link != '' AND (thumb_checked_at IS NULL OR thumb_checked_at < ?)
    ORDER BY id LIMIT ?`).bind(since, THUMBS_PER_CALL).all();
  const t = now();
  let updated = 0;
  const failed = [];
  const stmts = [];
  await Promise.all(list.map(async (p) => {
    try {
      const page = await fetch(p.link, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; TZG-listing/1.0)', accept: 'text/html' } });
      if (!page.ok) throw new Error(`商品頁 ${page.status}`);
      const img = extractOgImage(await page.text(), page.url || p.link);
      if (!img) throw new Error('商品頁沒有首圖');
      if (img === p.thumb_src && p.thumb_ver > 0) {
        stmts.push(db.prepare('UPDATE products SET thumb_checked_at = ?, thumb_error = NULL WHERE id = ?').bind(t, p.id));
        return;
      }
      const res = await fetch(img, { signal: AbortSignal.timeout(10000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) throw new Error('首圖下載失敗');
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_THUMB_BYTES) throw new Error('首圖超過 5MB');
      await env.PHOTOS.put(`thumbs/${p.id}`, buf, { httpMetadata: { contentType: type } });
      stmts.push(db.prepare('UPDATE products SET thumb_src = ?, thumb_ver = thumb_ver + 1, thumb_checked_at = ?, thumb_error = NULL WHERE id = ?').bind(img, t, p.id));
      updated++;
    } catch (e) {
      failed.push(p.name);
      stmts.push(db.prepare('UPDATE products SET thumb_checked_at = ?, thumb_error = ? WHERE id = ?').bind(t, String(e.message || e).slice(0, 100), p.id));
    }
  }));
  const { n: remaining } = await db.prepare(`SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL AND delisted_at IS NULL AND link != ''
    AND (thumb_checked_at IS NULL OR thumb_checked_at < ?)`).bind(since).first() ?? { n: 0 };
  const left = Math.max(0, remaining - list.length);
  if (!left) stmts.push(saveSetting(db, 'last_thumb_sync', { at: t, by: me.id }), log(db, me.id, 'thumb_sync'));
  if (stmts.length) await db.batch(stmts);
  return json({ processed: list.length, updated, failed, remaining: left });
});

route('GET', '/api/thumbs/:id', async ({ env, me, params }) => {
  requireMe(me);
  const obj = await env.PHOTOS.get(`thumbs/${intId(params.id)}`);
  if (!obj) throw new HttpError(404, '沒有首圖');
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag },
  });
});

// ---------- 照片 ----------

route('POST', '/api/products/:id/photos', async ({ db, env, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const form = await request.formData();
  const kind = String(form.get('kind'));
  if (!PHOTO_STEP[kind]) throw new HttpError(400, '照片類型錯誤');
  const open = await openStint(db, id, PHOTO_STEP[kind]);
  if (!open || open.member_id !== me.id) throw new HttpError(403, '只有認領這一步的人可以上傳');
  const files = form.getAll('file').filter((f) => typeof f === 'object' && f.size > 0);
  if (!files.length) throw new HttpError(400, '沒有收到照片');
  const t = now();
  const stmts = [];
  for (const f of files) {
    if (!String(f.type).startsWith('image/')) throw new HttpError(400, `${f.name} 不是圖片`);
    if (f.size > MAX_PHOTO_BYTES) throw new HttpError(400, `${f.name} 超過 10MB`);
    const ext = (f.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const key = `products/${id}/${kind}/${crypto.randomUUID()}.${ext}`;
    await env.PHOTOS.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
    stmts.push(db.prepare('INSERT INTO photos (product_id, kind, r2_key, filename, content_type, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, kind, key, String(f.name).slice(0, 120), f.type, me.id, t));
  }
  stmts.push(db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(t, p.id));
  stmts.push(log(db, me.id, 'photo_add', id, `${files.length} 張`));
  await db.batch(stmts);
  return json({ ok: true, count: files.length });
});

route('GET', '/api/photos/:id', async ({ db, env, params, me, url }) => {
  requireMe(me);
  const ph = await db.prepare('SELECT r2_key, content_type, filename FROM photos WHERE id = ?').bind(intId(params.id)).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  const obj = await env.PHOTOS.get(ph.r2_key);
  if (!obj) throw new HttpError(404, '照片檔案遺失');
  const headers = { 'content-type': ph.content_type, 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag };
  if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(ph.filename || 'photo.jpg')}`;
  return new Response(obj.body, { headers });
});

route('DELETE', '/api/photos/:id', async ({ db, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const ph = await db.prepare('SELECT product_id, kind FROM photos WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  const open = await openStint(db, ph.product_id, PHOTO_STEP[ph.kind]);
  const ownStep = open && open.member_id === me.id;
  if (!ownStep && !me.is_admin) throw new HttpError(403, '只有認領這一步的人或管理員可以刪除');
  await db.batch([
    db.prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').bind(now(), id),
    log(db, me.id, 'photo_delete', ph.product_id),
  ]);
  return json({ ok: true });
});

// ---------- 留言與 @ ----------

route('POST', '/api/products/:id/comments', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  await getProduct(db, id);
  const b = text((await body(request)).body, '留言', 2000);
  const t = now();
  const res = await db.prepare('INSERT INTO comments (product_id, member_id, body, created_at) VALUES (?, ?, ?, ?)').bind(id, me.id, b, t).run();
  const cid = res.meta.last_row_id;
  const { results } = await db.prepare('SELECT id, name FROM members WHERE active = 1 AND id != ?').bind(me.id).all();
  const mentioned = results.filter((m) => b.includes('@' + m.name));
  await db.batch([
    ...mentioned.map((m) => db.prepare('INSERT INTO mentions (comment_id, product_id, member_id, created_at) VALUES (?, ?, ?, ?)').bind(cid, id, m.id, t)),
    db.prepare('UPDATE mentions SET resolved_at = ? WHERE product_id = ? AND member_id = ? AND resolved_at IS NULL AND comment_id != ?').bind(t, id, me.id, cid),
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(t, id),
    log(db, me.id, 'comment_add', id, b.slice(0, 60)),
  ]);
  return json({ ok: true, mentioned: mentioned.map((m) => m.name) });
});

route('DELETE', '/api/comments/:id', async ({ db, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const c = await db.prepare('SELECT member_id, product_id FROM comments WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!c) throw new HttpError(404, '找不到留言');
  if (c.member_id !== me.id && !me.is_admin) throw new HttpError(403, '只能刪除自己的留言');
  await db.batch([
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').bind(now(), id),
    db.prepare('UPDATE mentions SET resolved_at = ? WHERE comment_id = ? AND resolved_at IS NULL').bind(now(), id),
    log(db, me.id, 'comment_delete', c.product_id),
  ]);
  return json({ ok: true });
});

route('POST', '/api/mentions/:id/ack', async ({ db, me, params }) => {
  requireMe(me);
  const m = await db.prepare('SELECT product_id FROM mentions WHERE id = ? AND member_id = ?').bind(intId(params.id), me.id).first();
  if (!m) throw new HttpError(404, '找不到這則提及');
  await db.batch([
    db.prepare('UPDATE mentions SET resolved_at = ? WHERE id = ?').bind(now(), intId(params.id)),
    log(db, me.id, 'mention_ack', m.product_id),
  ]);
  return json({ ok: true });
});

// ---------- 成效分析 ----------

route('GET', '/api/analysis', async ({ db, me, url, settings }) => {
  requireAdmin(me); // 成效分析先只給管理員看
  const days = Number(url.searchParams.get('days')) || 0;
  const d = await loadAll(db);
  const t = now();
  const cfg = cfgOf(settings);
  const since = days ? t - days * 86400000 : 0;
  return json({
    ranking: ranking({ stints: d.stints, now: t, cfg, since }),
    metrics: metrics({ products: d.all, stints: d.stints, now: t, cfg, settings, since }),
    names: Object.fromEntries(d.all.map((p) => [p.id, p.name])),
  });
});

route('GET', '/api/activity', async ({ db, me, url }) => {
  requireMe(me);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 150, 300);
  const { results } = await db.prepare(`SELECT a.id, a.member_id, a.action, a.product_id, a.detail, a.at, p.name AS product_name
    FROM activity a LEFT JOIN products p ON p.id = a.product_id
    WHERE a.action NOT IN ('member_bind') ORDER BY a.id DESC LIMIT ?`).bind(limit).all();
  return json(results);
});

// ---------- 刪除與回收區 ----------

route('DELETE', '/api/products/:id', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  await db.batch([
    db.prepare('UPDATE products SET deleted_at = ?, version = version + 1 WHERE id = ?').bind(now(), id),
    log(db, me.id, 'product_delete', id, p.name),
  ]);
  return json({ ok: true });
});

route('GET', '/api/trash', async ({ db, me }) => {
  requireAdmin(me);
  const [products, photos, comments] = await Promise.all([
    db.prepare('SELECT id, name, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100').all(),
    db.prepare(`SELECT ph.id, ph.product_id, ph.kind, ph.deleted_at, p.name AS product_name FROM photos ph JOIN products p ON p.id = ph.product_id
      WHERE ph.deleted_at IS NOT NULL ORDER BY ph.deleted_at DESC LIMIT 100`).all(),
    db.prepare(`SELECT c.id, c.product_id, c.body, c.deleted_at, p.name AS product_name FROM comments c JOIN products p ON p.id = c.product_id
      WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 100`).all(),
  ]);
  return json({ products: products.results, photos: photos.results, comments: comments.results });
});

const RESTORABLE = { product: 'products', photo: 'photos', comment: 'comments' };

route('POST', '/api/restore', async ({ db, request, me }) => {
  requireAdmin(me);
  const b = await body(request);
  const table = RESTORABLE[b.type];
  if (!table) throw new HttpError(400, '類型錯誤');
  const id = intId(b.id);
  const row = await db.prepare(`SELECT ${table === 'products' ? 'id AS product_id' : 'product_id'} FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, '找不到資料');
  await db.batch([
    db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).bind(id),
    log(db, me.id, `${b.type}_restore`, row.product_id),
  ]);
  return json({ ok: true });
});

// ---------- entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const r = routes.find((x) => x.method === request.method && x.re.test(url.pathname));
    if (!r) return json({ error: '找不到這個 API' }, 404);
    try {
      const db = env.DB;
      await ensureSchema(db);
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const [me, settings] = await Promise.all([currentMember(db, request), loadSettings(db)]);
      return await r.handler({ db, env, request, url, params, me, settings });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      return json({ error: '系統錯誤，請稍後再試' }, 500);
    }
  },
};
