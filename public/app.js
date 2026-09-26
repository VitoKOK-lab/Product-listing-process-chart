// TZG 上架跟進 — 前端（無框架，hash 路由）
// 所有時數、平均、排序都由後端計算，前端只負責顯示
'use strict';

const POLL_MS = 10000;
const MAX_EDGE = 1920;
const STEP_ORDER = ['cutout', 'listing', 'optimizing', 'mkt_check', 'done'];
const FLOW = ['cutout', 'listing', 'optimizing', 'mkt_check'];
const STEP_COLOR = {
  open: '#9B8AE0', cutout: '#4FBFA8', listing: '#6AA3EE', optimizing: '#E27BB4', mkt_check: '#F2A65A', done: '#45B98A',
};
const KIND = { pick: '選品照片', cutout: '商品圖', opt: '優化截圖' };
const STATUS = { A: '投放中', B: '優先製作', C: '可投放', D: '待製作' };
// 上架人員：商品文案第一階段檢查標準
const COPY_SOP = [
  '商品名稱正確', '寶石名稱正確', '克拉數正確', '材質正確', '證書資訊正確', '價格正確', '圖片需求清楚', '佩戴比例清楚', '不亂加未確認賣點',
  '來源、產地、特色、賣點、故事、適合佩戴場景：不需要過度美化，說清楚即可',
];
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
// 沒人接時的說法：行銷檢查叫「待審」，其他叫「等人認領」
const waitText = (step) => (step === 'mkt_check' ? '待審' : '等人認領');
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
  if (!location.hash) location.hash = S.me.is_admin ? '#/overview' : '#/radar';
  await render();
}

