// TZG 上架跟進 — 前端（無框架，hash 路由）
// 所有時數、平均、排序都由後端計算，前端只負責顯示
'use strict';

const POLL_MS = 10000;
const MAX_EDGE = 1920;
const STEP_ORDER = ['open', 'cutout', 'listing', 'optimizing', 'mkt_check', 'done'];
const FLOW = ['open', 'cutout', 'listing', 'optimizing', 'mkt_check'];
const STEP_COLOR = {
  open: '#9B8AE0', cutout: '#4FBFA8', listing: '#6AA3EE', optimizing: '#E27BB4', mkt_check: '#F2A65A', done: '#45B98A',
};
const KIND = { pick: '選品照片', cutout: '去背圖', opt: '優化截圖' };
const STATUS = { A: '投放中', B: '優先製作', C: '可投放', D: '待製作' };
const GROUPS = [
  ['rush', '插隊急件', 'var(--ruby)'],
  ['attention', '被退回・@我', 'var(--amethyst)'],
  ['slow', '比平均慢', 'var(--topaz)'],
  ['mine', '我手上', 'var(--ink-3)'],
  ['pool', '可以認領', 'var(--mint, #45B98A)'],
];

const S = {
  me: null, members: [], settings: null, roles: {}, stepLabel: {}, stepRole: {},
  version: null, busy: 0, radarScope: 'me', radarKeys: [], radarScroll: 0, handled: null,
  lastLoad: null, offline: false, fails: 0, ovFilter: 'all', ovSort: 'priority', ovDoneAll: false, ana: { days: 30 },
};
const $app = document.getElementById('app');

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const member = (id) => S.members.find((m) => m.id === id);
const stepLabel = (s) => S.stepLabel[s] || s;
const pad = (n) => String(n).padStart(2, '0');
const hasRole = (r) => !!S.me && S.me.roles.includes(r);
const isMkt = () => hasRole('marketing') || !!S.me?.is_admin;
const roleName = (r) => S.roles[r] || r;

function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtClock(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}（${'日一二三四五六'[new Date(y, m - 1, d).getDay()]}）`;
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
  if (!m) return '<span class="avatar" style="background:#C9C0D6">?</span>';
  const st = size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` : '';
  return `<span class="avatar" style="background:${m.color}${st}">${esc([...m.name][0])}</span>`;
}
const who = (id) => { const m = member(id); return `<span class="who">${avatar(m)}${esc(m?.name ?? '—')}</span>`; };
const stepChip = (s) => `<span class="step-chip" style="background:${STEP_COLOR[s]}">${esc(stepLabel(s))}</span>`;
const rolesText = (m) => (m?.roles || []).map(roleName).join('、');
const thumb = (id, ver, cls = '') => ver
  ? `<img class="thumb ${cls}" src="/api/thumbs/${id}?v=${ver}" alt="" loading="lazy">`
  : `<span class="thumb ${cls} noimg"></span>`;
function statusBadge(x) {
  if (x.rush_date && x.step !== 'done') return `<span class="st st-R" title="插隊，${esc(fmtDate(x.rush_date))}下班前完成">插隊 ${esc(x.rush_date.slice(5).replace('-', '/'))}</span>`;
  return x.status_code ? `<span class="st st-${x.status_code}" title="${STATUS[x.status_code]}">${x.status_code} ${STATUS[x.status_code]}</span>` : '';
}
// 商品名稱連到 Shopline 商品頁
const shopName = (name, link) => link
  ? `<a class="shop-link" href="${esc(link)}" target="_blank" rel="noopener" title="開啟商品頁">${esc(name)}<span class="ext">↗</span></a>`
  : `<span class="shop-link">${esc(name)}</span>`;
const diffTxt = (d) => d == null ? '—' : d > 0 ? `慢 ${fmtWork(d)}` : d < 0 ? `快 ${fmtWork(-d)}` : '持平';
const diffCls = (d) => d == null ? 'even' : d > 0 ? 'behind' : d < 0 ? 'ahead' : 'even';
function tomorrowYmd() {
  const t = new Date(Date.now() + 86400000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

let toastTimer;
function toast(msg, error = false, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = error ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
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
  if (S.offline) setOffline(false);
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
      if (e.status === 409 && !e.data?.code) await refresh();
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
  if (b.me) Object.assign(S, { settings: b.settings, roles: b.roles, stepLabel: b.step_label, stepRole: b.step_role });
  S.lastLoad = Date.now();
}

async function boot() {
  await loadBase();
  if (!S.me) return renderLogin();
  document.getElementById('topbar').hidden = false;
  renderNav();
  document.getElementById('me').innerHTML = `${avatar(S.me)}<span>${esc(S.me.name)}</span><span class="roles">${esc(rolesText(S.me) || (S.me.is_admin ? '管理員' : ''))}</span>`;
  S.version = (await api('GET', '/api/version')).v;
  if (!location.hash) location.hash = '#/overview';
  await render();
}

function renderNav() {
  const items = [['overview', '全覽'], ['radar', '我的待辦'], ['analysis', '成效分析'], ['log', '紀錄'], ...(S.me.is_admin ? [['settings', '設定']] : [])];
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
    // 版本變了就重載；全覽與待辦每分鐘也重算一次時間
    if (v.v !== S.version || (['radar', 'overview'].includes(route) && Date.now() - S.lastLoad > 60000)) await refresh();
  } catch { /* 離線橫幅已處理 */ }
}, POLL_MS);

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me && !isBusy()) refresh().catch(() => {}); });
window.addEventListener('online', () => { if (S.me) refresh().catch(() => {}); });

// ---------- login ----------

