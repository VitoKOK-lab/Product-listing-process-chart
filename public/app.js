// TZG 上架跟進 — 前端（無框架，hash 路由）
// 所有時數、顏色、排序都由後端計算，前端只負責顯示
'use strict';

const POLL_MS = 10000;
const MAX_EDGE = 1920;
const STEP_ORDER = ['raw', 'listing', 'review', 'assign', 'optimizing', 'final_review', 'done'];
const FLOW_COLS = ['raw', 'listing', 'review', 'assign', 'optimizing', 'final_review'];
const STEP_COLOR = {
  raw: '#3D4F7A', listing: '#1B7F8C', review: '#1E4E8C', assign: '#B8741A',
  optimizing: '#6B3FA0', final_review: '#1E4E8C', done: '#0E7C5A',
};
const REASON = { photo: '照片', copy: '文案', price: '價格' };
const KIND = { raw: '原圖', opt: '優化截圖' };
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
  lastLoad: null, offline: false, fails: 0, ovBatch: null, ovSort: 'progress', ana: { scope: 'all', days: 30, batch: 0 },
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
  if (!location.hash) location.hash = S.me.is_external ? '#/radar' : '#/overview';
  await render();
}

function renderNav() {
  const items = S.me.is_external
    ? [['radar', '我的優化']]
    : [['overview', '全覽'], ['radar', '我的待辦'], ['analysis', '延誤分析'], ['log', '紀錄'], ...(S.me.is_admin ? [['settings', '設定']] : [])];
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
    if (v.v !== S.version || (['radar', 'overview'].includes(route) && Date.now() - S.lastLoad > 60000)) await refresh();
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
  const ROLE_NAME = { picker: '選品', editor: '美編', lister: '上架人員', reviewer: '審查人', marketing: '老闆／行銷', none: '管理員' };
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

const currentRoute = () => (location.hash.replace(/^#\/?/, '') || (S.me?.is_external ? 'radar' : 'overview')).split('/');
window.addEventListener('hashchange', () => { if (S.me) render(); });

async function render() {
  const [route, arg] = currentRoute();
  if (route !== 'radar' && document.querySelector('[data-view=radar]')) S.radarScroll = window.scrollY;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (['p', 'new'].includes(route) && a.dataset.route === (S.me.is_external ? 'radar' : 'overview'))));
  const views = { overview: viewOverview, radar: viewRadar, analysis: viewAnalysis, log: viewLog, settings: viewSettings, p: viewProduct, new: viewNew };
  const view = S.me.is_external && !['radar', 'p'].includes(route) ? viewRadar : (views[route] || viewOverview);
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
      <h1>${S.me.is_external ? '我的優化' : '我的待辦'}</h1>
      ${S.me.is_external ? '' : `<div class="seg"><button data-scope="me" class="${scope === 'me' ? 'on' : ''}">我的</button><button data-scope="all" class="${scope === 'all' ? 'on' : ''}">全部卡關</button></div>`}
      <span class="spacer"></span>
      ${hasRole('picker') ? '<a class="btn primary" href="#/new">＋ 新增商品</a>' : ''}
    </div>
    ${handled ? `<div class="card rcard ghost" style="margin-bottom:12px"><div><span class="t">${esc(handled.name)}</span><div class="muted">已交棒給 ${esc(handled.to)}</div></div></div>` : ''}
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
  if (nav && scope === 'me') nav.innerHTML = `${S.me.is_external ? '我的優化' : '我的待辦'}${r.items.length ? `<span class="badge">${r.items.length}</span>` : ''}`;
  if (S.radarScroll) { window.scrollTo(0, S.radarScroll); S.radarScroll = 0; }
}

// ---------- 新增商品 ----------

function optionsFor(role, selected) {
  const ms = S.members.filter((m) => m.active && m.roles.includes(role));
  return `<option value="">請選擇</option>` + ms.map((m) => `<option value="${m.id}" ${m.id === selected || ms.length === 1 ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
}

async function viewNew() {
  $app.innerHTML = `
    <div class="page-head"><a class="btn small" href="#/overview">← 全覽</a><h1>新增商品</h1></div>
    <form class="card section" id="new-form" style="max-width:640px">
      <label class="field"><span>進貨批次</span>
        <select name="batch_id">
          <option value="">＋ 建立新批次</option>
          ${S.batches.map((b, i) => `<option value="${b.id}" ${i === 0 ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></label>
      <label class="field" id="new-batch" ${S.batches.length ? 'hidden' : ''}><span>新批次名稱</span><input type="text" name="batch_name" placeholder="例：9 月第 2 批／鋯石系列" maxlength="40"></label>
      <label class="field"><span>商品名稱</span><input type="text" name="name" required maxlength="100" placeholder="例：14K 金鋯石耳環"></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1;min-width:150px"><span>上架人員</span><select name="lister_id">${optionsFor('lister')}</select></label>
        <label class="field" style="flex:1;min-width:150px"><span>審查人</span><select name="reviewer_id">${optionsFor('reviewer')}</select></label>
      </div>
      <p class="muted">建立後進入「原圖」：由你上傳原圖並逐張勾選，完成後交給上架人員用原圖直接上架。</p>
      <div class="row"><span class="spacer"></span><button class="btn primary act">建立商品卡</button></div>
    </form>`;
  const f = document.getElementById('new-form');
  f.batch_id.onchange = () => { document.getElementById('new-batch').hidden = !!f.batch_id.value; };
  f.onsubmit = (e) => {
    e.preventDefault();
    const data = {
      name: f.name.value,
      lister_id: Number(f.lister_id.value) || null, reviewer_id: Number(f.reviewer_id.value) || null,
      ...(f.batch_id.value ? { batch_id: Number(f.batch_id.value) } : { batch_name: f.batch_name.value }),
    };
    act(async () => {
      const { id } = await api('POST', '/api/products', data);
      f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
      location.hash = `#/p/${id}`;
    }, '已建立，請上傳原圖', 'none');
  };
}

// ---------- 全覽（首頁） ----------

const varTxt = (v) => v > 0 ? `領先 ${fmtWork(v)}` : v < 0 ? `落後 ${fmtWork(-v)}` : '準時';
const varCls = (v) => v > 0 ? 'ahead' : v < 0 ? 'behind' : 'even';

// 自己負責（現在、過去或接下來）的格子上色，其他灰階
function isMineCell(c) {
  return c.holders?.includes(S.me.id) || c.owner === S.me.id || c.holder_id === S.me.id || (c.step === 'assign' && isMkt());
}

// 每件商品一條賽道：走過的路段填滿，目前位置一顆標記，一眼比出誰走到哪
function cellTip(c) {
  if (c.step === 'assign') return `${stepLabel(c.step)}\n等待 ${fmtWork(c.held)}`;
  const person = member(c.state === 'current' ? c.holder_id : c.state === 'done' ? c.holders[c.holders.length - 1] : c.owner);
  const lines = [`${stepLabel(c.step)}・${person?.name ?? '未指定'}`];
  if (c.state !== 'future') lines.push(`經手 ${fmtWork(c.held)}${c.budget != null ? `／標準 ${fmtWork(c.budget)}` : ''}`);
  if (c.variance) lines.push(c.variance > 0 ? `領先 ${fmtWork(c.variance)}` : `落後 ${fmtWork(-c.variance)}`);
  if (c.rounds > 1) lines.push(`退回重做，第 ${c.rounds} 輪`);
  if (c.state === 'future') lines.push('尚未開始');
  return lines.join('\n');
}

function laneRow(r) {
  const n = FLOW_COLS.length;
  const cur = r.done ? n - 1 : FLOW_COLS.indexOf(r.step);
  const at = (i) => ((i + 0.5) / n) * 100;
  const fillW = r.done ? at(n - 1) - at(0) : at(cur) - at(0);
  const nodes = r.cells.map((c, i) => {
    const mine = isMineCell(c);
    const tip = esc(cellTip(c));
    if (i === cur && !r.done) {
      const late = ['yellow', 'red', 'rush'].includes(c.color);
      const person = c.step === 'assign' ? '待行銷指定' : (member(c.holder_id)?.name ?? '—');
      const time = c.step === 'assign' ? `等 ${fmtWork(c.held)}` : `${fmtWork(c.held)}${c.budget != null ? ` / ${fmtWork(c.budget)}` : ''}`;
      const flag = c.color === 'rush' ? '急件' : late ? '超時' : c.rounds > 1 ? `第 ${c.rounds} 輪` : '';
      return `<div class="pin ${mine ? 'mine' : 'other'} st-${c.color}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0">
        <b>${esc(person)}</b><span class="mono">${esc(time)}</span>${flag ? `<em>${esc(flag)}</em>` : ''}</div>`;
    }
    const state = i < cur || r.done ? 'done' : 'future';
    const late = state === 'done' && c.variance < 0;
    return `<span class="node ${state} ${mine ? 'mine' : 'other'} ${late ? 'late' : ''}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0"></span>`;
  }).join('');
  return `<div class="lane-row ${r.cells.some(isMineCell) ? 'row-mine' : ''}">
    <div class="lane-name"><a href="#/p/${r.id}">${esc(r.name)}</a>${r.opt?.rush ? '<span class="tag rush">急件</span>' : ''}</div>
    <div class="lane">
      <div class="rail" style="left:${at(0)}%;right:${100 - at(n - 1)}%"></div>
      <div class="rail-fill" style="left:${at(0)}%;width:${fillW}%"></div>
      ${nodes}
    </div>
    <div class="lane-var"><span class="var big ${varCls(r.variance)}">${esc(varTxt(r.variance))}</span></div>
    <div class="lane-ret mono ${r.returns ? 'over' : 'faint'}">${r.returns ? `退 ${r.returns}` : '—'}</div>
  </div>`;
}

// 滑過節點顯示細節
(() => {
  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const show = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const b = el.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, b.left + b.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${b.top - tip.offsetHeight - 10}px`;
  };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tip.hidden = true; });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('focusout', () => { tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
})();

async function viewOverview() {
  const q = S.ovBatch == null ? '' : `?batch=${S.ovBatch}`;
  const d = await api('GET', `/api/overview${q}`);
  S.ovBatch = d.batch_id;
  const active = d.rows.filter((r) => !r.done);
  const done = d.rows.filter((r) => r.done).sort((a, b) => b.finished_at - a.finished_at);
  const idx = (r) => STEP_ORDER.indexOf(r.step);
  active.sort(S.ovSort === 'behind' ? (a, b) => a.variance - b.variance || idx(a) - idx(b) : (a, b) => idx(b) - idx(a) || b.variance - a.variance);
  const ahead = active.filter((r) => r.variance > 0).length;
  const behind = active.filter((r) => r.variance < 0).length;
  const returns = d.rows.reduce((s, r) => s + r.returns, 0);
  const assignable = d.rows.filter((r) => ['assign', 'done'].includes(r.step));
  S.radarKeys = active.map((r) => r.id);
  const mineRow = (r) => r.cells.some(isMineCell);
  $app.innerHTML = `
    <div class="page-head">
      <h1>全覽</h1>
      <div class="seg batch-seg">
        ${d.batches.map((b) => `<button data-batch="${b.id}" class="${b.id === d.batch_id ? 'on' : ''}">${esc(b.name)} <span class="mono">${b.done}/${b.total}</span></button>`).join('')}
        <button data-batch="0" class="${d.batch_id === 0 ? 'on' : ''}">全部</button>
      </div>
      <span class="spacer"></span>
      ${isMkt() && assignable.length ? `<button class="btn primary" id="bulk-opt">指定優化（${assignable.filter((r) => r.step === 'assign').length} 件待指定）</button>` : ''}
      ${hasRole('picker') ? '<a class="btn" href="#/new">＋ 新增商品</a>' : ''}
    </div>
    <div class="ov-kpis">
      <div class="kpi-chip"><span>進行中</span><b class="mono">${active.length}</b></div>
      <div class="kpi-chip k-emerald"><span>已完成</span><b class="mono">${done.length}</b></div>
      <div class="kpi-chip k-emerald"><span>領先</span><b class="mono">${ahead}</b></div>
      <div class="kpi-chip k-ruby"><span>落後</span><b class="mono">${behind}</b></div>
      <div class="kpi-chip k-topaz"><span>退件</span><b class="mono">${returns}</b></div>
      <span class="spacer"></span>
      <div class="legend"><span class="lg-node done"></span>已走過<span class="lg-node late"></span>該步落後<span class="lg-pin"></span>目前位置<span class="lg-node mine"></span>我負責的</div>
      <div class="seg"><button data-sort="progress" class="${S.ovSort === 'progress' ? 'on' : ''}">依進度</button><button data-sort="behind" class="${S.ovSort === 'behind' ? 'on' : ''}">落後優先</button></div>
    </div>
    <div class="card lanes">
      <div class="lane-row lane-head">
        <div class="lane-name">商品<span class="muted">（依進度排序）</span></div>
        <div class="lane">${FLOW_COLS.map((c, i) => `<span class="lane-step" style="left:${((i + 0.5) / FLOW_COLS.length) * 100}%;--sc:${STEP_COLOR[c]}">${esc(stepLabel(c))}</span>`).join('')}</div>
        <div class="lane-var">領先／落後</div>
        <div class="lane-ret">退件</div>
      </div>
      ${active.map(laneRow).join('') || '<p class="empty">這批沒有進行中的商品</p>'}
    </div>
    <h2 class="done-h">已完成 <span class="muted mono">${done.length}</span></h2>
    <div class="card ov-wrap">
      <table class="ov done-table">
        <thead><tr><th class="ov-name">商品</th><th>完成時間</th><th>優化</th><th class="num">領先／落後</th><th class="num">退件</th><th></th></tr></thead>
        <tbody>${done.map((r) => `<tr>
          <td class="ov-name"><a href="#/p/${r.id}">${esc(r.name)}</a></td>
          <td class="mono">${r.finished_at ? fmtTime(r.finished_at) : ''}</td>
          <td>${r.opt ? (r.opt.kind === 'premium' ? '設計師（外包）' : '公司美編') : '—'}</td>
          <td class="num"><span class="var ${varCls(r.variance)}">${esc(varTxt(r.variance))}</span></td>
          <td class="num mono ${r.returns ? 'over' : 'faint'}">${r.returns}</td>
          <td class="num">${isMkt() ? `<button class="btn small" data-reopt="${r.id}">再指定優化</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">還沒有完成的商品</td></tr>'}</tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:12px">滑鼠移到圓點可看每一步的負責人、經手時間與領先落後。時間從這個人接到工作才開始算，只算上班時間；前一關拖延不會算到下一關。</p>`;
  $app.querySelectorAll('[data-batch]').forEach((b) => { b.onclick = () => { S.ovBatch = Number(b.dataset.batch); viewOverview(); }; });
  $app.querySelectorAll('[data-sort]').forEach((b) => { b.onclick = () => { S.ovSort = b.dataset.sort; viewOverview(); }; });
  const bo = document.getElementById('bulk-opt');
  const toAssign = (rows) => rows.map((r) => ({ id: r.id, name: r.name, batch_id: r.batch_id, step: r.step }));
  if (bo) bo.onclick = () => openAssignModal(toAssign(assignable), assignable.filter((r) => r.step === 'assign').map((r) => r.id));
  $app.querySelectorAll('[data-reopt]').forEach((b) => {
    b.onclick = () => { const r = d.rows.find((x) => x.id === Number(b.dataset.reopt)); openAssignModal(toAssign([r]), [r.id]); };
  });
}

// ---------- 指定優化（單件或多件） ----------

function tomorrowYmd() {
  const t = new Date(Date.now() + 86400000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function openAssignModal(liveProducts, preselect = []) {
  if (!liveProducts.length) return toast('目前沒有待指定優化的商品', true);
  const pre = new Set(preselect);
  openModal(`
    <h3>指定優化</h3>
    <p class="muted">公司美編做一般優化、外包設計師做精製優化。截止前 ${esc(fmtWork(S.settings.rush_threshold_hours))}內自動變急件，排到優化者待辦最上面。</p>
    <div class="field"><span>商品（${liveProducts.length} 件可指定；可分次指定給不同的人）</span>
      <div class="row" style="margin-bottom:6px"><button type="button" class="btn small" data-all>全選</button><button type="button" class="btn small" data-none>全不選</button><span class="muted" id="pick-n"></span></div>
      <div class="pick-list">${liveProducts.map((p) => `<label><input type="checkbox" value="${p.id}" ${pre.has(p.id) ? 'checked' : ''}>${esc(p.name)}<span class="spacer"></span><span class="muted">${p.step === 'done' ? '已完成・再優化' : '待指定'}・${esc(batchName(p.batch_id))}</span></label>`).join('')}</div>
    </div>
    <div class="field"><span>類型</span>
      <div class="hour-pick" id="kind-pick">
        <label><input type="radio" name="kind" value="general">一般優化（公司美編）</label>
        <label><input type="radio" name="kind" value="premium">設計師優化（外包）</label>
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
        toast(`已指定 ${r.done} 件${r.skipped.length ? `，${r.skipped.length} 件狀態已變更已略過` : ''}`);
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
  const field = { raw: 'picker_id', listing: 'lister_id', review: 'reviewer_id', final_review: 'reviewer_id' }[step];
  return member(p[field])?.name ?? '';
}

function actionPanel(p) {
  const open = p.open;
  const mine = open && open.member_id === S.me.id;
  const returned = open?.start_reason === 'return' ? `
    <div class="returned"><b>被退回：${(open.reasons || []).map((r) => REASON[r]).join('、')}</b>（${esc(member(open.by_id)?.name ?? '')}・${fmtTime(open.started_at)}）
      <div class="note">${esc(open.note)}</div></div>` : '';
  const opt = p.active_opt;
  const deadline = opt ? `
    <div class="deadline-box ${opt.rush ? 'rush' : ''}">
      <div><div class="muted">截止</div><b>${esc(fmtDeadline(opt.deadline))}</b></div>
      <div><div class="muted">剩餘上班時間</div><span class="big">${opt.remaining_h > 0 ? esc(fmtWork(opt.remaining_h)) : '已逾期'}</span></div>
      ${opt.rush ? '<span class="tag rush">急件</span>' : ''}
      <div><div class="muted">類型</div>${opt.kind === 'premium' ? '設計師優化（外包）' : '一般優化（公司美編）'}・第 ${opt.rounds} 輪</div>
    </div>` : '';
  const shop = p.sl_url ? `<a class="btn" href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟 Shopline 頁面</a>` : '';

  if (p.step === 'assign' || p.step === 'done') {
    const title = p.step === 'done' ? `已完成 ${p.opt_version ? `<span class="tag green">優化 v${p.opt_version}</span>` : ''}` : '首次審查通過・待指定優化';
    return `<div class="card action ${isMkt() ? 'mine' : 'locked'}">
      <h2>${title}</h2>
      <div class="sub">${p.step === 'assign' ? '由行銷決定交給公司美編（一般優化）或外包設計師（設計師優化）' : ''}</div>
      <div class="row">${shop}${isMkt() ? `<button class="btn primary act" id="assign-one">${p.step === 'done' ? '再指定優化' : '指定優化'}</button>` : '<span class="muted">等待行銷指定</span>'}</div>
    </div>`;
  }
  if (!open) return '';
  const holder = member(open.member_id);
  if (!mine) {
    return `${deadline}<div class="card action locked">
      <h2>目前在「${esc(stepLabel(p.step))}」</h2>
      <div class="sub">負責人：${who(open.member_id)}・已經手 <span class="mono">${esc(fmtWork(open.visit_held))}</span>${open.budget_hours ? `／標準 <span class="mono">${esc(fmtWork(open.budget_hours))}</span>` : ''}</div>
      <button class="btn disabled" disabled>只有 ${esc(holder?.name ?? '負責人')} 可以操作</button>
      <span class="muted">需要催的話，在下方留言 @${esc(holder?.name ?? '')}</span>
    </div>`;
  }
  const head = (title, sub) => `<h2>${title}</h2><div class="sub">${sub}</div>`;
  switch (p.step) {
    case 'raw': {
      const miss = missingRaw(p);
      return `<div class="card action mine">${returned}${head('原圖・上傳並逐張勾選', '每張圖都要勾滿「準確／清楚／比例正確」才能交給上架')}
        ${photoGrid(p, 'raw', { upload: true, rawChecks: true, del: true })}
        <div class="row" style="margin-top:14px"><span class="missing">${miss.length ? '缺：' + esc(miss.join('；')) : ''}</span><span class="spacer"></span>
        <button class="btn primary act" data-do="complete_raw" ${miss.length ? 'disabled' : ''}>原圖完成 → 交給 ${esc(nextHolderName(p, 'listing'))}</button></div></div>`;
    }
    case 'listing':
      return `<div class="card action mine">${returned}${head('上架・用原圖直接上 Shopline', '下載原圖、寫好文案與價格上架，貼上 Shopline 網址後交給首次審查')}
        <div class="kind-title">原圖</div>${photoGrid(p, 'raw', { download: true })}
        <form id="listing-form" style="margin-top:16px">
          <label class="field"><span>商品名稱</span><input type="text" name="sl_name" value="${esc(p.sl_name || p.name)}" maxlength="200"></label>
          <label class="field"><span>文案</span><textarea name="sl_body" style="min-height:140px">${esc(p.sl_body)}</textarea></label>
          <div class="row">
            <label class="field" style="flex:1;min-width:140px"><span>價格（只能數字）</span><input type="text" inputmode="decimal" name="sl_price" value="${esc(p.sl_price)}"></label>
            <label class="field" style="flex:3;min-width:260px"><span>Shopline 網址</span><input type="url" name="sl_url" value="${esc(p.sl_url)}" placeholder="https://"></label>
          </div>
          <div class="row"><span class="missing" id="listing-miss"></span><span class="spacer"></span>
            <button type="button" class="btn act" id="listing-save">儲存草稿</button>
            <button class="btn primary act" id="listing-done">已上架 → 交給 ${esc(nextHolderName(p, 'review'))} 首次審查</button></div>
        </form></div>`;
    case 'review':
      return `<div class="card action mine">${returned}${head('首次審查・急件（標準 ' + esc(fmtWork(open.budget_hours)) + '）', '打開 Shopline 頁面檢查文案、價格、照片，三項都對才通過')}
        <div class="row" style="margin-bottom:12px">${shop}</div>
        <dl class="kv" style="margin-bottom:12px"><dt>名稱</dt><dd>${esc(p.sl_name)}</dd><dt>價格</dt><dd class="mono">${esc(p.sl_price)}</dd><dt>文案</dt><dd>${esc(p.sl_body)}</dd></dl>
        <div class="kind-title">原圖</div>${photoGrid(p, 'raw')}
        <div style="margin-top:14px">${reviewForm('首次審查')}</div></div>`;
    case 'optimizing':
      return `${deadline}<div class="card action mine">${returned}${head('優化・直接改 Shopline 線上頁面', '改完填寫改了什麼，按「已更新線上」交給最終審查')}
        <div class="row" style="margin-bottom:12px">${shop}</div>
        <div class="kind-title">原圖（參考）</div>${photoGrid(p, 'raw', { download: true })}
        <div class="kind-title">優化截圖（選填）</div>${photoGrid(p, 'opt', { upload: true, del: true })}
        <label class="field" style="margin-top:14px"><span>改了什麼（必填）</span><textarea id="opt-note" placeholder="例：換主圖、補尺寸表、調整比例"></textarea></label>
        <div class="row"><span class="missing" id="opt-miss">請填寫改了什麼</span><span class="spacer"></span>
        <button class="btn primary act" id="opt-submit" disabled>已更新線上 → 交給 ${esc(nextHolderName(p, 'final_review'))} 最終審查</button></div></div>`;
    case 'final_review': {
      const lastSubmit = [...p.stints].reverse().find((s) => s.step === 'optimizing' && s.end_note);
      return `${deadline}<div class="card action mine">${head('最終審查・有沒有改得更好', `標準 ${esc(fmtWork(open.budget_hours))}內審完；文字或照片比例改錯就退回優化者`)}
        <div class="row" style="margin-bottom:12px">${shop.replace('btn', 'btn primary')}</div>
        ${lastSubmit ? `<div class="returned" style="background:var(--line-2);color:var(--ink)"><b>${esc(member(lastSubmit.member_id)?.name ?? '')} 改了什麼</b><div class="note">${esc(lastSubmit.end_note)}</div></div>` : ''}
        <div class="kind-title">優化截圖</div>${photoGrid(p, 'opt')}
        <div style="margin-top:14px">${reviewForm('最終審查')}</div></div>`;
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
    ${row('選品', 'picker_id', 'picker')}${row('上架人員', 'lister_id', 'lister')}${row('審查人', 'reviewer_id', 'reviewer')}
    ${opt ? (can
      ? `<label class="field"><span>優化者（${opt.kind === 'premium' ? '外包設計師' : '公司美編'}）</span><select data-owner="optimizer_id">${optionsFor(opt.kind === 'premium' ? 'external' : 'editor', opt.optimizer_id)}</select></label>`
      : `<div class="row"><span class="muted" style="width:70px">優化者</span>${who(opt.optimizer_id)}</div>`) : ''}
  </div>`;
}

function timelineBlock(p) {
  const items = [...p.stints].reverse();
  return `<div class="card section"><h2>流程紀錄</h2><ul class="timeline">
    ${items.map((s) => {
      const endTxt = { complete: '完成', pass: '通過', return: '退回', submit: '更新線上', reassign: '改派' }[s.end_reason] || '';
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

async function viewProduct(idStr) {
  const id = Number(idStr);
  const p = await api('GET', `/api/products/${id}`);
  const idx = STEP_ORDER.indexOf(p.step);
  const nextId = S.radarKeys[S.radarKeys.indexOf(id) + 1] || (S.radarKeys[0] !== id ? S.radarKeys[0] : null);
  $app.innerHTML = `
    <div class="page-head">
      <a href="#/${S.me.is_external ? 'radar' : 'overview'}" class="btn small">← ${S.me.is_external ? '我的優化' : '全覽'}</a>
      <h1>${esc(p.name)}</h1>${stepChip(p.step)}
      ${p.open?.color === 'red' ? '<span class="tag red">紅色超時</span>' : p.open?.color === 'yellow' ? '<span class="tag yellow">黃色超時</span>' : p.open?.color === 'rush' ? '<span class="tag rush">急件</span>' : ''}
      <span class="muted">${esc(p.batch_name)}</span>
      <span class="spacer"></span>
      ${nextId ? `<a class="btn small" href="#/p/${nextId}">下一件 →</a>` : ''}
      ${S.me.is_admin ? '<button class="btn small danger" id="del-product">刪除</button>' : ''}
    </div>
    <div class="stepper">${STEP_ORDER.map((s, i) => `<div class="step ${i < idx ? 'done' : ''} ${i === idx ? 'cur' : ''}" style="${i === idx ? `background:${STEP_COLOR[s]}` : ''}">${i < idx ? '✓ ' : ''}${esc(stepLabel(s))}</div>`).join('')}</div>
    <div id="action">${actionPanel(p)}</div>
    <div class="detail">
      <div>
        ${p.step !== 'raw' || p.open?.member_id !== S.me.id ? `<div class="card section"><h2>圖片</h2>
          ${['raw', 'opt'].filter((k) => p.photos.some((ph) => ph.kind === k)).map((k) => `<div class="kind-title">${KIND[k]}</div>${photoGrid(p, k, { download: true })}`).join('') || '<div class="muted">尚無圖片</div>'}
        </div>` : ''}
        ${commentsBlock(p)}
      </div>
      <div>
        ${p.sl_url && p.step !== 'review' ? `<div class="card section"><h2>Shopline 資料</h2><dl class="kv"><dt>名稱</dt><dd>${esc(p.sl_name)}</dd><dt>價格</dt><dd class="mono">${esc(p.sl_price)}</dd><dt>網址</dt><dd><a href="${esc(p.sl_url)}" target="_blank" rel="noopener">開啟</a></dd></dl></div>` : ''}
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
      const next = { complete_raw: 'listing' }[b.dataset.do];
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
      const miss = [!v.sl_name.trim() && '名稱', !v.sl_body.trim() && '文案', !v.sl_price && '價格', !v.sl_url && 'Shopline 網址'].filter(Boolean);
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

  // 首次審查與最終審查
  const actionEl = document.getElementById('action');
  if (actionEl.querySelector('[data-checks]')) {
    const isFinal = p.step === 'final_review';
    const optimizer = isFinal ? member(p.active_opt.optimizer_id)?.name : '';
    bindReviewForm(actionEl, {
      onPass: (checks) => isFinal
        ? doAction('final_pass', { checks }, '（已完成）')
        : doAction('review_pass', { checks }, '行銷（待指定優化）'),
      onReturn: (reasons, note) => {
        const to = isFinal ? optimizer : reasons.includes('photo') ? nextHolderName(p, 'raw') : nextHolderName(p, 'listing');
        doAction(isFinal ? 'final_return' : 'review_return', { reasons, note }, `${to}（退回）`);
      },
      routeHint: (reasons) => isFinal
        ? `會退回優化者 ${optimizer}，記一次退件`
        : reasons.includes('photo')
          ? `會退回選品 ${nextHolderName(p, 'raw')} 重拍${reasons.length > 1 ? `；${reasons.filter((r) => r !== 'photo').map((r) => REASON[r]).join('、')}的退件同時記在上架 ${nextHolderName(p, 'listing')}` : ''}`
          : `會退回上架 ${nextHolderName(p, 'listing')}，記一次退件`,
    });
  }

  // 優化
  const optNote = document.getElementById('opt-note');
  if (optNote) {
    const btn = document.getElementById('opt-submit');
    optNote.oninput = () => {
      btn.disabled = !optNote.value.trim();
      document.getElementById('opt-miss').textContent = optNote.value.trim() ? '' : '請填寫改了什麼';
    };
    btn.onclick = () => doAction('submit_opt', { note: optNote.value.trim() }, nextHolderName(p, 'final_review'));
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

// ---------- 延誤分析 ----------

async function viewAnalysis() {
  const a = S.ana;
  const r = await api('GET', `/api/analysis?scope=${a.scope}&days=${a.days}&batch=${a.batch}`);
  const m = r.metrics;
  const maxOver = Math.max(1, ...r.ranking.map((x) => x.over));
  const kpi = (label, value, unit, hint) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value ?? '—'}${value != null && unit ? `<small> ${unit}</small>` : ''}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const reviewers = r.ranking.filter((x) => x.review_rounds > 0).sort((x, y) => (y.review_avg ?? 0) - (x.review_avg ?? 0));
  $app.innerHTML = `
    <div class="page-head">
      <h1>延誤分析</h1>
      <div class="seg" data-f="scope">${[['all', '全部'], ['rush', '急件'], ['normal', '一般件']].map(([k, l]) => `<button data-v="${k}" class="${a.scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" data-f="days">${[[7, '7 天'], [30, '30 天'], [90, '90 天'], [0, '全部']].map(([k, l]) => `<button data-v="${k}" class="${a.days === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="ana-batch" style="max-width:240px"><option value="0">全部批次</option>${S.batches.map((b) => `<option value="${b.id}" ${a.batch === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    </div>
    <div class="kpis">
      ${kpi('卡關平均停留', m.stuck_dwell_h, 'h', `從超時到有人動作・${m.stuck_n} 次`)}
      ${kpi('誤報率', m.false_alarm_rate, '%', `超時後沒人催就完成・${m.false_alarm_n} 次`)}
      ${kpi('首次審查一次通過率', m.review_first_pass.rate, '%', `${m.review_first_pass.n} 件`)}
      ${kpi('最終審查一次通過率', m.final_first_pass.rate, '%', `${m.final_first_pass.n} 件`)}
      ${kpi('首次審查平均耗時', m.review_avg_h, 'h', '從收到到審完')}
      ${kpi('退件總數', m.returns_total, '次')}
      ${kpi('錯過優化截止', m.missed_deadlines, '件')}
    </div>
    <div class="card section">
      <h2>個人排行 <span class="muted">依「超出標準時間」排序；時間從本人接到工作才開始算</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>#</th><th>負責人</th><th>身分</th><th class="num">經手</th><th>超出標準</th><th class="num">延誤次數</th><th>判斷</th><th class="num">被退件</th><th>退件原因</th></tr></thead>
        <tbody>${r.ranking.map((x, i) => `<tr>
          <td class="mono">${i + 1}</td><td>${who(x.member_id)}</td><td class="muted">${x.roles.map((ro) => S.roles[ro]).join('、')}</td>
          <td class="num mono">${x.held}h</td>
          <td style="min-width:140px"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="overbar" style="width:${(x.over / maxOver) * 100}px"></div><span class="mono ${x.over > 0 ? 'over' : ''}">${x.over}h</span></div></td>
          <td class="num mono">${x.late_count}</td>
          <td>${x.late_count ? `${x.speed ? `<span class="tag yellow">個人速度 ${x.speed}</span> ` : ''}${x.capacity ? `<span class="tag blue">產能不足 ${x.capacity}</span>` : ''}` : '<span class="tag green">準時</span>'}</td>
          <td class="num mono ${x.returned ? 'over' : ''}">${x.returned}</td>
          <td class="muted">${Object.entries(x.returned_reasons).filter(([, n]) => n).map(([k, n]) => `${REASON[k]} ${n}`).join('、') || '—'}</td>
        </tr>`).join('') || '<tr><td colspan="9" class="empty">這個範圍還沒有資料</td></tr>'}</tbody>
      </table></div>
      <p class="muted" style="margin-top:12px">被退件依原因算到做那部分的人：照片 → 選品、文案／價格 → 上架人員、最終審查退回 → 優化者。「產能不足」：延誤當下手上件數 ≥ 同身分平均的 ${S.settings.capacity_ratio} 倍。</p>
    </div>
    <div class="card section">
      <h2>審查人效率 <span class="muted">審查拖延不算到後面製作的人身上</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>審查人</th><th class="num">審查次數</th><th class="num">平均每次耗時</th><th class="num">超出標準</th><th class="num">退件發出</th></tr></thead>
        <tbody>${reviewers.map((x) => `<tr><td>${who(x.member_id)}</td><td class="num mono">${x.review_rounds}</td><td class="num mono">${x.review_avg}h</td>
          <td class="num mono ${x.over > 0 ? 'over' : ''}">${x.over}h</td><td class="num mono">${x.issued}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">還沒有審查紀錄</td></tr>'}</tbody>
      </table></div>
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
  product_add: '新增商品', raw_done: '完成原圖', listing_done: '完成上架', listing_save: '儲存上架草稿',
  review_pass: '首次審查通過', review_return: '退回', opt_assign: '指定優化',
  opt_submit: '更新線上', final_pass: '最終審查通過', final_return: '退回優化', reassign: '改派', comment_add: '留言',
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
  const SLA_LABEL = { raw: '原圖', listing: '上架', review: '首次審查', opt_general: '一般優化', opt_premium: '設計師優化', final_review: '最終審查' };
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