function renderNav() {
  const canAdd = hasRole('lister') || S.me.is_admin;
  const items = [['radar', '今天要做'], ['overview', '全覽'], ...(canAdd ? [['new', '新增商品']] : []), ...(S.me.is_admin ? [['analysis', '成效分析']] : []), ['log', '紀錄'], ['help', '使用說明'], ...(S.me.is_admin ? [['settings', '設定']] : [])];
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

const currentRoute = () => (location.hash.replace(/^#\/?/, '') || (S.me?.is_admin ? 'overview' : 'radar')).split('/');
window.addEventListener('hashchange', () => { if (S.me) render(); });

async function render() {
  const [route, arg] = currentRoute();
  if (route !== 'radar' && document.querySelector('[data-view=radar]')) S.radarScroll = window.scrollY;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (route === 'p' && a.dataset.route === 'overview')));
  const views = { overview: viewOverview, radar: viewRadar, analysis: viewAnalysis, log: viewLog, settings: viewSettings, p: viewProduct, new: viewNew, help: viewHelp };
  try {
    await (views[route] || (S.me.is_admin ? viewOverview : viewRadar))(arg);
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
  const time = it.held_h != null ? `<span>${it.holder_id ? `工作 <span class="mono">${esc(fmtWork(it.held_h))}</span>${it.avg_h != null ? `／平均 <span class="mono">${esc(fmtWork(it.avg_h))}</span>` : ''}` : ''}${it.wait_h ? `${it.holder_id ? '・' : ''}沒人接 <span class="mono">${esc(fmtWork(it.wait_h))}</span>` : ''}</span>` : '';
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
            ${S.radarScope === 'all' ? (it.holder_id ? who(it.holder_id) : `<span class="tag wait">${waitText(it.step)}</span>`) : ''}
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
      <h1>今天要做</h1>
      ${S.me.is_admin ? `<div class="seg"><button data-scope="me" class="${scope === 'me' ? 'on' : ''}">我的</button><button data-scope="all" class="${scope === 'all' ? 'on' : ''}">全部卡關</button></div>` : ''}
      <span class="spacer"></span>
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
  if (nav && scope === 'me') nav.innerHTML = `今天要做${mineN ? `<span class="badge">${mineN}</span>` : ''}`;
  if (S.radarScroll) { window.scrollTo(0, S.radarScroll); S.radarScroll = 0; }
}

// ---------- 使用說明 ----------

const HELP = {
  flow: {
    name: '整體流程',
    html: `
      <p class="lead">一件商品從廣告 Excel 開始，經過四個人的手，最後由行銷確認可以投放。每個人只要做好自己那一段，做完按「完成」，系統就會自動交給下一個人。</p>
      <div class="help-flow">
        <div class="hf-box hf-mkt"><b>行銷</b><span>在廣告 Excel 寫上商品名稱</span></div>
        <div class="hf-arrow">→</div>
        <div class="hf-pair">
          <div class="hf-box hf-ed"><b>美編</b><span>做圖</span></div>
          <div class="hf-box hf-li"><b>上架人員</b><span>寫文案、上架</span></div>
          <small>兩個人同時開始</small>
        </div>
        <div class="hf-arrow">→</div>
        <div class="hf-box hf-des"><b>設計師</b><span>優化商品頁</span></div>
        <div class="hf-arrow">→</div>
        <div class="hf-box hf-mkt"><b>行銷</b><span>投放前檢查（待審）</span></div>
        <div class="hf-arrow">→</div>
        <div class="hf-box hf-done"><b>完成</b><span>可以投放</span></div>
      </div>
      <h3>三個一定要知道的規則</h3>
      <ol class="help-list">
        <li><b>自己領工作</b>：系統不會指派，看到就按「我來做」。按了之後，這件只會出現在你的待辦。</li>
        <li><b>做完按「完成 →」</b>：系統會自動交給下一個人，不用另外通知。</li>
        <li><b>發現前面有問題按「← 退回」</b>：寫清楚哪裡不對，會回到做那一步的人手上；他改好會直接交回給你。</li>
      </ol>
      <h3>每天打開要看哪裡</h3>
      <p>登入後第一頁就是「<b>今天要做</b>」。最上面那一張粉紅框是「建議你現在先做這件」，照順序做就對了：插隊的最先，其次是被退回的，再來依投放優先（A 投放中 → B 優先製作 → C 可投放 → D 待製作）。</p>`,
  },
  marketing: {
    name: '行銷',
    html: `
      <p class="lead">你負責頭和尾：一開始決定要做哪些商品，最後確認能不能投放。</p>
      <h3>開頭：在 Excel 寫上商品名稱</h3>
      <ul class="help-list">
        <li>在「廣告數據表」的「銷售型-投廣素材」寫上商品名稱、狀態、商品連結，就算開單完成。</li>
        <li>設計師或管理員按「同步試算表」後，商品就會進到系統，美編和上架人員會自己去領。</li>
        <li>很急的件：打開商品頁，在「插隊」選完成日期（最早明天），這件就會排到所有人的最前面。</li>
      </ul>
      <h3>結尾：檢查（待審）</h3>
      <ul class="help-list">
        <li>設計師優化完，這件會出現在你的「今天要做」，顯示「待審」。</li>
        <li>按「我來做」→ 打開 Shopline 商品頁看一遍。</li>
        <li>沒問題：按「檢查通過・完成 ✓」。</li>
        <li>有問題：按「← 退回」，選是哪一步（做圖、文案上架、優化），寫哪裡不對。那個人改好後會直接回到你這裡。</li>
      </ul>
      <h3>要注意</h3>
      <p class="warn-note">Shopline 的網址就是商品名稱。<b>商品改名稱，網址就會變</b>。系統會記住新網址（以系統為主），但你 Excel 裡投放用的網址要自己確認是新的，不然廣告會連到失效頁面。同步後如果看到紅字「幾件 Excel 還是舊網址」，就是要你去改。</p>`,
  },
  editor: {
    name: '美編',
    html: `
      <p class="lead">你負責商品的圖。圖做好直接上傳到 Shopline，系統裡只要按「完成」。</p>
      <h3>怎麼做</h3>
      <ol class="help-list">
        <li>打開「今天要做」，從最上面那件開始，按「我來做」。</li>
        <li>照畫面上的做圖提示做圖（點教學圖可以放大看範例）：<b>正面、側面、佩戴示意</b>一定要有，需要時加背面、細節特寫。</li>
        <li>把圖上傳到 Shopline 商品頁。</li>
        <li>回系統按「完成 →」。</li>
      </ol>
      <h3>跟誰有關係</h3>
      <ul class="help-list">
        <li><b>工作從哪來</b>：行銷在 Excel 寫上商品，同步後就會出現。你和上架人員是同時開始的，不用等對方。</li>
        <li><b>做完給誰</b>：上架人員也上架了，就交給設計師。</li>
        <li><b>被退回</b>：設計師或行銷覺得圖不對、或還沒有圖，會退回給你。退回的件排在最前面，卡片上會寫原因，改好按完成就直接回到退你的人。</li>
      </ul>
      <p class="muted">順序：插隊 → 被退回 → 從試算表最下面往上做。</p>`,
  },
  lister: {
    name: '上架人員',
    html: `
      <p class="lead">你負責文案和上架。文案直接寫在 Shopline，系統裡只要貼上商品網址。</p>
      <h3>怎麼做</h3>
      <ol class="help-list">
        <li>打開「今天要做」，按「我來做」。</li>
        <li>照「商品文案第一階段檢查標準」寫文案：<b>寫對、寫清楚、寫完整</b>，不用寫得很美，不要亂加沒確認過的賣點。</li>
        <li>在 Shopline 上架。<b>不用等美編的圖</b>，可以先上架。</li>
        <li>回系統貼上 Shopline 商品網址，按「完成上架 →」。</li>
      </ol>
      <h3>跟誰有關係</h3>
      <ul class="help-list">
        <li><b>工作從哪來</b>：行銷在 Excel 寫上商品，同步後出現。跟美編同時開始。</li>
        <li><b>做完給誰</b>：交給設計師優化。</li>
        <li><b>被退回</b>：設計師或行銷覺得文案不對，會退回給你，改好直接回到退你的人。</li>
        <li><b>圖有問題</b>：可以按「← 退回」給美編。</li>
      </ul>
      <h3>改名稱要特別小心</h3>
      <p class="warn-note">Shopline 網址就是商品名稱。<b>改名稱，網址就會變</b>。如果設計師退回寫「名稱要改」，改好名稱後一定要把<b>新的網址</b>貼回系統（貼舊的會被擋下來）。</p>
      <h3>新增商品</h3>
      <p>廣告 Excel 以外的商品，可以在選單「新增商品」自己建：輸入名稱和網址，首圖會自動抓。之後廣告人員如果把同一個網址加進 Excel，系統會當成同一件。</p>`,
  },
  designer: {
    name: '設計師',
    html: `
      <p class="lead">你負責把商品頁優化到可以投放。直接改 Shopline 線上頁面，系統裡寫一句改了什麼。</p>
      <h3>怎麼做</h3>
      <ol class="help-list">
        <li>打開「今天要做」，照最上面建議的那件做，按「我來做」。</li>
        <li>打開 Shopline 商品頁優化。</li>
        <li>回系統寫「改了什麼」，按「完成優化 →」。</li>
      </ol>
      <h3>跟誰有關係</h3>
      <ul class="help-list">
        <li><b>工作從哪來</b>：上架人員上架完就會交給你。有時候美編的圖還在做，卡片會標「圖還在做」。</li>
        <li><b>發現問題</b>：按「← 退回」，選原因：
          <ul><li><b>圖</b>（沒圖、圖不對）→ 退給美編，美編會優先處理。</li>
          <li><b>文案</b> → 退給上架人員。如果是<b>商品名稱要改</b>，記得勾「名稱要改」，因為網址會跟著變。</li></ul>
          改好後會直接回到你手上。</li>
        <li><b>做完給誰</b>：交給行銷檢查（待審）。</li>
      </ul>
      <h3>同步按鈕</h3>
      <p>全覽上方的「同步試算表」「同步首圖」只有你和管理員能按。行銷在 Excel 加了新商品後，按一次「同步試算表」，再按一次「同步首圖」。</p>`,
  },
  admin: {
    name: '管理員',
    html: `
      <p class="lead">你看全局、處理卡住的件，不用自己做每一步。</p>
      <ul class="help-list">
        <li><b>全覽</b>：每件走到哪、誰在做、有沒有人接。</li>
        <li><b>成效分析</b>：只有你看得到。各步驟平均花多久、誰比較慢、哪一關常沒人接、退件次數。員工畫面不會出現任何時間。</li>
        <li><b>商品頁的管理員操作</b>：改派給別人、退回任一步（要寫原因）、直接推到下一關。</li>
        <li><b>設定</b>：新增成員、勾選身分、重設裝置（換手機或選錯名字時）、上班時間與假日。</li>
      </ul>`,
  },
  faq: {
    name: '常見問題',
    html: `
      <ul class="help-list">
        <li><b>按錯「我來做」怎麼辦？</b>商品頁工作卡片的右上角有「放回待認領」。</li>
        <li><b>看不到完成或退回的按鈕？</b>要先按「我來做」認領，按鈕只給認領的人。</li>
        <li><b>換手機、清掉瀏覽器資料後進不去？</b>請管理員到設定幫你「重設綁定」，再重新選一次名字。</li>
        <li><b>有事要找某個人？</b>在商品頁留言輸入 @ 加名字，對方的待辦會出現提醒。</li>
        <li><b>手機可以用嗎？</b>可以，用手機瀏覽器打開同一個網址就好。</li>
      </ul>`,
  },
};

function viewHelp(tab) {
  const roleTab = ['marketing', 'editor', 'lister', 'designer'].find((r) => hasRole(r));
  const cur = HELP[tab] ? tab : (S.me.is_admin && !roleTab ? 'flow' : roleTab || 'flow');
  const order = ['flow', 'marketing', 'editor', 'lister', 'designer', 'admin', 'faq'];
  $app.innerHTML = `
    <div class="page-head"><h1>使用說明</h1></div>
    <div class="seg help-tabs">${order.map((k) => `<a href="#/help/${k}" class="${k === cur ? 'on' : ''}">${esc(HELP[k].name)}${k === roleTab ? '<small>（你）</small>' : ''}</a>`).join('')}</div>
    <div class="card section help">${HELP[cur].html}</div>`;
}

// ---------- 新增商品（廣告數據表以外） ----------

async function viewNew() {
  if (!hasRole('lister') && !S.me.is_admin) { $app.innerHTML = '<p class="empty">只有上架人員可以新增商品</p>'; return; }
  $app.innerHTML = `
    <div class="page-head"><h1>新增商品</h1></div>
    <form class="card section" id="new-form" style="max-width:680px">
      <p class="muted" style="margin-top:0">這裡是「廣告數據表」<b>以外</b>的商品。廣告要用的話，請自己手動加到廣告的 Excel；之後同步時，Excel 裡同一個網址會視為同一件，改用 Excel 的狀態和排序。</p>
      <label class="field"><span>商品名稱</span><input type="text" name="name" required maxlength="200"></label>
      <label class="field"><span>商品網址（Shopline 商品頁）</span><input type="url" name="link" required placeholder="https://"></label>
      <p class="muted">建立後首圖會自動抓進來，接著跟其他商品一樣：美編做圖、上架人員寫文案上架。</p>
      <div class="row"><span class="spacer"></span><button class="btn primary act">建立</button></div>
    </form>`;
  const f = document.getElementById('new-form');
  f.onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      try {
        const r = await api('POST', '/api/products', { name: f.name.value, link: f.link.value.trim() });
        f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
        toast(r.thumb ? '已建立，首圖已抓到' : '已建立（首圖沒抓到，之後按同步首圖再試）');
        location.hash = `#/p/${r.id}`;
      } catch (err) {
        if (err.data?.id && confirm(`${err.message}\n要打開那一件嗎？`)) { location.hash = `#/p/${err.data.id}`; return; }
        throw err;
      }
    }, null, 'none');
  };
}

