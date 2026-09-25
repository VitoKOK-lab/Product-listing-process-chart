// 商品上架流程協作 — 前端（無框架，hash 路由）
'use strict';

// 進行中階段輪用寶石色；最後階段（完成）固定祖母綠；寶石紅保留給「卡關」警示
const GEMS = ['#1E4E8C', '#1B7F8C', '#6B3FA0', '#B8741A', '#8C2F6B', '#4A6B1E', '#3D4F7A'];
const DONE_COLOR = '#0E7C5A';
const POLL_MS = 10000;
const AGE_WARN_DAYS = 3;
const AGE_LATE_DAYS = 7;
const MAX_EDGE = 1920;

const S = {
  me: null, members: [], stages: [], platforms: [], products: [],
  version: null, busy: 0, flowSel: null, boardMine: false,
};
const $app = document.getElementById('app');

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = (arr, id) => arr.find((x) => x.id === id);
const member = (id) => byId(S.members, id);
const stage = (id) => byId(S.stages, id);
const stageIndex = (id) => S.stages.findIndex((s) => s.id === id);
const stageColor = (id) => {
  const i = stageIndex(id);
  return i === S.stages.length - 1 ? DONE_COLOR : GEMS[Math.max(0, i) % GEMS.length];
};
const lastStage = () => S.stages[S.stages.length - 1];
const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function avatar(m, size) {
  if (!m) return `<span class="avatar" style="background:#B8BCC8">?</span>`;
  const st = size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` : '';
  return `<span class="avatar" style="background:${m.color}${st}">${esc([...m.name][0])}</span>`;
}
function ageTag(iso) {
  const d = daysSince(iso);
  const cls = d >= AGE_LATE_DAYS ? 'late' : d >= AGE_WARN_DAYS ? 'warn' : '';
  return `<span class="age ${cls}" title="在此階段 ${d} 天">${d}d</span>`;
}

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = error ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function api(method, path, data) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (data instanceof FormData) opt.body = data;
  else if (data !== undefined) { opt.body = JSON.stringify(data); opt.headers['content-type'] = 'application/json'; }
  const res = await fetch(path, opt);
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) { S.me = null; await boot(); throw new Error(out.error || '請重新登入'); }
  if (!res.ok) throw new Error(out.error || `錯誤 ${res.status}`);
  return out;
}

async function act(fn, okMsg) {
  S.busy++;
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy--;
  }
}

// 使用者正在輸入或上傳時不自動刷新，避免蓋掉內容
function isBusy() {
  if (S.busy > 0) return true;
  if (document.querySelector('.lightbox')) return true;
  if ($app.querySelector('[data-dirty]')) return true;
  const a = document.activeElement;
  return !!a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

$app.addEventListener('input', (e) => {
  if (e.target.matches('input, textarea, select')) e.target.dataset.dirty = '1';
});

// ---------- data ----------

async function loadBase() {
  const b = await api('GET', '/api/bootstrap');
  Object.assign(S, { me: b.me, members: b.members, stages: b.stages, platforms: b.platforms });
}

async function boot() {
  await loadBase();
  if (!S.me) return renderLogin();
  document.getElementById('topbar').hidden = false;
  document.getElementById('nav-settings').hidden = !S.me.is_admin;
  document.getElementById('me').innerHTML =
    `${avatar(S.me)}<span>${esc(S.me.name)}</span>${S.me.is_admin ? '<span class="tag admin">管理者</span>' : ''}`;
  const v = await api('GET', '/api/version');
  S.version = v.v;
  await render();
}

async function refresh() {
  if (!S.me) return;
  const v = await api('GET', '/api/version');
  S.version = v.v;
  await loadBase();
  if (!S.me) return renderLogin();
  await render();
}

setInterval(async () => {
  if (!S.me || document.hidden || isBusy()) return;
  try {
    const v = await api('GET', '/api/version');
    if (v.v !== S.version && !isBusy()) await refresh();
  } catch { /* 網路暫時中斷時略過 */ }
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.me && !isBusy()) refresh().catch(() => {});
});

// ---------- login（名字綁定裝置） ----------

function renderLogin() {
  document.getElementById('topbar').hidden = true;
  const active = S.members.filter((m) => m.active);
  if (!active.length) {
    $app.innerHTML = `
      <div class="login">
        <h1>建立第一位成員</h1>
        <p class="muted">第一位成員會成為管理者，並綁定這台裝置。之後由管理者在「設定」新增其他成員。</p>
        <form id="first-form">
          <input type="text" name="name" placeholder="你的名字" maxlength="30" required>
          <button class="btn primary">建立並進入</button>
        </form>
      </div>`;
    document.getElementById('first-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/members', { name: e.target.name.value });
        await boot();
      } catch (err) { toast(err.message, true); }
    };
    return;
  }
  const open = active.filter((m) => !m.bound);
  $app.innerHTML = `
    <div class="login">
      <h1>選擇你的名字</h1>
      <p class="muted">選定後這台裝置會綁定你的名字，之後打開直接進入。<br>選錯或換裝置，請找管理者重設。</p>
      ${open.length ? `<div class="name-grid">${open.map((m) => `
        <button class="name-btn" data-id="${m.id}">${avatar(m)}<span>${esc(m.name)}</span></button>`).join('')}
      </div>` : '<p class="empty">目前沒有可選的名字。請聯絡管理者新增或重設。</p>'}
    </div>`;
  $app.querySelectorAll('.name-btn').forEach((b) => {
    b.onclick = async () => {
      const m = member(Number(b.dataset.id));
      if (!confirm(`確定你是「${m.name}」？\n選定後這台裝置會綁定此名字，只有管理者能重設。`)) return;
      try {
        await api('POST', '/api/claim', { member_id: m.id });
        await boot();
      } catch (err) { toast(err.message, true); await boot(); }
    };
  });
}

// ---------- router ----------

window.addEventListener('hashchange', () => { if (S.me) render(); });

async function render() {
  const [route, arg] = (location.hash.replace(/^#\/?/, '') || 'board').split('/');
  document.querySelectorAll('#nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === route || (route === 'p' && a.dataset.route === 'board')));
  const views = { board: viewBoard, p: viewProduct, flow: viewFlow, graph: viewGraph, charts: viewCharts, log: viewLog, settings: viewSettings };
  const view = views[route] || viewBoard;
  try {
    await view(arg);
  } catch (e) {
    $app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function loadProducts() {
  S.products = await api('GET', '/api/products');
  return S.products;
}

// ---------- 看板 ----------

function productCard(p) {
  const owner = member(p.owner_id);
  return `
    <a class="card pcard" href="#/p/${p.id}" style="border-left-color:${stageColor(p.stage_id)}">
      ${p.cover_id ? `<img class="cover" loading="lazy" src="/api/photos/${p.cover_id}" alt="">` : ''}
      <div class="title">${esc(p.name)}</div>
      ${p.sku ? `<div class="muted mono">${esc(p.sku)}</div>` : ''}
      <div class="meta">
        ${owner ? `${avatar(owner)}<span>${esc(owner.name)}</span>` : '<span>未指派</span>'}
        <span class="spacer"></span>
        ${p.photo_count ? `<span>📷 <span class="num">${p.photo_count}</span></span>` : ''}
        ${p.comment_count ? `<span>💬 <span class="num">${p.comment_count}</span></span>` : ''}
        ${p.stage_id !== lastStage()?.id ? ageTag(p.stage_entered_at) : ''}
      </div>
    </a>`;
}

async function viewBoard() {
  const products = await loadProducts();
  const list = S.boardMine ? products.filter((p) => p.owner_id === S.me.id) : products;
  $app.innerHTML = `
    <div class="page-head">
      <h1>看板</h1>
      <div class="row">
        <button class="btn small ${S.boardMine ? '' : 'primary'}" data-f="all">全部</button>
        <button class="btn small ${S.boardMine ? 'primary' : ''}" data-f="mine">我負責的</button>
      </div>
      <span class="spacer"></span>
      <form id="new-form" class="row">
        <input type="text" name="name" placeholder="新商品名稱" maxlength="100" required style="width:220px">
        <button class="btn primary">＋ 新增商品</button>
      </form>
    </div>
    <div class="board">
      ${S.stages.map((s) => {
        const items = list.filter((p) => p.stage_id === s.id);
        return `<section class="col">
          <div class="col-head"><span class="stage-dot" style="background:${stageColor(s.id)}"></span>${esc(s.name)}<span class="num">${items.length}</span></div>
          ${items.map(productCard).join('') || '<div class="muted" style="padding:8px 4px">—</div>'}
        </section>`;
      }).join('')}
    </div>`;
  $app.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { S.boardMine = b.dataset.f === 'mine'; viewBoard(); }; });
  document.getElementById('new-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('POST', '/api/products', { name: e.target.name.value });
      location.hash = `#/p/${id}`;
    } catch (err) { toast(err.message, true); }
  };
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
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file; // 瀏覽器無法解碼（例如 HEIC）時上傳原檔
  }
}