function renderLogin() {
  document.getElementById('topbar').hidden = true;
  const groups = {};
  for (const m of S.members) {
    const key = m.roles[0] || 'none';
    (groups[key] ||= []).push(m);
  }
  if (groups.none) { const none = groups.none; delete groups.none; Object.assign(groups, { none }); }
  const ROLE_NAME = { marketing: '行銷', editor: '美編', lister: '上架人員', designer: '設計師', none: '管理員' };
  $app.innerHTML = `
    <div class="login">
      <h1>選擇你的名字</h1>
      <p class="muted">選定後這台裝置會綁定你的名字，之後打開直接進入。<br>選錯或換裝置，請找管理員重設。</p>
      ${S.members.length ? Object.entries(groups).map(([role, ms]) => `
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

const currentRoute = () => (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
window.addEventListener('hashchange', () => { if (S.me) render(); });

async function render() {
  const [route, arg] = currentRoute();
  if (route !== 'radar' && document.querySelector('[data-view=radar]')) S.radarScroll = window.scrollY;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (['p', 'new'].includes(route) && a.dataset.route === 'overview')));
  const views = { overview: viewOverview, radar: viewRadar, analysis: viewAnalysis, log: viewLog, settings: viewSettings, p: viewProduct, new: viewNew };
  try {
    await (views[route] || viewOverview)(arg);
  } catch (e) {
    if (!e.network) $app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// 認領（待辦與商品頁共用）
function claim(productId, version, step) {
  return act(() => api('POST', `/api/products/${productId}/action`, { action: 'claim', version, step }), '已認領，現在由你負責');
}

// ---------- 我的待辦 ----------

function radarCard(it, hero = false) {
  const tags = it.tags.filter((t) => t.t).map((t) => `<span class="tag ${t.k}">${esc(t.t)}</span>`).join('');
  const time = it.held_h != null ? `<span>這一步 <span class="mono">${esc(fmtWork(it.held_h))}</span>${it.avg_h != null ? `／平均 <span class="mono">${esc(fmtWork(it.avg_h))}</span>` : ''}</span>` : '';
  return `
    <div class="card rcard g-${it.group} ${hero ? 'hero' : ''}" data-href="#/p/${it.product_id}" data-key="${esc(it.key)}">
      ${hero ? `<div class="hero-t">建議你現在先做這件<span class="muted">${esc(suggestWhy(it))}</span></div>` : ''}
      <div class="rc-grid">
        ${thumb(it.product_id, it.thumb)}
        <div style="min-width:0">
          <div class="row" style="gap:6px;flex-wrap:nowrap">${statusBadge(it)}<span class="t">${shopName(it.name, it.link)}</span></div>
          <div class="tags">${stepChip(it.step)}${tags}</div>
          ${it.returned?.note ? `<div class="ret-note"><b>${esc(member(it.returned.by)?.name ?? '')} 退回：</b>${esc(it.returned.note)}</div>` : ''}
          <div class="meta">
            ${S.radarScope === 'all' ? (it.holder_id ? who(it.holder_id) : '<span class="tag wait">等人認領</span>') : ''}
            ${time}
            ${it.mention_id ? `<button class="btn small" data-ack="${it.mention_id}">知道了</button>` : ''}
            ${it.claimable ? `<span class="spacer"></span><button class="btn small primary" data-claim="${it.product_id}" data-v="${it.version}" data-step="${it.step}">我來做</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

// 為什麼建議這件（顯示用）
function suggestWhy(it) {
  if (it.rush) return `插隊，${fmtDate(it.rush.date)}下班前要完成`;
  if (it.returned) return '被退回的件，優先處理';
  if (it.step === 'cutout') return '去背從試算表最下面往上做';
  return it.status_code ? `${it.status_code} ${STATUS[it.status_code]}，依優先順序排第一` : '依優先順序排第一';
}

async function viewRadar() {
  const scope = S.radarScope;
  const r = await api('GET', `/api/radar?scope=${scope}`);
  S.radarKeys = r.items.map((i) => i.product_id);
  const hero = r.items.find((i) => i.suggest);
  const byGroup = Object.fromEntries(GROUPS.map(([g]) => [g, r.items.filter((i) => i.group === g && i !== hero)]));
  const handled = S.handled && Date.now() - S.handled.at < 3000 ? S.handled : null;
  S.handled = null;
  const poolN = byGroup.pool.length;
  $app.innerHTML = `
    <div data-view="radar">
    <div class="page-head">
      <h1>我的待辦</h1>
      <div class="seg"><button data-scope="me" class="${scope === 'me' ? 'on' : ''}">我的</button><button data-scope="all" class="${scope === 'all' ? 'on' : ''}">全部卡關</button></div>
      <span class="spacer"></span>
      ${isMkt() ? '<a class="btn" href="#/new">＋ 手動開單</a>' : ''}
    </div>
    ${handled ? `<div class="card rcard ghost" style="margin-bottom:12px"><div><span class="t">${esc(handled.name)}</span><div class="muted">${esc(handled.to)}</div></div></div>` : ''}
    ${hero ? `<div class="hero-wrap">${radarCard(hero, true)}</div>` : ''}
    ${r.stuck_count === 0 && !hero && !byGroup.mine.length && !poolN ? `<div class="card calm"><b>目前沒有待辦</b><span class="muted">${scope === 'all' ? '沒有比平均慢或快到期的插隊件' : '你手上沒有工作，也沒有可以認領的件'}</span></div>` : ''}
    ${GROUPS.map(([g, label, color]) => byGroup[g].length ? `
      <section class="radar-group">
        <h2><span class="dot" style="background:${color}"></span>${label}<span class="num">${byGroup[g].length}</span>
          ${g === 'pool' ? '<span class="muted" style="font-weight:400">還沒人接，看到就按「我來做」；等待時間會算在這一步</span>' : ''}</h2>
        <div class="rcards">${byGroup[g].map(radarCard).join('')}</div>
      </section>` : '').join('')}
    </div>`;
  $app.querySelectorAll('[data-scope]').forEach((b) => { b.onclick = () => { S.radarScope = b.dataset.scope; viewRadar(); }; });
  $app.querySelectorAll('[data-href]').forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('a, button')) location.hash = c.dataset.href; };
  });
  $app.querySelectorAll('[data-ack]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/mentions/${b.dataset.ack}/ack`)); });
  $app.querySelectorAll('[data-claim]').forEach((b) => { b.onclick = () => claim(Number(b.dataset.claim), Number(b.dataset.v), b.dataset.step); });
  const nav = document.querySelector('#nav a[data-route=radar]');
  const mineN = r.items.filter((i) => i.group !== 'pool').length;
  if (nav && scope === 'me') nav.innerHTML = `我的待辦${mineN ? `<span class="badge">${mineN}</span>` : ''}`;
  if (S.radarScroll) { window.scrollTo(0, S.radarScroll); S.radarScroll = 0; }
}

// ---------- 手動開單 ----------

async function viewNew() {
  if (!isMkt()) { $app.innerHTML = '<p class="empty">只有行銷或管理員可以開單</p>'; return; }
  $app.innerHTML = `
    <div class="page-head"><a class="btn small" href="#/overview">← 全覽</a><h1>手動開單</h1></div>
    <form class="card section" id="new-form" style="max-width:640px">
      <p class="muted" style="margin-top:0">試算表裡的商品按「同步試算表」就會進來，不用手動開。這裡是給試算表以外的商品。</p>
      <label class="field"><span>商品名稱</span><input type="text" name="name" required maxlength="200" placeholder="例：14K 金鋯石耳環"></label>
      <label class="field"><span>商品連結（Shopline 商品頁，選填）</span><input type="url" name="link" placeholder="https://"></label>
      <label class="field"><span>狀態</span><select name="status_code"><option value="">未分類</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}">${k} ${l}</option>`).join('')}</select></label>
      <p class="muted">${hasRole('marketing') ? '建立後由你負責開單（上傳選品照片），最後也由你做行銷檢查。' : '建立後放在「待開單」，由行銷認領。'}</p>
      <div class="row"><span class="spacer"></span><button class="btn primary act">建立</button></div>
    </form>`;
  const f = document.getElementById('new-form');
  f.onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const { id } = await api('POST', '/api/products', { name: f.name.value, link: f.link.value.trim(), status_code: f.status_code.value });
      f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
      location.hash = `#/p/${id}`;
    }, '已建立', 'none');
  };
}

// ---------- 全覽（首頁） ----------

function isMineCell(c) {
  return c.holders?.includes(S.me.id) || c.holder_id === S.me.id || c.owner === S.me.id;
}

function cellTip(c) {
  const person = c.state === 'current' ? (c.waiting ? '等人認領' : member(c.holder_id)?.name) : member(c.holders[c.holders.length - 1] ?? c.owner)?.name;
  const lines = [`${stepLabel(c.step)}・${person ?? '還沒輪到'}`];
  if (c.held) lines.push(`花了 ${fmtWork(c.held)}${c.pool ? `（其中等認領 ${fmtWork(c.pool)}）` : ''}`);
  lines.push(c.avg != null ? `團隊平均 ${fmtWork(c.avg)}` : '團隊平均：資料還不夠（至少 3 件）');
  if (c.diff != null) lines.push(c.diff > 0 ? `比平均慢 ${fmtWork(c.diff)}` : c.diff < 0 ? `比平均快 ${fmtWork(-c.diff)}` : '跟平均差不多');
  if (c.rounds > 1) lines.push(`退回重做，第 ${c.rounds} 輪`);
  if (c.state === 'future' && !c.held) lines.push('尚未開始');
  return lines.join('\n');
}

