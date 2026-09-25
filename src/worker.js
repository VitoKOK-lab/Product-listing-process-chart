// 商品上架流程協作 — Cloudflare Worker API
// 資料：D1（binding DB）；照片：R2（binding PHOTOS）；前端：public/ 靜態檔

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    device_hash TEXT,
    bound_at TEXT,
    created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    stage_id INTEGER NOT NULL,
    owner_id INTEGER,
    stage_entered_at TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS product_platforms (
    product_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, platform_id))`,
  `CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    uploaded_by INTEGER,
    created_at TEXT NOT NULL,
    deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    member_id INTEGER,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    from_stage_id INTEGER,
    to_stage_id INTEGER NOT NULL,
    member_id INTEGER,
    at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    action TEXT NOT NULL,
    product_id INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_product ON photos(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_product ON comments(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_history_product ON stage_history(product_id, at)`,
];

const DEFAULT_STAGES = ['選品/進貨', '拍攝/修圖', '文案/規格', '定價', '審核', '上架'];
const DEFAULT_PLATFORMS = ['官網'];
const MEMBER_COLORS = ['#1E4E8C', '#0E7C5A', '#3D4F7A', '#6B3FA0', '#B8741A', '#1B7F8C', '#8C2F6B', '#4A6B1E'];
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const { n: stageCount } = await db.prepare('SELECT COUNT(*) AS n FROM stages').first();
  if (stageCount === 0) {
    await db.batch(DEFAULT_STAGES.map((name, i) =>
      db.prepare('INSERT INTO stages (name, position) VALUES (?, ?)').bind(name, i)));
  }
  const { n: platformCount } = await db.prepare('SELECT COUNT(*) AS n FROM platforms').first();
  if (platformCount === 0) {
    await db.batch(DEFAULT_PLATFORMS.map((name) =>
      db.prepare('INSERT INTO platforms (name) VALUES (?)').bind(name)));
  }
  schemaReady = true;
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, '資料格式錯誤'); }
}

function text(v, field, max = 200) {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `${field}不可空白`);
  if (s.length > max) throw new HttpError(400, `${field}超過 ${max} 字`);
  return s;
}

function optText(v, max = 2000) {
  return String(v ?? '').trim().slice(0, max);
}

function intId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'ID 錯誤');
  return n;
}

function cookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// 裝置綁定：名字第一次被選定時產生隨機 token 存在該裝置 cookie，資料庫只存 hash
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const deviceCookie = (token) => `dt=${token}; Path=/; Max-Age=315360000; SameSite=Lax; HttpOnly; Secure`;

async function currentMember(db, request) {
  const token = cookie(request, 'dt');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return db.prepare('SELECT id, name, is_admin, color FROM members WHERE device_hash = ? AND active = 1')
    .bind(await sha256(token)).first();
}

function requireMe(me) {
  if (!me) throw new HttpError(401, '請先選擇你的名字登入');
  return me;
}

function requireAdmin(me) {
  requireMe(me);
  if (!me.is_admin) throw new HttpError(403, '只有管理者可以執行這個操作');
  return me;
}

function log(db, memberId, action, productId = null, detail = '') {
  return db.prepare('INSERT INTO activity (member_id, action, product_id, detail, at) VALUES (?, ?, ?, ?, ?)')
    .bind(memberId, action, productId, detail, now());
}

async function getProduct(db, id) {
  const p = await db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!p) throw new HttpError(404, '找不到這個商品');
  return p;
}

async function validPlatformIds(db, ids) {
  if (!Array.isArray(ids)) return [];
  const { results } = await db.prepare('SELECT id FROM platforms').all();
  const valid = new Set(results.map((r) => r.id));
  return [...new Set(ids.map(Number))].filter((id) => valid.has(id));
}

async function validOwnerId(db, v) {
  if (v === null || v === undefined || v === '') return null;
  const id = intId(v);
  const m = await db.prepare('SELECT id FROM members WHERE id = ? AND active = 1').bind(id).first();
  if (!m) throw new HttpError(400, '負責人不存在');
  return id;
}

// ---------- route table ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// 版本號：前端每 10 秒輪詢，有變動才重新載入
route('GET', '/api/version', async ({ db }) => {
  const row = await db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM activity').first();
  return json({ v: row.v });
});

route('GET', '/api/bootstrap', async ({ db, me }) => {
  const [members, stages, platforms] = await Promise.all([
    db.prepare(`SELECT id, name, is_admin, color, active, bound_at,
      CASE WHEN device_hash IS NULL THEN 0 ELSE 1 END AS bound FROM members ORDER BY active DESC, id`).all(),
    db.prepare('SELECT id, name, position FROM stages ORDER BY position, id').all(),
    db.prepare('SELECT id, name FROM platforms ORDER BY id').all(),
  ]);
  return json({ me, members: members.results, stages: stages.results, platforms: platforms.results });
});

// 第一次選名字：綁定這台裝置。已綁定的名字不能再被選。
route('POST', '/api/claim', async ({ db, request, me }) => {
  if (me) throw new HttpError(400, `這台裝置已綁定「${me.name}」`);
  const { member_id } = await body(request);
  const id = intId(member_id);
  const token = newToken();
  const t = now();
  const res = await db.prepare('UPDATE members SET device_hash = ?, bound_at = ? WHERE id = ? AND active = 1 AND device_hash IS NULL')
    .bind(await sha256(token), t, id).run();
  if (!res.meta.changes) throw new HttpError(409, '這個名字已被其他裝置綁定，請找管理者重設');
  await log(db, id, 'member_bind').run();
  return json({ ok: true }, 200, { 'set-cookie': deviceCookie(token) });
});

// ---------- members ----------

route('POST', '/api/members', async ({ db, request, me }) => {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
  const first = n === 0;
  if (!first) requireAdmin(me);
  const b = await body(request);
  const name = text(b.name, '名字', 30);
  const dup = await db.prepare('SELECT id FROM members WHERE name = ?').bind(name).first();
  if (dup) throw new HttpError(409, '這個名字已經存在');
  const color = MEMBER_COLORS[n % MEMBER_COLORS.length];
  // 第一位成員（管理者）建立時直接綁定目前這台裝置
  const token = first ? newToken() : null;
  const t = now();
  const res = await db.prepare('INSERT INTO members (name, is_admin, color, device_hash, bound_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(name, first ? 1 : 0, color, token ? await sha256(token) : null, token ? t : null, t).run();
  const id = res.meta.last_row_id;
  await log(db, me?.id ?? id, 'member_add', null, name).run();
  return json({ id }, 200, token ? { 'set-cookie': deviceCookie(token) } : {});
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
    if (n <= 1) throw new HttpError(400, '至少要保留一位管理者');
  }
  if (name !== m.name) {
    const dup = await db.prepare('SELECT id FROM members WHERE name = ? AND id != ?').bind(name, id).first();
    if (dup) throw new HttpError(409, '這個名字已經存在');
  }
  await db.batch([
    db.prepare('UPDATE members SET name = ?, is_admin = ?, active = ? WHERE id = ?').bind(name, isAdmin, active, id),
    log(db, me.id, 'member_edit', null, name),
  ]);
  return json({ ok: true });
});

// 管理者重設：解除綁定，名字重新出現在登入名單，原裝置失去登入
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

// ---------- stages ----------

route('POST', '/api/stages', async ({ db, request, me }) => {
  requireAdmin(me);
  const name = text((await body(request)).name, '階段名稱', 20);
  const { p } = await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stages').first();
  await db.batch([
    db.prepare('INSERT INTO stages (name, position) VALUES (?, ?)').bind(name, p),
    log(db, me.id, 'stage_add', null, name),
  ]);
  return json({ ok: true });
});

route('PATCH', '/api/stages/:id', async ({ db, request, me, params }) => {
  requireAdmin(me);
  const name = text((await body(request)).name, '階段名稱', 20);
  await db.batch([
    db.prepare('UPDATE stages SET name = ? WHERE id = ?').bind(name, intId(params.id)),
    log(db, me.id, 'stage_edit', null, name),
  ]);
  return json({ ok: true });
});

route('PUT', '/api/stages/order', async ({ db, request, me }) => {
  requireAdmin(me);
  const { ids } = await body(request);
  if (!Array.isArray(ids)) throw new HttpError(400, '順序資料錯誤');
  const { results } = await db.prepare('SELECT id FROM stages').all();
  const existing = new Set(results.map((r) => r.id));
  const clean = ids.map(Number);
  if (clean.length !== existing.size || !clean.every((id) => existing.has(id))) {
    throw new HttpError(400, '順序資料與現有階段不一致');
  }
  await db.batch([
    ...clean.map((id, i) => db.prepare('UPDATE stages SET position = ? WHERE id = ?').bind(i, id)),
    log(db, me.id, 'stage_order'),
  ]);
  return json({ ok: true });
});

route('DELETE', '/api/stages/:id', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE stage_id = ?').bind(id).first();
  if (n > 0) throw new HttpError(400, `這個階段還有 ${n} 件商品（含回收區），請先移走`);
  const { total } = await db.prepare('SELECT COUNT(*) AS total FROM stages').first();
  if (total <= 1) throw new HttpError(400, '至少要保留一個階段');
  const s = await db.prepare('SELECT name FROM stages WHERE id = ?').bind(id).first();
  await db.batch([
    db.prepare('DELETE FROM stages WHERE id = ?').bind(id),
    log(db, me.id, 'stage_delete', null, s?.name ?? ''),
  ]);
  return json({ ok: true });
});

// ---------- platforms ----------

route('POST', '/api/platforms', async ({ db, request, me }) => {
  requireAdmin(me);
  const name = text((await body(request)).name, '平台名稱', 30);
  const dup = await db.prepare('SELECT id FROM platforms WHERE name = ?').bind(name).first();
  if (dup) throw new HttpError(409, '這個平台已經存在');
  await db.batch([
    db.prepare('INSERT INTO platforms (name) VALUES (?)').bind(name),
    log(db, me.id, 'platform_add', null, name),
  ]);
  return json({ ok: true });
});

route('PATCH', '/api/platforms/:id', async ({ db, request, me, params }) => {
  requireAdmin(me);
  const name = text((await body(request)).name, '平台名稱', 30);
  await db.batch([
    db.prepare('UPDATE platforms SET name = ? WHERE id = ?').bind(name, intId(params.id)),
    log(db, me.id, 'platform_edit', null, name),
  ]);
  return json({ ok: true });
});

route('DELETE', '/api/platforms/:id', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const p = await db.prepare('SELECT name FROM platforms WHERE id = ?').bind(id).first();
  await db.batch([
    db.prepare('DELETE FROM product_platforms WHERE platform_id = ?').bind(id),
    db.prepare('DELETE FROM platforms WHERE id = ?').bind(id),
    log(db, me.id, 'platform_delete', null, p?.name ?? ''),
  ]);
  return json({ ok: true });
});

// ---------- products ----------

route('GET', '/api/products', async ({ db, me }) => {
  requireMe(me);
  const [products, links] = await Promise.all([
    db.prepare(`
      SELECT p.id, p.name, p.sku, p.stage_id, p.owner_id, p.stage_entered_at, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM photos ph WHERE ph.product_id = p.id AND ph.deleted_at IS NULL) AS photo_count,
        (SELECT COUNT(*) FROM comments c WHERE c.product_id = p.id AND c.deleted_at IS NULL) AS comment_count,
        (SELECT ph.id FROM photos ph WHERE ph.product_id = p.id AND ph.deleted_at IS NULL ORDER BY ph.id LIMIT 1) AS cover_id
      FROM products p WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC`).all(),
    db.prepare(`SELECT pp.product_id, pp.platform_id FROM product_platforms pp
      JOIN products p ON p.id = pp.product_id WHERE p.deleted_at IS NULL`).all(),
  ]);
  const byProduct = {};
  for (const l of links.results) (byProduct[l.product_id] ||= []).push(l.platform_id);
  return json(products.results.map((p) => ({ ...p, platform_ids: byProduct[p.id] || [] })));
});

route('POST', '/api/products', async ({ db, request, me }) => {
  requireMe(me);
  const b = await body(request);
  const name = text(b.name, '商品名稱', 100);
  const first = await db.prepare('SELECT id FROM stages ORDER BY position, id LIMIT 1').first();
  const ownerId = await validOwnerId(db, b.owner_id ?? me.id);
  // 未指定平台時預設勾選全部平台
  const platformIds = b.platform_ids === undefined
    ? (await db.prepare('SELECT id FROM platforms').all()).results.map((r) => r.id)
    : await validPlatformIds(db, b.platform_ids);
  const t = now();
  const res = await db.prepare(`INSERT INTO products (name, sku, note, stage_id, owner_id, stage_entered_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(name, optText(b.sku, 60), optText(b.note), first.id, ownerId, t, me.id, t, t).run();
  const id = res.meta.last_row_id;
  await db.batch([
    ...platformIds.map((pid) => db.prepare('INSERT INTO product_platforms (product_id, platform_id) VALUES (?, ?)').bind(id, pid)),
    db.prepare('INSERT INTO stage_history (product_id, from_stage_id, to_stage_id, member_id, at) VALUES (?, NULL, ?, ?, ?)')
      .bind(id, first.id, me.id, t),
    log(db, me.id, 'product_add', id, name),
  ]);
  return json({ id });
});

