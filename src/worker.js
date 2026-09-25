// TZG 商品上架跟進頁 — Cloudflare Worker API
// 資料：D1（DB）；照片：R2（PHOTOS）；前端：public/
import { localYmd, localToEpoch, dayHours, workHoursBetween } from './worktime.js';
import {
  computeStintHours, buildRadar, attributionFor, deadlineBreakdown, ranking, metrics, overviewRows,
  optimizerBudget, stintColor, isRushNow, optRemaining, STEP_LABEL, REASON_LABEL,
} from './analytics.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0, is_external INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    device_hash TEXT, bound_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_roles (member_id INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY (member_id, role))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, name TEXT NOT NULL,
    step TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    picker_id INTEGER, editor_id INTEGER, lister_id INTEGER, reviewer_id INTEGER,
    sl_name TEXT NOT NULL DEFAULT '', sl_body TEXT NOT NULL DEFAULT '', sl_price TEXT NOT NULL DEFAULT '', sl_url TEXT NOT NULL DEFAULT '',
    published_at INTEGER, undo_until INTEGER, undo_by INTEGER, opt_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, optimization_id INTEGER,
    kind TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    uploaded_by INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER,
    chk_accurate INTEGER NOT NULL DEFAULT 0, chk_clear INTEGER NOT NULL DEFAULT 0, chk_ratio INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS optimizations (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, kind TEXT NOT NULL,
    optimizer_id INTEGER NOT NULL, deadline INTEGER NOT NULL, assigned_by INTEGER, assigned_at INTEGER NOT NULL,
    status TEXT NOT NULL, rounds INTEGER NOT NULL DEFAULT 1, passed_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stints (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, optimization_id INTEGER,
    step TEXT NOT NULL, member_id INTEGER, role TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    budget_hours REAL, start_reason TEXT NOT NULL, end_reason TEXT, reasons TEXT, note TEXT, by_id INTEGER, end_note TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, member_id INTEGER,
    body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, action TEXT NOT NULL,
    product_id INTEGER, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_stints_product ON stints(product_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_stints_open ON stints(ended_at)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_product ON photos(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_product ON comments(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_member ON mentions(member_id, resolved_at)`,
];

export const ROLES = {
  picker: '選品', editor: '美編', lister: '上架人員', reviewer: '審查人', marketing: '老闆／行銷', external: '外包設計師',
};
const SEED_PREFIX = { picker: '選品', editor: '美編', lister: '上架', reviewer: '審查', marketing: '行銷', external: '外包' };
const COLORS = ['#1E4E8C', '#0E7C5A', '#6B3FA0', '#1B7F8C', '#B8741A', '#8C2F6B', '#4A6B1E', '#3D4F7A'];

const DEFAULT_SETTINGS = {
  work: { days: [1, 2, 3, 4, 5], start: 9, end: 18, holidays: [], tz: 480 },
  sla_days: { raw: 1, listing: 1, review: 1, opt_general: 3, opt_premium: 7, final_review: 1 },
  rush_threshold_days: 2,
  rush_review_hours: 2,
  capacity_ratio: 1.5,
};

const STEP_OWNER = { raw: 'picker_id', listing: 'lister_id', review: 'reviewer_id', final_review: 'reviewer_id' };
const STEP_ROLE = { raw: 'picker', listing: 'lister', review: 'reviewer', final_review: 'reviewer' };
const NO_STINT = ['assign', 'done']; // 待指定優化、已完成：沒有人拿著
const REASONS = ['photo', 'copy', 'price'];
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
  if (n === 0) await seedMembers(db);
  // 外包設計師統一用名字登入，不再用專屬連結
  await db.prepare('UPDATE members SET is_external = 0 WHERE is_external = 1').run();
  schemaReady = true;
}

// 預設成員：管理員 1 位 + 每種身分 3 位
async function seedMembers(db) {
  const t = Date.now();
  const stmts = [db.prepare('INSERT INTO members (name, color, is_admin, created_at) VALUES (?, ?, 1, ?)').bind('管理員', '#23283A', t)];
  let i = 0;
  for (const role of Object.keys(ROLES)) {
    for (let k = 1; k <= 3; k++) {
      const name = `${SEED_PREFIX[role]} ${k}`;
      stmts.push(db.prepare('INSERT INTO members (name, color, created_at) VALUES (?, ?, ?)')
        .bind(name, COLORS[i++ % COLORS.length], t));
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
  const dh = dayHours(s.work);
  s.sla_days = { ...DEFAULT_SETTINGS.sla_days, ...s.sla_days };
  s.rush_threshold_hours = s.rush_threshold_days * dh;
  s.final_review_hours = s.sla_days.final_review * dh;
  s.day_hours = dh;
  return s;
}

function budgetFor(step, settings) {
  return ['raw', 'listing', 'review', 'final_review'].includes(step) ? settings.sla_days[step] * settings.day_hours : null;
}

async function memberRoles(db, id) {
  const { results } = await db.prepare('SELECT role FROM member_roles WHERE member_id = ?').bind(id).all();
  return results.map((r) => r.role);
}

async function currentMember(db, request) {
  const token = cookie(request, 'dt');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const m = await db.prepare('SELECT id, name, color, is_admin, is_external FROM members WHERE device_hash = ? AND active = 1')
    .bind(await sha256(token)).first();
  if (!m) return null;
  m.roles = await memberRoles(db, m.id);
  return m;
}

const requireMe = (me) => { if (!me) throw new HttpError(401, '請先選擇你的名字登入'); return me; };
const requireAdmin = (me) => { requireMe(me); if (!me.is_admin) throw new HttpError(403, '只有管理員可以執行這個操作'); return me; };
const hasRole = (me, role) => me.roles.includes(role);
const requireRole = (me, role) => {
  requireMe(me);
  if (!hasRole(me, role) && !me.is_admin) throw new HttpError(403, `需要「${ROLES[role]}」身分`);
};
const requireInternal = (me) => { requireMe(me); if (me.is_external) throw new HttpError(403, '外包連結無法使用這個功能'); };

function log(db, memberId, action, productId = null, detail = '') {
  return db.prepare('INSERT INTO activity (member_id, action, product_id, detail, at) VALUES (?, ?, ?, ?, ?)')
    .bind(memberId, action, productId, detail, now());
}

async function getProduct(db, id) {
  const p = await db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!p) throw new HttpError(404, '找不到這個商品');
  return p;
}

async function openStint(db, productId) {
  return db.prepare('SELECT * FROM stints WHERE product_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(productId).first();
}

async function activeOptimization(db, productId) {
  return db.prepare("SELECT * FROM optimizations WHERE product_id = ? AND status != 'passed' ORDER BY id DESC LIMIT 1").bind(productId).first();
}

async function canView(db, me, productId) {
  if (!me.is_external) return true;
  const o = await db.prepare("SELECT id FROM optimizations WHERE product_id = ? AND optimizer_id = ? AND status != 'passed'")
    .bind(productId, me.id).first();
  return !!o;
}

async function requireView(db, me, productId) {
  requireMe(me);
  if (!(await canView(db, me, productId))) throw new HttpError(403, '你沒有這件商品的權限');
}

// 送出時比對狀態，已被別人改過就拒絕
async function checkVersion(db, p, version) {
  if (Number(version) === p.version) return;
  const last = await db.prepare(`SELECT a.action, a.at, m.name FROM activity a LEFT JOIN members m ON m.id = a.member_id
    WHERE a.product_id = ? ORDER BY a.id DESC LIMIT 1`).bind(p.id).first();
  const mins = last ? Math.max(1, Math.round((now() - last.at) / 60000)) : 0;
  const what = last ? (ACTION_TEXT[last.action] || last.action) : '更新';
  throw new HttpError(409, last ? `${last.name} ${mins} 分鐘前已${what}，畫面已更新` : '這件商品已被更新，畫面已更新');
}

const ACTION_TEXT = {
  product_add: '新增商品', raw_done: '完成原圖', listing_done: '完成上架', listing_save: '儲存上架資料',
  review_pass: '首次審查通過', review_return: '退回', opt_assign: '指定優化',
  opt_submit: '更新線上', final_pass: '最終審查通過', final_return: '退回優化', reassign: '改派', comment_add: '留言',
};

async function memberHasRole(db, memberId, role) {
  if (!memberId) return false;
  const r = await db.prepare(`SELECT 1 AS ok FROM member_roles mr JOIN members m ON m.id = mr.member_id
    WHERE mr.member_id = ? AND mr.role = ? AND m.active = 1`).bind(memberId, role).first();
  return !!r;
}

async function validOwner(db, v, role) {
  if (v === null || v === undefined || v === '') return null;
  const id = intId(v, '負責人');
  if (!(await memberHasRole(db, id, role))) throw new HttpError(400, `此人不是「${ROLES[role]}」`);
  return id;
}

// 換關：關閉目前停留、開啟下一段停留、更新商品狀態、寫紀錄
function transition(db, p, open, me, { endReason, endNote = null, next, updates = {}, action, detail = '' }) {
  const t = now();
  const stmts = [];
  if (open) {
    stmts.push(db.prepare('UPDATE stints SET ended_at = ?, end_reason = ?, end_note = COALESCE(?, end_note) WHERE id = ?')
      .bind(t, endReason, endNote, open.id));
  }
  if (next && !NO_STINT.includes(next.step)) {
    stmts.push(db.prepare(`INSERT INTO stints (product_id, optimization_id, step, member_id, role, started_at, budget_hours,
      start_reason, reasons, note, by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(p.id, next.optimization_id ?? null, next.step, next.member_id, next.role, t, next.budget ?? null,
        next.start_reason, next.reasons ? JSON.stringify(next.reasons) : null, next.note ?? null, me.id));
  }
  const cols = { ...updates, updated_at: t };
  if (next) cols.step = next.step;
  const keys = Object.keys(cols);
  stmts.push(db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ?`)
    .bind(...keys.map((k) => cols[k]), p.id));
  stmts.push(db.prepare('UPDATE mentions SET resolved_at = ? WHERE product_id = ? AND member_id = ? AND resolved_at IS NULL')
    .bind(t, p.id, me.id));
  stmts.push(log(db, me.id, action, p.id, detail));
  return stmts;
}

function nextFor(step, p, settings, extra = {}) {
  const member_id = p[STEP_OWNER[step]];
  if (!member_id) throw new HttpError(400, `這件商品還沒指定${ROLES[STEP_ROLE[step]]}，請找行銷或管理員指派`);
  return { step, member_id, role: STEP_ROLE[step], budget: budgetFor(step, settings), start_reason: 'advance', ...extra };
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
  const [members, roles, batches] = await Promise.all([
    db.prepare(`SELECT id, name, color, is_admin, is_external, active, bound_at,
      CASE WHEN device_hash IS NULL THEN 0 ELSE 1 END AS bound FROM members ORDER BY id`).all(),
    db.prepare('SELECT member_id, role FROM member_roles').all(),
    db.prepare('SELECT id, name, created_at FROM batches ORDER BY id DESC').all(),
  ]);
  const rolesBy = {};
  for (const r of roles.results) (rolesBy[r.member_id] ||= []).push(r.role);
  let list = members.results.map((m) => ({ ...m, roles: rolesBy[m.id] || [] }));
  if (!me) {
    // 未登入只給登入頁需要的：未綁定、非外包、啟用中的名字
    list = list.filter((m) => m.active && !m.bound).map(({ id, name, color, roles }) => ({ id, name, color, roles }));
    return json({ me: null, members: list });
  }
  const { rush_threshold_hours, day_hours, ...pub } = settings;
  return json({ me, members: list, batches: batches.results, settings: { ...pub, rush_threshold_hours, day_hours }, roles: ROLES, step_label: STEP_LABEL, now: now() });
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

// 外包設計師：獨立連結登入
route('POST', '/api/link-login', async ({ db, request }) => {
  const { token } = await body(request);
  const admin = await db.prepare('SELECT name FROM members WHERE is_admin = 1 AND active = 1 ORDER BY id LIMIT 1').first();
  const contact = admin?.name ?? '管理員';
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new HttpError(404, '連結已失效', { contact });
  const m = await db.prepare('SELECT id FROM members WHERE device_hash = ? AND is_external = 1 AND active = 1').bind(await sha256(token)).first();
  if (!m) throw new HttpError(404, '連結已失效', { contact });
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
  const res = await db.prepare('INSERT INTO members (name, color, created_at) VALUES (?, ?, ?)')
    .bind(name, COLORS[n % COLORS.length], now()).run();
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
  if (b.roles !== undefined) {
    stmts.push(...(await setRoles(db, id, b.roles)));
  }
  stmts.push(log(db, me.id, 'member_edit', null, name));
  await db.batch(stmts);
  return json({ ok: true });
});

route('POST', '/api/members/:id/reset', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const m = await db.prepare('SELECT name, is_external FROM members WHERE id = ?').bind(id).first();
  if (!m) throw new HttpError(404, '找不到這位成員');
  await db.batch([
    db.prepare('UPDATE members SET device_hash = NULL, bound_at = NULL WHERE id = ?').bind(id),
    log(db, me.id, m.is_external ? 'link_revoke' : 'member_reset', null, m.name),
  ]);
  return json({ ok: true });
});

route('POST', '/api/members/:id/link', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const m = await db.prepare('SELECT name, is_external FROM members WHERE id = ? AND active = 1').bind(id).first();
  if (!m?.is_external) throw new HttpError(400, '只有外包設計師可以產生連結');
  const token = newToken();
  await db.batch([
    db.prepare('UPDATE members SET device_hash = ?, bound_at = ? WHERE id = ?').bind(await sha256(token), now(), id),
    log(db, me.id, 'link_create', null, m.name),
  ]);
  return json({ token });
});

// ---------- 設定（管理員） ----------

route('PUT', '/api/settings', async ({ db, request, me }) => {
  requireAdmin(me);
  const b = await body(request);
  const w = b.work;
  const validDays = Array.isArray(w?.days) && w.days.length && w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!validDays || !(Number.isInteger(w.start) && Number.isInteger(w.end) && w.start >= 0 && w.end <= 24 && w.end > w.start)) {
    throw new HttpError(400, '上班時間設定錯誤');
  }
  const holidays = (w.holidays || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const sla = {};
  for (const k of Object.keys(DEFAULT_SETTINGS.sla_days)) {
    const v = Number(b.sla_days?.[k]);
    if (!(v > 0 && v <= 60)) throw new HttpError(400, 'SLA 天數需介於 0 到 60');
    sla[k] = v;
  }
  const rushDays = Number(b.rush_threshold_days);
  const rushReview = Number(b.rush_review_hours);
  const ratio = Number(b.capacity_ratio);
  if (!(rushDays > 0 && rushReview > 0 && ratio >= 1)) throw new HttpError(400, '急件或產能門檻設定錯誤');
  const values = {
    work: { days: w.days, start: w.start, end: w.end, holidays, tz: 480 },
    sla_days: sla, rush_threshold_days: rushDays, rush_review_hours: rushReview, capacity_ratio: ratio,
  };
  await db.batch([
    ...Object.entries(values).map(([k, v]) =>
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify(v))),
    log(db, me.id, 'settings_edit'),
  ]);
  return json({ ok: true });
});

// ---------- 批次 ----------

route('PATCH', '/api/batches/:id', async ({ db, request, me, params }) => {
  requireInternal(me);
  if (!me.is_admin && !hasRole(me, 'marketing') && !hasRole(me, 'picker')) throw new HttpError(403, '沒有權限');
  const name = text((await body(request)).name, '批次名稱', 40);
  await db.batch([
    db.prepare('UPDATE batches SET name = ? WHERE id = ?').bind(name, intId(params.id)),
    log(db, me.id, 'batch_edit', null, name),
  ]);
  return json({ ok: true });
});

// ---------- 全部資料載入（雷達／看板／分析共用） ----------

async function loadAll(db) {
  const [products, stints, opts, mentions, comments, roles] = await Promise.all([
    db.prepare('SELECT * FROM products WHERE deleted_at IS NULL').all(),
    db.prepare('SELECT s.* FROM stints s JOIN products p ON p.id = s.product_id WHERE p.deleted_at IS NULL').all(),
    db.prepare('SELECT o.* FROM optimizations o JOIN products p ON p.id = o.product_id WHERE p.deleted_at IS NULL').all(),
    db.prepare('SELECT * FROM mentions WHERE resolved_at IS NULL').all(),
    db.prepare('SELECT product_id, member_id, created_at FROM comments WHERE deleted_at IS NULL').all(),
    db.prepare('SELECT mr.member_id, mr.role FROM member_roles mr JOIN members m ON m.id = mr.member_id WHERE m.active = 1').all(),
  ]);
  const roleMembers = {};
  for (const r of roles.results) (roleMembers[r.role] ||= []).push(r.member_id);
  return {
    products: products.results, stints: stints.results, optimizations: opts.results, mentions: mentions.results,
    comments: comments.results, roleMembers,
  };
}

function cfgOf(settings) { return settings.work; }

route('GET', '/api/radar', async ({ db, me, url, settings }) => {
  requireMe(me);
  const scope = url.searchParams.get('scope') === 'all' && !me.is_external ? 'all' : 'me';
  const d = await loadAll(db);
  const t = now();
  const hoursMap = computeStintHours(d.stints, d.optimizations, t, cfgOf(settings));
  const r = buildRadar({ ...d, me: me.id, meRoles: me.roles, scope, now: t, cfg: cfgOf(settings), settings, hoursMap });
  if (scope === 'all') {
    r.items = r.items.filter((i) => i.group !== 'mine');
    r.upcoming = [];
  }
  return json(r);
});

route('GET', '/api/products', async ({ db, me, settings }) => {
  requireMe(me);
  const d = await loadAll(db);
  const t = now();
  const cfg = cfgOf(settings);
  const hoursMap = computeStintHours(d.stints, d.optimizations, t, cfg);
  const openBy = new Map(d.stints.filter((s) => s.ended_at == null).map((s) => [s.product_id, s]));
  const optBy = new Map(d.optimizations.filter((o) => o.status !== 'passed').map((o) => [o.product_id, o]));
  let list = d.products.map((p) => {
    const s = openBy.get(p.id);
    const opt = optBy.get(p.id) || null;
    const h = s ? hoursMap.get(s.id) : null;
    return {
      id: p.id, name: p.name, batch_id: p.batch_id, step: p.step, version: p.version, updated_at: p.updated_at,
      holder_id: s?.member_id ?? null, color: s ? stintColor(s, h, opt, t, cfg, settings) : 'ok',
      held_h: h ? Math.round((h.visit_held ?? h.held) * 10) / 10 : null,
      deadline: opt?.deadline ?? null, rush: !!(opt && isRushNow(opt, t, cfg, settings)),
      remaining_h: opt ? Math.round(optRemaining(opt, t, cfg) * 10) / 10 : null, opt_version: p.opt_version,
      returned: s?.start_reason === 'return',
    };
  });
  if (me.is_external) {
    const mine = new Set(d.optimizations.filter((o) => o.optimizer_id === me.id && o.status !== 'passed').map((o) => o.product_id));
    list = list.filter((p) => mine.has(p.id));
  }
  return json(list);
});

route('POST', '/api/products', async ({ db, request, me, settings }) => {
  requireRole(me, 'picker');
  requireInternal(me);
  const b = await body(request);
  const name = text(b.name, '商品名稱', 100);
  let batchId;
  if (b.batch_name) {
    const bn = text(b.batch_name, '批次名稱', 40);
    const ex = await db.prepare('SELECT id FROM batches WHERE name = ?').bind(bn).first();
    batchId = ex ? ex.id : (await db.prepare('INSERT INTO batches (name, created_at) VALUES (?, ?)').bind(bn, now()).run()).meta.last_row_id;
  } else {
    batchId = intId(b.batch_id, '批次');
    if (!(await db.prepare('SELECT id FROM batches WHERE id = ?').bind(batchId).first())) throw new HttpError(400, '批次不存在');
  }
  const owners = {};
  for (const [field, role, label] of [['lister_id', 'lister', '上架人員'], ['reviewer_id', 'reviewer', '審查人']]) {
    owners[field] = await validOwner(db, b[field], role);
    if (!owners[field]) {
      // 只有一個人時自動帶入
      const { results } = await db.prepare(`SELECT mr.member_id FROM member_roles mr JOIN members m ON m.id = mr.member_id
        WHERE mr.role = ? AND m.active = 1`).bind(role).all();
      if (results.length === 1) owners[field] = results[0].member_id;
      else throw new HttpError(400, `請指定${label}`);
    }
  }
  const t = now();
  const res = await db.prepare(`INSERT INTO products (batch_id, name, step, picker_id, lister_id, reviewer_id, created_at, updated_at)
    VALUES (?, ?, 'raw', ?, ?, ?, ?, ?)`).bind(batchId, name, me.id, owners.lister_id, owners.reviewer_id, t, t).run();
  const id = res.meta.last_row_id;
  await db.batch([
    db.prepare(`INSERT INTO stints (product_id, step, member_id, role, started_at, budget_hours, start_reason, by_id)
      VALUES (?, 'raw', ?, 'picker', ?, ?, 'create', ?)`).bind(id, me.id, t, budgetFor('raw', settings), me.id),
    log(db, me.id, 'product_add', id, name),
  ]);
  return json({ id });
});

route('GET', '/api/products/:id', async ({ db, me, params, settings }) => {
  const id = intId(params.id);
  await requireView(db, me, id);
  const p = await getProduct(db, id);
  const t = now();
  const cfg = cfgOf(settings);
  const [photos, comments, stints, opts, mentions, batch] = await Promise.all([
    db.prepare('SELECT id, optimization_id, kind, filename, uploaded_by, created_at, chk_accurate, chk_clear, chk_ratio FROM photos WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT id, member_id, body, created_at FROM comments WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT * FROM stints WHERE product_id = ? ORDER BY started_at, id').bind(id).all(),
    db.prepare('SELECT * FROM optimizations WHERE product_id = ? ORDER BY id').bind(id).all(),
    db.prepare('SELECT id, member_id, comment_id FROM mentions WHERE product_id = ? AND resolved_at IS NULL').bind(id).all(),
    db.prepare('SELECT name FROM batches WHERE id = ?').bind(p.batch_id).first(),
  ]);
  const hoursMap = computeStintHours(stints.results, opts.results, t, cfg);
  const open = stints.results.find((s) => s.ended_at == null) || null;
  const activeOpt = opts.results.find((o) => o.status !== 'passed') || null;
  const lastOpt = opts.results[opts.results.length - 1] || null;
  return json({
    ...p,
    batch_name: batch?.name ?? '',
    photos: photos.results,
    comments: comments.results,
    my_mentions: mentions.results.filter((m) => m.member_id === me.id),
    stints: stints.results.map((s) => ({ ...s, reasons: s.reasons ? JSON.parse(s.reasons) : null, held: hoursMap.get(s.id)?.held ?? 0, over: hoursMap.get(s.id)?.over ?? 0 })),
    optimizations: opts.results,
    active_opt: activeOpt ? { ...activeOpt, rush: isRushNow(activeOpt, t, cfg, settings), remaining_h: Math.round(optRemaining(activeOpt, t, cfg) * 10) / 10 } : null,
    open: open ? { ...open, color: stintColor(open, hoursMap.get(open.id), activeOpt, t, cfg, settings), visit_held: hoursMap.get(open.id)?.visit_held ?? 0 } : null,
    attribution: attributionFor(id, stints.results, hoursMap),
    breakdown: lastOpt ? deadlineBreakdown(lastOpt, stints.results, hoursMap, t) : null,
    now: t,
  });
});

// ---------- 流程動作 ----------

route('POST', '/api/products/:id/action', async ({ db, request, me, params, settings }) => {
  requireMe(me);
  const id = intId(params.id);
  await requireView(db, me, id);
  const p = await getProduct(db, id);
  const b = await body(request);
  await checkVersion(db, p, b.version);
  const open = await openStint(db, id);
  const mustHold = (step) => {
    if (p.step !== step || !open || open.step !== step) throw new HttpError(409, '這件商品已不在這一步，畫面已更新');
    if (open.member_id !== me.id) throw new HttpError(403, '只有這一步的負責人可以操作');
  };
  const photosOf = async (kinds, optId = null) => (await db.prepare(
    `SELECT * FROM photos WHERE product_id = ? AND deleted_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')})
     ${optId ? 'AND optimization_id = ?' : ''}`).bind(id, ...kinds, ...(optId ? [optId] : [])).all()).results;
  let stmts;

  switch (b.action) {
    case 'complete_raw': {
      mustHold('raw');
      const raws = await photosOf(['raw']);
      if (!raws.length) throw new HttpError(400, '請至少上傳 1 張原圖');
      if (raws.some((r) => !(r.chk_accurate && r.chk_clear && r.chk_ratio))) throw new HttpError(400, '每張原圖都要勾滿三項');
      stmts = transition(db, p, open, me, { endReason: 'complete', next: nextFor('listing', p, settings), action: 'raw_done' });
      break;
    }
    case 'save_listing':
    case 'complete_listing': {
      mustHold('listing');
      const f = {
        sl_name: String(b.sl_name ?? '').trim().slice(0, 200),
        sl_body: String(b.sl_body ?? '').trim().slice(0, 10000),
        sl_price: String(b.sl_price ?? '').trim(),
        sl_url: String(b.sl_url ?? '').trim().slice(0, 500),
      };
      if (f.sl_price && !/^\d+(\.\d{1,2})?$/.test(f.sl_price)) throw new HttpError(400, '價格只能填數字');
      if (b.action === 'save_listing') {
        await db.batch([
          db.prepare('UPDATE products SET sl_name = ?, sl_body = ?, sl_price = ?, sl_url = ?, updated_at = ? WHERE id = ?')
            .bind(f.sl_name, f.sl_body, f.sl_price, f.sl_url, now(), id),
          log(db, me.id, 'listing_save', id),
        ]);
        return json({ ok: true });
      }
      const missing = [['sl_name', '名稱'], ['sl_body', '文案'], ['sl_price', '價格'], ['sl_url', 'Shopline 網址']].filter(([k]) => !f[k]).map(([, l]) => l);
      if (missing.length) throw new HttpError(400, `請填寫：${missing.join('、')}`);
      if (!/^https?:\/\//.test(f.sl_url)) throw new HttpError(400, 'Shopline 網址需以 http 開頭');
      stmts = transition(db, p, open, me, {
        endReason: 'complete', next: nextFor('review', p, settings),
        updates: { ...f, published_at: p.published_at ?? now() }, action: 'listing_done',
      });
      break;
    }
    case 'review_pass': {
      mustHold('review');
      if (!(b.checks?.copy && b.checks?.price && b.checks?.photo)) throw new HttpError(400, '文案、價格、照片三項都要勾');
      stmts = transition(db, p, open, me, { endReason: 'pass', next: { step: 'assign' }, action: 'review_pass' });
      break;
    }
    case 'review_return': {
      mustHold('review');
      const reasons = [...new Set((b.reasons || []).filter((r) => REASONS.includes(r)))];
      const note = String(b.note ?? '').trim();
      if (!reasons.length) throw new HttpError(400, '請選擇退回原因');
      if (!note) throw new HttpError(400, '請寫要改什麼');
      // 照片 → 原圖（選品）；文案／價格 → 上架；多選退到最前面那關
      const target = reasons.includes('photo') ? 'raw' : 'listing';
      stmts = transition(db, p, open, me, {
        endReason: 'return', next: nextFor(target, p, settings, { start_reason: 'return', reasons, note }),
        action: 'review_return', detail: `${reasons.map((r) => REASON_LABEL[r]).join('、')}：${note.slice(0, 60)}`,
      });
      break;
    }
    case 'submit_opt': {
      mustHold('optimizing');
      const note = String(b.note ?? '').trim();
      if (!note) throw new HttpError(400, '請填寫改了什麼');
      const opt = await activeOptimization(db, id);
      const rush = isRushNow(opt, now(), cfgOf(settings), settings);
      stmts = transition(db, p, open, me, {
        endReason: 'submit', endNote: note,
        next: { ...nextFor('final_review', p, settings), budget: rush ? settings.rush_review_hours : settings.final_review_hours, start_reason: 'submit', optimization_id: opt.id },
        action: 'opt_submit', detail: note.slice(0, 80),
      });
      stmts.push(db.prepare("UPDATE optimizations SET status = 'review' WHERE id = ?").bind(opt.id));
      break;
    }
    case 'final_pass': {
      mustHold('final_review');
      if (!(b.checks?.copy && b.checks?.price && b.checks?.photo)) throw new HttpError(400, '文案、價格、照片三項都要勾');
      const opt = await activeOptimization(db, id);
      stmts = transition(db, p, open, me, {
        endReason: 'pass', next: { step: 'done' }, updates: { opt_version: p.opt_version + 1 }, action: 'final_pass',
        detail: `第 ${p.opt_version + 1} 版`,
      });
      stmts.push(db.prepare("UPDATE optimizations SET status = 'passed', passed_at = ? WHERE id = ?").bind(now(), opt.id));
      break;
    }
    case 'final_return': {
      mustHold('final_review');
      const reasons = [...new Set((b.reasons || []).filter((r) => REASONS.includes(r)))];
      const note = String(b.note ?? '').trim();
      if (!reasons.length) throw new HttpError(400, '請選擇退回原因');
      if (!note) throw new HttpError(400, '請寫要改什麼');
      const opt = await activeOptimization(db, id);
      const firstOpt = await db.prepare("SELECT budget_hours FROM stints WHERE optimization_id = ? AND step = 'optimizing' ORDER BY id LIMIT 1").bind(opt.id).first();
      stmts = transition(db, p, open, me, {
        endReason: 'return',
        next: { step: 'optimizing', member_id: opt.optimizer_id, role: opt.kind === 'premium' ? 'external' : 'editor', budget: firstOpt?.budget_hours ?? null, start_reason: 'return', reasons, note, optimization_id: opt.id },
        action: 'final_return', detail: `${reasons.map((r) => REASON_LABEL[r]).join('、')}：${note.slice(0, 60)}`,
      });
      stmts.push(db.prepare("UPDATE optimizations SET status = 'working', rounds = rounds + 1 WHERE id = ?").bind(opt.id));
      break;
    }
    default:
      throw new HttpError(400, '未知的動作');
  }
  await db.batch(stmts);
  return json({ ok: true });
});

// 指定優化（可一次多件）：截止時間只能選明天起的 15:00 或 17:00
route('POST', '/api/optimizations', async ({ db, request, me, settings }) => {
  requireRole(me, 'marketing');
  requireInternal(me);
  const b = await body(request);
  const cfg = cfgOf(settings);
  const kind = b.kind === 'premium' ? 'premium' : b.kind === 'general' ? 'general' : null;
  if (!kind) throw new HttpError(400, '請選擇一般或精製');
  const hour = Number(b.hour);
  if (hour !== 15 && hour !== 17) throw new HttpError(400, '請選擇 15:00 或 17:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw new HttpError(400, '請選擇截止日期');
  if (b.date <= localYmd(now(), cfg)) throw new HttpError(400, '截止日期最早只能選明天');
  const deadline = localToEpoch(b.date, hour, cfg);
  const role = kind === 'premium' ? 'external' : 'editor';
  const optimizerId = intId(b.optimizer_id, '優化者');
  if (!(await memberHasRole(db, optimizerId, role))) throw new HttpError(400, `${kind === 'premium' ? '精製' : '一般'}優化要選${ROLES[role]}`);
  const ids = [...new Set((b.product_ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new HttpError(400, '請勾選商品');
  const t = now();
  const skipped = [];
  let done = 0;
  for (const pid of ids) {
    const p = await db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').bind(pid).first();
    if (!p || !['assign', 'done'].includes(p.step)) { skipped.push(p?.name ?? `#${pid}`); continue; }
    const res = await db.prepare(`INSERT INTO optimizations (product_id, kind, optimizer_id, deadline, assigned_by, assigned_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'working')`).bind(pid, kind, optimizerId, deadline, me.id, t).run();
    await db.batch(transition(db, p, null, me, {
      next: { step: 'optimizing', member_id: optimizerId, role, budget: optimizerBudget(t, deadline, cfg, settings), start_reason: 'assign', optimization_id: res.meta.last_row_id },
      action: 'opt_assign', detail: `${kind === 'premium' ? '精製' : '一般'}・截止 ${b.date} ${hour}:00`,
    }));
    done++;
  }
  const slaHours = settings.sla_days[kind === 'premium' ? 'opt_premium' : 'opt_general'] * settings.day_hours;
  const windowH = workHoursBetween(t, deadline, cfg);
  return json({ ok: true, done, skipped, short: windowH < slaHours, window_h: Math.round(windowH * 10) / 10, sla_h: slaHours });
});

// 指定優化前的期限檢查（給前端即時提示，計算留在後端）
route('GET', '/api/deadline-check', async ({ me, url, settings }) => {
  requireInternal(me);
  const cfg = cfgOf(settings);
  const date = url.searchParams.get('date');
  const hour = Number(url.searchParams.get('hour'));
  const kind = url.searchParams.get('kind') === 'premium' ? 'premium' : 'general';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || (hour !== 15 && hour !== 17)) return json({ valid: false });
  const deadline = localToEpoch(date, hour, cfg);
  const t = now();
  const dow = new Date(deadline + cfg.tz * 60000).getUTCDay();
  const windowH = workHoursBetween(t, deadline, cfg);
  const slaH = settings.sla_days[kind === 'premium' ? 'opt_premium' : 'opt_general'] * settings.day_hours;
  return json({
    valid: date > localYmd(t, cfg),
    workday: cfg.days.includes(dow) && !(cfg.holidays || []).includes(date),
    window_h: Math.round(windowH * 10) / 10,
    optimizer_h: Math.round(Math.max(0, windowH - settings.rush_review_hours) * 10) / 10,
    sla_h: slaH,
    rush_now: windowH <= settings.rush_threshold_hours,
  });
});

// 改派負責人（老闆／行銷、管理員）
route('PATCH', '/api/products/:id/owners', async ({ db, request, me, params }) => {
  requireMe(me);
  requireInternal(me);
  if (!me.is_admin && !hasRole(me, 'marketing')) throw new HttpError(403, '只有老闆／行銷或管理員可以改派');
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const b = await body(request);
  await checkVersion(db, p, b.version);
  const updates = {};
  for (const [field, role] of [['picker_id', 'picker'], ['lister_id', 'lister'], ['reviewer_id', 'reviewer']]) {
    if (b[field] !== undefined) updates[field] = await validOwner(db, b[field], role);
  }
  const open = await openStint(db, id);
  const opt = await activeOptimization(db, id);
  const stmts = [];
  let newHolder = null;
  if (open && STEP_OWNER[open.step] && updates[STEP_OWNER[open.step]] !== undefined && updates[STEP_OWNER[open.step]] !== open.member_id) {
    newHolder = updates[STEP_OWNER[open.step]];
    if (!newHolder) throw new HttpError(400, '目前這一步的負責人不能留空');
  }
  if (b.optimizer_id !== undefined && opt) {
    const role = opt.kind === 'premium' ? 'external' : 'editor';
    const oid = await validOwner(db, b.optimizer_id, role);
    if (!oid) throw new HttpError(400, '優化者不能留空');
    stmts.push(db.prepare('UPDATE optimizations SET optimizer_id = ? WHERE id = ?').bind(oid, opt.id));
    if (open?.step === 'optimizing' && oid !== open.member_id) newHolder = oid;
  }
  const t = now();
  if (newHolder) {
    stmts.push(db.prepare("UPDATE stints SET ended_at = ?, end_reason = 'reassign' WHERE id = ?").bind(t, open.id));
    stmts.push(db.prepare(`INSERT INTO stints (product_id, optimization_id, step, member_id, role, started_at, budget_hours, start_reason, by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reassign', ?)`).bind(id, open.optimization_id, open.step, newHolder, open.role, t, open.budget_hours, me.id));
  }
  const keys = Object.keys(updates);
  stmts.push(db.prepare(`UPDATE products SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')}, version = version + 1 WHERE id = ?`)
    .bind(...keys.map((k) => updates[k]), t, id));
  stmts.push(log(db, me.id, 'reassign', id));
  await db.batch(stmts);
  return json({ ok: true });
});

// ---------- 照片 ----------

const PHOTO_STEP = { raw: 'raw', opt: 'optimizing' };

route('POST', '/api/products/:id/photos', async ({ db, env, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  await requireView(db, me, id);
  const p = await getProduct(db, id);
  const form = await request.formData();
  const kind = String(form.get('kind'));
  if (!PHOTO_STEP[kind]) throw new HttpError(400, '照片類型錯誤');
  const open = await openStint(db, id);
  if (!open || open.step !== PHOTO_STEP[kind] || open.member_id !== me.id) throw new HttpError(403, '只有這一步的負責人可以上傳');
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
    stmts.push(db.prepare('INSERT INTO photos (product_id, optimization_id, kind, r2_key, filename, content_type, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, kind === 'opt' ? open.optimization_id : null, kind, key, String(f.name).slice(0, 120), f.type, me.id, t));
  }
  stmts.push(db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(t, p.id));
  stmts.push(log(db, me.id, 'photo_add', id, `${files.length} 張`));
  await db.batch(stmts);
  return json({ ok: true, count: files.length });
});

route('GET', '/api/photos/:id', async ({ db, env, params, me, url }) => {
  requireMe(me);
  const ph = await db.prepare('SELECT product_id, r2_key, content_type, filename FROM photos WHERE id = ?').bind(intId(params.id)).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  await requireView(db, me, ph.product_id);
  const obj = await env.PHOTOS.get(ph.r2_key);
  if (!obj) throw new HttpError(404, '照片檔案遺失');
  const headers = { 'content-type': ph.content_type, 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag };
  if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(ph.filename || 'photo.jpg')}`;
  return new Response(obj.body, { headers });
});

route('PATCH', '/api/photos/:id', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const ph = await db.prepare("SELECT product_id FROM photos WHERE id = ? AND kind = 'raw' AND deleted_at IS NULL").bind(id).first();
  if (!ph) throw new HttpError(404, '找不到原圖');
  const open = await openStint(db, ph.product_id);
  if (!open || open.step !== 'raw' || open.member_id !== me.id) throw new HttpError(403, '只有選品負責人可以勾選');
  const b = await body(request);
  await db.prepare('UPDATE photos SET chk_accurate = ?, chk_clear = ?, chk_ratio = ? WHERE id = ?')
    .bind(b.chk_accurate ? 1 : 0, b.chk_clear ? 1 : 0, b.chk_ratio ? 1 : 0, id).run();
  return json({ ok: true });
});

route('DELETE', '/api/photos/:id', async ({ db, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const ph = await db.prepare('SELECT product_id, kind, uploaded_by FROM photos WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  const open = await openStint(db, ph.product_id);
  const ownStep = open && open.step === PHOTO_STEP[ph.kind] && open.member_id === me.id;
  if (!ownStep && !me.is_admin) throw new HttpError(403, '只有這一步的負責人或管理員可以刪除');
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
  await requireView(db, me, id);
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

// ---------- 全覽（首頁） ----------

route('GET', '/api/overview', async ({ db, me, url, settings }) => {
  requireInternal(me);
  const d = await loadAll(db);
  const t = now();
  const cfg = cfgOf(settings);
  const hoursMap = computeStintHours(d.stints, d.optimizations, t, cfg);
  const { results: batches } = await db.prepare('SELECT id, name, created_at FROM batches ORDER BY id DESC').all();
  const counts = {};
  for (const p of d.products) {
    const c = (counts[p.batch_id] ||= { total: 0, done: 0 });
    c.total++;
    if (p.step === 'done') c.done++;
  }
  const batchList = batches.filter((b) => counts[b.id]).map((b) => ({ ...b, ...counts[b.id] }));
  const want = Number(url.searchParams.get('batch'));
  const batchId = want === 0 && url.searchParams.has('batch') ? 0 : (batchList.find((b) => b.id === want)?.id ?? batchList.find((b) => b.done < b.total)?.id ?? batchList[0]?.id ?? 0);
  const products = batchId ? d.products.filter((p) => p.batch_id === batchId) : d.products;
  const rows = overviewRows({ products, stints: d.stints, optimizations: d.optimizations, hoursMap, now: t, cfg, settings });
  return json({ batches: batchList, batch_id: batchId, rows, now: t });
});

// ---------- 延誤分析 ----------

route('GET', '/api/analysis', async ({ db, me, url, settings }) => {
  requireInternal(me);
  const scope = ['rush', 'normal'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'all';
  const days = Number(url.searchParams.get('days')) || 0;
  const batch = Number(url.searchParams.get('batch')) || 0;
  const d = await loadAll(db);
  const t = now();
  const cfg = cfgOf(settings);
  const hoursMap = computeStintHours(d.stints, d.optimizations, t, cfg);
  const batchOf = new Map(d.products.map((p) => [p.id, p.batch_id]));
  const since = days ? t - days * 86400000 : 0;
  const filter = (s) => (s.ended_at == null || s.ended_at >= since) && (!batch || batchOf.get(s.product_id) === batch);
  filter.scope = scope;
  const optFiltered = d.optimizations.filter((o) => (!batch || batchOf.get(o.product_id) === batch) && (o.passed_at == null || o.passed_at >= since));
  return json({
    ranking: ranking({ stints: d.stints, optimizations: d.optimizations, hoursMap, roleMembers: d.roleMembers, settings, now: t, cfg, filter }),
    metrics: metrics({ stints: d.stints, optimizations: optFiltered, comments: d.comments, hoursMap, now: t, cfg, filter }),
  });
});

route('GET', '/api/activity', async ({ db, me, url }) => {
  requireInternal(me);
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
