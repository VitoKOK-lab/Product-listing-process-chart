// 全覽、待辦、成效分析（純函式，所有數字由程式計算）
import { workHoursBetween, localToEpoch } from './worktime.js';
import { STATUS_RANK } from './sheet.js';

// 流程：行銷在試算表寫上商品名稱（= 開單）→ 美編做圖、上架人員寫文案（同時進行）→ 上架 → 優化 → 行銷檢查 → 已完成
// open 只留給舊資料；新商品從 cutout + listing 同時開始
export const STEPS = ['open', 'cutout', 'listing', 'optimizing', 'mkt_check', 'done'];
export const FLOW = ['cutout', 'listing', 'optimizing', 'mkt_check'];
export const STEP_LABEL = { open: '開單', cutout: '做圖', listing: '文案上架', optimizing: '優化', mkt_check: '行銷檢查', done: '已完成' };
export const STEP_ROLE = { open: 'marketing', cutout: 'editor', listing: 'lister', optimizing: 'designer', mkt_check: 'marketing' };
export const MIN_SAMPLE = 3; // 同一步至少 3 件走完，才拿來比團隊平均

// 這些開始原因代表「又輪到這一步一次」；認領、放回、改派、恢復只是同一輪換手
// import = 上線時整批推進的舊件，排隊時間不拿來算團隊平均
const VISIT_START = new Set(['create', 'advance', 'return', 'import']);

const round1 = (n) => Math.round(n * 10) / 10;
const stepIdx = (s) => STEPS.indexOf(s);

export function stintHours(stints, now, cfg) {
  const out = new Map();
  for (const s of stints) out.set(s.id, workHoursBetween(s.started_at, s.ended_at ?? now, cfg));
  return out;
}

// 每件商品每一步：總時數（含沒人認領的等待）、工作時數（認領後）、等待時數、第幾輪、經手的人
// 成效用工作時數比；總時數用來看哪一關沒人接
export function stepTimes(stints, hours) {
  const out = new Map();
  const sorted = [...stints].sort((a, b) => a.started_at - b.started_at || a.id - b.id);
  for (const s of sorted) {
    const byStep = out.get(s.product_id) || out.set(s.product_id, {}).get(s.product_id);
    const e = (byStep[s.step] ||= { held: 0, work: 0, pool: 0, rounds: 0, open: false, holders: [], imported: false });
    if (s.start_reason === 'import') e.imported = true;
    const h = hours.get(s.id) || 0;
    e.held += h;
    if (s.member_id) e.work += h;
    else e.pool += h;
    if (VISIT_START.has(s.start_reason)) e.rounds++;
    if (s.ended_at == null) e.open = true;
    if (s.member_id && !e.holders.includes(s.member_id)) e.holders.push(s.member_id);
  }
  return out;
}

// 團隊平均：只拿已經走過這一步的商品來算
export function teamAverages(products, times) {
  const out = {};
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  for (const step of FLOW) {
    const vals = [];
    const totals = [];
    const pools = [];
    for (const p of products) {
      const e = times.get(p.id)?.[step];
      if (!e || e.open || e.imported || stepIdx(p.step) <= stepIdx(step)) continue;
      vals.push(e.work);
      totals.push(e.held);
      pools.push(e.pool);
    }
    const ok = vals.length >= MIN_SAMPLE;
    out[step] = {
      avg: ok ? round1(mean(vals)) : null, total_avg: ok ? round1(mean(totals)) : null,
      pool_avg: ok ? round1(mean(pools)) : null, n: vals.length,
    };
  }
  return out;
}

// 跟團隊平均比：慢 1.5 倍以上「偏慢」、2 倍以上「很慢」；差不到半小時不算
export function compare(held, avg) {
  if (avg == null) return { diff: null, level: 'ok' };
  const diff = round1(held - avg);
  const ratio = avg > 0 ? held / avg : held > 0 ? Infinity : 1;
  const level = diff >= 0.5 && ratio >= 2 ? 'very' : diff >= 0.5 && ratio >= 1.5 ? 'slow' : 'ok';
  return { diff, level };
}

// 插隊：截止 = 那天下班；剩 N 個上班日內是急件
export function rushInfo(p, now, cfg, settings) {
  if (!p.rush_date) return null;
  const deadline = localToEpoch(p.rush_date, cfg.end, cfg);
  const done = p.step === 'done';
  const end = done ? (p.done_at ?? now) : now;
  const remaining = end >= deadline ? 0 : workHoursBetween(end, deadline, cfg);
  return {
    date: p.rush_date, deadline, remaining_h: round1(remaining),
    urgent: !done && remaining <= settings.rush_threshold_hours,
    overdue: !done && now > deadline,
    missed: end > deadline,
  };
}

