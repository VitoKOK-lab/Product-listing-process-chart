// TZG 上架跟進 — 前端（無框架，hash 路由）
// 所有時數、顏色、排序都由後端計算，前端只負責顯示
'use strict';

const POLL_MS = 10000;
const MAX_EDGE = 1920;
const STEP_ORDER = ['raw', 'edit', 'listing', 'review', 'publish', 'live', 'optimizing', 'opt_review'];
const STEP_COLOR = {
  raw: '#3D4F7A', edit: '#6B3FA0', listing: '#1B7F8C', review: '#1E4E8C', publish: '#B8741A',
  live: '#0E7C5A', optimizing: '#8C2F6B', opt_review: '#1E4E8C',
};
const REASON = { photo: '照片', copy: '文案', price: '價格' };
const KIND = { raw: '原圖', cutout: '去背圖', mood: '意象圖', opt: '優化截圖' };
const GROUPS = [
  ['rush', '急件', 'var(--ruby)'],
  ['attention', '@我・被退回', 'var(--amethyst)'],
  ['red', '紅色超時', 'var(--ruby)'],
  ['yellow', '黃色超時', 'var(--topaz)'],
  ['mine', '等我處理', 'var(--ink-3)'],
];

const S = {
  me: null, members: [], batches: [], settings: null, roles: {}, stepLabel: {},
  version: null, busy: 0, radarScope: 'me', radarKeys: [], radarScroll: 0, handled: null,
  lastLoad: null, offline: false, fails: 0, kanbanQuery: '', ana: { scope: 'all', days: 30, batch: 0 },
};
const $app = document.getElementById('app');

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const member = (id) => S.members.find((m) => m.id === id);
const batchName = (id) => S.batches.find((b) => b.id === id)?.name ?? '';
const stepLabel = (s) => S.stepLabel[s] || s;
const pad = (n) => String(n).padStart(2, '0');
const hasRole = (r) => S.me && (S.me.roles.includes(r));
const isMkt = () => hasRole('marketing') || S.me?.is_admin;

function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtClock(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDeadline(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}（${'日一二三四五六'[d.getDay()]}）${pad(d.getHours())}:00`;
}
// 上班時數 → 「1 天 3 小時」（1 天 = 設定的每日上班時數）
function fmtWork(h) {
  if (h == null) return '—';
  const dh = S.settings?.day_hours || 9;
  if (h < 1) return `${Math.round(h * 60)} 分鐘`;
  const d = Math.floor(h / dh);
  const r = Math.round((h - d * dh) * 10) / 10;
  return d ? `${d} 天${r ? ` ${r} 小時` : ''}` : `${r} 小時`;
}
function avatar(m, size) {
  if (!m) return '<span class="avatar" style="background:#B8BCC8">?</span>';
  const st = size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` : '';
  return `<span class="avatar" style="background:${m.color}${st}">${esc([...m.name][0])}</span>`;
}
const who = (id) => { const m = member(id); return `<span class="who">${avatar(m)}${esc(m?.name ?? '—')}</span>`; };
const stepChip = (s) => `<span class="step-chip" style="background:${STEP_COLOR[s]}">${esc(stepLabel(s))}</span>`;
const rolesText = (m) => (m?.roles || []).map((r) => S.roles[r]).join('、');

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = error ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function setOffline(on) {
  S.offline = on;
  document.body.classList.toggle('offline', on);
  const bar = document.getElementById('offline');
  bar.hidden = !on;
  if (on) bar.textContent = `連線中斷・顯示的是 ${S.lastLoad ? fmtClock(S.lastLoad) : '—'} 的資料，恢復後自動重新載入`;
}

async function api(method, path, data) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (data instanceof FormData) opt.body = data;
  else if (data !== undefined) { opt.body = JSON.stringify(data); opt.headers['content-type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(path, opt);
  } catch {
    setOffline(true);
    const e = new Error('連線中斷，請稍後再試');
    e.network = true;
    throw e;
  }
  if (S.offline) { setOffline(false); }
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) { S.me = null; await boot(); throw new Error(out.error || '請重新登入'); }
  if (!res.ok) { const e = new Error(out.error || `錯誤 ${res.status}`); e.status = res.status; e.data = out; throw e; }
  return out;
}

// 執行動作：失敗時保留輸入；連續 3 次網路失敗提示複製內容
async function act(fn, okMsg, after = 'refresh') {
  S.busy++;
  try {
    await fn();
    S.fails = 0;
    if (okMsg) toast(okMsg);
    if (after === 'refresh') await refresh();
    return true;
  } catch (e) {
    if (e.network) {
      S.fails++;
      if (S.fails >= 3) showFailModal();
      else toast(e.message, true);
    } else {
      toast(e.message, true);
      if (e.status === 409) await refresh();
    }
    return false;
  } finally {
    S.busy--;
  }
}

function showFailModal() {
  const drafts = [...$app.querySelectorAll('textarea, input[type=text], input[type=url]')].map((el) => el.value).filter(Boolean).join('\n\n');
  openModal(`
    <h3>連續送出失敗，可能是連線問題</h3>
    <p class="muted">你輸入的內容還在畫面上，沒有被清掉。也可以先複製起來。</p>
    <textarea readonly style="min-height:120px">${esc(drafts)}</textarea>
    <div class="acts"><button class="btn" data-copy>複製內容</button><button class="btn primary" data-close>稍後再試</button></div>`,
  (m) => {
    m.querySelector('[data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(drafts); toast('已複製'); } catch { m.querySelector('textarea').select(); }
    };
  });
  S.fails = 0;
}

function openModal(html, bind) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  const back = root.firstElementChild;
  const close = () => { root.innerHTML = ''; };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  bind?.(back.querySelector('.modal'), close);
  return close;
}

function isBusy() {
  if (S.busy > 0) return true;
  if (document.querySelector('.lightbox, .modal-back')) return true;
  if ($app.querySelector('[data-dirty]')) return true;
  const a = document.activeElement;
  return !!a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}
$app.addEventListener('input', (e) => { if (e.target.matches('input, textarea, select')) e.target.dataset.dirty = '1'; });

// ---------- boot & sync ----------

async function loadBase() {
  const b = await api('GET', '/api/bootstrap');
  Object.assign(S, { me: b.me, members: b.members });
  if (b.me) Object.assign(S, { batches: b.batches, settings: b.settings, roles: b.roles, stepLabel: b.step_label });
  S.lastLoad = Date.now();
}

async function boot() {
  const token = new URLSearchParams(location.search).get('x');
  if (token) {
    history.replaceState(null, '', location.pathname + location.hash);
    try {
      await api('POST', '/api/link-login', { token });
    } catch (e) {
      return renderLinkExpired(e.data?.contact);
    }
  }
  await loadBase();
  if (!S.me) return renderLogin();
  document.getElementById('topbar').hidden = false;
  renderNav();
  document.getElementById('me').innerHTML = `${avatar(S.me)}<span>${esc(S.me.name)}</span><span class="roles">${esc(rolesText(S.me) || (S.me.is_admin ? '管理員' : ''))}</span>`;
  S.version = (await api('GET', '/api/version')).v;
  if (!location.hash) location.hash = '#/radar';
  await render();
}

function renderNav() {
  const items = S.me.is_external
    ? [['radar', '我的優化']]
    : [['radar', '雷達'], ['kanban', 'Kanban'], ['batches', '整批進度'], ['analysis', '延誤分析'], ['log', '紀錄'], ...(S.me.is_admin ? [['settings', '設定']] : [])];
  document.getElementById('nav').innerHTML = items.map(([r, l]) => `<a href="#/${r}" data-route="${r}">${l}</a>`).join('');
}

async function refresh() {
  if (!S.me) return;
  S.version = (await api('GET', '/api/version')).v;
  await loadBase();
  if (!S.me) return renderLogin();
  await render();
}

setInterval(async () => {
  if (!S.me || document.hidden) return;
  try {
    const v = await api('GET', '/api/version');
    if (isBusy()) return;
    const route = currentRoute()[0];
    // 版本變了就重載；雷達與看板每分鐘也重算一次顏色
    if (v.v !== S.version || (['radar', 'kanban'].includes(route) && Date.now() - S.lastLoad > 60000)) await refresh();
  } catch { /* 離線橫幅已處理 */ }
}, POLL_MS);

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me && !isBusy()) refresh().catch(() => {}); });
window.addEventListener('online', () => { if (S.me) refresh().catch(() => {}); });

// ---------- login ----------

function renderLinkExpired(contact) {
  document.getElementById('topbar').hidden = true;
  $app.innerHTML = `<div class="login"><h1>連結已失效</h1><p class="muted">請聯絡 ${esc(contact || '管理員')} 重新取得連結。</p></div>`;
}

function renderLogin() {
  document.getElementById('topbar').hidden = true;
  const open = S.members;
  const groups = {};
  for (const m of open) {
    const key = m.roles[0] || 'none';
    (groups[key] ||= []).push(m);
  }
  if (groups.none) { const none = groups.none; delete groups.none; Object.assign(groups, { none }); }
  const ROLE_NAME = { picker: '選品', editor: '美編', lister: '上架人員', reviewer: '審核人', marketing: '老闆／行銷', none: '管理員' };
  $app.innerHTML = `
    <div class="login">
      <h1>選擇你的名字</h1>
      <p class="muted">選定後這台裝置會綁定你的名字，之後打開直接進入。<br>選錯或換裝置，請找管理員重設。</p>
      ${open.length ? Object.entries(groups).map(([role, ms]) => `
        <div class="role-group"><h3>${ROLE_NAME[role] || role}</h3>
          <div class="name-grid">${ms.map((m) => `<button class="name-btn" data-id="${m.id}">${avatar(m)}<b>${esc(m.name)}</b></button>`).join('')}</div>
        </div>`).join('') : '<p class="empty">目前沒有可選的名字。請聯絡管理員新增或重設。</p>'}
    </div>`;
  $app.querySelectorAll('.name-btn').forEach((b) => {
    b.onclick = async () => {
      const m = member(Number(b.dataset.id));
      if (!confirm(`確定你是「${m.name}」？\n選定後這台裝置會綁定此名字，只有管理員能重設。`)) return;
      try { await api('POST', '/api/claim', { member_id: m.id }); await boot(); } catch (e) { toast(e.message, true); await boot(); }
    };
  });
}