// ---------- 全覽（首頁） ----------

function isMineCell(c) {
  return c.holders?.includes(S.me.id) || c.holder_id === S.me.id || c.owner === S.me.id;
}

function cellTip(c) {
  if (c.held == null) {
    const who2 = c.state === 'current' ? (c.waiting ? waitText(c.step) : member(c.holder_id)?.name) : member(c.holders[c.holders.length - 1] ?? c.owner)?.name;
    return `${stepLabel(c.step)}・${who2 ?? (c.state === 'future' ? '還沒輪到' : '—')}${c.rounds > 1 ? `\n退回重做，第 ${c.rounds} 輪` : ''}`;
  }
  const person = c.state === 'current' ? (c.waiting ? waitText(c.step) : member(c.holder_id)?.name) : member(c.holders[c.holders.length - 1] ?? c.owner)?.name;
  const lines = [`${stepLabel(c.step)}・${person ?? '還沒輪到'}`];
  if (c.held) lines.push(`工作 ${fmtWork(c.work)}（認領後）・總共 ${fmtWork(c.held)}${c.pool ? `，沒人接 ${fmtWork(c.pool)}` : ''}`);
  lines.push(c.avg != null ? `團隊平均工作 ${fmtWork(c.avg)}` : '團隊平均：資料還不夠（至少 3 件）');
  if (c.diff != null) lines.push(c.diff > 0 ? `比平均慢 ${fmtWork(c.diff)}` : c.diff < 0 ? `比平均快 ${fmtWork(-c.diff)}` : '跟平均差不多');
  if (c.rounds > 1) lines.push(`退回重做，第 ${c.rounds} 輪`);
  if (c.state === 'future' && !c.held) lines.push('尚未開始');
  return lines.join('\n');
}