// 排序：插隊（依截止日）> A 投放中 > B 優先製作 > C 可投放 > D 待製作 > 其他
export function priorityOf(p) {
  if (p.rush_date && p.step !== 'done') return [0, p.rush_date];
  return [STATUS_RANK[p.status_code] || 5, ''];
}

export function comparePriority(a, b) {
  const pa = priorityOf(a);
  const pb = priorityOf(b);
  return pa[0] - pb[0] || (pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0);
}

// 被退件：算在上一次做這一步的人身上
export function returnEvents(stints) {
  const sorted = [...stints].sort((a, b) => a.started_at - b.started_at || a.id - b.id);
  const events = [];
  sorted.forEach((s, i) => {
    if (s.start_reason !== 'return') return;
    let member_id = null;
    for (let j = i - 1; j >= 0 && !member_id; j--) {
      const x = sorted[j];
      if (x.product_id === s.product_id && x.step === s.step && x.member_id) member_id = x.member_id;
    }
    member_id ||= s.member_id;
    if (member_id) events.push({ member_id, product_id: s.product_id, step: s.step, at: s.started_at, by_id: s.by_id, note: s.note });
  });
  return events;
}

// 目前這一輪如果是被退回來的，找出那筆退回紀錄
export function currentReturn(stints, open) {
  if (!open) return null;
  const same = stints.filter((x) => x.product_id === open.product_id && x.step === open.step && (x.started_at < open.started_at || (x.started_at === open.started_at && x.id <= open.id)))
    .sort((a, b) => b.started_at - a.started_at || b.id - a.id);
  for (const x of same) {
    if (x.start_reason === 'return') return x;
    if (VISIT_START.has(x.start_reason)) return null;
  }
  return null;
}

function ctx({ allProducts, stints, now, cfg }) {
  const hours = stintHours(stints, now, cfg);
  const times = stepTimes(stints, hours);
  const avgs = teamAverages(allProducts, times);
  return { hours, times, avgs };
}

// 全覽：每件商品一條賽道，每一步跟團隊平均比
export function overviewRows({ products, allProducts, stints, now, cfg, settings }) {
  const { times, avgs } = ctx({ allProducts, stints, now, cfg });
  // 一件商品可能同時有兩段在進行（做圖、文案）
  const openBy = new Map();
  for (const s of stints) if (s.ended_at == null) (openBy.get(s.product_id) || openBy.set(s.product_id, {}).get(s.product_id))[s.step] = s;
  const returnsBy = new Map();
  for (const e of returnEvents(stints)) returnsBy.set(e.product_id, (returnsBy.get(e.product_id) || 0) + 1);
  const LV = { ok: 0, slow: 1, very: 2 };

  const rows = products.map((p) => {
    const t = times.get(p.id) || {};
    const done = p.step === 'done';
    const cur = done ? FLOW.length : Math.max(0, FLOW.indexOf(p.step));
    const opens = openBy.get(p.id) || {};
    let diff = 0;
    let level = 'ok';
    const cells = FLOW.map((step, i) => {
      const e = t[step];
      const open = opens[step] || null;
      const state = open ? 'current' : i < cur ? 'done' : 'future';
      const held = round1(e?.held || 0);
      const work = round1(e?.work || 0);
      const cell = {
        step, state, held, work, pool: round1(e?.pool || 0), rounds: e?.rounds || 0, holders: e?.holders || [],
        avg: avgs[step].avg, total_avg: avgs[step].total_avg, diff: null, level: 'ok', holder_id: null, waiting: false,
        parallel: !!open && step !== p.step, owner: step === 'mkt_check' ? p.marketer_id ?? null : null,
      };
      if (open) {
        cell.holder_id = open.member_id ?? null;
        cell.waiting = !open.member_id;
      }
      if (e && state !== 'future' && !e.imported) {
        const c = compare(work, cell.avg);
        // 進行中的步驟只在比平均慢時才算，不提前算快
        if (state === 'done' || (c.diff ?? 0) > 0) {
          cell.diff = c.diff;
          cell.level = c.level;
          if (c.diff != null) diff += c.diff;
          if (LV[c.level] > LV[level]) level = c.level;
        }
      }
      return cell;
    });
    return {
      id: p.id, name: p.name, link: p.link || '', step: p.step, done, delisted: !!p.delisted_at,
      status_code: p.status_code || '', sheet_status: p.sheet_status || '', thumb: p.thumb_ver || 0,
      rush: rushInfo(p, now, cfg, settings), rush_date: p.rush_date ?? null, cells, diff: round1(diff), level,
      returns: returnsBy.get(p.id) || 0, done_at: p.done_at ?? null, marketer_id: p.marketer_id ?? null,
    };
  });
  rows.sort((a, b) => comparePriority(a, b) || stepIdx(b.step) - stepIdx(a.step) || a.id - b.id);
  return { rows, avgs };
}

