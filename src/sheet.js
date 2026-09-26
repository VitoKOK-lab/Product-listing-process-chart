// 試算表同步與首圖抓取（純函式，方便測試）

// 試算表狀態 → 優先序代碼；插隊在系統裡手動設定，不從試算表來
const STATUS_MAP = [['投放中', 'A'], ['優先製作', 'B'], ['可投放', 'C'], ['待製作', 'D']];
export const STATUS_RANK = { A: 1, B: 2, C: 3, D: 4 };

// 這些狀態代表商品已經不用做：已經有的標成已下架，沒有的不建立
const INACTIVE = ['已停止', '已更名失效', '失效'];

export function statusCode(text) {
  const s = String(text ?? '').trim();
  for (const [k, code] of STATUS_MAP) if (s.includes(k)) return code;
  if (INACTIVE.some((k) => s.includes(k))) return 'X';
  return '';
}

const rankOf = (code) => (code === 'X' ? 10 : STATUS_RANK[code] || 9);

// 同一個商品的識別：有連結用連結（去掉參數），沒有連結用名稱
export function normalizeLink(v) {
  const s = String(v ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

export function sheetKey(name, link) {
  const l = normalizeLink(link);
  return l ? `url:${l}` : `name:${String(name).trim()}`;
}

// 整理 Apps Script 傳回的商品列：[{ status, name, link }]（A 狀態、C 商品／活動、D 商品連結）
// row = 在試算表裡的先後（0 = 最上面），美編從最下面往上做
export function sheetRows(list) {
  const out = new Map();
  (Array.isArray(list) ? list : []).forEach((r, row) => {
    const name = String(r?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!name) return;
    const rawLink = String(r?.link ?? '').trim();
    const link = /^https?:\/\//i.test(rawLink) ? rawLink.slice(0, 500) : '';
    const status = String(r?.status ?? '').trim().slice(0, 20);
    const code = statusCode(status);
    const key = sheetKey(name, link);
    const prev = out.get(key);
    // 同一商品出現多列：保留優先序最高的狀態
    if (!prev || rankOf(code) < rankOf(prev.code)) out.set(key, { key, name, link, status, code, row });
  });
  return [...out.values()];
}

// 比對試算表與系統：新增、更新、下架、恢復
// existing: [{ id, sheet_key, name, link, sheet_status, status_code, sheet_row, delisted_at, deleted_at, source }]
// 狀態是「已停止／已更名失效」的列：已經有的商品標成已下架，沒有的不建立
export function planSync(existing, rows) {
  const byKey = new Map(existing.filter((p) => p.sheet_key).map((p) => [p.sheet_key, p]));
  const seen = new Set();
  const plan = { inserts: [], updates: [], delist: [], restore: [] };
  for (const r of rows) {
    const inactive = r.code === 'X';
    if (!inactive) seen.add(r.key);
    const p = byKey.get(r.key);
    if (!p) { if (!inactive) plan.inserts.push(r); continue; }
    if (p.deleted_at) continue; // 被管理員刪除的不動
    if (p.delisted_at && !inactive) plan.restore.push({ id: p.id, row: r });
    if (p.name !== r.name || (p.link || '') !== r.link || (p.sheet_status || '') !== r.status || (p.status_code || '') !== r.code
      || (p.sheet_row ?? null) !== (r.row ?? null) || p.source !== 'sheet') {
      plan.updates.push({ id: p.id, row: r });
    }
  }
  for (const p of existing) {
    if (p.source === 'sheet' && p.sheet_key && !seen.has(p.sheet_key) && !p.delisted_at && !p.deleted_at) plan.delist.push(p.id);
  }
  return plan;
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 讀商品頁的首圖（og:image），找不到再用 twitter:image
export function extractOgImage(html, baseUrl) {
  const found = {};
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    const keyM = attr('property') || attr('name');
    const valM = attr('content');
    if (!keyM || !valM) continue;
    const k = (keyM[2] ?? keyM[3]).toLowerCase();
    if (['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image'].includes(k) && !found[k]) found[k] = valM[2] ?? valM[3];
  }
  const raw = found['og:image:secure_url'] || found['og:image'] || found['og:image:url'] || found['twitter:image'];
  if (!raw) return null;
  try { return new URL(decodeEntities(raw.trim()), baseUrl).href; } catch { return null; }
}