// ---------- router ----------

const currentRoute = () => (location.hash.replace(/^#\/?/, '') || 'radar').split('/');
window.addEventListener('hashchange', () => { if (S.me) render(); });

async function render() {
  const [route, arg] = currentRoute();
  if (route !== 'radar' && document.querySelector('[data-view=radar]')) S.radarScroll = window.scrollY;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (route === 'p' && a.dataset.route === 'radar') || (route === 'new' && a.dataset.route === 'radar')));
  const views = { radar: viewRadar, kanban: viewKanban, batches: viewBatches, analysis: viewAnalysis, log: viewLog, settings: viewSettings, p: viewProduct, new: viewNew };
  const view = S.me.is_external && !['radar', 'p'].includes(route) ? viewRadar : (views[route] || viewRadar);
  try {
    await view(arg);
  } catch (e) {
    if (!e.network) $app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// ---------- 雷達 ----------

function radarCard(it, soon) {
  const holder = member(it.holder_id);
  const tags = it.tags.filter((t) => t.t).map((t) => `<span class="tag ${t.k}">${esc(t.t)}</span>`).join('');
  const right = it.group === 'rush'
    ? `<span class="countdown">${it.remaining_h > 0 ? '剩 ' + esc(fmtWork(it.remaining_h)) : '已逾期'}</span>`
    : '';
  return `
    <a class="card rcard g-${it.group} ${soon ? 'soon' : ''}" href="#/p/${it.product_id}" data-key="${esc(it.key)}">
      ${it.cover_id ? `<img class="thumb" loading="lazy" src="/api/photos/${it.cover_id}" alt="">` : '<div class="thumb"></div>'}
      <div>
        <div class="row" style="gap:6px"><span class="t">${esc(it.name)}</span><span class="spacer"></span>${right}</div>
        <div class="tags">${stepChip(it.step)}${tags}</div>
        <div class="meta">
          ${S.radarScope === 'all' && holder ? who(it.holder_id) : ''}
          ${it.budget_h != null ? `<span>停留 <span class="mono">${esc(fmtWork(it.held_h))}</span>／標準 <span class="mono">${esc(fmtWork(it.budget_h))}</span></span>` : ''}
          ${it.deadline ? `<span>截止 ${esc(fmtDeadline(it.deadline))}</span>` : ''}
          ${batchName(it.batch_id) ? `<span>${esc(batchName(it.batch_id))}</span>` : ''}
          ${it.mention_id ? `<button class="btn small" data-ack="${it.mention_id}">知道了</button>` : ''}
        </div>
      </div>
    </a>`;
}

async function viewRadar() {
  const scope = S.me.is_external ? 'me' : S.radarScope;
  const r = await api('GET', `/api/radar?scope=${scope}`);
  S.radarKeys = r.items.map((i) => i.product_id);
  const soon = new Set(r.upcoming);
  const byGroup = Object.fromEntries(GROUPS.map(([g]) => [g, r.items.filter((i) => i.group === g)]));
  const handled = S.handled && Date.now() - S.handled.at < 3000 ? S.handled : null;
  S.handled = null;
  $app.innerHTML = `
    <div data-view="radar">
    <div class="page-head">
      <h1>${S.me.is_external ? '我的優化' : '雷達'}</h1>
      ${S.me.is_external ? '' : `<div class="seg"><button data-scope="me" class="${scope === 'me' ? 'on' : ''}">我的</button><button data-scope="all" class="${scope === 'all' ? 'on' : ''}">全部卡關</button></div>`}
      <span class="spacer"></span>
      ${hasRole('picker') ? '<a class="btn primary" href="#/new">＋ 新增商品</a>' : ''}
    </div>
    ${handled ? `<div class="card rcard ghost" style="margin-bottom:12px"><div></div><div><span class="t">${esc(handled.name)}</span><div class="muted">已交棒給 ${esc(handled.to)}</div></div></div>` : ''}
    ${r.stuck_count === 0 ? `<div class="card calm"><b>目前沒有卡關</b><span class="muted">${scope === 'me' && soon.size ? '下面虛線框是最接近超時的件，可以提前處理' : scope === 'all' ? '所有人手上都在時限內' : '你手上沒有待辦'}</span></div>` : ''}
    ${GROUPS.map(([g, label, color]) => byGroup[g].length ? `
      <section class="radar-group">
        <h2><span class="dot" style="background:${color}"></span>${label}<span class="num">${byGroup[g].length}</span></h2>
        <div class="rcards">${byGroup[g].map((it) => radarCard(it, soon.has(it.key))).join('')}</div>
      </section>` : '').join('')}
    </div>`;
  $app.querySelectorAll('[data-scope]').forEach((b) => { b.onclick = () => { S.radarScope = b.dataset.scope; viewRadar(); }; });
  $app.querySelectorAll('[data-ack]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); act(() => api('POST', `/api/mentions/${b.dataset.ack}/ack`)); };
  });
  const nav = document.querySelector('#nav a[data-route=radar]');
  if (nav && scope === 'me') nav.innerHTML = `${S.me.is_external ? '我的優化' : '雷達'}${r.stuck_count ? `<span class="badge">${r.stuck_count}</span>` : ''}`;
  if (S.radarScroll) { window.scrollTo(0, S.radarScroll); S.radarScroll = 0; }
}

// ---------- 新增商品 ----------

function optionsFor(role, selected) {
  const ms = S.members.filter((m) => m.active && m.roles.includes(role));
  return `<option value="">請選擇</option>` + ms.map((m) => `<option value="${m.id}" ${m.id === selected || ms.length === 1 ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
}

async function viewNew() {
  $app.innerHTML = `
    <div class="page-head"><a class="btn small" href="#/radar">← 雷達</a><h1>新增商品</h1></div>
    <form class="card section" id="new-form" style="max-width:640px">
      <label class="field"><span>進貨批次</span>
        <select name="batch_id">
          <option value="">＋ 建立新批次</option>
          ${S.batches.map((b, i) => `<option value="${b.id}" ${i === 0 ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></label>
      <label class="field" id="new-batch" ${S.batches.length ? 'hidden' : ''}><span>新批次名稱</span><input type="text" name="batch_name" placeholder="例：9 月第 2 批／鋯石系列" maxlength="40"></label>
      <label class="field"><span>商品名稱</span><input type="text" name="name" required maxlength="100" placeholder="例：14K 金鋯石耳環"></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1;min-width:150px"><span>美編</span><select name="editor_id">${optionsFor('editor')}</select></label>
        <label class="field" style="flex:1;min-width:150px"><span>上架人員</span><select name="lister_id">${optionsFor('lister')}</select></label>
        <label class="field" style="flex:1;min-width:150px"><span>審核人</span><select name="reviewer_id">${optionsFor('reviewer')}</select></label>
      </div>
      <p class="muted">建立後進入「原圖」，由你上傳原圖並逐張勾選。</p>
      <div class="row"><span class="spacer"></span><button class="btn primary act">建立商品卡</button></div>
    </form>`;
  const f = document.getElementById('new-form');
  f.batch_id.onchange = () => { document.getElementById('new-batch').hidden = !!f.batch_id.value; };
  f.onsubmit = (e) => {
    e.preventDefault();
    const data = {
      name: f.name.value,
      editor_id: Number(f.editor_id.value) || null, lister_id: Number(f.lister_id.value) || null, reviewer_id: Number(f.reviewer_id.value) || null,
      ...(f.batch_id.value ? { batch_id: Number(f.batch_id.value) } : { batch_name: f.batch_name.value }),
    };
    act(async () => {
      const { id } = await api('POST', '/api/products', data);
      f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
      location.hash = `#/p/${id}`;
    }, '已建立，請上傳原圖', 'none');
  };
}

// ---------- Kanban ----------

async function viewKanban() {
  const list = await api('GET', '/api/products');
  const q = S.kanbanQuery.trim().toLowerCase();
  const hit = q ? list.filter((p) => (p.name + batchName(p.batch_id)).toLowerCase().includes(q)) : list;
  const recent = [...list].sort((a, b) => b.updated_at - a.updated_at).slice(0, 3);
  $app.innerHTML = `
    <div class="page-head">
      <h1>Kanban</h1>
      <input type="text" id="kq" placeholder="搜尋商品或批次" value="${esc(S.kanbanQuery)}" style="max-width:260px">
      <span class="spacer"></span>
      ${isMkt() ? '<button class="btn primary" id="bulk-opt">指定優化（可多選）</button>' : ''}
      ${hasRole('picker') ? '<a class="btn" href="#/new">＋ 新增商品</a>' : ''}
    </div>
    ${q && !hit.length ? `<div class="card section"><p>找不到符合「${esc(S.kanbanQuery)}」的商品</p>
      <button class="btn small" id="kq-clear">清除搜尋</button>
      <div class="muted" style="margin-top:12px">最近更新：${recent.map((p) => `<a href="#/p/${p.id}">${esc(p.name)}</a>`).join('、')}</div></div>` : ''}
    <div class="kanban">
      ${STEP_ORDER.map((s) => {
        const items = hit.filter((p) => p.step === s);
        return `<section class="kcol">
          <div class="kcol-head"><span class="dot" style="background:${STEP_COLOR[s]}"></span>${esc(stepLabel(s))}<span class="num">${items.length}</span></div>
          ${items.map((p) => `
            <a class="card kcard c-${p.color}" href="#/p/${p.id}">
              <div class="t">${esc(p.name)}</div>
              <div class="meta">
                ${p.holder_id ? `${avatar(member(p.holder_id))}<span>${esc(member(p.holder_id)?.name ?? '')}</span>` : ''}
                ${p.rush ? '<span class="tag rush">急件</span>' : ''}
                ${p.returned ? '<span class="tag return">退回</span>' : ''}
                ${p.color === 'red' ? '<span class="tag red">紅</span>' : p.color === 'yellow' ? '<span class="tag yellow">黃</span>' : ''}
                ${p.held_h != null ? `<span class="mono">${esc(fmtWork(p.held_h))}</span>` : ''}
                ${p.opt_version ? `<span class="tag green">v${p.opt_version}</span>` : ''}
              </div>
            </a>`).join('') || '<div class="muted" style="padding:6px">—</div>'}
        </section>`;
      }).join('')}
    </div>`;
  const kq = document.getElementById('kq');
  kq.oninput = () => { S.kanbanQuery = kq.value; clearTimeout(kq._t); kq._t = setTimeout(async () => { await viewKanban(); const n = document.getElementById('kq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  const clr = document.getElementById('kq-clear');
  if (clr) clr.onclick = () => { S.kanbanQuery = ''; viewKanban(); };
  const bo = document.getElementById('bulk-opt');
  if (bo) bo.onclick = () => openAssignModal(list.filter((p) => p.step === 'live'));
}

// ---------- 指定優化（單件或多件） ----------

function tomorrowYmd() {
  const t = new Date(Date.now() + 86400000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function openAssignModal(liveProducts, preselect = []) {
  if (!liveProducts.length) return toast('目前沒有「已上架」的商品可以指定', true);
  const pre = new Set(preselect);
  openModal(`
    <h3>指定優化</h3>
    <p class="muted">截止前 ${esc(fmtWork(S.settings.rush_threshold_hours))}內會自動變急件，排到優化者雷達最上面。</p>
    <div class="field"><span>商品（${liveProducts.length} 件已上架）</span>
      <div class="row" style="margin-bottom:6px"><button type="button" class="btn small" data-all>全選</button><button type="button" class="btn small" data-none>全不選</button><span class="muted" id="pick-n"></span></div>
      <div class="pick-list">${liveProducts.map((p) => `<label><input type="checkbox" value="${p.id}" ${pre.has(p.id) ? 'checked' : ''}>${esc(p.name)}<span class="spacer"></span><span class="muted">${esc(batchName(p.batch_id))}</span></label>`).join('')}</div>
    </div>
    <div class="field"><span>類型</span>
      <div class="hour-pick" id="kind-pick">
        <label><input type="radio" name="kind" value="general">一般（美編）</label>
        <label><input type="radio" name="kind" value="premium">精製（外包）</label>
      </div></div>
    <label class="field"><span>優化者</span><select name="optimizer" disabled><option value="">先選類型</option></select></label>
    <label class="field"><span>截止日期（最早明天）</span><input type="date" name="date" min="${tomorrowYmd()}"></label>
    <div class="field"><span>截止時間</span>
      <div class="hour-pick" id="hour-pick">
        <label><input type="radio" name="hour" value="15">15:00</label>
        <label><input type="radio" name="hour" value="17">17:00</label>
      </div></div>
    <div id="dl-check"></div>
    <p class="missing" id="assign-missing"></p>
    <div class="acts"><button class="btn" data-close>取消</button><button class="btn primary" id="assign-go" disabled>指定優化</button></div>`,
  (m, close) => {
    const val = () => ({
      ids: [...m.querySelectorAll('.pick-list input:checked')].map((i) => Number(i.value)),
      kind: m.querySelector('[name=kind]:checked')?.value,
      optimizer: Number(m.querySelector('[name=optimizer]').value) || null,
      date: m.querySelector('[name=date]').value,
      hour: Number(m.querySelector('[name=hour]:checked')?.value) || null,
    });
    const update = async () => {
      const v = val();
      m.querySelectorAll('.hour-pick label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      m.querySelector('#pick-n').textContent = `已選 ${v.ids.length} 件`;
      const miss = [];
      if (!v.ids.length) miss.push('商品');
      if (!v.kind) miss.push('類型');
      if (!v.optimizer) miss.push('優化者');
      if (!v.date) miss.push('日期');
      else if (v.date < tomorrowYmd()) miss.push('日期（最早明天）');
      if (!v.hour) miss.push('時間（15:00 或 17:00）');
      m.querySelector('#assign-missing').textContent = miss.length ? `還缺：${miss.join('、')}` : '';
      m.querySelector('#assign-go').disabled = miss.length > 0;
      const box = m.querySelector('#dl-check');
      if (v.date && v.hour && v.kind) {
        try {
          const c = await api('GET', `/api/deadline-check?date=${v.date}&hour=${v.hour}&kind=${v.kind}`);
          const warns = [];
          if (!c.workday) warns.push('這天不是上班日，只會計算到前一個上班日下班');
          if (c.window_h < c.sla_h) warns.push(`到截止只有 ${fmtWork(c.window_h)}上班時間，比標準 ${fmtWork(c.sla_h)}短`);
          if (c.rush_now) warns.push('一指定就是急件');
          box.innerHTML = `<div class="muted">到截止共 <b class="mono">${esc(fmtWork(c.window_h))}</b> 上班時間，扣掉急件審核後，優化者約有 <b class="mono">${esc(fmtWork(c.optimizer_h))}</b></div>
            ${warns.map((w) => `<div class="warnbox">${esc(w)}</div>`).join('')}`;
        } catch { box.innerHTML = ''; }
      } else box.innerHTML = '';
    };
    m.querySelectorAll('[name=kind]').forEach((r) => {
      r.onchange = () => {
        const role = r.value === 'premium' ? 'external' : 'editor';
        const sel = m.querySelector('[name=optimizer]');
        sel.disabled = false;
        sel.innerHTML = optionsFor(role);
        update();
      };
    });
    m.addEventListener('change', update);
    m.querySelector('[data-all]').onclick = () => { m.querySelectorAll('.pick-list input').forEach((i) => { i.checked = true; }); update(); };
    m.querySelector('[data-none]').onclick = () => { m.querySelectorAll('.pick-list input').forEach((i) => { i.checked = false; }); update(); };
    m.querySelector('#assign-go').onclick = () => {
      const v = val();
      act(async () => {
        const r = await api('POST', '/api/optimizations', { product_ids: v.ids, kind: v.kind, optimizer_id: v.optimizer, date: v.date, hour: v.hour });
        close();
        toast(`已指定 ${r.done} 件${r.skipped.length ? `，${r.skipped.length} 件不是已上架狀態已略過` : ''}`);
      }, null);
    };
    update();
  });
}

// ---------- 商品頁 ----------

async function resizeImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const keepPng = file.type === 'image/png'; // 去背圖保留透明
    const blob = await new Promise((r) => c.toBlob(r, keepPng ? 'image/png' : 'image/jpeg', 0.88));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + (keepPng ? '.png' : '.jpg'), { type: blob.type }) : file;
  } catch {
    return file;
  }
}

async function uploadPhotos(productId, kind, files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return toast('請選擇圖片檔', true);
  await act(async () => {
    toast(`上傳中… ${imgs.length} 張`);
    const fd = new FormData();
    fd.append('kind', kind);
    for (const f of imgs) fd.append('file', await resizeImage(f));
    await api('POST', `/api/products/${productId}/photos`, fd);
  }, `已上傳 ${imgs.length} 張`);
}

function photoGrid(p, kind, { upload = false, rawChecks = false, del = false, download = false } = {}) {
  const list = p.photos.filter((ph) => ph.kind === kind && (kind !== 'opt' || ph.optimization_id === p.active_opt?.id || !p.active_opt));
  return `<div class="photos">
    ${list.map((ph, i) => {
      const complete = ph.chk_accurate && ph.chk_clear && ph.chk_ratio;
      return `<div class="photo ${rawChecks && !complete ? 'incomplete' : ''}">
        <img loading="lazy" src="/api/photos/${ph.id}" data-full="/api/photos/${ph.id}" alt="${esc(ph.filename)}" title="${esc(member(ph.uploaded_by)?.name ?? '')} · ${fmtTime(ph.created_at)}">
        ${rawChecks ? `<div class="rawchk" data-raw="${ph.id}">
          <b class="muted">第 ${i + 1} 張</b>
          <label><input type="checkbox" data-c="chk_accurate" ${ph.chk_accurate ? 'checked' : ''}>準確</label>
          <label><input type="checkbox" data-c="chk_clear" ${ph.chk_clear ? 'checked' : ''}>清楚</label>
          <label><input type="checkbox" data-c="chk_ratio" ${ph.chk_ratio ? 'checked' : ''}>比例正確</label>
        </div>` : ''}
        <div class="tools">
          ${download ? `<a class="btn small" href="/api/photos/${ph.id}?download=1">下載</a>` : ''}
          ${del ? `<button class="btn small danger" data-del-photo="${ph.id}">刪除</button>` : ''}
        </div>
      </div>`;
    }).join('')}
    ${upload ? `<label class="dropzone" data-drop="${kind}"><input type="file" accept="image/*" multiple hidden data-file="${kind}"><span>＋ 上傳${KIND[kind]}<br><span class="muted">點選或拖曳，可多張</span></span></label>` : ''}
    ${!upload && !list.length ? '<div class="muted">尚無</div>' : ''}
  </div>`;
}

function reviewForm(prefix) {
  return `
    <div class="checks" data-checks>
      <label><input type="checkbox" data-k="copy">文案</label>
      <label><input type="checkbox" data-k="price">價格</label>
      <label><input type="checkbox" data-k="photo">照片</label>
    </div>
    <div class="row">
      <button class="btn go act" data-pass disabled>${prefix}通過</button>
      <button class="btn danger act" data-open-return>退回…</button>
      <span class="missing" data-pass-missing>三項都勾才能通過</span>
    </div>
    <div data-return-form hidden style="margin-top:14px">
      <div class="field"><span>退回原因（可多選）</span>
        <div class="checks" data-reasons>
          <label><input type="checkbox" value="photo">照片不對</label>
          <label><input type="checkbox" value="copy">文案不對</label>
          <label><input type="checkbox" value="price">價格不對</label>
        </div></div>
      <label class="field"><span>要改什麼（必填）</span><textarea data-return-note placeholder="請寫要改什麼"></textarea></label>
      <div class="row"><span class="muted" data-route-hint></span><span class="spacer"></span><button class="btn warn act" data-return disabled>送出退回</button></div>
    </div>`;
}

function bindReviewForm(root, { onPass, onReturn, routeHint }) {
  const checks = root.querySelector('[data-checks]');
  const passBtn = root.querySelector('[data-pass]');
  const syncChecks = () => {
    checks.querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    const all = [...checks.querySelectorAll('input')].every((i) => i.checked);
    passBtn.disabled = !all;
    root.querySelector('[data-pass-missing]').textContent = all ? '' : '缺：' + [...checks.querySelectorAll('input')].filter((i) => !i.checked).map((i) => i.parentElement.textContent.trim()).join('、');
  };
  checks.addEventListener('change', syncChecks);
  syncChecks();
  passBtn.onclick = () => {
    const c = Object.fromEntries([...checks.querySelectorAll('input')].map((i) => [i.dataset.k, i.checked]));
    onPass(c);
  };
  const rf = root.querySelector('[data-return-form]');
  root.querySelector('[data-open-return]').onclick = () => { rf.hidden = !rf.hidden; };
  const note = rf.querySelector('[data-return-note]');
  const reasonsBox = rf.querySelector('[data-reasons]');
  const send = rf.querySelector('[data-return]');
  const syncReturn = () => {
    reasonsBox.querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    const reasons = [...reasonsBox.querySelectorAll('input:checked')].map((i) => i.value);
    const ok = reasons.length && note.value.trim();
    send.disabled = !ok;
    note.classList.toggle('invalid', !!reasons.length && !note.value.trim());
    rf.querySelector('[data-route-hint]').textContent = reasons.length ? routeHint(reasons) : '請選原因並寫留言';
  };
  rf.addEventListener('input', syncReturn);
  rf.addEventListener('change', syncReturn);
  syncReturn();
  send.onclick = () => onReturn([...reasonsBox.querySelectorAll('input:checked')].map((i) => i.value), note.value.trim());
}

function missingRaw(p) {
  const raws = p.photos.filter((ph) => ph.kind === 'raw');
  if (!raws.length) return ['至少 1 張原圖'];
  const out = [];
  raws.forEach((ph, i) => {
    const lack = [['chk_accurate', '準確'], ['chk_clear', '清楚'], ['chk_ratio', '比例正確']].filter(([k]) => !ph[k]).map(([, l]) => `「${l}」`);
    if (lack.length) out.push(`第 ${i + 1} 張未勾${lack.join('')}`);
  });
  return out;
}

function nextHolderName(p, step) {
  const field = { edit: 'editor_id', listing: 'lister_id', review: 'reviewer_id', publish: 'lister_id', opt_review: 'reviewer_id' }[step];
  return member(p[field])?.name ?? '';
}

function actionPanel(p) {
  const open = p.open;
  const mine = open && open.member_id === S.me.id;
  const returned = open?.start_reason === 'return' ? `
    <div class="returned"><b>被退回：${(open.reasons || []).map((r) => REASON[r]).join('、')}</b>（${esc(member(open.by_id)?.name ?? '')}・${fmtTime(open.started_at)}）
      <div class="note">${esc(open.note)}</div></div>` : '';
  const undo = p.undo_left_ms > 0 && p.undo_by === S.me.id
    ? `<div class="undo-bar"><span>已標記「已上架」</span><span class="num mono" id="undo-left">${Math.ceil(p.undo_left_ms / 1000)}</span><span>秒內可撤銷</span><span class="spacer"></span><button class="btn small" id="undo-btn">撤銷</button></div>` : '';
  const opt = p.active_opt;
  const deadline = opt ? `
    <div class="deadline-box ${opt.rush ? 'rush' : ''}">
      <div><div class="muted">截止</div><b>${esc(fmtDeadline(opt.deadline))}</b></div>
      <div><div class="muted">剩餘上班時間</div><span class="big">${opt.remaining_h > 0 ? esc(fmtWork(opt.remaining_h)) : '已逾期'}</span></div>
      ${opt.rush ? '<span class="tag rush">急件</span>' : ''}
      <div><div class="muted">類型</div>${opt.kind === 'premium' ? '精製（外包）' : '一般（美編）'}・第 ${opt.rounds} 輪</div>
    </div>` : '';

  if (p.step === 'live') {
    return `${undo}<div class="card action ${isMkt() ? 'mine' : 'locked'}">
      <h2>已上架 ${p.opt_version ? `<span class="tag green">優化 v${p.opt_version}</span>` : ''}</h2>
      <div class="sub">${p.published_at ? `發布於 ${fmtTime(p.published_at)}` : ''}${p.sl_url ? `・<a href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟 Shopline 頁面</a>` : ''}</div>
      ${isMkt() ? '<button class="btn primary act" id="assign-one">指定優化</button>' : '<div class="muted">由老闆／行銷決定是否優化</div>'}
    </div>`;
  }
  if (!open) return '';
  const holder = member(open.member_id);
  if (!mine) {
    return `${deadline}<div class="card action locked">
      <h2>目前在「${esc(stepLabel(p.step))}」</h2>
      <div class="sub">負責人：${who(open.member_id)}・已停留 <span class="mono">${esc(fmtWork(open.visit_held))}</span>${open.budget_hours ? `／標準 <span class="mono">${esc(fmtWork(open.budget_hours))}</span>` : ''}</div>
      <button class="btn disabled" disabled>只有 ${esc(holder?.name ?? '負責人')} 可以操作</button>
      <span class="muted">需要催的話，在下方留言 @${esc(holder?.name ?? '')}</span>
    </div>`;
  }
  const head = (title, sub) => `<h2>${title}</h2><div class="sub">${sub}</div>`;
  switch (p.step) {
    case 'raw': {
      const miss = missingRaw(p);
      return `<div class="card action mine">${returned}${head('步驟 1・上傳原圖並逐張勾選', '每張圖都要勾滿「準確／清楚／比例正確」才能送出')}
        ${photoGrid(p, 'raw', { upload: true, rawChecks: true, del: true })}
        <div class="row" style="margin-top:14px"><span class="missing">${miss.length ? '缺：' + esc(miss.join('；')) : ''}</span><span class="spacer"></span>
        <button class="btn primary act" data-do="complete_raw" ${miss.length ? 'disabled' : ''}>原圖完成 → 交給 ${esc(nextHolderName(p, 'edit'))}</button></div></div>`;
    }
    case 'edit': {
      const hasCut = p.photos.some((ph) => ph.kind === 'cutout');
      const hasMood = p.photos.some((ph) => ph.kind === 'mood');
      const miss = [!hasCut && '去背圖', !hasMood && '意象圖'].filter(Boolean);
      return `<div class="card action mine">${returned}${head('步驟 2・做去背圖與意象圖', '兩類各至少 1 張')}
        <div class="kind-title">原圖（參考）</div>${photoGrid(p, 'raw', { download: true })}
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout', { upload: true, del: true })}
        <div class="kind-title">意象圖</div>${photoGrid(p, 'mood', { upload: true, del: true })}
        <div class="row" style="margin-top:14px"><span class="missing">${miss.length ? '缺：' + miss.join('、') : ''}</span><span class="spacer"></span>
        <button class="btn primary act" data-do="complete_edit" ${miss.length ? 'disabled' : ''}>圖片完成 → 交給 ${esc(nextHolderName(p, 'listing'))}</button></div></div>`;
    }
    case 'listing':
      return `<div class="card action mine">${returned}${head('步驟 3・Shopline 建檔', '下載圖片到 Shopline 建檔，完成後貼上商品連結')}
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout', { download: true })}
        <div class="kind-title">意象圖</div>${photoGrid(p, 'mood', { download: true })}
        <form id="listing-form" style="margin-top:16px">
          <label class="field"><span>商品名稱</span><input type="text" name="sl_name" value="${esc(p.sl_name || p.name)}" maxlength="200"></label>
          <label class="field"><span>內文</span><textarea name="sl_body" style="min-height:120px">${esc(p.sl_body)}</textarea></label>
          <div class="row">
            <label class="field" style="flex:1;min-width:140px"><span>價格（只能數字）</span><input type="text" inputmode="decimal" name="sl_price" value="${esc(p.sl_price)}"></label>
            <label class="field" style="flex:3;min-width:220px"><span>Shopline 商品連結</span><input type="url" name="sl_url" value="${esc(p.sl_url)}" placeholder="https://"></label>
          </div>
          <div class="row"><span class="missing" id="listing-miss"></span><span class="spacer"></span>
            <button type="button" class="btn act" id="listing-save">儲存草稿</button>
            <button class="btn primary act" id="listing-done">建檔完成 → 交給 ${esc(nextHolderName(p, 'review'))}</button></div>
        </form></div>`;
    case 'review':
      return `<div class="card action mine">${returned}${head('步驟 4・審核三項', '對照圖片與 Shopline 頁面，三項都對才通過')}
        <dl class="kv" style="margin-bottom:12px"><dt>名稱</dt><dd>${esc(p.sl_name)}</dd><dt>價格</dt><dd class="mono">${esc(p.sl_price)}</dd>
          <dt>連結</dt><dd><a href="${esc(p.sl_url)}" target="_blank" rel="noopener">${esc(p.sl_url)}</a></dd><dt>內文</dt><dd>${esc(p.sl_body)}</dd></dl>
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout')}
        <div class="kind-title">意象圖</div>${photoGrid(p, 'mood')}
        <div style="margin-top:14px">${reviewForm('審核')}</div></div>`;
    case 'publish':
      return `<div class="card action mine">${head('步驟 5・Shopline 發布', '在 Shopline 發布後，回來按「已上架」')}
        <div class="row"><a class="btn" href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟 Shopline 頁面</a><span class="spacer"></span>
        <button class="btn go act" id="publish-btn">已上架</button></div></div>`;
    case 'optimizing':
      return `${deadline}<div class="card action mine">${returned}${head('優化・直接改 Shopline 線上頁面', '改完填寫改了什麼，按「已更新線上」交給審核')}
        <div class="row" style="margin-bottom:12px"><a class="btn" href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟 Shopline 頁面</a></div>
        <div class="kind-title">優化截圖（選填）</div>${photoGrid(p, 'opt', { upload: true, del: true })}
        <label class="field" style="margin-top:14px"><span>改了什麼（必填）</span><textarea id="opt-note" placeholder="例：換主圖、補尺寸表"></textarea></label>
        <div class="row"><span class="missing" id="opt-miss">請填寫改了什麼</span><span class="spacer"></span>
        <button class="btn primary act" id="opt-submit" disabled>已更新線上 → 交給 ${esc(nextHolderName(p, 'opt_review'))}</button></div></div>`;
    case 'opt_review': {
      const lastSubmit = [...p.stints].reverse().find((s) => s.step === 'optimizing' && s.end_note);
      return `${deadline}<div class="card action mine">${head('優化審核・事後檢查線上頁面', `${opt?.rush ? '急件：' : ''}標準 ${fmtWork(open.budget_hours)}內審完`)}
        <div class="row" style="margin-bottom:12px"><a class="btn primary" href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟 Shopline 線上頁面</a></div>
        ${lastSubmit ? `<div class="returned" style="background:var(--line-2);color:var(--ink)"><b>${esc(member(lastSubmit.member_id)?.name ?? '')} 改了什麼</b><div class="note">${esc(lastSubmit.end_note)}</div></div>` : ''}
        <div class="kind-title">優化截圖</div>${photoGrid(p, 'opt')}
        <div style="margin-top:14px">${reviewForm('優化')}</div></div>`;
    }
    default:
      return '';
  }
}

function attributionBlock(p) {
  if (!p.attribution.length) return '';
  const total = p.attribution.reduce((s, a) => s + a.held, 0) || 1;
  return `<div class="card section">
    <h2>時間歸屬 <span class="muted">上班時數・依超出排序</span></h2>
    <div class="attr-bar">${p.attribution.map((a) => `<div style="width:${(a.held / total) * 100}%;background:${member(a.member_id)?.color ?? '#999'}" title="${esc(member(a.member_id)?.name)} ${a.held}h"></div>`).join('')}</div>
    <div class="attr-row muted" style="font-size:12px"><span>負責人</span><span class="num">經手</span><span class="num">超出標準</span></div>
    ${p.attribution.map((a) => `<div class="attr-row">${who(a.member_id)}<span class="num mono">${a.held}h</span><span class="num mono ${a.over > 0 ? 'over' : ''}">${a.over > 0 ? a.over + 'h' : '—'}</span></div>`).join('')}
    ${p.breakdown ? `<div class="warnbox" style="margin-top:12px"><b>錯過截止時間</b>：${p.breakdown.rows.length ? p.breakdown.rows.map((r) => `${esc(member(r.member_id)?.name)}（${esc(stepLabel(r.step))}）超出 ${r.over}h`).join('、') : '沒有人超出自己的標準時間'}</div>` : ''}
  </div>`;
}

function ownersBlock(p) {
  const can = isMkt();
  const row = (label, field, role) => {
    const cur = p[field];
    return can
      ? `<label class="field"><span>${label}</span><select data-owner="${field}">${optionsFor(role, cur).replace('<option value="">請選擇</option>', '<option value="">未指定</option>')}</select></label>`
      : `<div class="row" style="margin-bottom:8px"><span class="muted" style="width:70px">${label}</span>${cur ? who(cur) : '<span class="muted">未指定</span>'}</div>`;
  };
  const opt = p.active_opt;
  return `<div class="card section"><h2>負責人 ${can ? '<span class="muted">改派會寫入紀錄</span>' : ''}</h2>
    ${row('選品', 'picker_id', 'picker')}${row('美編', 'editor_id', 'editor')}${row('上架人員', 'lister_id', 'lister')}${row('審核人', 'reviewer_id', 'reviewer')}
    ${opt ? (can
      ? `<label class="field"><span>優化者（${opt.kind === 'premium' ? '外包' : '美編'}）</span><select data-owner="optimizer_id">${optionsFor(opt.kind === 'premium' ? 'external' : 'editor', opt.optimizer_id)}</select></label>`
      : `<div class="row"><span class="muted" style="width:70px">優化者</span>${who(opt.optimizer_id)}</div>`) : ''}
  </div>`;
}

function timelineBlock(p) {
  const items = [...p.stints].reverse();
  return `<div class="card section"><h2>流程紀錄</h2><ul class="timeline">
    ${items.map((s) => {
      const endTxt = { complete: '完成', pass: '通過', return: '退回', publish: '發布', submit: '更新線上', reassign: '改派' }[s.end_reason] || '';
      return `<li class="${s.start_reason === 'return' ? 'ret' : ''} ${s.ended_at == null ? 'open' : ''}">
        <b>${esc(stepLabel(s.step))}</b>・${esc(member(s.member_id)?.name ?? '—')}
        <span class="muted">${fmtTime(s.started_at)} → ${s.ended_at ? fmtTime(s.ended_at) + ' ' + endTxt : '進行中'}・經手 ${esc(fmtWork(s.held))}${s.over > 0 ? `・<span class="over">超出 ${Math.round(s.over * 10) / 10}h</span>` : ''}</span>
        ${s.start_reason === 'return' ? `<div class="note"><b>被 ${esc(member(s.by_id)?.name ?? '')} 退回（${(s.reasons || []).map((r) => REASON[r]).join('、')}）</b>\n${esc(s.note)}</div>` : ''}
        ${s.start_reason === 'reassign' ? `<div class="muted">由 ${esc(member(s.by_id)?.name ?? '')} 改派</div>` : ''}
        ${s.end_note ? `<div class="note">改了什麼：${esc(s.end_note)}</div>` : ''}
      </li>`;
    }).join('')}
  </ul></div>`;
}

function commentBody(text) {
  let html = esc(text);
  for (const m of S.members) {
    const at = '@' + esc(m.name);
    if (html.includes(at)) html = html.split(at).join(`<span class="at">${at}</span>`);
  }
  return html;
}

function commentsBlock(p) {
  return `<div class="card section" id="comments"><h2>留言 <span class="muted num">${p.comments.length}</span></h2>
    ${p.my_mentions.length ? `<div class="row" style="margin-bottom:10px"><span class="tag mention">有人 @ 你</span><button class="btn small" id="ack-all">知道了</button></div>` : ''}
    <div class="comments">
      ${p.comments.map((c) => `<div class="comment">${avatar(member(c.member_id))}
        <div class="bubble"><div class="hd"><b>${esc(member(c.member_id)?.name ?? '—')}</b><span class="mono">${fmtTime(c.created_at)}</span>
          ${c.member_id === S.me.id || S.me.is_admin ? `<button class="btn small" data-del-comment="${c.id}" style="margin-left:auto">刪除</button>` : ''}</div>
          <div class="text">${commentBody(c.body)}</div></div></div>`).join('') || '<div class="muted">還沒有留言</div>'}
    </div>
    <form id="comment-form" style="position:relative">
      <textarea name="body" placeholder="輸入 @ 可以提及成員（Ctrl + Enter 送出）" maxlength="2000"></textarea>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn primary act">送出留言</button></div>
    </form></div>`;
}

function bindMentionPicker(textarea) {
  let pop = null;
  let sel = 0;
  let matches = [];
  const close = () => { pop?.remove(); pop = null; };
  const query = () => {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const m = before.match(/@([^\s@]*)$/);
    return m ? m[1] : null;
  };
  const insert = (name) => {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos).replace(/@([^\s@]*)$/, '@' + name + ' ');
    textarea.value = before + textarea.value.slice(pos);
    textarea.setSelectionRange(before.length, before.length);
    textarea.dataset.dirty = '1';
    close();
    textarea.focus();
  };
  const show = () => {
    const q = query();
    if (q === null) return close();
    matches = S.members.filter((m) => m.active && m.id !== S.me.id && m.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
    if (!matches.length) return close();
    sel = Math.min(sel, matches.length - 1);
    if (!pop) { pop = document.createElement('div'); pop.className = 'mention-pop'; textarea.parentElement.appendChild(pop); }
    pop.style.left = '0';
    pop.style.top = textarea.offsetHeight + 'px';
    pop.innerHTML = matches.map((m, i) => `<button type="button" class="${i === sel ? 'sel' : ''}" data-n="${esc(m.name)}">${avatar(m, 22)}${esc(m.name)}<span class="muted">${esc(rolesText(m))}</span></button>`).join('');
    pop.querySelectorAll('button').forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); insert(b.dataset.n); }; });
  };
  textarea.addEventListener('input', () => { sel = 0; show(); });
  textarea.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % matches.length; show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; show(); }
    else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); insert(matches[sel].name); }
    else if (e.key === 'Escape') close();
  });
  textarea.addEventListener('blur', () => setTimeout(close, 150));
}