// 我的待辦：插隊急件 → 被退回／@我 → 比平均慢 → 我手上 → 等人認領
// showTime = false：員工看不到任何時間與比平均（只有管理員看得到）
export function buildRadar({ products, allProducts, stints, mentions, me, meRoles = [], scope, now, cfg, settings, showTime = true }) {
  const { times, avgs } = ctx({ allProducts, stints, now, cfg });
  const prodById = new Map(products.map((p) => [p.id, p]));
  const items = new Map();

  for (const s of stints) {
    if (s.ended_at != null || !prodById.has(s.product_id)) continue;
    const p = prodById.get(s.product_id);
    const mine = s.member_id === me;
    const claimable = !s.member_id && meRoles.includes(s.role);
    const st = times.get(p.id)?.[s.step];
    const held = round1(st?.work || 0);
    const c = st?.imported || !showTime ? { diff: null, level: 'ok' } : compare(held, avgs[s.step]?.avg);
    const rush = rushInfo(p, now, cfg, settings);
    if (scope === 'me' && !mine && !claimable) continue;
    if (scope === 'all' && !(c.level !== 'ok' || rush?.urgent || rush?.overdue)) continue;
    const tags = [];
    let group = mine ? 'mine' : 'pool';
    if (rush?.urgent || rush?.overdue) {
      group = 'rush';
      tags.push(rush.overdue ? { t: '插隊已逾期', k: 'red' } : { t: `插隊・剩 ${rush.remaining_h}h`, k: 'rush' });
    }
    const r = currentReturn(stints, s);
    if (r) {
      tags.push({ t: '被退回', k: 'return' });
      if (group === 'mine') group = 'attention';
    }
    if (c.level !== 'ok') {
      tags.push({ t: `比平均慢 ${c.diff}h`, k: c.level === 'very' ? 'red' : 'yellow' });
      if (group === 'mine') group = 'slow';
    }
    if (!s.member_id) tags.push({ t: '等人認領', k: 'wait' });
    if (s.step === 'listing' && p.step === 'cutout') tags.push({ t: '圖還在做', k: 'wait' });
    if (s.step === 'listing' && p.rename_pending) tags.push({ t: '名稱要改・網址會變', k: 'return' });
    items.set(`${s.product_id}:${s.id}`, {
      key: `${s.product_id}:${s.id}`, product_id: p.id, name: p.name, link: p.link || '', step: s.step, role: s.role,
      holder_id: s.member_id ?? null, claimable, started_at: s.started_at,
      held_h: showTime ? held : null, wait_h: showTime ? round1(st?.pool || 0) : null, avg_h: showTime ? avgs[s.step]?.avg ?? null : null,
      blocked: s.step === 'listing' && p.step === 'cutout',
      level: c.level, group, tags, returned: r ? { note: r.note, by: r.by_id } : null, rush,
      status_code: p.status_code || '', rush_date: p.rush_date ?? null, thumb: p.thumb_ver || 0, version: p.version,
      sheet_row: p.sheet_row ?? null,
    });
  }

  if (scope === 'me') {
    for (const m of mentions) {
      if (m.member_id !== me || m.resolved_at != null || !prodById.has(m.product_id)) continue;
      const existing = [...items.values()].find((it) => it.product_id === m.product_id);
      const tag = { t: '@ 提及你', k: 'mention' };
      if (existing) {
        existing.tags.unshift(tag);
        if (existing.group !== 'rush') existing.group = 'attention';
        existing.mention_id = m.id;
      } else {
        const p = prodById.get(m.product_id);
        items.set(`m${m.id}`, {
          key: `m${m.id}`, product_id: p.id, name: p.name, link: p.link || '', step: p.step, holder_id: null, claimable: false,
          started_at: m.created_at, held_h: null, avg_h: null, level: 'ok', group: 'attention', tags: [tag], returned: null,
          rush: rushInfo(p, now, cfg, settings), status_code: p.status_code || '', rush_date: p.rush_date ?? null,
          thumb: p.thumb_ver || 0, mention_id: m.id,
        });
      }
    }
  }

  const order = { rush: 0, attention: 1, slow: 2, mine: 3, pool: 4 };
  const list = [...items.values()].sort((a, b) => order[a.group] - order[b.group]
    || (b.returned ? 1 : 0) - (a.returned ? 1 : 0) || workOrder(a, b));
  // 建議現在先做的那一件：排最前面、輪到我（或我能認領）的
  const first = scope === 'me' && list.find((i) => i.holder_id === me || i.claimable);
  if (first) first.suggest = true;
  return { items: list, stuck_count: list.filter((i) => ['rush', 'attention', 'slow'].includes(i.group)).length };
}

