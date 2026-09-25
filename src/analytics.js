// 責任歸屬、雷達、延誤分析（純函式，所有數字由程式計算）
import { workHoursBetween, addWorkHours } from './worktime.js';

export const STEPS = ['raw', 'edit', 'listing', 'review', 'publish', 'live', 'optimizing', 'opt_review'];
export const STEP_LABEL = {
  raw: '原圖', edit: '美編', listing: '建檔', review: '審核', publish: '待發布',
  live: '已上架', optimizing: '優化中', opt_review: '優化審核',
};

const round1 = (n) => Math.round(n * 10) / 10;

// 同一段「停留」= 同商品、同步驟、同優化單，連續且只因改派而換人的 stints
function visitsOf(stints) {
  const sorted = [...stints].sort((a, b) => a.product_id - b.product_id || a.started_at - b.started_at || a.id - b.id);
  const visits = [];
  let cur = null;
  for (const s of sorted) {
    const cont = cur && s.start_reason === 'reassign' && cur.product_id === s.product_id
      && cur.step === s.step && cur.optimization_id === s.optimization_id;
    if (cont) cur.stints.push(s);
    else {
      cur = { product_id: s.product_id, step: s.step, optimization_id: s.optimization_id, budget: s.budget_hours, stints: [s] };
      visits.push(cur);
    }
  }
  return visits;
}

// 每個 stint 的經手時數與超出預算時數
// 一般步驟：同一段停留內累計，超過預算的部分算給當時拿著的人
// 優化中：只看截止時間；審核超時的時數會延後優化者的有效截止時間
export function computeStintHours(stints, optimizations, now, cfg) {
  const out = new Map();
  const optById = new Map(optimizations.map((o) => [o.id, o]));
  const held = (s) => workHoursBetween(s.started_at, s.ended_at ?? now, cfg);

  for (const v of visitsOf(stints.filter((s) => s.step !== 'optimizing'))) {
    let acc = 0;
    for (const s of v.stints) {
      const h = held(s);
      let over = 0;
      if (v.budget != null) {
        const before = Math.max(0, acc - v.budget);
        const after = Math.max(0, acc + h - v.budget);
        over = after - before;
      }
      acc += h;
      out.set(s.id, { held: h, over, visit_held: acc });
    }
  }

  const optStints = stints.filter((s) => s.step === 'optimizing');
  for (const s of optStints) {
    const opt = optById.get(s.optimization_id);
    const h = held(s);
    if (!opt) { out.set(s.id, { held: h, over: 0 }); continue; }
    // 此段開始前、已結束的審核輪次超時總和
    const reviewerOver = stints
      .filter((r) => r.step === 'opt_review' && r.optimization_id === opt.id && r.ended_at != null && r.ended_at <= s.started_at)
      .reduce((sum, r) => sum + (out.get(r.id)?.over || 0), 0);
    const eff = addWorkHours(opt.deadline, reviewerOver, cfg);
    const end = s.ended_at ?? now;
    const over = end > eff ? workHoursBetween(Math.max(s.started_at, eff), end, cfg) : 0;
    out.set(s.id, { held: h, over, visit_held: h });
  }
  return out;
}

export function optRemaining(opt, now, cfg) {
  return now >= opt.deadline ? 0 : workHoursBetween(now, opt.deadline, cfg);
}

export function isRushNow(opt, now, cfg, settings) {
  return opt && opt.status !== 'passed' && optRemaining(opt, now, cfg) <= settings.rush_threshold_hours;
}

// 這張優化單是否曾經是急件（結案時或現在距截止 ≤ 門檻）
export function wasRush(opt, now, cfg, settings) {
  const end = opt.passed_at ?? now;
  return (end >= opt.deadline ? 0 : workHoursBetween(end, opt.deadline, cfg)) <= settings.rush_threshold_hours;
}