async function uploadPhotos(productId, files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return toast('請選擇圖片檔', true);
  await act(async () => {
    toast(`上傳中… ${imgs.length} 張`);
    const fd = new FormData();
    for (const f of imgs) fd.append('file', await resizeImage(f));
    await api('POST', `/api/products/${productId}/photos`, fd);
  }, `已上傳 ${imgs.length} 張`);
}

function historyText(h) {
  const who = member(h.member_id)?.name ?? '—';
  if (h.from_stage_id === null) return `${esc(who)} 建立，進入「${esc(stage(h.to_stage_id)?.name ?? '已刪除階段')}」`;
  const back = stageIndex(h.to_stage_id) < stageIndex(h.from_stage_id);
  return `${esc(who)} ${back ? '退回' : '推進'}到「${esc(stage(h.to_stage_id)?.name ?? '已刪除階段')}」`;
}

async function viewProduct(idStr) {
  const id = Number(idStr);
  const p = await api('GET', `/api/products/${id}`);
  const idx = stageIndex(p.stage_id);
  const prev = S.stages[idx - 1];
  const next = S.stages[idx + 1];
  const activeMembers = S.members.filter((m) => m.active || m.id === p.owner_id);
  $app.innerHTML = `
    <div class="page-head">
      <a href="#/board" class="btn small">← 看板</a>
      <h1>${esc(p.name)}</h1>
      <span class="chip plain" style="background:${stageColor(p.stage_id)};color:#fff">${esc(stage(p.stage_id)?.name)}</span>
      ${idx !== S.stages.length - 1 ? ageTag(p.stage_entered_at) : ''}
      <span class="spacer"></span>
      ${S.me.is_admin ? '<button class="btn small danger" id="del-product">刪除商品</button>' : ''}
    </div>

    <div class="card section">
      <div class="stepper">
        ${S.stages.map((s, i) => `<button class="step ${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}" data-stage="${s.id}"
          style="${i === idx ? `background:${stageColor(s.id)}` : ''}" title="移到「${esc(s.name)}」">${i < idx ? '✓ ' : ''}${esc(s.name)}</button>`).join('')}
      </div>
      <div class="row">
        ${prev ? `<button class="btn" data-stage="${prev.id}">← 退回「${esc(prev.name)}」</button>` : ''}
        <span class="spacer"></span>
        ${next ? `<button class="btn primary" data-stage="${next.id}">完成，推進到「${esc(next.name)}」→</button>` : '<span class="muted">已在最後階段</span>'}
      </div>
    </div>

    <div class="detail">
      <div>
        <div class="card section">
          <h2>照片 <span class="muted num">${p.photos.length}</span></h2>
          <div class="photos" id="photos">
            ${p.photos.map((ph) => `
              <div class="photo">
                <img loading="lazy" src="/api/photos/${ph.id}" alt="${esc(ph.filename)}" data-full="/api/photos/${ph.id}"
                  title="${esc(member(ph.uploaded_by)?.name ?? '')} · ${fmtTime(ph.created_at)}">
                ${S.me.is_admin ? `<button class="btn small danger del" data-photo="${ph.id}">刪除</button>` : ''}
              </div>`).join('')}
            <label class="dropzone" id="dropzone">
              <input type="file" accept="image/*" multiple hidden id="file-input">
              <span>＋ 上傳照片<br><span class="muted">點選或拖曳，可多張</span></span>
            </label>
          </div>
        </div>

        <div class="card section">
          <h2>留言 <span class="muted num">${p.comments.length}</span></h2>
          <div class="comments">
            ${p.comments.map((c) => {
              const m = member(c.member_id);
              return `<div class="comment">${avatar(m)}
                <div class="bubble">
                  <div class="who"><b>${esc(m?.name ?? '—')}</b><span class="mono">${fmtTime(c.created_at)}</span>
                    ${c.member_id === S.me.id || S.me.is_admin ? `<button class="btn small" data-del-comment="${c.id}" style="margin-left:auto">刪除</button>` : ''}
                  </div>
                  <div class="text">${esc(c.body)}</div>
                </div></div>`;
            }).join('') || '<div class="muted">還沒有留言</div>'}
          </div>
          <form id="comment-form">
            <textarea name="body" placeholder="寫下留言…（Ctrl + Enter 送出）" maxlength="2000" required></textarea>
            <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn primary">送出留言</button></div>
          </form>
        </div>
      </div>

      <div>
        <form class="card section" id="info-form">
          <h2>商品資料</h2>
          <label class="field"><span>商品名稱</span><input type="text" name="name" value="${esc(p.name)}" maxlength="100" required></label>
          <label class="field"><span>SKU／貨號</span><input type="text" name="sku" value="${esc(p.sku)}" maxlength="60"></label>
          <label class="field"><span>負責人</span>
            <select name="owner_id"><option value="">未指派</option>
              ${activeMembers.map((m) => `<option value="${m.id}" ${m.id === p.owner_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
            </select></label>
          <div class="field"><span>上架平台</span>
            <div class="check-row">${S.platforms.map((pl) => `
              <label><input type="checkbox" name="platform" value="${pl.id}" ${p.platform_ids.includes(pl.id) ? 'checked' : ''}>${esc(pl.name)}</label>`).join('')}
            </div></div>
          <label class="field"><span>備註</span><textarea name="note" maxlength="2000">${esc(p.note)}</textarea></label>
          <div class="row"><span class="spacer"></span><button class="btn primary">儲存</button></div>
        </form>

        <div class="card section">
          <h2>流程紀錄</h2>
          <ul class="timeline">
            ${p.history.slice().reverse().map((h) => `<li>${historyText(h)}<div class="muted mono">${fmtTime(h.at)}</div></li>`).join('')}
          </ul>
        </div>
      </div>
    </div>`;

  $app.querySelectorAll('[data-stage]').forEach((b) => {
    b.onclick = () => {
      const to = Number(b.dataset.stage);
      if (to === p.stage_id) return;
      act(() => api('POST', `/api/products/${id}/move`, { to_stage_id: to }), `已移到「${stage(to).name}」`);
    };
  });

  const input = document.getElementById('file-input');
  input.onchange = () => uploadPhotos(id, input.files);
  const dz = document.getElementById('dropzone');
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); uploadPhotos(id, e.dataTransfer.files); };

  $app.querySelectorAll('img[data-full]').forEach((img) => {
    img.onclick = () => {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${img.dataset.full}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    };
  });
  $app.querySelectorAll('[data-photo]').forEach((b) => {
    b.onclick = () => confirm('刪除這張照片？（可在設定 → 回收區還原）') &&
      act(() => api('DELETE', `/api/photos/${b.dataset.photo}`), '已刪除照片');
  });
  $app.querySelectorAll('[data-del-comment]').forEach((b) => {
    b.onclick = () => confirm('刪除這則留言？') && act(() => api('DELETE', `/api/comments/${b.dataset.delComment}`), '已刪除留言');
  });

  const cf = document.getElementById('comment-form');
  cf.onsubmit = (e) => {
    e.preventDefault();
    const text = cf.body.value;
    act(async () => {
      await api('POST', `/api/products/${id}/comments`, { body: text });
      delete cf.body.dataset.dirty;
      cf.body.value = '';
    });
  };
  cf.body.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) cf.requestSubmit(); };

  const f = document.getElementById('info-form');
  f.onsubmit = (e) => {
    e.preventDefault();
    const data = {
      name: f.name.value, sku: f.sku.value, note: f.note.value,
      owner_id: f.owner_id.value ? Number(f.owner_id.value) : null,
      platform_ids: [...f.querySelectorAll('[name=platform]:checked')].map((c) => Number(c.value)),
    };
    act(async () => {
      await api('PATCH', `/api/products/${id}`, data);
      f.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
    }, '已儲存');
  };

  const del = document.getElementById('del-product');
  if (del) del.onclick = () => confirm(`刪除「${p.name}」？（可在設定 → 回收區還原）`) &&
    act(async () => { await api('DELETE', `/api/products/${id}`); location.hash = '#/board'; }, '已刪除商品');
}

// ---------- 流程圖（依階段設定自動產生） ----------

async function viewFlow() {
  const [products, stats] = await Promise.all([loadProducts(), api('GET', '/api/stats')]);
  const counts = Object.fromEntries(S.stages.map((s) => [s.id, products.filter((p) => p.stage_id === s.id).length]));
  // 瓶頸 = 最後階段以外、平均停留天數最長的階段
  const candidates = S.stages.slice(0, -1).filter((s) => stats.avg_dwell_days[s.id] > 0);
  const bottleneck = candidates.sort((a, b) => stats.avg_dwell_days[b.id] - stats.avg_dwell_days[a.id])[0];
  if (!S.flowSel || !stage(S.flowSel)) S.flowSel = S.stages[0]?.id;
  const sel = products.filter((p) => p.stage_id === S.flowSel);
  const arrow = '<div class="flow-arrow"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 12h14m-5-6 6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
  $app.innerHTML = `
    <div class="page-head"><h1>流程圖</h1><span class="muted">依設定的階段自動產生；點階段看裡面的商品</span></div>
    <div class="flow">
      ${S.stages.map((s, i) => `
        ${i ? arrow : ''}
        <div class="flow-node ${s.id === S.flowSel ? 'sel' : ''}" data-id="${s.id}" style="background:${stageColor(s.id)}">
          ${bottleneck && bottleneck.id === s.id ? '<span class="bottleneck">瓶頸</span>' : ''}
          <span class="nm">${i + 1}. ${esc(s.name)}</span>
          <span class="n">${counts[s.id]}</span>
          <span class="dw">${i === S.stages.length - 1 ? '完成' : `平均停留 <span class="mono">${stats.avg_dwell_days[s.id] ?? 0}</span> 天`}</span>
        </div>`).join('')}
    </div>
    <div class="card flow-list">
      <div class="section" style="margin:0;padding-bottom:6px"><h2 style="margin:0">「${esc(stage(S.flowSel)?.name ?? '')}」中的商品</h2></div>
      ${sel.map((p) => {
        const o = member(p.owner_id);
        return `<a href="#/p/${p.id}">${avatar(o)}<span>${esc(p.name)}</span><span class="spacer"></span>${ageTag(p.stage_entered_at)}</a>`;
      }).join('') || '<div class="empty">這個階段目前沒有商品</div>'}
    </div>`;
  $app.querySelectorAll('.flow-node').forEach((n) => { n.onclick = () => { S.flowSel = Number(n.dataset.id); viewFlow(); }; });
}

// ---------- 關係圖：負責人 ↔ 商品 ↔ 平台 ----------

async function viewGraph() {
  const products = (await loadProducts()).slice().sort((a, b) => stageIndex(a.stage_id) - stageIndex(b.stage_id) || a.id - b.id);
  const owners = S.members.filter((m) => m.active || products.some((p) => p.owner_id === m.id));
  const plats = S.platforms;
  const ROW = 38, TOP = 50;
  const rows = Math.max(owners.length, products.length, plats.length, 1);
  const H = TOP + rows * ROW + 20;
  const W = 900, XM = 190, XP1 = 330, XP2 = 570, XL = 720;
  const yFor = (i, n) => TOP + ((rows - n) * ROW) / 2 + i * ROW + ROW / 2;
  const pos = {};
  owners.forEach((m, i) => { pos[`m${m.id}`] = yFor(i, owners.length); });
  products.forEach((p, i) => { pos[`p${p.id}`] = yFor(i, products.length); });
  plats.forEach((pl, i) => { pos[`l${pl.id}`] = yFor(i, plats.length); });
  const curve = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
  const edges = [];
  for (const p of products) {
    if (p.owner_id && pos[`m${p.owner_id}`] !== undefined) {
      edges.push({ a: `m${p.owner_id}`, b: `p${p.id}`, d: curve(XM + 10, pos[`m${p.owner_id}`], XP1, pos[`p${p.id}`]) });
    }
    for (const pl of p.platform_ids) {
      if (pos[`l${pl}`] !== undefined) edges.push({ a: `p${p.id}`, b: `l${pl}`, d: curve(XP2, pos[`p${p.id}`], XL - 10, pos[`l${pl}`]) });
    }
  }
  const trunc = (s, n) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);
  $app.innerHTML = `
    <div class="page-head"><h1>關係圖</h1><span class="muted">點節點看關聯；再點一次商品開啟商品頁</span></div>
    <div class="legend">${S.stages.map((s) => `<span><i class="stage-dot" style="background:${stageColor(s.id)}"></i>${esc(s.name)}</span>`).join('')}</div>
    <div class="card graph-wrap"><div class="graph" id="graph">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin meet" style="max-height:${H}px">
        <text class="col-label" x="${XM}" y="28" text-anchor="end">負責人</text>
        <text class="col-label" x="${(XP1 + XP2) / 2}" y="28" text-anchor="middle">商品</text>
        <text class="col-label" x="${XL}" y="28">平台</text>
        ${edges.map((e) => `<path class="edge" data-a="${e.a}" data-b="${e.b}" d="${e.d}"/>`).join('')}
        ${owners.map((m) => `<g class="node" data-k="m${m.id}">
            <circle cx="${XM}" cy="${pos[`m${m.id}`]}" r="10" fill="${m.color}"/>
            <text x="${XM - 18}" y="${pos[`m${m.id}`] + 4}" text-anchor="end">${esc(m.name)}</text></g>`).join('')}
        ${products.map((p) => `<g class="node" data-k="p${p.id}" data-pid="${p.id}">
            <rect x="${XP1}" y="${pos[`p${p.id}`] - 14}" width="${XP2 - XP1}" height="28" rx="7" fill="#fff" stroke="${stageColor(p.stage_id)}" stroke-width="2"/>
            <rect x="${XP1}" y="${pos[`p${p.id}`] - 14}" width="8" height="28" rx="3" fill="${stageColor(p.stage_id)}"/>
            <text x="${XP1 + 16}" y="${pos[`p${p.id}`] + 4}">${esc(trunc(p.name, 16))}</text></g>`).join('')}
        ${plats.map((pl) => `<g class="node" data-k="l${pl.id}">
            <circle cx="${XL}" cy="${pos[`l${pl.id}`]}" r="10" fill="#1F2430"/>
            <text x="${XL + 18}" y="${pos[`l${pl.id}`] + 4}">${esc(pl.name)}</text></g>`).join('')}
      </svg>
      ${products.length ? '' : '<p class="empty">還沒有商品</p>'}
    </div></div>`;

  const g = document.getElementById('graph');
  let focus = null;
  g.querySelectorAll('.node').forEach((n) => {
    n.onclick = () => {
      const k = n.dataset.k;
      if (focus === k && n.dataset.pid) { location.hash = `#/p/${n.dataset.pid}`; return; }
      focus = focus === k ? null : k;
      g.classList.toggle('focus', !!focus);
      g.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
      if (!focus) return;
      // 找出與焦點直接或經由商品間接相連的節點
      const lit = new Set([focus]);
      const productKeys = new Set(focus.startsWith('p') ? [focus] : []);
      g.querySelectorAll('.edge').forEach((e) => {
        if (e.dataset.a === focus || e.dataset.b === focus) {
          const other = e.dataset.a === focus ? e.dataset.b : e.dataset.a;
          lit.add(other);
          if (other.startsWith('p')) productKeys.add(other);
        }
      });
      g.querySelectorAll('.edge').forEach((e) => {
        if (productKeys.has(e.dataset.a) || productKeys.has(e.dataset.b)) {
          e.classList.add('hl'); lit.add(e.dataset.a); lit.add(e.dataset.b);
        }
      });
      g.querySelectorAll('.node').forEach((el) => { if (lit.has(el.dataset.k)) el.classList.add('hl'); });
    };
  });
}