let undoTimer;
async function viewProduct(idStr) {
  const id = Number(idStr);
  const p = await api('GET', `/api/products/${id}`);
  const idx = STEP_ORDER.indexOf(p.step);
  const nextId = S.radarKeys[S.radarKeys.indexOf(id) + 1] || (S.radarKeys[0] !== id ? S.radarKeys[0] : null);
  $app.innerHTML = `
    <div class="page-head">
      <a href="#/radar" class="btn small">← ${S.me.is_external ? '我的優化' : '雷達'}</a>
      <h1>${esc(p.name)}</h1>${stepChip(p.step)}
      ${p.open?.color === 'red' ? '<span class="tag red">紅色超時</span>' : p.open?.color === 'yellow' ? '<span class="tag yellow">黃色超時</span>' : p.open?.color === 'rush' ? '<span class="tag rush">急件</span>' : ''}
      <span class="muted">${esc(p.batch_name)}</span>
      <span class="spacer"></span>
      ${nextId ? `<a class="btn small" href="#/p/${nextId}">下一件 →</a>` : ''}
      ${S.me.is_admin ? '<button class="btn small danger" id="del-product">刪除</button>' : ''}
    </div>
    <div class="stepper">${STEP_ORDER.map((s, i) => `<div class="step ${i < idx ? 'done' : ''} ${i === idx ? 'cur' : ''}" style="${i === idx ? `background:${STEP_COLOR[s]}` : ''}">${i < idx && idx <= 5 ? '✓ ' : ''}${esc(stepLabel(s))}</div>`).join('')}</div>
    <div id="action">${actionPanel(p)}</div>
    <div class="detail">
      <div>
        ${!['raw', 'edit'].includes(p.step) || p.open?.member_id !== S.me.id ? `<div class="card section"><h2>圖片</h2>
          ${['raw', 'cutout', 'mood', 'opt'].filter((k) => p.photos.some((ph) => ph.kind === k)).map((k) => `<div class="kind-title">${KIND[k]}</div>${photoGrid(p, k, { download: true })}`).join('') || '<div class="muted">尚無圖片</div>'}
        </div>` : ''}
        ${commentsBlock(p)}
      </div>
      <div>
        ${p.sl_url && p.step !== 'review' ? `<div class="card section"><h2>Shopline 資料</h2><dl class="kv"><dt>名稱</dt><dd>${esc(p.sl_name)}</dd><dt>價格</dt><dd class="mono">${esc(p.sl_price)}</dd><dt>連結</dt><dd><a href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟</a></dd></dl></div>` : ''}
        ${attributionBlock(p)}
        ${S.me.is_external ? '' : ownersBlock(p)}
        ${timelineBlock(p)}
      </div>
    </div>`;
  bindProduct(p);
}