// 目前停留的顏色：rush / red / yellow / ok（一般步驟依整段停留累計 vs 預算）
export function stintColor(s, hours, opt, now, cfg, settings) {
  if (s.step === 'optimizing' || s.step === 'opt_review') {
    if (opt && now > opt.deadline) return 'red';
    if (isRushNow(opt, now, cfg, settings)) return 'rush';
  }
  if (s.budget_hours == null) return 'ok';
  const total = hours.visit_held ?? hours.held;
  if (total > 2 * s.budget_hours) return 'red';
  if (total > s.budget_hours) return 'yellow';
  return 'ok';
}

function parseReasons(r) {
  if (!r) return [];
  try { return Array.isArray(r) ? r : JSON.parse(r); } catch { return []; }
}

const REASON_LABEL = { photo: '照片', copy: '文案', price: '價格' };

const WAIT_TAG = {
  raw: '待上傳原圖', edit: '待做圖', listing: '圖已到，可建檔', review: '等我審核', publish: '等我發布',
  optimizing: '優化中', opt_review: '等我審核優化',
};

// 雷達：依規格固定排序 急件 → @我／被退回 → 紅 → 黃 → 等我處理
export function buildRadar({ stints, optimizations, mentions, products, me, scope, now, cfg, settings, hoursMap }) {
  const optById = new Map(optimizations.map((o) => [o.id, o]));
  const prodById = new Map(products.map((p) => [p.id, p]));
  const open = stints.filter((s) => s.ended_at == null && prodById.has(s.product_id));
  const items = new Map();

  for (const s of open) {
    if (scope === 'me' && s.member_id !== me) continue;
    const p = prodById.get(s.product_id);
    const opt = s.optimization_id ? optById.get(s.optimization_id) : null;
    const h = hoursMap.get(s.id) || { held: 0, over: 0 };
    const color = stintColor(s, h, opt, now, cfg, settings);
    const tags = [];
    let group = 'mine';
    let returned = null;
    if (color === 'rush' || (opt && (s.step === 'optimizing' || s.step === 'opt_review') && color === 'red')) {
      group = 'rush';
      const rem = optRemaining(opt, now, cfg);
      tags.push(now > opt.deadline ? { t: `逾期 ${round1(workHoursBetween(opt.deadline, now, cfg))}h`, k: 'red' } : { t: `急件 剩 ${round1(rem)}h`, k: 'rush' });
    }
    if (s.start_reason === 'return') {
      returned = { reasons: parseReasons(s.reasons).map((r) => REASON_LABEL[r] || r), note: s.note, by: s.by_id };
      tags.push({ t: `被退回：${returned.reasons.join('、')}`, k: 'return' });
      if (group === 'mine') group = 'attention';
    }
    if (color === 'red' && group === 'mine') group = 'red';
    if (color === 'yellow' && group === 'mine') group = 'yellow';
    if (h.over > 0) tags.push({ t: `超時 ${round1(h.over)}h`, k: color === 'red' ? 'red' : 'yellow' });
    tags.push({ t: WAIT_TAG[s.step] || '', k: 'wait' });
    items.set(s.product_id + ':' + s.id, {
      key: s.product_id + ':' + s.id, product_id: p.id, name: p.name, batch_id: p.batch_id, step: s.step,
      holder_id: s.member_id, started_at: s.started_at, held_h: round1(h.held), over_h: round1(h.over),
      budget_h: s.budget_hours, color, group, tags, returned,
      deadline: opt?.deadline ?? null, remaining_h: opt ? round1(optRemaining(opt, now, cfg)) : null,
      budget_left_h: s.budget_hours != null ? round1(s.budget_hours - (h.visit_held ?? h.held)) : null,
    });
  }

  if (scope === 'me') {
    for (const m of mentions) {
      if (m.member_id !== me || m.resolved_at != null || !prodById.has(m.product_id)) continue;
      const existing = [...items.values()].find((it) => it.product_id === m.product_id);
      const tag = { t: '@ 提及你', k: 'mention', mention_id: m.id };
      if (existing) {
        existing.tags.unshift(tag);
        if (existing.group !== 'rush') existing.group = 'attention';
        existing.mention_id = m.id;
      } else {
        const p = prodById.get(m.product_id);
        items.set('m' + m.id, {
          key: 'm' + m.id, product_id: p.id, name: p.name, batch_id: p.batch_id, step: p.step,
          holder_id: null, started_at: m.created_at, held_h: 0, over_h: 0, budget_h: null, color: 'ok',
          group: 'attention', tags: [tag], returned: null, deadline: null, remaining_h: null, mention_id: m.id,
          budget_left_h: null,
        });
      }
    }
  }

  const order = { rush: 0, attention: 1, red: 2, yellow: 3, mine: 4 };
  const list = [...items.values()];
  list.sort((a, b) => order[a.group] - order[b.group]
    || (a.group === 'rush' ? a.deadline - b.deadline : 0)
    || (a.group === 'red' || a.group === 'yellow' ? b.over_h - a.over_h : 0)
    || a.started_at - b.started_at);
  const stuck = list.filter((i) => i.group !== 'mine');
  const upcoming = stuck.length ? [] : list
    .filter((i) => i.budget_left_h != null)
    .sort((a, b) => a.budget_left_h - b.budget_left_h)
    .slice(0, 3)
    .map((i) => i.key);
  return { items: list, stuck_count: stuck.length, upcoming };
}