// ---------- 圖表（數字全部由程式計算） ----------

function barList(items, max, unit = '') {
  const m = Math.max(max, 1);
  return `<div class="bars">${items.map((it) => `
    <div class="bar-row"><span class="lbl" title="${esc(it.label)}">${esc(it.label)}</span>
      <div class="bar-track">${(it.parts || [{ v: it.v, color: it.color }]).map((pt) =>
        `<div class="bar-fill" style="width:${(pt.v / m) * 100}%;background:${pt.color}" title="${esc(pt.title ?? '')} ${pt.v}"></div>`).join('')}</div>
      <span class="v">${it.v}${unit}</span></div>`).join('')}</div>`;
}

async function viewCharts() {
  const [products, stats] = await Promise.all([loadProducts(), api('GET', '/api/stats')]);
  const last = lastStage();
  const inProgress = products.filter((p) => p.stage_id !== last?.id);
  const listed = products.length - inProgress.length;
  const byStage = S.stages.map((s) => ({ label: s.name, v: products.filter((p) => p.stage_id === s.id).length, color: stageColor(s.id) }));
  const workStages = S.stages.slice(0, -1);
  const byOwner = S.members.filter((m) => m.active).map((m) => {
    const mine = inProgress.filter((p) => p.owner_id === m.id);
    return {
      label: m.name, v: mine.length,
      parts: workStages.map((s) => ({ v: mine.filter((p) => p.stage_id === s.id).length, color: stageColor(s.id), title: s.name })),
    };
  }).sort((a, b) => b.v - a.v);
  const unassigned = inProgress.filter((p) => !p.owner_id).length;
  if (unassigned) byOwner.push({ label: '未指派', v: unassigned, color: '#B8BCC8' });
  const dwell = workStages.map((s) => ({ label: s.name, v: stats.avg_dwell_days[s.id] ?? 0, color: stageColor(s.id) }));
  const stuck = inProgress.filter((p) => daysSince(p.stage_entered_at) >= AGE_LATE_DAYS);

  $app.innerHTML = `
    <div class="page-head"><h1>圖表</h1></div>
    <div class="kpis">
      <div class="card kpi"><div class="label">進行中</div><div class="value">${inProgress.length}</div></div>
      <div class="card kpi"><div class="label">已${esc(last?.name ?? '完成')}</div><div class="value" style="color:var(--emerald)">${listed}</div></div>
      <div class="card kpi"><div class="label">近 7 天新增</div><div class="value">${stats.added_7d}</div></div>
      <div class="card kpi"><div class="label">近 7 天${esc(last?.name ?? '完成')}</div><div class="value">${stats.listed_7d}</div></div>
      <div class="card kpi"><div class="label">卡關 ≥ ${AGE_LATE_DAYS} 天</div><div class="value" style="color:${stuck.length ? 'var(--ruby)' : 'inherit'}">${stuck.length}</div></div>
    </div>
    <div class="charts">
      <div class="card section"><h2>各階段件數</h2>${barList(byStage, Math.max(...byStage.map((x) => x.v)))}</div>
      <div class="card section"><h2>每人手上件數 <span class="muted">（進行中，依階段著色）</span></h2>${barList(byOwner, Math.max(0, ...byOwner.map((x) => x.v)))}</div>
      <div class="card section"><h2>平均停留天數 <span class="muted">（含進行中）</span></h2>${barList(dwell, Math.max(0, ...dwell.map((x) => x.v)), 'd')}</div>
      <div class="card section"><h2>卡關清單</h2>
        ${stuck.sort((a, b) => Date.parse(a.stage_entered_at) - Date.parse(b.stage_entered_at)).map((p) => `
          <div class="log-item"><a href="#/p/${p.id}">${esc(p.name)}</a><span class="muted">${esc(stage(p.stage_id)?.name)} · ${esc(member(p.owner_id)?.name ?? '未指派')}</span><time>${ageTag(p.stage_entered_at)}</time></div>`).join('')
          || '<p class="muted">沒有卡關的商品</p>'}
      </div>
    </div>`;
}