function laneRow(r) {
  const n = FLOW.length;
  const cur = r.done ? n - 1 : FLOW.indexOf(r.step);
  const at = (i) => ((i + 0.5) / n) * 100;
  const fillW = at(cur) - at(0);
  const nodes = r.cells.map((c, i) => {
    const mine = isMineCell(c);
    const tip = esc(cellTip(c));
    if (i === cur && !r.done) {
      const person = c.waiting ? '等人認領' : (member(c.holder_id)?.name ?? '—');
      const time = `${fmtWork(c.held)}${c.avg != null ? ` / 均 ${fmtWork(c.avg)}` : ''}`;
      const rushHot = r.rush && (r.rush.urgent || r.rush.overdue);
      const flag = r.rush?.overdue ? '逾期' : rushHot ? '插隊' : c.level === 'very' ? '很慢' : c.level === 'slow' ? '偏慢' : c.rounds > 1 ? `第 ${c.rounds} 輪` : '';
      const st = rushHot || c.level === 'very' ? 'st-red' : c.level === 'slow' ? 'st-yellow' : c.waiting ? 'st-wait' : '';
      return `<div class="pin ${mine ? 'mine' : 'other'} ${st}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0">
        <b>${esc(person)}</b><span class="mono">${esc(time)}</span>${flag ? `<em>${esc(flag)}</em>` : ''}</div>`;
    }
    const state = i < cur || r.done ? 'done' : 'future';
    const late = state === 'done' && c.level !== 'ok';
    return `<span class="node ${state} ${mine ? 'mine' : 'other'} ${late ? 'late' : ''} ${state === 'future' && c.held ? 'visited' : ''}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0"></span>`;
  }).join('');
  return `<div class="lane-row ${r.cells.some(isMineCell) ? 'row-mine' : ''}" data-href="#/p/${r.id}">
    <div class="lane-name">${thumb(r.id, r.thumb, 'sm')}<div class="ln-text">${statusBadge(r)}${shopName(r.name, r.link)}</div></div>
    <div class="lane">
      <div class="rail" style="left:${at(0)}%;right:${100 - at(n - 1)}%"></div>
      <div class="rail-fill" style="left:${at(0)}%;width:${fillW}%"></div>
      ${nodes}
    </div>
    <div class="lane-var"><span class="var big ${diffCls(r.diff)}" title="每一步跟團隊平均比，加總">${esc(diffTxt(r.cells.some((c) => c.diff != null) ? r.diff : null))}</span></div>
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

function syncBar() {
  if (!S.me.can_sync) return '';
  const ls = S.settings.last_sheet_sync;
  const lt = S.settings.last_thumb_sync;
  return `<div class="card sync-bar">
    <span class="muted">試算表：${ls ? `${fmtTime(ls.at)} ${esc(member(ls.by)?.name ?? '')} 同步・共 ${ls.total} 件（新增 ${ls.added}、更新 ${ls.updated}、下架 ${ls.delisted}、恢復 ${ls.restored}）` : '還沒同步過'}</span>
    <span class="muted">・首圖：${lt ? fmtTime(lt.at) : '還沒同步過'}</span>
    <span class="spacer"></span>
    <button class="btn small" id="sync-setup">連線設定</button>
    <button class="btn small" id="sync-thumbs" ${S.settings.sheet_api_url ? '' : 'disabled'}>同步首圖</button>
    <button class="btn small primary" id="sync-sheet" ${S.settings.sheet_api_url ? '' : 'disabled'}>同步試算表</button>
  </div>`;
}

async function viewOverview() {
  const d = await api('GET', `/api/overview?filter=${S.ovFilter}`);
  const active = d.rows.filter((r) => !r.done);
  const done = d.rows.filter((r) => r.done).sort((a, b) => b.done_at - a.done_at);
  const idx = (r) => STEP_ORDER.indexOf(r.step);
  if (S.ovSort === 'progress') active.sort((a, b) => idx(b) - idx(a) || b.diff - a.diff);
  if (S.ovSort === 'slow') active.sort((a, b) => b.diff - a.diff || idx(b) - idx(a));
  const slow = active.filter((r) => r.level !== 'ok').length;
  const waiting = active.filter((r) => r.cells.some((c) => c.state === 'current' && c.waiting)).length;
  const returns = d.rows.reduce((s, r) => s + r.returns, 0);
  const overdue = active.filter((r) => r.rush?.overdue).length;
  S.radarKeys = active.map((r) => r.id);
  const c = d.counts;
  const filters = [['all', '全部', c.all], ['rush', '插隊', c.rush], ...['A', 'B', 'C', 'D'].map((k) => [k, `${k} ${STATUS[k]}`, c[k]]),
    ...(c.other ? [['other', '其他', c.other]] : []), ['delisted', '已下架', c.delisted]];
  const doneShown = S.ovDoneAll ? done : done.slice(0, 30);
  $app.innerHTML = `
    <div class="page-head">
      <h1>全覽</h1>
      <div class="seg batch-seg">${filters.map(([k, l, n]) => `<button data-filter="${k}" class="${S.ovFilter === k ? 'on' : ''}">${esc(l)} <span class="mono">${n}</span></button>`).join('')}</div>
      <span class="spacer"></span>
      ${isMkt() ? '<a class="btn" href="#/new">＋ 手動開單</a>' : ''}
    </div>
    ${syncBar()}
    <div class="ov-kpis">
      <div class="kpi-chip"><span>進行中</span><b class="mono">${active.length}</b></div>
      <div class="kpi-chip"><span>等人認領</span><b class="mono">${waiting}</b></div>
      <div class="kpi-chip k-ruby"><span>比平均慢</span><b class="mono">${slow}</b></div>
      <div class="kpi-chip k-topaz"><span>退件</span><b class="mono">${returns}</b></div>
      ${overdue ? `<div class="kpi-chip k-ruby"><span>插隊逾期</span><b class="mono">${overdue}</b></div>` : ''}
      <div class="kpi-chip k-emerald"><span>已完成</span><b class="mono">${done.length}</b></div>
      <span class="spacer"></span>
      <div class="seg"><button data-sort="priority" class="${S.ovSort === 'priority' ? 'on' : ''}">依優先</button><button data-sort="progress" class="${S.ovSort === 'progress' ? 'on' : ''}">依進度</button><button data-sort="slow" class="${S.ovSort === 'slow' ? 'on' : ''}">慢的優先</button></div>
    </div>
    <div class="legend" style="margin:0 0 10px 4px"><span class="lg-node done"></span>已走過<span class="lg-node late"></span>這一步比平均慢<span class="lg-pin"></span>目前位置<span class="lg-pin wait"></span>等人認領<span class="lg-node mine"></span>我負責的</div>
    <div class="card lanes">
      <div class="lane-row lane-head">
        <div class="lane-name">商品<span class="muted">（名稱連到商品頁，點這列看詳情）</span></div>
        <div class="lane">${FLOW.map((s, i) => `<span class="lane-step" style="left:${((i + 0.5) / FLOW.length) * 100}%;--sc:${STEP_COLOR[s]}">${esc(stepLabel(s))}</span>`).join('')}</div>
        <div class="lane-var">跟團隊平均比</div>
        <div class="lane-ret">退件</div>
      </div>
      ${active.map(laneRow).join('') || `<p class="empty">${S.ovFilter === 'delisted' ? '沒有已下架的商品' : S.me.can_sync && !S.settings.last_sheet_sync ? '還沒有商品：先按上面的「連線設定」接上試算表，再按「同步試算表」' : '這裡沒有進行中的商品'}</p>`}
    </div>
    <h2 class="done-h">已完成 <span class="muted mono">${done.length}</span></h2>
    <div class="card ov-wrap">
      <table class="ov done-table">
        <thead><tr><th class="ov-name">商品</th><th>完成時間</th><th class="num">跟團隊平均比</th><th class="num">退件</th></tr></thead>
        <tbody>${doneShown.map((r) => `<tr data-href="#/p/${r.id}">
          <td class="ov-name"><div class="row" style="gap:8px;flex-wrap:nowrap">${thumb(r.id, r.thumb, 'sm')}${statusBadge(r)}${shopName(r.name, r.link)}</div></td>
          <td class="mono">${r.done_at ? fmtTime(r.done_at) : ''}${r.rush ? (r.rush.missed ? ' <span class="tag red">錯過插隊日</span>' : ' <span class="tag green">插隊準時</span>') : ''}</td>
          <td class="num"><span class="var ${diffCls(r.diff)}">${esc(diffTxt(r.cells.some((x) => x.diff != null) ? r.diff : null))}</span></td>
          <td class="num mono ${r.returns ? 'over' : 'faint'}">${r.returns}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">還沒有完成的商品</td></tr>'}</tbody>
      </table>
      ${done.length > doneShown.length ? `<div class="row" style="padding:10px"><span class="spacer"></span><button class="btn small" id="done-all">顯示全部 ${done.length} 件</button></div>` : ''}
    </div>
    <p class="muted" style="margin-top:12px">滑鼠移到圓點看每一步花了多久、團隊平均多久。平均只拿走完這一步的商品來算，至少 3 件才比；沒人認領的等待時間也算在那一步。只算上班時間。</p>`;
  $app.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { S.ovFilter = b.dataset.filter; viewOverview(); }; });
  $app.querySelectorAll('[data-sort]').forEach((b) => { b.onclick = () => { S.ovSort = b.dataset.sort; viewOverview(); }; });
  $app.querySelectorAll('[data-href]').forEach((row) => {
    row.onclick = (e) => { if (!e.target.closest('a, button')) location.hash = row.dataset.href; };
  });
  const da = document.getElementById('done-all');
  if (da) da.onclick = () => { S.ovDoneAll = true; viewOverview(); };
  bindSyncBar();
}