function laneRow(r) {
  const n = FLOW.length;
  const cur = r.done ? n - 1 : Math.max(0, FLOW.indexOf(r.step));
  const at = (i) => ((i + 0.5) / n) * 100;
  const fillW = at(cur) - at(0);
  const nodes = r.cells.map((c, i) => {
    const mine = isMineCell(c);
    const tip = esc(cellTip(c));
    if (c.state === 'current' && !r.done) {
      const person = c.waiting ? waitText(c.step) : (member(c.holder_id)?.name ?? '—');
      const time = !S.showTime || c.held == null ? '' : c.waiting ? `沒人接 ${fmtWork(c.pool)}` : `${fmtWork(c.work)}${c.avg != null ? ` / 均 ${fmtWork(c.avg)}` : ''}`;
      const rushHot = r.rush && (r.rush.urgent || r.rush.overdue);
      const lv = S.showTime ? c.level : 'ok';
      const flag = r.rush?.overdue ? '逾期' : rushHot ? '插隊' : lv === 'very' ? '很慢' : lv === 'slow' ? '偏慢' : c.rounds > 1 ? `第 ${c.rounds} 輪` : '';
      const st = rushHot || lv === 'very' ? 'st-red' : lv === 'slow' ? 'st-yellow' : c.waiting ? 'st-wait' : '';
      return `<div class="pin ${mine ? 'mine' : 'other'} ${st} ${c.parallel ? 'parallel' : ''}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0">
        <b>${esc(person)}</b>${time ? `<span class="mono">${esc(time)}</span>` : ''}${flag ? `<em>${esc(flag)}</em>` : ''}</div>`;
    }
    const state = i < cur || r.done ? 'done' : 'future';
    const late = S.showTime && state === 'done' && c.level !== 'ok';
    return `<span class="node ${state} ${mine ? 'mine' : 'other'} ${late ? 'late' : ''} ${state === 'future' && c.held ? 'visited' : ''}" style="left:${at(i)}%" data-tip="${tip}" tabindex="0"></span>`;
  }).join('');
  return `<div class="lane-row ${r.cells.some(isMineCell) ? 'row-mine' : ''}" data-href="#/p/${r.id}">
    <div class="lane-name">${thumb(r.id, r.thumb, 'sm')}<div class="ln-text">${statusBadge(r)}${shopName(r.name, r.link)}</div></div>
    <div class="lane-mobile">${r.done ? stepChip('done') : r.cells.filter((c) => c.state === 'current').map((c) => `${stepChip(c.step)}<span class="${c.waiting ? 'muted' : ''}">${esc(c.waiting ? waitText(c.step) : member(c.holder_id)?.name ?? '')}</span>`).join('') || stepChip(r.step)}</div>
    <div class="lane">
      <div class="rail" style="left:${at(0)}%;right:${100 - at(n - 1)}%"></div>
      <div class="rail-fill" style="left:${at(0)}%;width:${fillW}%"></div>
      ${nodes}
    </div>
    ${S.showTime ? `<div class="lane-var"><span class="var big ${diffCls(r.diff)}" title="每一步跟團隊平均比，加總">${esc(diffTxt(r.cells.some((c) => c.diff != null) ? r.diff : null))}</span></div>` : '<div class="lane-var"></div>'}
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
    <span class="muted">試算表：${ls ? `${fmtTime(ls.at)} ${esc(member(ls.by)?.name ?? '')} 同步・共 ${ls.total} 件（新增 ${ls.added}、更新 ${ls.updated}、下架 ${ls.delisted}、恢復 ${ls.restored}）${ls.stale ? `・<b class="over">${ls.stale} 件 Excel 還是舊網址</b>（以系統為主，請廣告人員更新）` : ''}` : '還沒同步過'}</span>
    <span class="muted">・首圖：${lt ? fmtTime(lt.at) : '還沒同步過'}</span>
    <span class="spacer"></span>
    <button class="btn small" id="sync-setup">連線設定</button>
    <button class="btn small" id="sync-thumbs" ${S.settings.sheet_api_url ? '' : 'disabled'}>同步首圖</button>
    <button class="btn small primary" id="sync-sheet" ${S.settings.sheet_api_url ? '' : 'disabled'}>同步試算表</button>
  </div>`;
}