route('GET', '/api/products/:id', async ({ db, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const [platforms, photos, comments, history] = await Promise.all([
    db.prepare('SELECT platform_id FROM product_platforms WHERE product_id = ?').bind(id).all(),
    db.prepare('SELECT id, filename, uploaded_by, created_at FROM photos WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT id, member_id, body, created_at FROM comments WHERE product_id = ? AND deleted_at IS NULL ORDER BY id').bind(id).all(),
    db.prepare('SELECT from_stage_id, to_stage_id, member_id, at FROM stage_history WHERE product_id = ? ORDER BY at, id').bind(id).all(),
  ]);
  return json({
    ...p,
    platform_ids: platforms.results.map((r) => r.platform_id),
    photos: photos.results,
    comments: comments.results,
    history: history.results,
  });
});

route('PATCH', '/api/products/:id', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const b = await body(request);
  const name = b.name !== undefined ? text(b.name, '商品名稱', 100) : p.name;
  const sku = b.sku !== undefined ? optText(b.sku, 60) : p.sku;
  const note = b.note !== undefined ? optText(b.note) : p.note;
  const ownerId = b.owner_id !== undefined ? await validOwnerId(db, b.owner_id) : p.owner_id;
  const stmts = [
    db.prepare('UPDATE products SET name = ?, sku = ?, note = ?, owner_id = ?, updated_at = ? WHERE id = ?')
      .bind(name, sku, note, ownerId, now(), id),
  ];
  if (b.platform_ids !== undefined) {
    const platformIds = await validPlatformIds(db, b.platform_ids);
    stmts.push(db.prepare('DELETE FROM product_platforms WHERE product_id = ?').bind(id));
    for (const pid of platformIds) {
      stmts.push(db.prepare('INSERT INTO product_platforms (product_id, platform_id) VALUES (?, ?)').bind(id, pid));
    }
  }
  const changes = [];
  if (name !== p.name) changes.push('名稱');
  if (sku !== p.sku) changes.push('SKU');
  if (note !== p.note) changes.push('備註');
  if (ownerId !== p.owner_id) changes.push('負責人');
  if (b.platform_ids !== undefined) changes.push('平台');
  stmts.push(log(db, me.id, 'product_edit', id, changes.join('、')));
  await db.batch(stmts);
  return json({ ok: true });
});