// ---------- 試算表與首圖同步（設計師、管理員） ----------

function bindSyncBar() {
  const setup = document.getElementById('sync-setup');
  if (!setup) return;
  setup.onclick = openSyncSetup;
  document.getElementById('sync-sheet').onclick = () => syncSheet(false);
  document.getElementById('sync-thumbs').onclick = syncThumbs;
}

async function syncSheet(force) {
  S.busy++;
  toast('同步試算表中…', false, 0);
  try {
    const r = await api('POST', '/api/sync/sheet', { force });
    toast(`同步完成：共 ${r.total} 件，新增 ${r.added}、更新 ${r.updated}、下架 ${r.delisted}、恢復 ${r.restored}`, false, 6000);
    S.busy--;
    await refresh();
    return;
  } catch (e) {
    S.busy--;
    if (e.data?.code === 'mass_delist') {
      document.getElementById('toast').hidden = true;
      if (confirm(`${e.message}\n\n按「確定」照樣同步，按「取消」先不要。`)) return syncSheet(true);
      return;
    }
    toast(e.message, true, 6000);
  }
}

async function syncThumbs() {
  const since = Date.now();
  let done = 0;
  let updated = 0;
  const failed = [];
  S.busy++;
  try {
    for (let i = 0; i < 200; i++) {
      const r = await api('POST', '/api/sync/thumbs', { since });
      done += r.processed;
      updated += r.updated;
      failed.push(...r.failed);
      toast(`首圖同步中… 已處理 ${done} 件，剩 ${r.remaining} 件`, false, 0);
      if (!r.remaining || !r.processed) break;
    }
    toast(`首圖同步完成：處理 ${done} 件，更新 ${updated} 張${failed.length ? `，${failed.length} 件抓不到（${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}）` : ''}`, false, 8000);
  } catch (e) {
    toast(e.message, true, 6000);
  } finally {
    S.busy--;
  }
  await refresh();
}