// ---------- 活動紀錄 ----------

const ACTIONS = {
  product_add: '新增商品', product_edit: '修改商品', product_move: '移動商品到', product_delete: '刪除商品', product_restore: '還原商品',
  photo_add: '上傳照片', photo_delete: '刪除照片', photo_restore: '還原照片',
  comment_add: '留言', comment_delete: '刪除留言', comment_restore: '還原留言',
  member_add: '新增成員', member_edit: '修改成員', member_bind: '綁定裝置', member_reset: '重設綁定',
  stage_add: '新增階段', stage_edit: '修改階段', stage_order: '調整階段順序', stage_delete: '刪除階段',
  platform_add: '新增平台', platform_edit: '修改平台', platform_delete: '刪除平台',
};

async function viewLog() {
  const items = await api('GET', '/api/activity?limit=200');
  $app.innerHTML = `
    <div class="page-head"><h1>活動紀錄</h1><span class="muted">誰、何時、做了什麼</span></div>
    <div class="card section">
      ${items.map((a) => {
        const m = member(a.member_id);
        const target = a.product_id ? ` <a href="#/p/${a.product_id}">${esc(a.product_name ?? '')}</a>` : '';
        return `<div class="log-item">${avatar(m)}<div><b>${esc(m?.name ?? '—')}</b> ${ACTIONS[a.action] ?? esc(a.action)}${target}
          ${a.detail ? `<span class="muted">・${esc(a.detail)}</span>` : ''}</div><time>${fmtTime(a.at)}</time></div>`;
      }).join('') || '<p class="empty">還沒有紀錄</p>'}
    </div>`;
}