route('POST', '/api/products/:id/move', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  const toStageId = intId((await body(request)).to_stage_id);
  const to = await db.prepare('SELECT id, name FROM stages WHERE id = ?').bind(toStageId).first();
  if (!to) throw new HttpError(400, '階段不存在');
  if (to.id === p.stage_id) return json({ ok: true });
  const t = now();
  await db.batch([
    db.prepare('UPDATE products SET stage_id = ?, stage_entered_at = ?, updated_at = ? WHERE id = ?').bind(to.id, t, t, id),
    db.prepare('INSERT INTO stage_history (product_id, from_stage_id, to_stage_id, member_id, at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, p.stage_id, to.id, me.id, t),
    log(db, me.id, 'product_move', id, to.name),
  ]);
  return json({ ok: true });
});

route('DELETE', '/api/products/:id', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const p = await getProduct(db, id);
  await db.batch([
    db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').bind(now(), id),
    log(db, me.id, 'product_delete', id, p.name),
  ]);
  return json({ ok: true });
});

// ---------- photos ----------

route('POST', '/api/products/:id/photos', async ({ db, env, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  await getProduct(db, id);
  const form = await request.formData();
  const files = form.getAll('file').filter((f) => typeof f === 'object' && f.size > 0);
  if (!files.length) throw new HttpError(400, '沒有收到照片');
  const t = now();
  const stmts = [];
  for (const f of files) {
    if (!String(f.type).startsWith('image/')) throw new HttpError(400, `${f.name} 不是圖片`);
    if (f.size > MAX_PHOTO_BYTES) throw new HttpError(400, `${f.name} 超過 10MB`);
    const ext = (f.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const key = `products/${id}/${crypto.randomUUID()}.${ext}`;
    await env.PHOTOS.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
    stmts.push(db.prepare('INSERT INTO photos (product_id, r2_key, filename, content_type, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, key, optText(f.name, 120), f.type, me.id, t));
  }
  stmts.push(db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(t, id));
  stmts.push(log(db, me.id, 'photo_add', id, `${files.length} 張`));
  await db.batch(stmts);
  return json({ ok: true, count: files.length });
});

route('GET', '/api/photos/:id', async ({ db, env, params, me }) => {
  requireMe(me);
  const ph = await db.prepare('SELECT r2_key, content_type FROM photos WHERE id = ?').bind(intId(params.id)).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  const obj = await env.PHOTOS.get(ph.r2_key);
  if (!obj) throw new HttpError(404, '照片檔案遺失');
  return new Response(obj.body, {
    headers: {
      'content-type': ph.content_type,
      'cache-control': 'private, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  });
});

route('DELETE', '/api/photos/:id', async ({ db, me, params }) => {
  requireAdmin(me);
  const id = intId(params.id);
  const ph = await db.prepare('SELECT product_id FROM photos WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!ph) throw new HttpError(404, '找不到照片');
  await db.batch([
    db.prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').bind(now(), id),
    log(db, me.id, 'photo_delete', ph.product_id),
  ]);
  return json({ ok: true });
});

// ---------- comments ----------

route('POST', '/api/products/:id/comments', async ({ db, request, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  await getProduct(db, id);
  const b = text((await body(request)).body, '留言', 2000);
  const t = now();
  await db.batch([
    db.prepare('INSERT INTO comments (product_id, member_id, body, created_at) VALUES (?, ?, ?, ?)').bind(id, me.id, b, t),
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(t, id),
    log(db, me.id, 'comment_add', id, b.slice(0, 60)),
  ]);
  return json({ ok: true });
});

route('DELETE', '/api/comments/:id', async ({ db, me, params }) => {
  requireMe(me);
  const id = intId(params.id);
  const c = await db.prepare('SELECT member_id, product_id FROM comments WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!c) throw new HttpError(404, '找不到留言');
  if (c.member_id !== me.id && !me.is_admin) throw new HttpError(403, '只能刪除自己的留言');
  await db.batch([
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').bind(now(), id),
    log(db, me.id, 'comment_delete', c.product_id),
  ]);
  return json({ ok: true });
});

// ---------- 回收區 ----------

route('GET', '/api/trash', async ({ db, me }) => {
  requireAdmin(me);
  const [products, photos, comments] = await Promise.all([
    db.prepare('SELECT id, name, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100').all(),
    db.prepare(`SELECT ph.id, ph.product_id, ph.filename, ph.deleted_at, p.name AS product_name FROM photos ph
      JOIN products p ON p.id = ph.product_id WHERE ph.deleted_at IS NOT NULL ORDER BY ph.deleted_at DESC LIMIT 100`).all(),
    db.prepare(`SELECT c.id, c.product_id, c.body, c.member_id, c.deleted_at, p.name AS product_name FROM comments c
      JOIN products p ON p.id = c.product_id WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 100`).all(),
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

// ---------- 統計（全部由程式計算） ----------

route('GET', '/api/stats', async ({ db, me }) => {
  requireMe(me);
  const [history, products] = await Promise.all([
    db.prepare(`SELECT h.product_id, h.from_stage_id, h.to_stage_id, h.at FROM stage_history h
      JOIN products p ON p.id = h.product_id WHERE p.deleted_at IS NULL ORDER BY h.product_id, h.at, h.id`).all(),
    db.prepare('SELECT id, created_at FROM products WHERE deleted_at IS NULL').all(),
  ]);
  const nowMs = Date.now();
  const DAY = 86400000;
  // 每一段「停留」= 進入某階段到離開（或到現在）
  const dwell = {}; // stage_id -> { total_days, stints, open }
  const rows = history.results;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1] && rows[i + 1].product_id === cur.product_id ? rows[i + 1] : null;
    const end = next ? Date.parse(next.at) : nowMs;
    const days = Math.max(0, (end - Date.parse(cur.at)) / DAY);
    const d = (dwell[cur.to_stage_id] ||= { total_days: 0, stints: 0, open: 0 });
    d.total_days += days;
    d.stints += 1;
    if (!next) d.open += 1;
  }
  const avg_dwell_days = {};
  for (const [sid, d] of Object.entries(dwell)) avg_dwell_days[sid] = Math.round((d.total_days / d.stints) * 10) / 10;

  const weekAgo = nowMs - 7 * DAY;
  const lastStage = await db.prepare('SELECT id FROM stages ORDER BY position DESC, id DESC LIMIT 1').first();
  const added_7d = products.results.filter((p) => Date.parse(p.created_at) >= weekAgo).length;
  const listed_7d = rows.filter((r) => r.to_stage_id === lastStage?.id && r.from_stage_id !== null && Date.parse(r.at) >= weekAgo).length;
  return json({ avg_dwell_days, added_7d, listed_7d, last_stage_id: lastStage?.id ?? null });
});

route('GET', '/api/activity', async ({ db, me, url }) => {
  requireMe(me);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);
  const { results } = await db.prepare(`SELECT a.id, a.member_id, a.action, a.product_id, a.detail, a.at, p.name AS product_name
    FROM activity a LEFT JOIN products p ON p.id = a.product_id
    WHERE a.action != 'login' ORDER BY a.id DESC LIMIT ?`).bind(limit).all();
  return json(results);
});

// ---------- entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const r = routes.find((r) => r.method === request.method && r.re.test(url.pathname));
    if (!r) return json({ error: '找不到這個 API' }, 404);
    try {
      const db = env.DB;
      await ensureSchema(db);
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const me = await currentMember(db, request);
      return await r.handler({ db, env, request, url, params, me });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: '系統錯誤，請稍後再試' }, 500);
    }
  },
};