async function openSyncSetup() {
  if (!S.settings.sheet_api_key) {
    await api('PUT', '/api/sheet-source', {});
    await loadBase();
  }
  const tpl = await fetch('/apps-script.txt').then((r) => r.text());
  const code = tpl.replace('__KEY__', S.settings.sheet_api_key);
  openModal(`
    <h3>連線設定：Google 試算表</h3>
    <ol class="steps">
      <li>打開「廣告數據表」，上方選單 <b>擴充功能 → Apps Script</b>。</li>
      <li>把編輯區原本的內容全部刪掉，貼上下面這段程式，按儲存。</li>
      <li>右上角 <b>部署 → 新增部署作業</b>，類型選 <b>網頁應用程式</b>：執行身分選「我」，誰可以存取選「<b>所有人</b>」，按部署並同意授權。</li>
      <li>把產生的 <b>網頁應用程式網址</b>（…/exec 結尾）貼到下面，按儲存。</li>
    </ol>
    <div class="field"><span>程式（已含這個系統專用的密碼）</span><textarea readonly class="code" id="gs-code">${esc(code)}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn small" id="gs-copy">複製程式</button><span class="spacer"></span><button class="btn small danger" id="gs-rekey">換新密碼</button></div></div>
    <label class="field"><span>網頁應用程式網址</span><input type="url" id="gs-url" value="${esc(S.settings.sheet_api_url || '')}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <p class="muted">沒有密碼的人打開這個網址只會看到「密碼錯誤」。系統只讀 A 狀態、C 商品／活動、D 商品連結三欄，不會改試算表。</p>
    <div class="acts"><button class="btn" data-close>取消</button><button class="btn primary" id="gs-save">儲存</button></div>`,
  (m, close) => {
    m.querySelector('#gs-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(code); toast('已複製程式'); } catch { m.querySelector('#gs-code').select(); }
    };
    m.querySelector('#gs-rekey').onclick = () => {
      if (!confirm('換新密碼後，Apps Script 裡的程式也要重新貼上並重新部署，否則同步會失敗。確定要換？')) return;
      act(async () => { await api('PUT', '/api/sheet-source', { new_key: true }); close(); }, '已換新密碼，請重新貼上程式').then(() => openSyncSetup());
    };
    m.querySelector('#gs-save').onclick = () => act(async () => {
      await api('PUT', '/api/sheet-source', { url: m.querySelector('#gs-url').value.trim() });
      close();
    }, '已儲存，可以按「同步試算表」了');
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

function photoGrid(p, kind, { upload = false, del = false, download = false } = {}) {
  const list = p.photos.filter((ph) => ph.kind === kind);
  return `<div class="photos">
    ${list.map((ph) => `<div class="photo">
        <img loading="lazy" src="/api/photos/${ph.id}" data-full="/api/photos/${ph.id}" alt="${esc(ph.filename)}" title="${esc(member(ph.uploaded_by)?.name ?? '')} · ${fmtTime(ph.created_at)}">
        <div class="tools">
          ${download ? `<a class="btn small" href="/api/photos/${ph.id}?download=1">下載</a>` : ''}
          ${del ? `<button class="btn small danger" data-del-photo="${ph.id}">刪除</button>` : ''}
        </div>
      </div>`).join('')}
    ${upload ? `<label class="dropzone" data-drop="${kind}"><input type="file" accept="image/*" multiple hidden data-file="${kind}"><span>＋ 上傳${KIND[kind]}<br><span class="muted">點選或拖曳，可多張</span></span></label>` : ''}
    ${!upload && !list.length ? '<div class="muted">尚無</div>' : ''}
  </div>`;
}

// 完成後交給誰（顯示用；實際由後端決定）
function nextHint(p) {
  if (p.return_to === 'mkt_check' && p.step !== 'mkt_check') return `行銷檢查（${member(p.marketer_id)?.name ?? '行銷'}）`;
  const next = STEP_ORDER[STEP_ORDER.indexOf(p.step) + 1];
  if (next === 'done') return '已完成';
  if (next === 'mkt_check') return `行銷檢查（${member(p.marketer_id)?.name ?? '行銷'}）`;
  return `${stepLabel(next)}`;
}

function returnForm(p) {
  const isCheck = p.step === 'mkt_check';
  const isOpt = p.step === 'optimizing';
  const targets = ['cutout', 'listing', 'optimizing'];
  const prev = { cutout: 'open', listing: 'cutout' }[p.step];
  return `<div class="return-box" data-return-form hidden>
    ${isCheck ? `<div class="field"><span>退回哪一步（改好後直接交回你）</span>
      <div class="hour-pick" id="ret-target">${targets.map((t) => `<label><input type="radio" name="target" value="${t}">${esc(stepLabel(t))}</label>`).join('')}</div></div>`
    : isOpt ? `<div class="field"><span>哪裡有問題（改好後直接交回你）</span>
      <div class="hour-pick" id="ret-target"><label><input type="radio" name="target" value="listing">文案 → 上架人員</label><label><input type="radio" name="target" value="cutout">去背圖 → 美編</label></div></div>
      <label class="rename-chk" hidden><input type="checkbox" name="rename"> 商品名稱要改（Shopline 網址會跟著變，上架人員要去試算表換新網址）</label>`
    : `<p class="muted" style="margin-top:0">會退回「${esc(stepLabel(prev))}」，記一次退件在上一步的人身上。</p>`}
    <label class="field"><span>哪裡有問題（必填）</span><textarea data-return-note placeholder="例：去背邊緣有白邊、主圖比例不對"></textarea></label>
    <div class="row"><span class="missing" data-ret-miss></span><span class="spacer"></span><button class="btn warn act" data-return disabled>送出退回</button></div>
  </div>`;
}

function actionPanel(p) {
  const open = p.open;
  const shop = (p.sl_url || p.link) ? `<a class="btn" href="${esc(p.sl_url || p.link)}" target="_blank" rel="noopener">開啟 Shopline 商品頁 ↗</a>` : '';
  if (p.delisted_at) {
    return `<div class="card action locked"><h2>已下架</h2><div class="sub">試算表裡已經沒有這件，${fmtTime(p.delisted_at)} 標成已下架。試算表加回來後，下次同步會自動恢復。</div></div>`;
  }
  if (p.step === 'done') {
    return `<div class="card action locked"><h2>已完成</h2><div class="sub">${p.done_at ? `${fmtTime(p.done_at)} 由行銷檢查通過` : ''}</div><div class="row">${shop}</div></div>`;
  }
  if (!open) return '';
  const returned = p.returned ? `
    <div class="returned"><b>被 ${esc(member(p.returned.by_id)?.name ?? '')} 退回</b>（${fmtTime(p.returned.at)}）
      <div class="note">${esc(p.returned.note)}</div></div>` : '';
  const st = p.steps[p.step];
  const timeLine = `這一步已花 <span class="mono">${esc(fmtWork(st.held))}</span>${st.pool ? `（其中等認領 ${esc(fmtWork(st.pool))}）` : ''}・團隊平均 <span class="mono">${st.avg != null ? esc(fmtWork(st.avg)) : '資料不足'}</span>`;
  const role = open.role;
  if (!open.member_id) {
    const can = hasRole(role);
    return `<div class="card action ${can ? 'mine' : 'locked'}">${returned}
      <h2>「${esc(stepLabel(p.step))}」等人認領</h2>
      <div class="sub">${timeLine}</div>
      ${can ? `<button class="btn primary act" id="claim-btn">我來做</button> <span class="muted">認領後只會出現在你的待辦</span>`
        : `<span class="muted">等${esc(roleName(role))}認領</span>`}
    </div>`;
  }
  if (open.member_id !== S.me.id) {
    const holder = member(open.member_id);
    return `<div class="card action locked">${returned}
      <h2>目前在「${esc(stepLabel(p.step))}」</h2>
      <div class="sub">負責人：${who(open.member_id)}・${timeLine}</div>
      <button class="btn disabled" disabled>只有 ${esc(holder?.name ?? '負責人')} 可以操作</button>
      <span class="muted">需要催的話，在下方留言 @${esc(holder?.name ?? '')}</span>
    </div>`;
  }
  const head = (title, sub) => `<div class="row" style="align-items:flex-start"><div style="flex:1"><h2>${title}</h2><div class="sub">${sub}</div></div>
    <button class="btn small" id="release-btn" title="不做了，放回給其他${esc(roleName(role))}">放回待認領</button></div>`;
  const retBtn = p.step !== 'open' ? `<button class="btn danger act" data-open-return>${['mkt_check', 'optimizing'].includes(p.step) ? '退回…' : '退回上一步…'}</button>` : '';
  const foot = (btn, miss = '') => `<div class="row" style="margin-top:14px">${retBtn}<span class="missing" id="miss">${esc(miss)}</span><span class="spacer"></span>${btn}</div>${p.step !== 'open' ? returnForm(p) : ''}`;
  const toTxt = esc(nextHint(p));
  switch (p.step) {
    case 'open': {
      const n = p.photos.filter((ph) => ph.kind === 'pick').length;
      return `<div class="card action mine">${returned}${head('開單・上傳選品照片', `${timeLine}。上傳後交給美編去背；最後的行銷檢查也是你。`)}
        <div class="row" style="margin-bottom:12px">${shop}</div>
        ${photoGrid(p, 'pick', { upload: true, del: true })}
        ${foot(`<button class="btn primary act" id="complete-btn" ${n ? '' : 'disabled'}>開單完成 → ${toTxt}</button>`, n ? '' : '至少 1 張選品照片')}</div>`;
    }
    case 'cutout': {
      const n = p.photos.filter((ph) => ph.kind === 'cutout').length;
      return `<div class="card action mine">${returned}${head('去背・做首圖去背', `${timeLine}。選品照片有問題就退回行銷。`)}
        <div class="kind-title">選品照片</div>${photoGrid(p, 'pick', { download: true })}
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout', { upload: true, del: true })}
        ${foot(`<button class="btn primary act" id="complete-btn" ${n ? '' : 'disabled'}>去背完成 → ${toTxt}</button>`, n ? '' : '請上傳去背圖')}</div>`;
    }
    case 'listing': {
      const url = p.rename_pending ? '' : (p.sl_url || p.link || '');
      const rename = p.rename_pending ? `<div class="warnbox rename-box"><b>商品名稱要改，網址會跟著變</b>
        <ol class="steps"><li>在 Shopline 改好商品名稱，複製新的商品網址。</li>
        <li>到試算表「銷售型-投廣素材」：這件的 D 欄換成新網址；舊網址那一列移到最下面，狀態寫「<b>已更名失效</b>」。</li>
        <li>把新網址貼到下面，按完成，會直接交回設計師。</li></ol>
        <div class="muted">舊網址：${esc(p.link)}</div></div>` : '';
      return `<div class="card action mine">${returned}${rename}${head('上架・上 Shopline', `${timeLine}。用選品照片和去背圖上架，去背有問題就退回美編。`)}
        <div class="kind-title">選品照片</div>${photoGrid(p, 'pick', { download: true })}
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout', { download: true })}
        <label class="field" style="margin-top:14px"><span>Shopline 商品網址</span><input type="url" id="sl-url" value="${esc(url)}" placeholder="https://"></label>
        ${foot(`<button class="btn primary act" id="complete-btn">已上架 → ${toTxt}</button>`)}</div>`;
    }
    case 'optimizing': {
      return `<div class="card action mine">${returned}${head('優化・直接改 Shopline 線上頁面', `${timeLine}。上架有問題就退回上架人員。`)}
        <div class="row" style="margin-bottom:12px">${shop}</div>
        <div class="kind-title">選品照片・去背圖（參考）</div>${photoGrid(p, 'pick', { download: true })}${photoGrid(p, 'cutout', { download: true })}
        <div class="kind-title">優化截圖（選填）</div>${photoGrid(p, 'opt', { upload: true, del: true })}
        <label class="field" style="margin-top:14px"><span>改了什麼（必填）</span><textarea id="opt-note" placeholder="例：換主圖、補尺寸表、調整比例"></textarea></label>
        ${foot(`<button class="btn primary act" id="complete-btn" disabled>已更新線上 → ${toTxt}</button>`, '請填寫改了什麼')}</div>`;
    }
    case 'mkt_check': {
      const lastOpt = [...p.stints].reverse().find((s) => s.step === 'optimizing' && s.end_note);
      return `<div class="card action mine">${head('行銷檢查・投放前最後確認', `${timeLine}。哪一步有問題就退回那一步，改好直接回到你這裡。`)}
        <div class="row" style="margin-bottom:12px">${shop.replace('class="btn"', 'class="btn primary"')}</div>
        ${lastOpt ? `<div class="returned soft"><b>${esc(member(lastOpt.member_id)?.name ?? '')} 改了什麼</b><div class="note">${esc(lastOpt.end_note)}</div></div>` : ''}
        <div class="kind-title">去背圖</div>${photoGrid(p, 'cutout')}
        <div class="kind-title">優化截圖</div>${photoGrid(p, 'opt')}
        ${foot('<button class="btn go act" id="complete-btn">檢查通過 → 已完成</button>')}</div>`;
    }
    default:
      return '';
  }
}

function rushBlock(p) {
  if (p.step === 'done' && !p.rush) return '';
  const r = p.rush;
  const can = isMkt() && p.step !== 'done' && !p.delisted_at;
  if (!r && !can) return '';
  return `<div class="card section rush-box ${r?.urgent || r?.overdue ? 'hot' : ''}">
    <h2>插隊 ${r ? `<span class="tag ${r.overdue ? 'red' : r.urgent ? 'rush' : 'rush-soft'}">${r.overdue ? '已逾期' : r.urgent ? '急件' : '插隊中'}</span>` : ''}</h2>
    ${r ? `<div class="row"><div><div class="muted">完成日期</div><b>${esc(fmtDate(r.date))} 下班前</b></div>
      ${p.step !== 'done' ? `<div><div class="muted">剩餘上班時間</div><span class="big mono">${r.remaining_h > 0 ? esc(fmtWork(r.remaining_h)) : '已逾期'}</span></div>` : `<div>${r.missed ? '<span class="tag red">錯過插隊日</span>' : '<span class="tag green">準時完成</span>'}</div>`}</div>` : '<p class="muted" style="margin:0 0 8px">設定完成日期後，這件會排到所有人待辦的最前面；剩 2 個上班日內變急件。</p>'}
    ${can ? `<div class="row" style="margin-top:10px"><input type="date" id="rush-date" min="${tomorrowYmd()}" value="${esc(r?.date ?? '')}" style="max-width:180px">
      <button class="btn small primary" id="rush-set">${r ? '改日期' : '設定插隊'}</button>${r ? '<button class="btn small" id="rush-clear">取消插隊</button>' : ''}
      <span class="muted">最早只能選明天</span></div>` : ''}
  </div>`;
}

function stepsBlock(p) {
  return `<div class="card section"><h2>每一步花了多久 <span class="muted">跟團隊平均比</span></h2>
    <table class="rank"><thead><tr><th>步驟</th><th class="num">花了</th><th class="num">平均</th><th class="num">差</th></tr></thead>
    <tbody>${FLOW.map((s) => {
      const x = p.steps[s];
      const started = x.held > 0 || p.step === s;
      return `<tr><td>${esc(stepLabel(s))}${x.rounds > 1 ? ` <span class="tag red">${x.rounds} 輪</span>` : ''}</td>
        <td class="num mono">${started ? esc(fmtWork(x.held)) : '—'}${x.pool ? `<div class="muted">等認領 ${esc(fmtWork(x.pool))}</div>` : ''}</td>
        <td class="num mono">${x.avg != null ? esc(fmtWork(x.avg)) : '—'}</td>
        <td class="num">${started && x.diff != null ? `<span class="var ${diffCls(x.diff)}">${esc(diffTxt(x.diff))}</span>` : '—'}</td></tr>`;
    }).join('')}</tbody></table>
  </div>`;
}

function attributionBlock(p) {
  if (!p.attribution.length) return '';
  const total = p.attribution.reduce((s, a) => s + a.held, 0) || 1;
  return `<div class="card section">
    <h2>時間歸屬 <span class="muted">上班時數</span></h2>
    <div class="attr-bar">${p.attribution.map((a) => `<div style="width:${(a.held / total) * 100}%;background:${member(a.member_id)?.color ?? '#D8CFE3'}" title="${esc(member(a.member_id)?.name ?? '等人認領')} ${a.held}h"></div>`).join('')}</div>
    ${p.attribution.map((a) => `<div class="attr-row">${a.member_id ? who(a.member_id) : '<span class="who muted">等人認領</span>'}<span class="muted">${a.steps.map(stepLabel).join('、')}</span><span class="num mono">${a.held}h</span></div>`).join('')}
  </div>`;
}

function timelineBlock(p) {
  const items = [...p.stints].reverse();
  const END = { complete: '完成', pass: '檢查通過', return: '退回', claim: '有人認領', release: '放回', reassign: '改派', admin: '管理員推進', delisted: '下架' };
  return `<div class="card section"><h2>流程紀錄</h2><ul class="timeline">
    ${items.map((s) => `<li class="${s.start_reason === 'return' ? 'ret' : ''} ${s.ended_at == null ? 'open' : ''}">
        <b>${esc(stepLabel(s.step))}</b>・${s.member_id ? esc(member(s.member_id)?.name ?? '—') : '<span class="muted">等人認領</span>'}
        <span class="muted">${fmtTime(s.started_at)} → ${s.ended_at ? fmtTime(s.ended_at) + ' ' + (END[s.end_reason] || '') : '進行中'}・${esc(fmtWork(s.held))}</span>
        ${s.start_reason === 'return' ? `<div class="note"><b>被 ${esc(member(s.by_id)?.name ?? '')} 退回</b>\n${esc(s.note)}</div>` : ''}
        ${s.start_reason === 'reassign' ? `<div class="muted">由 ${esc(member(s.by_id)?.name ?? '')} 改派</div>` : ''}
        ${s.start_reason === 'restore' ? '<div class="muted">試算表加回來，恢復</div>' : ''}
        ${s.end_note ? `<div class="note">改了什麼：${esc(s.end_note)}</div>` : ''}
      </li>`).join('')}
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

function adminBar(p) {
  if (!S.me.is_admin || p.step === 'done' || p.delisted_at) return '';
  const open = p.open;
  const ms = open ? S.members.filter((m) => m.active && m.roles.includes(open.role)) : [];
  return `<div class="card admin-bar"><span class="muted">管理員操作</span>
    ${open ? `<label class="row" style="gap:6px"><span class="muted">改派</span><select id="reassign" style="width:auto">
      <option value="">等人認領</option>${ms.map((m) => `<option value="${m.id}" ${m.id === open.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}
    <span class="spacer"></span>
    <button class="btn act" id="admin-advance">直接推到下一關：${esc(nextHint(p))} →</button></div>`;
}

async function viewProduct(idStr) {
  const id = Number(idStr);
  const p = await api('GET', `/api/products/${id}`);
  const idx = STEP_ORDER.indexOf(p.step);
  const nextId = S.radarKeys[S.radarKeys.indexOf(id) + 1] || (S.radarKeys[0] !== id ? S.radarKeys[0] : null);
  const cur = p.open && p.steps[p.step];
  const level = cur && p.open ? cur.level : 'ok';
  $app.innerHTML = `
    <div class="page-head">
      <a href="#/overview" class="btn small">← 全覽</a>
      ${thumb(p.id, p.thumb_ver, 'md')}
      <h1>${shopName(p.name, p.link)}</h1>${statusBadge(p)}${stepChip(p.step)}
      ${p.delisted_at ? '<span class="tag red">已下架</span>' : ''}
      ${level === 'very' ? '<span class="tag red">很慢</span>' : level === 'slow' ? '<span class="tag yellow">偏慢</span>' : ''}
      ${p.sheet_status ? `<span class="muted">試算表：${esc(p.sheet_status)}</span>` : p.source === 'manual' ? '<span class="muted">手動開單</span>' : ''}
      <span class="spacer"></span>
      ${nextId ? `<a class="btn small" href="#/p/${nextId}">下一件 →</a>` : ''}
      ${S.me.is_admin ? '<button class="btn small danger" id="del-product">刪除</button>' : ''}
    </div>
    <div class="stepper">${STEP_ORDER.map((s, i) => `<div class="step ${i < idx ? 'done' : ''} ${i === idx ? 'cur' : ''}" style="${i === idx ? `background:${STEP_COLOR[s]}` : ''}">${i < idx ? '✓ ' : ''}${esc(stepLabel(s))}</div>`).join('')}</div>
    <div id="action">${actionPanel(p)}</div>
    ${adminBar(p)}
    <div class="detail">
      <div>
        <div class="card section"><h2>圖片</h2>
          ${['pick', 'cutout', 'opt'].filter((k) => p.photos.some((ph) => ph.kind === k)).map((k) => `<div class="kind-title">${KIND[k]}</div>${photoGrid(p, k, { download: true })}`).join('') || '<div class="muted">尚無圖片</div>'}
        </div>
        ${commentsBlock(p)}
      </div>
      <div>
        ${rushBlock(p)}
        ${stepsBlock(p)}
        ${attributionBlock(p)}
        ${timelineBlock(p)}
      </div>
    </div>`;
  bindProduct(p);
}

function bindProduct(p) {
  const id = p.id;
  const doAction = (action, extra = {}, doneMsg = null) => act(async () => {
    await api('POST', `/api/products/${id}/action`, { action, version: p.version, step: p.step, ...extra });
    $app.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    if (doneMsg) { S.handled = { name: p.name, to: doneMsg, at: Date.now() }; location.hash = '#/radar'; }
  }, doneMsg ? null : '已完成', doneMsg ? 'none' : 'refresh');

  const cb = document.getElementById('claim-btn');
  if (cb) cb.onclick = () => claim(id, p.version, p.step);
  const rb = document.getElementById('release-btn');
  if (rb) rb.onclick = () => confirm('放回待認領？其他同身分的人就能接手。') && doAction('release');

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

  // 完成這一步
  const done = document.getElementById('complete-btn');
  if (done) {
    const miss = document.getElementById('miss');
    const slUrl = document.getElementById('sl-url');
    const optNote = document.getElementById('opt-note');
    if (slUrl) {
      const sameAsOld = (v) => p.rename_pending && v.replace(/[?#].*$/, '').replace(/\/+$/, '') === String(p.link).replace(/[?#].*$/, '').replace(/\/+$/, '');
      const sync = () => {
        const v = slUrl.value.trim();
        const ok = /^https?:\/\//.test(v) && !sameAsOld(v);
        done.disabled = !ok;
        miss.textContent = ok ? '' : sameAsOld(v) ? '這是舊網址，請貼改名後的新網址' : '請貼上 Shopline 商品網址';
      };
      slUrl.oninput = sync;
      sync();
    }
    if (optNote) optNote.oninput = () => { done.disabled = !optNote.value.trim(); miss.textContent = optNote.value.trim() ? '' : '請填寫改了什麼'; };
    done.onclick = () => {
      const extra = slUrl ? { sl_url: slUrl.value.trim() } : optNote ? { note: optNote.value.trim() } : {};
      doAction('complete', extra, p.step === 'mkt_check' ? '檢查通過，已完成' : `已交給 ${nextHint(p)}`);
    };
  }

  // 退回
  const rf = $app.querySelector('[data-return-form]');
  if (rf) {
    $app.querySelector('[data-open-return]').onclick = () => { rf.hidden = !rf.hidden; if (!rf.hidden) rf.querySelector('textarea').focus(); };
    const note = rf.querySelector('[data-return-note]');
    const send = rf.querySelector('[data-return]');
    const target = () => rf.querySelector('[name=target]:checked')?.value;
    const sync = () => {
      rf.querySelectorAll('.hour-pick label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      const miss = [];
      if (['mkt_check', 'optimizing'].includes(p.step) && !target()) miss.push(p.step === 'optimizing' ? '文案或去背圖' : '退回哪一步');
      const rc = rf.querySelector('.rename-chk');
      if (rc) { rc.hidden = target() !== 'listing'; if (rc.hidden) rc.querySelector('input').checked = false; }
      if (!note.value.trim()) miss.push('哪裡有問題');
      send.disabled = miss.length > 0;
      rf.querySelector('[data-ret-miss]').textContent = miss.length ? `還缺：${miss.join('、')}` : '';
    };
    rf.addEventListener('input', sync);
    rf.addEventListener('change', sync);
    sync();
    send.onclick = () => {
      const t = ['mkt_check', 'optimizing'].includes(p.step) ? target() : { cutout: 'open', listing: 'cutout' }[p.step];
      const rename = !!rf.querySelector('[name=rename]:checked');
      doAction('return', { note: note.value.trim(), target: t, rename }, `已退回「${stepLabel(t)}」${rename ? '，上架人員會換新網址' : ''}`);
    };
  }

  // 插隊
  const rs = document.getElementById('rush-set');
  if (rs) {
    rs.onclick = () => {
      const date = document.getElementById('rush-date').value;
      if (!date) return toast('請選擇完成日期', true);
      if (date < tomorrowYmd()) return toast('完成日期最早只能選明天', true);
      act(() => api('PUT', `/api/products/${id}/rush`, { date }), `已設定插隊：${fmtDate(date)}下班前完成`);
    };
  }
  const rc = document.getElementById('rush-clear');
  if (rc) rc.onclick = () => confirm('取消插隊？') && act(() => api('PUT', `/api/products/${id}/rush`, { date: null }), '已取消插隊');

  // 管理員
  const ra = document.getElementById('reassign');
  if (ra) {
    ra.onchange = () => {
      const name = ra.value ? ra.options[ra.selectedIndex].text : '等人認領';
      if (!confirm(`改派給「${name}」？`)) { delete ra.dataset.dirty; return refresh(); }
      act(() => api('POST', `/api/products/${id}/action`, { action: 'reassign', version: p.version, member_id: Number(ra.value) || null }), '已改派');
    };
  }
  const adv = document.getElementById('admin-advance');
  if (adv) {
    adv.onclick = () => openModal(`
      <h3>直接推到下一關？</h3>
      <p class="muted">不用等負責人、也不檢查完成條件。這個動作會記錄在流程紀錄，標示為管理員推進。</p>
      <label class="field"><span>原因（選填）</span><textarea id="adv-note" placeholder="例：已口頭確認、負責人請假"></textarea></label>
      <div class="acts"><button class="btn" data-close>取消</button><button class="btn primary" id="adv-go">確定推進</button></div>`,
    (m, close) => {
      m.querySelector('#adv-go').onclick = () => {
        const note = m.querySelector('#adv-note').value.trim();
        close();
        doAction('admin_advance', { note });
      };
    });
  }

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
    act(async () => { await api('DELETE', `/api/products/${id}`); location.hash = '#/overview'; }, '已刪除', 'none');
}

// ---------- 成效分析 ----------

async function viewAnalysis() {
  const a = S.ana;
  const r = await api('GET', `/api/analysis?days=${a.days}`);
  const m = r.metrics;
  const team = r.ranking.team_avg;
  const kpi = (label, value, unit, hint) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value ?? '—'}${value != null && unit ? `<small> ${unit}</small>` : ''}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const cell = (st) => {
    if (!st) return '<td class="num faint">—</td>';
    const d = st.diff;
    return `<td class="num"><span class="mono">${esc(fmtWork(st.avg))}</span><div><span class="var ${diffCls(d)}">${d == null ? `${st.n} 件` : `${esc(diffTxt(d))}・${st.n} 件`}</span></div></td>`;
  };
  $app.innerHTML = `
    <div class="page-head">
      <h1>成效分析</h1>
      <div class="seg" data-f="days">${[[7, '7 天'], [30, '30 天'], [90, '90 天'], [0, '全部']].map(([k, l]) => `<button data-v="${k}" class="${a.days === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="kpis">
      ${kpi('完成件數', m.done_count, '件')}
      ${kpi('退件總數', m.returns_total, '次', FLOW.filter((s) => m.returns_by_step[s]).map((s) => `${stepLabel(s)} ${m.returns_by_step[s]}`).join('・') || '')}
      ${kpi('插隊件數', m.rush_total, '件')}
      ${kpi('錯過插隊日', m.rush_missed, '件')}
    </div>
    <div class="card section">
      <h2>每一步的團隊平均 <span class="muted">只算上班時間；「等認領」是還沒人接的時間，看得出哪一關沒人接</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>步驟</th><th class="num">平均花多久</th><th class="num">其中等認領</th><th class="num">樣本</th><th class="num">被退件</th></tr></thead>
        <tbody>${FLOW.map((s) => `<tr><td>${stepChip(s)}</td>
          <td class="num mono">${m.steps[s].avg != null ? esc(fmtWork(m.steps[s].avg)) : '資料不足'}</td>
          <td class="num mono">${m.steps[s].pool_avg != null ? esc(fmtWork(m.steps[s].pool_avg)) : '—'}</td>
          <td class="num mono">${m.steps[s].n}</td><td class="num mono">${m.returns_by_step[s]}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card section">
      <h2>個人成效 <span class="muted">每個人每一步平均花多久，跟同一步的團隊平均比（只算自己認領後的時間）</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>成員</th>${FLOW.map((s) => `<th class="num">${esc(stepLabel(s))}${team[s] != null ? `<div class="faint">均 ${esc(fmtWork(team[s]))}</div>` : ''}</th>`).join('')}<th class="num">合計比平均</th><th class="num">被退件</th><th class="num">發出退件</th></tr></thead>
        <tbody>${r.ranking.rows.map((x) => `<tr>
          <td>${who(x.member_id)}<div class="muted">${esc(rolesText(member(x.member_id)))}</div></td>
          ${FLOW.map((s) => cell(x.steps[s])).join('')}
          <td class="num"><span class="var big ${diffCls(x.extra || null)}">${esc(diffTxt(x.extra || null))}</span></td>
          <td class="num mono ${x.returned ? 'over' : ''}">${x.returned}</td>
          <td class="num mono">${x.issued}</td>
        </tr>`).join('') || `<tr><td colspan="${FLOW.length + 4}" class="empty">這段期間還沒有資料</td></tr>`}</tbody>
      </table></div>
      <p class="muted" style="margin-top:12px">被退件算在上一次做那一步的人身上。同一步走完至少 3 件，才會出現團隊平均。</p>
    </div>
    ${r.ranking.rows.some((x) => x.returned) ? `<div class="card section"><h2>被退件內容</h2>
      ${r.ranking.rows.filter((x) => x.returned).map((x) => `<details class="ret-list"><summary>${who(x.member_id)} <span class="muted">${x.returned} 次</span></summary>
        ${x.returned_list.map((e) => `<div class="log-item"><div><a href="#/p/${e.product_id}">${esc(r.names[e.product_id] ?? '')}</a>・${esc(stepLabel(e.step))}
          <span class="muted">（${esc(member(e.by_id)?.name ?? '')} 退回）</span><div class="note">${esc(e.note)}</div></div><time>${fmtTime(e.at)}</time></div>`).join('')}
      </details>`).join('')}</div>` : ''}`;
  $app.querySelectorAll('[data-f] button').forEach((b) => {
    b.onclick = () => { S.ana.days = Number(b.dataset.v); viewAnalysis(); };
  });
}

// ---------- 紀錄 ----------

const ACTIONS = {
  product_add: '手動開單', claim: '認領', release: '放回待認領', complete: '完成', return: '退回', check_pass: '行銷檢查通過',
  admin_advance: '管理員手動推進', reassign: '改派', comment_add: '留言', comment_delete: '刪除留言', photo_add: '上傳照片',
  photo_delete: '刪除照片', mention_ack: '已讀提及', rush_set: '設定插隊', rush_clear: '取消插隊',
  sheet_sync: '同步試算表', thumb_sync: '同步首圖', sheet_source_edit: '修改試算表連線',
  member_add: '新增成員', member_edit: '修改成員', member_reset: '重設綁定', settings_edit: '修改設定',
  product_delete: '刪除商品', product_restore: '還原商品', photo_restore: '還原照片', comment_restore: '還原留言',
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
  const roles = Object.entries(S.roles);
  $app.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <div class="set-grid">
      <div class="card section">
        <h2>成員</h2>
        <p class="muted" style="margin-top:-6px">成員第一次選名字後綁定裝置。換裝置或選錯，按「重設綁定」。</p>
        ${S.members.map((m) => `
          <div class="mrow" data-member="${m.id}">
            <div class="top">${avatar(m)}<input type="text" value="${esc(m.name)}" maxlength="30" data-name>
              ${m.is_admin ? '<span class="tag blue">管理員</span>' : ''}
              ${!m.active ? '<span class="tag red">停用</span>' : m.bound ? `<span class="tag green" title="${fmtTime(m.bound_at)}">已綁定</span>` : '<span class="tag">未綁定</span>'}
            </div>
            <div class="roles">${roles.map(([k, l]) => `<label class="${m.roles.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${m.roles.includes(k) ? 'checked' : ''}>${l}</label>`).join('')}</div>
            <div class="row">
              <button class="btn small" data-a="save">儲存</button>
              ${m.bound ? '<button class="btn small danger" data-a="reset">重設綁定</button>' : ''}<button class="btn small" data-a="admin">${m.is_admin ? '取消管理員' : '設為管理員'}</button>
              <button class="btn small ${m.active ? 'danger' : ''}" data-a="active">${m.active ? '停用' : '啟用'}</button>
            </div>
          </div>`).join('')}
        <form id="add-member" style="margin-top:14px">
          <div class="row"><input type="text" name="name" placeholder="新成員名字" maxlength="30" required style="flex:1;width:auto">
            <button class="btn primary">新增</button></div>
        </form>
      </div>

      <div>
        <form class="card section" id="work-form">
          <h2>上班時間與插隊</h2>
          <div class="field"><span>上班日</span><div class="days">${['日', '一', '二', '三', '四', '五', '六'].map((d, i) => `<label class="${st.work.days.includes(i) ? 'on' : ''}"><input type="checkbox" value="${i}" ${st.work.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
          <div class="row">
            <label class="field" style="flex:1"><span>上班</span><input type="number" name="start" min="0" max="23" value="${st.work.start}"></label>
            <label class="field" style="flex:1"><span>下班（插隊截止也是這個時間）</span><input type="number" name="end" min="1" max="24" value="${st.work.end}"></label>
          </div>
          <label class="field"><span>國定假日（一行一天，YYYY-MM-DD）</span><textarea name="holidays" placeholder="2026-10-09&#10;2026-10-10">${esc(st.work.holidays.join('\n'))}</textarea></label>
          <label class="field"><span>插隊剩幾個上班日內變急件</span><input type="number" step="0.5" min="0.5" name="rush_days" value="${st.rush_threshold_days}" style="max-width:140px"></label>
          <div class="row"><span class="spacer"></span><button class="btn primary">儲存設定</button></div>
        </form>

        <div class="card section">
          <h2>回收區</h2>
          ${[
            ...trash.products.map((x) => ({ type: 'product', id: x.id, label: `商品「${x.name}」`, at: x.deleted_at })),
            ...trash.photos.map((x) => ({ type: 'photo', id: x.id, label: `${KIND[x.kind] || '照片'}（${x.product_name}）`, at: x.deleted_at })),
            ...trash.comments.map((x) => ({ type: 'comment', id: x.id, label: `留言「${x.body.slice(0, 20)}」（${x.product_name}）`, at: x.deleted_at })),
          ].sort((x, y) => y.at - x.at).map((x) => `<div class="set-row"><span style="flex:1">${esc(x.label)}</span><span class="muted mono">${fmtTime(x.at)}</span>
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
          const rs = [...row.querySelectorAll('.roles input:checked')].map((i) => i.value);
          act(async () => { await api('PATCH', `/api/members/${id}`, { name: row.querySelector('[data-name]').value, roles: rs }); row.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty); }, '已儲存');
        }
        if (a === 'admin') act(() => api('PATCH', `/api/members/${id}`, { is_admin: !m.is_admin }), '已更新');
        if (a === 'active') act(() => api('PATCH', `/api/members/${id}`, { active: !m.active }), '已更新');
        if (a === 'reset' && confirm(`重設「${m.name}」的裝置綁定？\n原裝置會立即登出，名字重新出現在登入頁。`)) {
          act(() => api('POST', `/api/members/${id}/reset`), '已重設');
        }
      };
    });
  });
  document.getElementById('add-member').onsubmit = (e) => {
    e.preventDefault();
    act(() => api('POST', '/api/members', { name: e.target.name.value, roles: [] }), '已新增，記得勾選身分');
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
      rush_threshold_days: Number(f.rush_days.value),
    };
    act(async () => { await api('PUT', '/api/settings', data); f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty); }, '設定已儲存');
  };
  $app.querySelectorAll('[data-restore]').forEach((b) => {
    const [type, rid] = b.dataset.restore.split(':');
    b.onclick = () => act(() => api('POST', '/api/restore', { type, id: Number(rid) }), '已還原');
  });
}

boot().catch((e) => { if (!e.network) $app.innerHTML = `<p class="empty">無法載入：${esc(e.message)}</p>`; });