async function viewOverview() {
  const d = await api('GET', `/api/overview?filter=${S.ovFilter}`);
  S.showTime = false; // 全覽只看進度，時間與比較都在成效分析
  const active = d.rows.filter((r) => !r.done);
  const done = d.rows.filter((r) => r.done).sort((a, b) => b.done_at - a.done_at);
  const idx = (r) => STEP_ORDER.indexOf(r.step);
  if (S.ovSort === 'progress') active.sort((a, b) => idx(b) - idx(a) || b.diff - a.diff);
  S.radarKeys = active.map((r) => r.id);
  const c = d.counts;
  const filters = [['all', '全部', c.all], ['rush', '插隊', c.rush], ...['A', 'B', 'C', 'D'].map((k) => [k, `${k} ${STATUS[k]}`, c[k]]),
    ...(c.other ? [['other', '其他', c.other]] : []), ['delisted', '已下架', c.delisted]];
  const doneShown = S.ovDoneAll ? done : done.slice(0, 30);
  $app.innerHTML = `
    <div class="page-head">
      <h1>全覽</h1>
      <div class="seg batch-seg">${filters.map(([k, l, n]) => `<button data-filter="${k}" class="${S.ovFilter === k ? 'on' : ''}">${esc(l)} <span class="mono">${n}</span></button>`).join('')}</div>
    </div>
    ${syncBar()}
    <div class="card lanes">
      <div class="lane-row lane-head">
        <div class="lane-name">商品<span class="muted">（名稱連到 Shopline，點這列看詳情）</span></div>
        <div class="lane">${FLOW.map((s, i) => `<span class="lane-step" style="left:${((i + 0.5) / FLOW.length) * 100}%;--sc:${STEP_COLOR[s]}">${esc(stepLabel(s))}</span>`).join('')}</div>
        <div class="lane-var">${S.showTime ? '跟團隊平均比' : ''}</div>
        <div class="lane-ret">退件</div>
      </div>
      ${active.map(laneRow).join('') || `<p class="empty">${S.ovFilter === 'delisted' ? '沒有已下架的商品' : S.me.can_sync && !S.settings.last_sheet_sync ? '還沒有商品：先按上面的「連線設定」接上試算表，再按「同步試算表」' : '這裡沒有進行中的商品'}</p>`}
    </div>
    <h2 class="done-h">已完成 <span class="muted mono">${done.length}</span></h2>
    <div class="card ov-wrap">
      <table class="ov done-table">
        <thead><tr><th class="ov-name">商品</th><th>完成時間</th><th class="num">${S.showTime ? '跟團隊平均比' : ''}</th><th class="num">退件</th></tr></thead>
        <tbody>${doneShown.map((r) => `<tr data-href="#/p/${r.id}">
          <td class="ov-name"><div class="row" style="gap:8px;flex-wrap:nowrap">${thumb(r.id, r.thumb, 'sm')}${statusBadge(r)}${shopName(r.name, r.link)}</div></td>
          <td class="mono">${r.done_at ? fmtTime(r.done_at) : ''}${r.rush ? (r.rush.missed ? ' <span class="tag red">錯過插隊日</span>' : ' <span class="tag green">插隊準時</span>') : ''}</td>
          <td class="num">${S.showTime ? `<span class="var ${diffCls(r.diff)}">${esc(diffTxt(r.cells.some((x) => x.diff != null) ? r.diff : null))}</span>` : ''}</td>
          <td class="num mono ${r.returns ? 'over' : 'faint'}">${r.returns}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">還沒有完成的商品</td></tr>'}</tbody>
      </table>
      ${done.length > doneShown.length ? `<div class="row" style="padding:10px"><span class="spacer"></span><button class="btn small" id="done-all">顯示全部 ${done.length} 件</button></div>` : ''}
    </div>
    ${S.showTime ? '' : '<!--'}<p class="muted" style="margin-top:12px">做圖和文案同時開始。跟團隊平均比的是「認領後到完成」的工作時間；沒人接的時間另外記，滑鼠移到圓點可以看。平均只拿走完這一步的商品來算，至少 3 件才比。只算上班時間。</p>${S.showTime ? '' : '-->'}`;
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
    toast(`同步完成：共 ${r.total} 件，新增 ${r.added}、更新 ${r.updated}、下架 ${r.delisted}、恢復 ${r.restored}${r.stale ? `；${r.stale} 件 Excel 還是舊網址` : ''}`, false, 7000);
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

async function uploadPhotos(productId, spec, files) {
  const [kind, angle] = spec.split(':');
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return toast('請選擇圖片檔', true);
  await act(async () => {
    toast(`上傳中… ${imgs.length} 張`);
    const fd = new FormData();
    fd.append('kind', kind);
    if (angle) fd.append('angle', angle);
    for (const f of imgs) fd.append('file', await resizeImage(f));
    await api('POST', `/api/products/${productId}/photos`, fd);
  }, `已上傳 ${imgs.length} 張`);
}

function photoGrid(p, kind, { upload = false, del = false, download = false, angle = null, label = null } = {}) {
  const list = p.photos.filter((ph) => ph.kind === kind && (!angle || ph.angle === angle));
  const spec = angle ? `${kind}:${angle}` : kind;
  return `<div class="photos">
    ${list.map((ph) => `<div class="photo">
        <img loading="lazy" src="/api/photos/${ph.id}" data-full="/api/photos/${ph.id}" alt="${esc(ph.filename)}" title="${esc(member(ph.uploaded_by)?.name ?? '')} · ${fmtTime(ph.created_at)}">
        <div class="tools">
          ${download ? `<a class="btn small" href="/api/photos/${ph.id}?download=1">下載</a>` : ''}
          ${del ? `<button class="btn small danger" data-del-photo="${ph.id}">刪除</button>` : ''}
        </div>
      </div>`).join('')}
    ${upload ? `<label class="dropzone" data-drop="${spec}"><input type="file" accept="image/*" multiple hidden data-file="${spec}"><span>＋ 上傳${esc(label || KIND[kind])}<br><span class="muted">點選或拖曳，可多張</span></span></label>` : ''}
    ${!upload && !list.length ? '<div class="muted">尚無</div>' : ''}
  </div>`;
}

// 完成後交給誰（顯示用；實際由後端決定）
function nextHint(p, step = p.step) {
  if (p.return_to && p.return_to !== step) return p.return_to === 'mkt_check' ? `行銷檢查（${member(p.marketer_id)?.name ?? '行銷'}）` : stepLabel(p.return_to);
  const next = STEP_ORDER[STEP_ORDER.indexOf(step) + 1];
  if (next === 'done') return '已完成';
  if (next === 'mkt_check') return `行銷檢查（${member(p.marketer_id)?.name ?? '行銷'}）`;
  return `${stepLabel(next)}`;
}

function returnForm(p) {
  const isCheck = p.step === 'mkt_check';
  const isOpt = p.step === 'optimizing';
  const targets = ['cutout', 'listing', 'optimizing'];
  const prev = { listing: 'cutout' }[p.step];
  return `<div class="return-box" data-return-form hidden>
    ${isCheck ? `<div class="field"><span>退回哪一步（改好後直接交回你）</span>
      <div class="hour-pick" id="ret-target">${targets.map((t) => `<label><input type="radio" name="target" value="${t}">${esc(stepLabel(t))}</label>`).join('')}</div></div>`
    : isOpt ? `<div class="field"><span>哪裡有問題（改好後直接交回你）</span>
      <div class="hour-pick" id="ret-target"><label><input type="radio" name="target" value="listing">文案 → 上架人員</label><label><input type="radio" name="target" value="cutout">圖 → 美編</label></div></div>
      <label class="rename-chk" hidden><input type="checkbox" name="rename"> 商品名稱要改（Shopline 網址會跟著變，上架人員要去試算表換新網址）</label>`
    : `<p class="muted" style="margin-top:0">會退回「${esc(stepLabel(prev))}」，記一次退件在上一步的人身上。</p>`}
    <label class="field"><span>哪裡有問題（必填）</span><textarea data-return-note placeholder="例：去背邊緣有白邊、主圖比例不對"></textarea></label>
    <div class="row"><span class="missing" data-ret-miss></span><span class="spacer"></span><button class="btn warn act" data-return disabled>送出退回</button></div>
  </div>`;
}

// 這件商品我要操作的是哪一段：我手上的 > 我能認領的 > 商品目前所在的那一段（做圖、文案可能同時進行）
function chosenStint(p) {
  const opens = p.opens || [];
  return opens.find((s) => s.member_id === S.me.id)
    || opens.find((s) => !s.member_id && hasRole(s.role))
    || p.open || null;
}

function actionPanel(p) {
  const open = chosenStint(p);
  const shop = (p.sl_url || p.link) ? `<a class="btn" href="${esc(p.sl_url || p.link)}" target="_blank" rel="noopener">開啟 Shopline 商品頁 ↗</a>` : '';
  if (p.delisted_at) {
    return `<div class="card action locked"><h2>已下架</h2><div class="sub">試算表裡已經沒有這件，${fmtTime(p.delisted_at)} 標成已下架。試算表加回來後，下次同步會自動恢復。</div></div>`;
  }
  if (p.step === 'done') {
    return `<div class="card action locked"><h2>已完成</h2><div class="sub">${p.done_at ? `${fmtTime(p.done_at)} 由行銷檢查通過` : ''}</div><div class="row">${shop}</div></div>`;
  }
  if (!open) return '';
  const step = open.step;
  const others = (p.opens || []).filter((s) => s.id !== open.id)
    .map((s) => `<div class="muted parallel-line">同時進行：${esc(stepLabel(s.step))}・${s.member_id ? esc(member(s.member_id)?.name ?? '') : waitText(s.step)}</div>`).join('');
  const returned = open.returned ? `
    <div class="returned"><b>被 ${esc(member(open.returned.by_id)?.name ?? '')} 退回</b>（${fmtTime(open.returned.at)}）
      <div class="note">${esc(open.returned.note)}</div></div>` : '';
  const role = open.role;
  if (!open.member_id) {
    const can = hasRole(role);
    return `<div class="card action ${can ? 'mine' : 'locked'}">${returned}
      <h2>「${esc(stepLabel(step))}」${waitText(step)}</h2>
      <div class="sub">還沒有人接，按「我來做」就由你負責</div>
      ${can ? `<button class="btn primary act" id="claim-btn">我來做</button> <span class="muted">認領後只會出現在你的待辦</span>`
        : `<span class="muted">等${esc(roleName(role))}認領</span>`}
      ${others}
    </div>`;
  }
  if (open.member_id !== S.me.id) {
    const holder = member(open.member_id);
    return `<div class="card action locked">${returned}
      <h2>目前在「${esc(stepLabel(step))}」</h2>
      <div class="sub">負責人：${who(open.member_id)}</div>
      <button class="btn disabled" disabled>只有 ${esc(holder?.name ?? '負責人')} 可以操作</button>
      <span class="muted">需要催的話，在下方留言 @${esc(holder?.name ?? '')}</span>
      ${others}
    </div>`;
  }
  const imgPending = step === 'listing' && (p.opens || []).some((o) => o.step === 'cutout');
  const head = (title, sub) => `<div class="row" style="align-items:flex-start"><div style="flex:1"><h2>${title}</h2><div class="sub">${sub}</div></div>
    <button class="btn small" id="release-btn" title="不做了，放回給其他${esc(roleName(role))}">放回待認領</button></div>${others}`;
  const canReturn = step !== 'cutout' && open.step === p.step && !imgPending;
  const backTo = { listing: '美編（圖）', optimizing: '文案或圖', mkt_check: '任一步' }[step] || '';
  // 中間是自己這一步：往左退回上一步，往右完成交給下一步（行銷檢查往右就是完成）
  const foot = (btn, miss = '') => `<div class="flowbar">
      <div class="fb-back">${canReturn ? `<button class="btn danger act" data-open-return>← 退回${esc(backTo)}</button>` : '<span class="muted">沒有上一步</span>'}</div>
      <div class="fb-cur"><b>${esc(stepLabel(step))}</b><small>你現在這一步</small></div>
      <div class="fb-next">${btn}</div>
    </div>
    <div class="missing fb-miss" id="miss">${esc(miss)}</div>${canReturn ? returnForm(p) : ''}`;
  const toTxt = esc(nextHint(p, step));
  switch (step) {
    case 'cutout': {
      return `<div class="card action mine">${returned}${head('做圖', '做好的圖直接上傳到 Shopline 商品頁，完成後按右邊的「完成」。')}
        <div class="guide">
          <img src="/guide-photo.webp" data-full="/guide-photo.webp" alt="做圖教學示意圖" title="點一下放大">
          <div>
            <b>做圖提示（點左邊的圖放大看範例）</b>
            <ul><li><b>每個商品都要有</b>：正面（主體設計）、側面（厚度、鑲嵌）、佩戴示意（手、頸、耳朵上的實際效果）</li>
            <li>需要時加上：背面／底部、細節特寫</li>
            <li>背景簡潔、光線充足、對焦清晰，不要過度濾鏡</li>
            <li>尺寸比例用統一角度與光源；AI 生成要真實自然，不誇張</li>
            <li>最短邊 ≥ 1200 px，JPG 或 PNG</li></ul>
            <div class="row" style="margin-top:6px">${shop}</div>
          </div>
        </div>
        ${foot(`<button class="btn primary act" id="complete-btn">完成 → ${toTxt}</button>`)}</div>`;
    }
    case 'listing': {
      const url = p.rename_pending ? '' : (p.sl_url || p.link || '');
      const rename = p.rename_pending ? `<div class="warnbox rename-box"><b>商品名稱要改，網址會跟著變</b>
        <ol class="steps"><li>在 Shopline 改好商品名稱，複製新的商品網址。</li>
        <li>把新網址貼到下面，按完成，會直接交回設計師。</li></ol>
        <div class="muted">舊網址：${esc(p.link)}<br>網址以系統為主。廣告的 Excel 還是舊網址也不會出錯，但廣告人員要自己確認投放的網址。</div></div>` : '';
      return `<div class="card action mine">${returned}${rename}${head('文案・上架', `文案直接寫在 Shopline，完成後在下面輸入商品網址。${imgPending ? '美編的圖還在做，可以先上架。' : '圖有問題就退回美編。'}`)}
        <div class="sop">
          <b>商品文案第一階段檢查標準</b>
          <p class="muted">第一階段文案不是寫美，而是把商品資料寫對、寫清楚、寫完整，讓後面的拍照、AI 生成、修圖、設計都可以直接執行，不需要猜。</p>
          <ol class="sop-list">${COPY_SOP.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
        </div>
        <div class="row" style="margin-bottom:4px">${shop}</div>
        <label class="field" style="margin-top:14px"><span>Shopline 商品網址</span><input type="url" id="sl-url" value="${esc(url)}" placeholder="https://"></label>
        ${foot(`<button class="btn primary act" id="complete-btn">完成上架 → ${toTxt}</button>`)}</div>`;
    }
    case 'optimizing': {
      return `<div class="card action mine">${returned}${head('優化・直接改 Shopline 線上頁面', `文案或圖有問題就退回。`)}
        <div class="row" style="margin-bottom:12px">${shop}</div>
        <label class="field" style="margin-top:14px"><span>改了什麼（必填）</span><textarea id="opt-note" placeholder="例：換主圖、補尺寸表、調整比例"></textarea></label>
        ${foot(`<button class="btn primary act" id="complete-btn" disabled>完成優化 → ${toTxt}</button>`, '請填寫改了什麼')}</div>`;
    }
    case 'mkt_check': {
      const lastOpt = [...p.stints].reverse().find((s) => s.step === 'optimizing' && s.end_note);
      return `<div class="card action mine">${head('行銷檢查・投放前最後確認', `哪一步有問題就退回那一步，改好直接回到你這裡。`)}
        <div class="row" style="margin-bottom:12px">${shop.replace('class="btn"', 'class="btn primary"')}</div>
        ${lastOpt ? `<div class="returned soft"><b>${esc(member(lastOpt.member_id)?.name ?? '')} 改了什麼</b><div class="note">${esc(lastOpt.end_note)}</div></div>` : ''}
        ${foot('<button class="btn go act" id="complete-btn">檢查通過・完成 ✓</button>')}</div>`;
    }
    default:
      return `<div class="card action locked"><h2>${esc(stepLabel(step))}</h2><div class="sub">舊流程的步驟，請管理員直接推到下一關。</div></div>`;
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



function timelineBlock(p) {
  const items = [...p.stints].reverse();
  const END = { complete: '完成', pass: '檢查通過', return: '退回', claim: '有人認領', release: '放回', reassign: '改派', admin: '管理員推進', delisted: '下架' };
  return `<div class="card section"><h2>流程紀錄</h2><ul class="timeline">
    ${items.map((s) => `<li class="${s.start_reason === 'return' ? 'ret' : ''} ${s.ended_at == null ? 'open' : ''}">
        <b>${esc(stepLabel(s.step))}</b>・${s.member_id ? esc(member(s.member_id)?.name ?? '—') : `<span class="muted">${waitText(s.step)}</span>`}
        <span class="muted">${fmtTime(s.started_at)} → ${s.ended_at ? fmtTime(s.ended_at) + ' ' + (END[s.end_reason] || '') : '進行中'}</span>
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
  const sel = (open) => {
    const ms = S.members.filter((m) => m.active && m.roles.includes(open.role));
    return `<label class="row" style="gap:6px"><span class="muted">改派${esc(stepLabel(open.step))}</span><select data-reassign="${open.step}" style="width:auto">
      <option value="">${waitText(open.step)}</option>${ms.map((m) => `<option value="${m.id}" ${m.id === open.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`;
  };
  return `<div class="card admin-bar"><span class="muted">管理員操作</span>
    ${(p.opens || []).map(sel).join('')}
    <span class="spacer"></span>
    ${FLOW.indexOf(p.step) > 0 ? '<button class="btn danger act" id="admin-return">退回…</button>' : ''}
    <button class="btn act" id="admin-advance">直接推到下一關：${esc(nextHint(p))} →</button></div>`;
}

async function viewProduct(idStr) {
  const id = Number(idStr);
  const p = await api('GET', `/api/products/${id}`);
  const idx = STEP_ORDER.indexOf(p.step);
  const nextId = S.radarKeys[S.radarKeys.indexOf(id) + 1] || (S.radarKeys[0] !== id ? S.radarKeys[0] : null);
  $app.innerHTML = `
    <div class="page-head">
      <a href="#/overview" class="btn small">← 全覽</a>
      ${thumb(p.id, p.thumb_ver, 'md')}
      <h1>${shopName(p.name, p.link)}</h1>${statusBadge(p)}${stepChip(p.step)}
      ${p.delisted_at ? '<span class="tag red">已下架</span>' : ''}
      ${p.sheet_status ? `<span class="muted">試算表：${esc(p.sheet_status)}</span>` : p.source === 'manual' ? '<span class="muted">手動開單</span>' : ''}
      <span class="spacer"></span>
      ${nextId ? `<a class="btn small" href="#/p/${nextId}">下一件 →</a>` : ''}
      ${S.me.is_admin ? '<button class="btn small danger" id="del-product">刪除</button>' : ''}
    </div>
    <div class="stepper">${STEP_ORDER.map((s, i) => {
      const on = i === idx || (p.opens || []).some((o) => o.step === s);
      return `<div class="step ${i < idx && !on ? 'done' : ''} ${on ? 'cur' : ''}" style="${on ? `background:${STEP_COLOR[s]}` : ''}">${i < idx && !on ? '✓ ' : ''}${esc(stepLabel(s))}</div>`;
    }).join('')}</div>
    <div id="action">${actionPanel(p)}</div>
    ${adminBar(p)}
    <div class="detail">
      <div>
        ${p.photos.length ? `<div class="card section"><h2>圖片</h2>
          ${['cutout', 'opt', 'pick'].filter((k) => p.photos.some((ph) => ph.kind === k)).map((k) => `<div class="kind-title">${KIND[k]}</div>${photoGrid(p, k, { download: true })}`).join('')}
        </div>` : ''}
        ${commentsBlock(p)}
      </div>
      <div>
        ${rushBlock(p)}
        ${S.me.is_admin ? timelineBlock(p) : ''}
      </div>
    </div>`;
  bindProduct(p);
}

function bindProduct(p) {
  const id = p.id;
  const cur = chosenStint(p);
  const doAction = (action, extra = {}, doneMsg = null) => act(async () => {
    await api('POST', `/api/products/${id}/action`, { action, version: p.version, step: action === 'admin_advance' ? p.step : (cur?.step ?? p.step), ...extra });
    $app.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    if (doneMsg) { S.handled = { name: p.name, to: doneMsg, at: Date.now() }; location.hash = '#/radar'; }
  }, doneMsg ? null : '已完成', doneMsg ? 'none' : 'refresh');

  const cb = document.getElementById('claim-btn');
  if (cb) cb.onclick = () => claim(id, p.version, cur.step);
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
      doAction('complete', extra, cur.step === 'mkt_check' ? '檢查通過，已完成' : `已交給 ${nextHint(p, cur.step)}`);
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
      if (['mkt_check', 'optimizing'].includes(p.step) && !target()) miss.push(p.step === 'optimizing' ? '文案或圖' : '退回哪一步');
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
  $app.querySelectorAll('[data-reassign]').forEach((ra) => {
    ra.onchange = () => {
      const name = ra.value ? ra.options[ra.selectedIndex].text : waitText(ra.dataset.reassign);
      if (!confirm(`改派給「${name}」？`)) { delete ra.dataset.dirty; return refresh(); }
      act(() => api('POST', `/api/products/${id}/action`, { action: 'reassign', version: p.version, step: ra.dataset.reassign, member_id: Number(ra.value) || null }), '已改派');
    };
  });
  const aret = document.getElementById('admin-return');
  if (aret) {
    const before = FLOW.slice(0, FLOW.indexOf(p.step));
    aret.onclick = () => openModal(`
      <h3>退回</h3>
      <p class="muted">退回的那一步改好後，直接交回「${esc(stepLabel(p.step))}」。會記一次退件在那一步上次做的人身上。</p>
      <div class="field"><span>退回哪一步</span><div class="hour-pick" id="ar-target">${before.map((t) => `<label><input type="radio" name="ar" value="${t}">${esc(stepLabel(t))}</label>`).join('')}</div></div>
      <label class="field"><span>哪裡有問題（必填）</span><textarea id="ar-note"></textarea></label>
      <div class="acts"><button class="btn" data-close>取消</button><button class="btn warn" id="ar-go" disabled>送出退回</button></div>`,
    (m, close) => {
      const sync = () => {
        m.querySelectorAll('.hour-pick label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
        m.querySelector('#ar-go').disabled = !(m.querySelector('[name=ar]:checked') && m.querySelector('#ar-note').value.trim());
      };
      m.addEventListener('input', sync);
      m.addEventListener('change', sync);
      m.querySelector('#ar-go').onclick = () => {
        const target = m.querySelector('[name=ar]:checked').value;
        const note = m.querySelector('#ar-note').value.trim();
        close();
        act(() => api('POST', `/api/products/${id}/action`, { action: 'return', version: p.version, step: p.step, target, note }), `已退回「${stepLabel(target)}」`);
      };
    });
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
  if (!S.me.is_admin) { $app.innerHTML = '<p class="empty">成效分析目前只有管理員看得到</p>'; return; }
  const a = S.ana;
  const [r, ov] = await Promise.all([api('GET', `/api/analysis?days=${a.days}`), api('GET', '/api/overview?filter=all')]);
  const live = ov.rows.filter((x) => !x.done);
  const slowRows = live.filter((x) => x.level !== 'ok').sort((x, y) => y.diff - x.diff);
  const chip = (label, n, k = '') => `<div class="kpi-chip ${k}"><span>${label}</span><b class="mono">${n}</b></div>`;
  const dash = `<div class="ov-kpis">
      ${chip('進行中', live.length)}
      ${chip('等人認領', live.filter((x) => x.cells.some((c) => c.state === 'current' && c.waiting)).length)}
      ${chip('比平均慢', slowRows.length, 'k-ruby')}
      ${chip('退件', ov.rows.reduce((n, x) => n + x.returns, 0), 'k-topaz')}
      ${chip('插隊逾期', live.filter((x) => x.rush?.overdue).length, 'k-ruby')}
      ${chip('已完成', ov.counts.done, 'k-emerald')}
    </div>
`;
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
    ${dash}
    <div class="kpis">
      ${kpi('完成件數', m.done_count, '件')}
      ${kpi('退件總數', m.returns_total, '次', FLOW.filter((s) => m.returns_by_step[s]).map((s) => `${stepLabel(s)} ${m.returns_by_step[s]}`).join('・') || '')}
      ${kpi('插隊件數', m.rush_total, '件')}
      ${kpi('錯過插隊日', m.rush_missed, '件')}
    </div>
    <div class="card section">
      <h2>每一步的團隊平均 <span class="muted">只算上班時間；工作時間 = 認領後到完成，沒人接的時間另外算，看得出哪一關沒人接</span></h2>
      <div class="table-wrap"><table class="rank">
        <thead><tr><th>步驟</th><th class="num">平均工作時間</th><th class="num">平均總時間</th><th class="num">其中沒人接</th><th class="num">樣本</th><th class="num">被退件</th></tr></thead>
        <tbody>${FLOW.map((s) => `<tr><td>${stepChip(s)}</td>
          <td class="num mono">${m.steps[s].avg != null ? esc(fmtWork(m.steps[s].avg)) : '資料不足'}</td>
          <td class="num mono">${m.steps[s].total_avg != null ? esc(fmtWork(m.steps[s].total_avg)) : '—'}</td>
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