function afterHandoff(p, toName) {
  S.handled = { name: p.name, to: toName, at: Date.now() };
  location.hash = '#/radar';
}

function bindProduct(p) {
  const id = p.id;
  const doAction = (action, extra = {}, handoffTo = null) => act(async () => {
    await api('POST', `/api/products/${id}/action`, { action, version: p.version, ...extra });
    $app.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    if (handoffTo !== null) afterHandoff(p, handoffTo);
  }, handoffTo !== null ? null : '已完成', handoffTo !== null ? 'none' : 'refresh');

  $app.querySelectorAll('[data-do]').forEach((b) => {
    b.onclick = () => {
      const next = { complete_raw: 'edit', complete_edit: 'listing' }[b.dataset.do];
      doAction(b.dataset.do, {}, nextHolderName(p, next));
    };
  });

  // 原圖逐張勾選
  // 勾選只更新提示與完成鈕，不重畫整頁
  $app.querySelectorAll('[data-raw]').forEach((box) => {
    box.addEventListener('change', async () => {
      const data = Object.fromEntries([...box.querySelectorAll('input')].map((i) => [i.dataset.c, i.checked ? 1 : 0]));
      const ok = await act(() => api('PATCH', `/api/photos/${box.dataset.raw}`, data), null, 'none');
      if (!ok) return refresh();
      Object.assign(p.photos.find((ph) => ph.id === Number(box.dataset.raw)), data);
      box.closest('.photo').classList.toggle('incomplete', !(data.chk_accurate && data.chk_clear && data.chk_ratio));
      const miss = missingRaw(p);
      const btn = $app.querySelector('[data-do=complete_raw]');
      btn.disabled = miss.length > 0;
      btn.parentElement.querySelector('.missing').textContent = miss.length ? '缺：' + miss.join('；') : '';
    });
  });

  $app.querySelectorAll('[data-file]').forEach((input) => { input.onchange = () => uploadPhotos(id, input.dataset.file, input.files); });
  $app.querySelectorAll('[data-drop]').forEach((dz) => {
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); uploadPhotos(id, dz.dataset.drop, e.dataTransfer.files); };
  });
  $app.querySelectorAll('img[data-full]').forEach((img) => {
    img.onclick = () => {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${img.dataset.full}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    };
  });
  $app.querySelectorAll('[data-del-photo]').forEach((b) => {
    b.onclick = () => confirm('刪除這張照片？') && act(() => api('DELETE', `/api/photos/${b.dataset.delPhoto}`), '已刪除');
  });

  // 建檔
  const lf = document.getElementById('listing-form');
  if (lf) {
    const vals = () => ({ sl_name: lf.sl_name.value, sl_body: lf.sl_body.value, sl_price: lf.sl_price.value.trim(), sl_url: lf.sl_url.value.trim() });
    const sync = () => {
      const v = vals();
      const miss = [!v.sl_name.trim() && '名稱', !v.sl_body.trim() && '內文', !v.sl_price && '價格', !v.sl_url && 'Shopline 連結'].filter(Boolean);
      const badPrice = v.sl_price && !/^\d+(\.\d{1,2})?$/.test(v.sl_price);
      lf.sl_price.classList.toggle('invalid', !!badPrice);
      document.getElementById('listing-miss').textContent = badPrice ? '價格只能填數字' : miss.length ? '缺：' + miss.join('、') : '';
      document.getElementById('listing-done').disabled = !!(miss.length || badPrice);
    };
    lf.addEventListener('input', sync);
    sync();
    document.getElementById('listing-save').onclick = () => act(async () => {
      await api('POST', `/api/products/${id}/action`, { action: 'save_listing', version: p.version, ...vals() });
      lf.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    }, '已儲存草稿');
    lf.onsubmit = (e) => { e.preventDefault(); doAction('complete_listing', vals(), nextHolderName(p, 'review')); };
  }

  // 審核（第 4 步與第 4' 步）
  const actionEl = document.getElementById('action');
  if (actionEl.querySelector('[data-checks]')) {
    const isOpt = p.step === 'opt_review';
    bindReviewForm(actionEl, {
      onPass: (checks) => isOpt
        ? doAction('opt_pass', { checks }, '（已上架，記錄新版本）')
        : doAction('review_pass', { checks }, nextHolderName(p, 'publish')),
      onReturn: (reasons, note) => {
        const to = isOpt ? member(p.active_opt.optimizer_id)?.name : reasons.includes('photo') ? nextHolderName(p, 'edit') : nextHolderName(p, 'listing');
        doAction(isOpt ? 'opt_return' : 'review_return', { reasons, note }, `${to}（退回）`);
      },
      routeHint: (reasons) => isOpt
        ? `會退回 ${member(p.active_opt.optimizer_id)?.name ?? '優化者'}`
        : reasons.includes('photo')
          ? `會退回美編 ${nextHolderName(p, 'edit')}${reasons.length > 1 ? '，其餘原因寫在留言讓下一關看到' : ''}`
          : `會退回上架人員 ${nextHolderName(p, 'listing')}`,
    });
  }

  // 發布：二次確認 → 30 秒撤銷
  const pub = document.getElementById('publish-btn');
  if (pub) {
    pub.onclick = () => openModal(`
      <h3>確認已在 Shopline 發布？</h3>
      <p>「${esc(p.name)}」會標記為已上架。<br><span class="muted">送出後 30 秒內可以撤銷。撤銷只會改系統紀錄，不會撤回 Shopline 上的發布。</span></p>
      <div class="acts"><button class="btn" data-close>取消</button><button class="btn go" id="pub-confirm">確認已上架</button></div>`,
    (m, close) => {
      m.querySelector('#pub-confirm').onclick = () => { close(); doAction('publish'); };
    });
  }
  const undoBtn = document.getElementById('undo-btn');
  clearInterval(undoTimer);
  if (undoBtn) {
    let left = Math.ceil(p.undo_left_ms / 1000);
    undoTimer = setInterval(() => {
      left--;
      const el = document.getElementById('undo-left');
      if (!el || left <= 0) { clearInterval(undoTimer); if (el) refresh(); return; }
      el.textContent = left;
    }, 1000);
    undoBtn.onclick = () => { clearInterval(undoTimer); doAction('undo_publish'); };
  }

  // 優化
  const optNote = document.getElementById('opt-note');
  if (optNote) {
    const btn = document.getElementById('opt-submit');
    optNote.oninput = () => {
      btn.disabled = !optNote.value.trim();
      document.getElementById('opt-miss').textContent = optNote.value.trim() ? '' : '請填寫改了什麼';
    };
    btn.onclick = () => doAction('submit_opt', { note: optNote.value.trim() }, nextHolderName(p, 'opt_review'));
  }
  const assignOne = document.getElementById('assign-one');
  if (assignOne) assignOne.onclick = () => openAssignModal([{ id: p.id, name: p.name, batch_id: p.batch_id }], [p.id]);

  // 改派
  $app.querySelectorAll('[data-owner]').forEach((sel) => {
    sel.onchange = () => {
      const name = sel.options[sel.selectedIndex].text;
      if (!confirm(`改派給「${name}」？`)) { sel.value = sel.dataset.prev ?? sel.value; delete sel.dataset.dirty; return refresh(); }
      act(() => api('PATCH', `/api/products/${id}/owners`, { version: p.version, [sel.dataset.owner]: Number(sel.value) || null }), '已改派');
    };
  });

  // 留言
  const cf = document.getElementById('comment-form');
  bindMentionPicker(cf.body);
  cf.onsubmit = (e) => {
    e.preventDefault();
    const text = cf.body.value.trim();
    if (!text) return;
    act(async () => {
      const r = await api('POST', `/api/products/${id}/comments`, { body: text });
      delete cf.body.dataset.dirty;
      cf.body.value = '';
      if (r.mentioned.length) toast(`已通知 ${r.mentioned.join('、')}`);
    });
  };
  cf.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) cf.requestSubmit(); });
  $app.querySelectorAll('[data-del-comment]').forEach((b) => {
    b.onclick = () => confirm('刪除這則留言？') && act(() => api('DELETE', `/api/comments/${b.dataset.delComment}`), '已刪除');
  });
  const ack = document.getElementById('ack-all');
  if (ack) ack.onclick = () => act(async () => { for (const m of p.my_mentions) await api('POST', `/api/mentions/${m.id}/ack`); });

  const del = document.getElementById('del-product');
  if (del) del.onclick = () => confirm(`刪除「${p.name}」？（可在設定 → 回收區還原）`) &&
    act(async () => { await api('DELETE', `/api/products/${id}`); location.hash = '#/radar'; }, '已刪除', 'none');
}