// 當時手上同步件數 → 個人速度 or 產能不足
export function diagnose(s, stints, roleMembers, ratio) {
  const t = s.started_at;
  const loadOf = (mid) => stints.filter((x) => x.member_id === mid && x.started_at <= t && (x.ended_at == null || x.ended_at > t)).length;
  const load = loadOf(s.member_id);
  const peers = roleMembers[s.role] || [];
  const avg = peers.length ? peers.reduce((sum, mid) => sum + loadOf(mid), 0) / peers.length : load;
  const capacity = load >= 2 && avg > 0 && load >= ratio * avg;
  return { load, avg: round1(avg), kind: capacity ? 'capacity' : 'speed' };
}

// 單件商品的時間歸屬條
export function attributionFor(productId, stints, hoursMap) {
  const agg = new Map();
  for (const s of stints) {
    if (s.product_id !== productId) continue;
    const h = hoursMap.get(s.id);
    if (!h) continue;
    const a = agg.get(s.member_id) || { member_id: s.member_id, roles: new Set(), held: 0, over: 0 };
    a.roles.add(s.role);
    a.held += h.held;
    a.over += h.over;
    agg.set(s.member_id, a);
  }
  return [...agg.values()]
    .map((a) => ({ member_id: a.member_id, roles: [...a.roles], held: round1(a.held), over: round1(a.over) }))
    .sort((a, b) => b.over - a.over || b.held - a.held);
}

// 優化單錯過截止時間時，延誤拆解到每位超時的人
export function deadlineBreakdown(opt, stints, hoursMap, now) {
  const end = opt.passed_at ?? now;
  if (end <= opt.deadline) return null;
  const rows = stints
    .filter((s) => s.optimization_id === opt.id && (hoursMap.get(s.id)?.over || 0) > 0)
    .map((s) => ({ member_id: s.member_id, step: s.step, over: round1(hoursMap.get(s.id).over) }));
  return { late: true, rows };
}