// ---------- 設定（管理者） ----------

async function viewSettings() {
  if (!S.me.is_admin) { $app.innerHTML = '<p class="empty">只有管理者可以進入設定</p>'; return; }
  const trash = await api('GET', '/api/trash');
  $app.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <div class="charts">
      <div class="card section">
        <h2>成員</h2>
        <p class="muted" style="margin-top:-8px">成員第一次選名字後綁定該裝置。換裝置或選錯，按「重設綁定」讓名字重新出現在登入頁。</p>
        ${S.members.map((m) => `
          <div class="set-row" data-member="${m.id}">
            ${avatar(m)}
            <input type="text" value="${esc(m.name)}" maxlength="30">
            ${m.is_admin ? '<span class="tag admin">管理者</span>' : ''}
            ${!m.active ? '<span class="tag off">停用</span>' : m.bound ? `<span class="tag bound" title="${fmtTime(m.bound_at)}">已綁定</span>` : '<span class="tag">未綁定</span>'}
            <button class="btn small" data-act="rename">改名</button>
            <button class="btn small" data-act="admin">${m.is_admin ? '取消管理者' : '設為管理者'}</button>
            ${m.bound ? '<button class="btn small danger" data-act="reset">重設綁定</button>' : ''}
            <button class="btn small ${m.active ? 'danger' : ''}" data-act="active">${m.active ? '停用' : '啟用'}</button>
          </div>`).join('')}
        <form class="add-row" id="add-member"><input type="text" name="name" placeholder="新成員名字" maxlength="30" required><button class="btn primary">新增</button></form>
      </div>

      <div class="card section">
        <h2>流程階段</h2>
        <p class="muted" style="margin-top:-8px">順序即流程圖順序；最後一個階段視為「完成」。</p>
        ${S.stages.map((s, i) => `
          <div class="set-row" data-stage-row="${s.id}">
            <span class="stage-dot" style="background:${stageColor(s.id)}"></span>
            <input type="text" value="${esc(s.name)}" maxlength="20">
            <button class="btn small" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn small" data-act="down" ${i === S.stages.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn small" data-act="rename">改名</button>
            <button class="btn small danger" data-act="delete">刪除</button>
          </div>`).join('')}
        <form class="add-row" id="add-stage"><input type="text" name="name" placeholder="新階段名稱" maxlength="20" required><button class="btn primary">新增</button></form>
      </div>

      <div class="card section">
        <h2>上架平台</h2>
        ${S.platforms.map((pl) => `
          <div class="set-row" data-platform="${pl.id}">
            <input type="text" value="${esc(pl.name)}" maxlength="30">
            <button class="btn small" data-act="rename">改名</button>
            <button class="btn small danger" data-act="delete">刪除</button>
          </div>`).join('')}
        <form class="add-row" id="add-platform"><input type="text" name="name" placeholder="新平台名稱" maxlength="30" required><button class="btn primary">新增</button></form>
      </div>

      <div class="card section">
        <h2>回收區</h2>
        ${[
          ...trash.products.map((x) => ({ type: 'product', id: x.id, label: `商品「${x.name}」`, at: x.deleted_at })),
          ...trash.photos.map((x) => ({ type: 'photo', id: x.id, label: `照片（${x.product_name}）`, at: x.deleted_at })),
          ...trash.comments.map((x) => ({ type: 'comment', id: x.id, label: `留言「${x.body.slice(0, 20)}」（${x.product_name}）`, at: x.deleted_at })),
        ].sort((a, b) => b.at.localeCompare(a.at)).map((x) => `
          <div class="set-row"><span style="flex:1">${esc(x.label)}</span><span class="muted mono">${fmtTime(x.at)}</span>
            <button class="btn small" data-restore="${x.type}:${x.id}">還原</button></div>`).join('') || '<p class="muted">回收區是空的</p>'}
      </div>
    </div>`;

  $app.querySelectorAll('[data-member]').forEach((row) => {
    const id = Number(row.dataset.member);
    const m = member(id);
    const input = row.querySelector('input');
    row.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'rename') act(() => api('PATCH', `/api/members/${id}`, { name: input.value }), '已改名');
        if (a === 'admin') act(() => api('PATCH', `/api/members/${id}`, { is_admin: !m.is_admin }), '已更新');
        if (a === 'active') act(() => api('PATCH', `/api/members/${id}`, { active: !m.active }), '已更新');
        if (a === 'reset' && confirm(`重設「${m.name}」的裝置綁定？\n原裝置會立即登出，名字重新出現在登入頁。`)) {
          act(() => api('POST', `/api/members/${id}/reset`), '已重設，名字已回到登入頁');
        }
      };
    });
  });
  document.getElementById('add-member').onsubmit = (e) => {
    e.preventDefault();
    act(() => api('POST', '/api/members', { name: e.target.name.value }), '已新增成員');
  };

  $app.querySelectorAll('[data-stage-row]').forEach((row) => {
    const id = Number(row.dataset.stageRow);
    const input = row.querySelector('input');
    row.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'rename') act(() => api('PATCH', `/api/stages/${id}`, { name: input.value }), '已改名');
        if (a === 'delete' && confirm(`刪除階段「${stage(id).name}」？`)) act(() => api('DELETE', `/api/stages/${id}`), '已刪除');
        if (a === 'up' || a === 'down') {
          const ids = S.stages.map((s) => s.id);
          const i = ids.indexOf(id);
          const j = a === 'up' ? i - 1 : i + 1;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          act(() => api('PUT', '/api/stages/order', { ids }));
        }
      };
    });
  });
  document.getElementById('add-stage').onsubmit = (e) => {
    e.preventDefault();
    act(() => api('POST', '/api/stages', { name: e.target.name.value }), '已新增階段');
  };

  $app.querySelectorAll('[data-platform]').forEach((row) => {
    const id = Number(row.dataset.platform);
    const input = row.querySelector('input');
    row.querySelector('[data-act=rename]').onclick = () => act(() => api('PATCH', `/api/platforms/${id}`, { name: input.value }), '已改名');
    row.querySelector('[data-act=delete]').onclick = () => confirm('刪除這個平台？商品上的勾選也會移除。') &&
      act(() => api('DELETE', `/api/platforms/${id}`), '已刪除');
  });
  document.getElementById('add-platform').onsubmit = (e) => {
    e.preventDefault();
    act(() => api('POST', '/api/platforms', { name: e.target.name.value }), '已新增平台');
  };

  $app.querySelectorAll('[data-restore]').forEach((b) => {
    const [type, id] = b.dataset.restore.split(':');
    b.onclick = () => act(() => api('POST', '/api/restore', { type, id: Number(id) }), '已還原');
  });
}

boot().catch((e) => { $app.innerHTML = `<p class="empty">無法載入：${esc(e.message)}</p>`; });