// ---------- 整批進度 ----------

async function viewBatches() {
  const list = await api('GET', '/api/batches');
  $app.innerHTML = `
    <div class="page-head"><h1>整批進度</h1><span class="muted">依進貨批次；已上架含優化中</span></div>
    ${list.length ? `<div class="batches">${list.map((b) => `
      <div class="card section">
        <h2>${esc(b.name)}<span class="spacer"></span><span class="mono">${b.listed}/${b.total}</span></h2>
        <div class="progress"><div style="width:${b.listed_pct}%"></div></div>
        <div class="stepcounts">${STEP_ORDER.map((s) => `<div class="${b.counts[s] ? '' : 'zero'}"><b>${b.counts[s] || 0}</b>${esc(stepLabel(s))}</div>`).join('')}</div>
        ${b.slowest ? `<div class="row" style="font-size:14px"><span class="muted">最慢</span><a href="#/p/${b.slowest.product_id}">${esc(b.slowest.name)}</a>
          卡在 ${stepChip(b.slowest.step)} ${who(b.slowest.holder_id)} <span class="mono">${esc(fmtWork(b.slowest.held_h))}</span></div>` : '<div class="muted">這批都已上架</div>'}
      </div>`).join('')}</div>` : '<p class="empty">還沒有批次。選品建卡時會建立批次。</p>'}`;
}