// 延誤排行（依超出預算時數排序）
export function ranking({ stints, optimizations, hoursMap, roleMembers, settings, now, cfg, filter }) {
  const optById = new Map(optimizations.map((o) => [o.id, o]));
  const rows = new Map();
  for (const s of stints) {
    if (!filter(s)) continue;
    const opt = s.optimization_id ? optById.get(s.optimization_id) : null;
    const rush = opt ? wasRush(opt, now, cfg, settings) : false;
    if (filter.scope === 'rush' && !rush) continue;
    if (filter.scope === 'normal' && rush) continue;
    const h = hoursMap.get(s.id);
    if (!h) continue;
    const r = rows.get(s.member_id) || { member_id: s.member_id, roles: new Set(), held: 0, over: 0, late_count: 0, speed: 0, capacity: 0 };
    r.roles.add(s.role);
    r.held += h.held;
    r.over += h.over;
    if (h.over > 0) {
      r.late_count++;
      r[diagnose(s, stints, roleMembers, settings.capacity_ratio).kind]++;
    }
    rows.set(s.member_id, r);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, roles: [...r.roles], held: round1(r.held), over: round1(r.over) }))
    .sort((a, b) => b.over - a.over || b.held - a.held);
}

// 規格第 0 節的指標
export function metrics({ stints, optimizations, comments, undoCount, hoursMap, now, cfg, filter }) {
  const commentsBy = new Map();
  for (const c of comments) (commentsBy.get(c.product_id) || commentsBy.set(c.product_id, []).get(c.product_id)).push(c);

  let dwellSum = 0, dwellN = 0, yellowEnded = 0, falseAlarm = 0;
  const visits = visitsOf(stints.filter((s) => s.step !== 'optimizing' && filter(s)));
  for (const v of visits) {
    if (v.budget == null) continue;
    const first = v.stints[0];
    const last = v.stints[v.stints.length - 1];
    const total = v.stints.reduce((sum, s) => sum + (hoursMap.get(s.id)?.held || 0), 0);
    if (total <= v.budget) continue;
    const yellowAt = addWorkHours(first.started_at, v.budget, cfg);
    const end = last.ended_at ?? now;
    const cs = (commentsBy.get(v.product_id) || []).filter((c) => c.created_at >= yellowAt && c.created_at <= end);
    const firstAction = Math.min(end, ...cs.map((c) => c.created_at));
    dwellSum += workHoursBetween(yellowAt, firstAction, cfg);
    dwellN++;
    if (last.ended_at != null && ['complete', 'pass', 'publish', 'submit'].includes(last.end_reason)) {
      yellowEnded++;
      const nudged = cs.some((c) => c.member_id !== last.member_id);
      if (!nudged) falseAlarm++;
    }
  }

  const firstPass = (step, keyOf) => {
    const firsts = new Map();
    for (const s of [...stints].sort((a, b) => a.started_at - b.started_at)) {
      if (s.step !== step || s.ended_at == null || !filter(s)) continue;
      const k = keyOf(s);
      if (!firsts.has(k)) firsts.set(k, s.end_reason);
    }
    const all = [...firsts.values()];
    return all.length ? { rate: Math.round((all.filter((r) => r === 'pass').length / all.length) * 100), n: all.length } : { rate: null, n: 0 };
  };

  const editVisits = visitsOf(stints.filter((s) => s.step === 'edit' && s.ended_at != null && filter(s)));
  const editAvg = editVisits.length
    ? editVisits.reduce((sum, v) => sum + v.stints.reduce((x, s) => x + (hoursMap.get(s.id)?.held || 0), 0), 0) / editVisits.length
    : null;

  const missed = optimizations.filter((o) => (o.passed_at ?? now) > o.deadline && (o.passed_at != null || now > o.deadline)).length;

  return {
    stuck_dwell_h: dwellN ? round1(dwellSum / dwellN) : null,
    stuck_n: dwellN,
    false_alarm_rate: yellowEnded ? Math.round((falseAlarm / yellowEnded) * 100) : null,
    false_alarm_n: yellowEnded,
    review_first_pass: firstPass('review', (s) => s.product_id),
    opt_first_pass: firstPass('opt_review', (s) => s.optimization_id),
    edit_avg_h: editAvg == null ? null : round1(editAvg),
    undo_count: undoCount,
    missed_deadlines: missed,
  };
}