// 同一組裡的先後：去背從試算表最下面往上做；其他依插隊 > A > B > C > D，同狀態依試算表由上往下
export function workOrder(a, b) {
  const rowUp = (x) => (x.sheet_row == null ? Infinity : x.sheet_row);
  if (a.step === 'cutout' && b.step === 'cutout') {
    const ra = a.rush_date || '9999';
    const rb = b.rush_date || '9999';
    if (ra !== rb) return ra < rb ? -1 : 1;
    const da = a.sheet_row == null ? -Infinity : a.sheet_row;
    const db = b.sheet_row == null ? -Infinity : b.sheet_row;
    return db - da || a.started_at - b.started_at;
  }
  return comparePriority(a, b) || rowUp(a) - rowUp(b) || a.started_at - b.started_at;
}

// 商品頁：每個人在這件花的時間（沒人認領的等待另外列）
export function attributionFor(productId, stints, hours) {
  const agg = new Map();
  for (const s of stints) {
    if (s.product_id !== productId) continue;
    const k = s.member_id ?? 0;
    const a = agg.get(k) || { member_id: s.member_id ?? null, steps: new Set(), held: 0 };
    a.steps.add(s.step);
    a.held += hours.get(s.id) || 0;
    agg.set(k, a);
  }
  return [...agg.values()].map((a) => ({ member_id: a.member_id, steps: [...a.steps], held: round1(a.held) })).sort((a, b) => b.held - a.held);
}

// 個人成效：每一步平均花多久，跟同一步的團隊平均比；被退件次數與內容
export function ranking({ stints, now, cfg, since = 0 }) {
  const hours = stintHours(stints, now, cfg);
  const entries = new Map(); // member|product|step
  for (const s of stints) {
    if (!s.member_id || (s.ended_at ?? now) < since) continue;
    const k = `${s.member_id}|${s.product_id}|${s.step}`;
    const e = entries.get(k) || { member_id: s.member_id, step: s.step, held: 0, open: false, imported: false };
    e.held += hours.get(s.id) || 0;
    if (s.ended_at == null) e.open = true;
    if (s.start_reason === 'import') e.imported = true;
    entries.set(k, e);
  }
  const done = [...entries.values()].filter((e) => !e.open && !e.imported);
  const teamAvg = {};
  for (const step of FLOW) {
    const v = done.filter((e) => e.step === step);
    teamAvg[step] = v.length >= MIN_SAMPLE ? round1(v.reduce((x, e) => x + e.held, 0) / v.length) : null;
  }
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { member_id: id, steps: {}, held: 0, n: 0, extra: 0, returned: 0, returned_list: [], issued: 0 });
    return rows.get(id);
  };
  for (const e of entries.values()) {
    const r = row(e.member_id);
    r.held += e.held;
    if (e.open || e.imported) continue;
    const st = (r.steps[e.step] ||= { n: 0, held: 0 });
    st.n++;
    st.held += e.held;
    r.n++;
  }
  for (const r of rows.values()) {
    for (const [step, st] of Object.entries(r.steps)) {
      st.avg = round1(st.held / st.n);
      st.team = teamAvg[step];
      st.diff = st.team == null ? null : round1(st.avg - st.team);
      if (st.diff != null) r.extra += st.diff * st.n;
      st.held = round1(st.held);
    }
    r.held = round1(r.held);
    r.extra = round1(r.extra);
  }
  for (const e of returnEvents(stints)) {
    if (e.at < since) continue;
    const r = row(e.member_id);
    r.returned++;
    r.returned_list.push({ product_id: e.product_id, step: e.step, note: e.note, by_id: e.by_id, at: e.at });
    if (e.by_id) row(e.by_id).issued++;
  }
  for (const r of rows.values()) r.returned_list.sort((a, b) => b.at - a.at);
  return {
    team_avg: teamAvg,
    rows: [...rows.values()].sort((a, b) => b.extra - a.extra || b.returned - a.returned || b.held - a.held),
  };
}

// 團隊指標：每一步平均多久、其中沒人認領的等待多久、退件、插隊達成
export function metrics({ products, stints, now, cfg, settings, since = 0 }) {
  const { avgs } = ctx({ allProducts: products, stints, now, cfg });
  const evs = returnEvents(stints).filter((e) => e.at >= since);
  const rushes = products.map((p) => rushInfo(p, now, cfg, settings)).filter((r) => r && r.deadline >= since);
  return {
    steps: avgs,
    returns_total: evs.length,
    returns_by_step: Object.fromEntries(FLOW.map((s) => [s, evs.filter((e) => e.step === s).length])),
    rush_total: rushes.length,
    rush_missed: rushes.filter((r) => r.missed).length,
    done_count: products.filter((p) => p.step === 'done' && (p.done_at ?? 0) >= since).length,
  };
}