// ---------- 延誤分析 ----------

async function viewAnalysis() {
  const a = S.ana;
  const r = await api('GET', `/api/analysis?scope=${a.scope}&days=${a.days}&batch=${a.batch}`);
  const m = r.metrics;
  const maxOver = Math.max(1, ...r.ranking.map((x) => x.over));
  const kpi = (label, value, unit, hint) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value ?? '—'}${value != null && unit ? `<small> ${unit}</small>` : ''}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  $app.innerHTML = `
    <div class="page-head">
      <h1>延誤分析</h1>
      <div class="seg" data-f="scope">${[['all', '全部'], ['rush', '急件'], ['normal', '一般件']].map(([k, l]) => `<button data-v="${k}" class="${a.scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" data-f="days">${[[7, '7 天'], [30, '30 天'], [90, '90 天'], [0, '全部']].map(([k, l]) => `<button data-v="${k}" class="${a.days === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="ana-batch" style="max-width:220px"><option value="0">全部批次</option>${S.batches.map((b) => `<option value="${b.id}" ${a.batch === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    </div>
    <div class="kpis">
      ${kpi('卡關平均停留', m.stuck_dwell_h, 'h', `從變黃到有人動作・${m.stuck_n} 次`)}
      ${kpi('誤報率', m.false_alarm_rate, '%', `變黃後沒人催就完成・${m.false_alarm_n} 次`)}
      ${kpi('審核一次通過率', m.review_first_pass.rate, '%', `第 4 步・${m.review_first_pass.n} 件`)}
      ${kpi('優化一次通過率', m.opt_first_pass.rate, '%', `第 4' 步・${m.opt_first_pass.n} 件`)}
      ${kpi('美編平均停留', m.edit_avg_h, 'h', '整條線的瓶頸關卡')}
      ${kpi('發布撤銷', m.undo_count, '次')}
      ${kpi('錯過截止', m.missed_deadlines, '件', '優化期限')}
    </div>
    <div class="card section">
      <h2>延誤排行 <span class="muted">依「超出標準時間」排序，SLA 長的關卡不吃虧</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>#</th><th>負責人</th><th>身分</th><th class="num">經手</th><th>超出標準</th><th class="num">延誤次數</th><th>判斷</th></tr></thead>
        <tbody>${r.ranking.map((x, i) => `<tr>
          <td class="mono">${i + 1}</td><td>${who(x.member_id)}</td><td class="muted">${x.roles.map((ro) => S.roles[ro]).join('、')}</td>
          <td class="num mono">${x.held}h</td>
          <td style="min-width:140px"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="overbar" style="width:${(x.over / maxOver) * 100}px"></div><span class="mono ${x.over > 0 ? 'over' : ''}">${x.over}h</span></div></td>
          <td class="num mono">${x.late_count}</td>
          <td>${x.late_count ? `${x.speed ? `<span class="tag yellow">個人速度 ${x.speed}</span> ` : ''}${x.capacity ? `<span class="tag blue">產能不足 ${x.capacity}</span>` : ''}` : '<span class="tag green">準時</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">這個範圍還沒有資料</td></tr>'}</tbody>
      </table></div>
      <p class="muted" style="margin-top:12px">「產能不足」：延誤當下手上件數 ≥ 同身分平均的 ${S.settings.capacity_ratio} 倍，建議加人或錯開發件；否則標「個人速度」。優化者只看是否在截止時間前交件，審核拖延的時間不算在優化者身上。</p>
    </div>`;
  $app.querySelectorAll('[data-f]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { const k = seg.dataset.f; S.ana[k] = k === 'days' ? Number(b.dataset.v) : b.dataset.v; viewAnalysis(); };
    });
  });
  document.getElementById('ana-batch').onchange = (e) => { S.ana.batch = Number(e.target.value); viewAnalysis(); };
}

// ---------- 紀錄 ----------

const ACTIONS = {
  product_add: '新增商品', raw_done: '完成原圖', edit_done: '完成美編圖', listing_done: '完成建檔', listing_save: '儲存建檔草稿',
  review_pass: '審核通過', review_return: '退回', publish: '發布', publish_undo: '撤銷發布', opt_assign: '指定優化',
  opt_submit: '更新線上', opt_pass: '優化審核通過', opt_return: '退回優化', reassign: '改派', comment_add: '留言',
  comment_delete: '刪除留言', photo_add: '上傳照片', photo_delete: '刪除照片', mention_ack: '已讀提及',
  member_add: '新增成員', member_edit: '修改成員', member_reset: '重設綁定', link_create: '產生外包連結', link_revoke: '讓外包連結失效',
  settings_edit: '修改設定', batch_edit: '修改批次', product_delete: '刪除商品', product_restore: '還原商品', photo_restore: '還原照片', comment_restore: '還原留言',
};

async function viewLog() {
  const items = await api('GET', '/api/activity?limit=200');
  $app.innerHTML = `
    <div class="page-head"><h1>紀錄</h1><span class="muted">誰、何時、做了什麼</span></div>
    <div class="card section">
      ${items.map((a) => `<div class="log-item">${avatar(member(a.member_id))}<div><b>${esc(member(a.member_id)?.name ?? '—')}</b> ${ACTIONS[a.action] ?? esc(a.action)}
        ${a.product_id ? ` <a href="#/p/${a.product_id}">${esc(a.product_name ?? '')}</a>` : ''}
        ${a.detail ? `<span class="muted">・${esc(a.detail)}</span>` : ''}</div><time>${fmtTime(a.at)}</time></div>`).join('') || '<p class="empty">還沒有紀錄</p>'}
    </div>`;
}

// ---------- 設定（管理員） ----------

async function viewSettings() {
  if (!S.me.is_admin) { $app.innerHTML = '<p class="empty">只有管理員可以進入設定</p>'; return; }
  const trash = await api('GET', '/api/trash');
  const st = S.settings;
  const internalRoles = Object.entries(S.roles).filter(([k]) => k !== 'external');
  const SLA_LABEL = { raw: '原圖', edit: '美編', listing: '建檔', review: '審核', publish: '發布', opt_general: '一般優化', opt_premium: '精製優化', opt_review: '優化審核' };
  $app.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <div class="set-grid">
      <div class="card section">
        <h2>成員</h2>
        <p class="muted" style="margin-top:-6px">成員第一次選名字後綁定裝置。換裝置或選錯，按「重設綁定」。外包設計師用連結進入。</p>
        ${S.members.map((m) => `
          <div class="mrow" data-member="${m.id}">
            <div class="top">${avatar(m)}<input type="text" value="${esc(m.name)}" maxlength="30" data-name>
              ${m.is_admin ? '<span class="tag blue">管理員</span>' : ''}
              ${!m.active ? '<span class="tag red">停用</span>' : m.is_external ? (m.bound ? '<span class="tag green">連結有效</span>' : '<span class="tag">無連結</span>') : m.bound ? `<span class="tag green" title="${fmtTime(m.bound_at)}">已綁定</span>` : '<span class="tag">未綁定</span>'}
            </div>
            ${m.is_external ? '<div class="roles"><span class="tag">外包設計師</span></div>' : `<div class="roles">${internalRoles.map(([k, l]) => `<label class="${m.roles.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${m.roles.includes(k) ? 'checked' : ''}>${l}</label>`).join('')}</div>`}
            <div class="row">
              <button class="btn small" data-a="save">儲存</button>
              ${m.is_external
                ? `<button class="btn small" data-a="link">${m.bound ? '重新產生連結' : '產生連結'}</button>${m.bound ? '<button class="btn small danger" data-a="reset">讓連結失效</button>' : ''}`
                : `${m.bound ? '<button class="btn small danger" data-a="reset">重設綁定</button>' : ''}<button class="btn small" data-a="admin">${m.is_admin ? '取消管理員' : '設為管理員'}</button>`}
              <button class="btn small ${m.active ? 'danger' : ''}" data-a="active">${m.active ? '停用' : '啟用'}</button>
            </div>
            <div data-linkbox></div>
          </div>`).join('')}
        <form id="add-member" style="margin-top:14px">
          <div class="row"><input type="text" name="name" placeholder="新成員名字" maxlength="30" required style="flex:1;width:auto">
            <select name="type" style="width:auto"><option value="internal">內部成員</option><option value="external">外包設計師</option></select>
            <button class="btn primary">新增</button></div>
        </form>
      </div>

      <div>
        <form class="card section" id="work-form">
          <h2>上班時間與 SLA</h2>
          <div class="field"><span>上班日</span><div class="days">${['日', '一', '二', '三', '四', '五', '六'].map((d, i) => `<label class="${st.work.days.includes(i) ? 'on' : ''}"><input type="checkbox" value="${i}" ${st.work.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
          <div class="row">
            <label class="field" style="flex:1"><span>上班</span><input type="number" name="start" min="0" max="23" value="${st.work.start}"></label>
            <label class="field" style="flex:1"><span>下班</span><input type="number" name="end" min="1" max="24" value="${st.work.end}"></label>
          </div>
          <label class="field"><span>國定假日（一行一天，YYYY-MM-DD）</span><textarea name="holidays" placeholder="2026-10-09&#10;2026-10-10">${esc(st.work.holidays.join('\n'))}</textarea></label>
          <div class="field"><span>各步 SLA（上班日，1 天 = ${st.day_hours} 小時）</span>
            <div class="sla-grid">${Object.entries(SLA_LABEL).map(([k, l]) => `<label class="field" style="margin:0"><span>${l}</span><input type="number" step="0.5" min="0.5" name="sla_${k}" value="${st.sla_days[k]}"></label>`).join('')}</div></div>
          <div class="row">
            <label class="field" style="flex:1;min-width:140px"><span>急件門檻（上班日）</span><input type="number" step="0.5" min="0.5" name="rush_days" value="${st.rush_threshold_days}"></label>
            <label class="field" style="flex:1;min-width:140px"><span>急件審核（上班小時）</span><input type="number" step="0.5" min="0.5" name="rush_review" value="${st.rush_review_hours}"></label>
            <label class="field" style="flex:1;min-width:140px"><span>產能不足門檻（倍）</span><input type="number" step="0.1" min="1" name="ratio" value="${st.capacity_ratio}"></label>
          </div>
          <div class="row"><span class="spacer"></span><button class="btn primary">儲存設定</button></div>
        </form>

        <div class="card section">
          <h2>回收區</h2>
          ${[
            ...trash.products.map((x) => ({ type: 'product', id: x.id, label: `商品「${x.name}」`, at: x.deleted_at })),
            ...trash.photos.map((x) => ({ type: 'photo', id: x.id, label: `${KIND[x.kind] || '照片'}（${x.product_name}）`, at: x.deleted_at })),
            ...trash.comments.map((x) => ({ type: 'comment', id: x.id, label: `留言「${x.body.slice(0, 20)}」（${x.product_name}）`, at: x.deleted_at })),
          ].sort((a, b) => b.at - a.at).map((x) => `<div class="set-row"><span style="flex:1">${esc(x.label)}</span><span class="muted mono">${fmtTime(x.at)}</span>
            <button class="btn small" data-restore="${x.type}:${x.id}">還原</button></div>`).join('') || '<p class="muted">回收區是空的</p>'}
        </div>
      </div>
    </div>`;

  $app.querySelectorAll('.days input, .mrow .roles input').forEach((i) => {
    i.addEventListener('change', () => i.parentElement.classList.toggle('on', i.checked));
  });
  $app.querySelectorAll('[data-member]').forEach((row) => {
    const id = Number(row.dataset.member);
    const m = member(id);
    row.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'save') {
          const roles = m.is_external ? ['external'] : [...row.querySelectorAll('.roles input:checked')].map((i) => i.value);
          act(async () => { await api('PATCH', `/api/members/${id}`, { name: row.querySelector('[data-name]').value, roles }); row.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty); }, '已儲存');
        }
        if (a === 'admin') act(() => api('PATCH', `/api/members/${id}`, { is_admin: !m.is_admin }), '已更新');
        if (a === 'active') act(() => api('PATCH', `/api/members/${id}`, { active: !m.active }), '已更新');
        if (a === 'reset' && confirm(m.is_external ? `讓「${m.name}」的連結失效？\n提醒：Shopline 帳號權限要另外去 Shopline 關閉。` : `重設「${m.name}」的裝置綁定？\n原裝置會立即登出，名字重新出現在登入頁。`)) {
          act(() => api('POST', `/api/members/${id}/reset`), m.is_external ? '連結已失效' : '已重設');
        }
        if (a === 'link') {
          if (m.bound && !confirm('重新產生會讓舊連結失效，確定？')) return;
          act(async () => {
            const { token } = await api('POST', `/api/members/${id}/link`);
            const url = `${location.origin}/?x=${token}`;
            await refresh();
            const box = document.querySelector(`[data-member="${id}"] [data-linkbox]`);
            if (box) box.innerHTML = `<div class="linkbox">${esc(url)}</div><button class="btn small" id="copy-link-${id}" style="margin-top:6px">複製連結</button><span class="muted">連結只顯示這一次</span>`;
            const cp = document.getElementById(`copy-link-${id}`);
            if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(url); toast('已複製'); } catch { toast('請手動複製', true); } };
          }, null, 'none');
        }
      };
    });
  });
  document.getElementById('add-member').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    act(() => api('POST', '/api/members', { name: f.name.value, roles: f.type.value === 'external' ? ['external'] : [] }), '已新增，記得勾選身分');
  };
  document.getElementById('work-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {
      work: {
        days: [...f.querySelectorAll('.days input:checked')].map((i) => Number(i.value)),
        start: Number(f.start.value), end: Number(f.end.value),
        holidays: f.holidays.value.split(/\s+/).filter(Boolean),
      },
      sla_days: Object.fromEntries(Object.keys(SLA_LABEL).map((k) => [k, Number(f['sla_' + k].value)])),
      rush_threshold_days: Number(f.rush_days.value), rush_review_hours: Number(f.rush_review.value), capacity_ratio: Number(f.ratio.value),
    };
    act(async () => { await api('PUT', '/api/settings', data); f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty); }, '設定已儲存');
  };
  $app.querySelectorAll('[data-restore]').forEach((b) => {
    const [type, rid] = b.dataset.restore.split(':');
    b.onclick = () => act(() => api('POST', '/api/restore', { type, id: Number(rid) }), '已還原');
  });
}

boot().catch((e) => { if (!e.network) $app.innerHTML = `<p class="empty">無法載入：${esc(e.message)}</p>`; });
