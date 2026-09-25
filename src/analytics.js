// 責任歸屬、全覽、雷達、延誤分析（純函式，所有數字由程式計算）
import { workHoursBetween, addWorkHours } from './worktime.js';

// 流程：原圖 → 上架（用原圖＋文案直接上 Shopline）→ 首次審查 → 待指定優化 → 優化 → 最終審查 → 已完成
export const STEPS = ['raw', 'listing', 'review', 'assign', 'optimizing', 'final_review', 'done'];
export const FLOW_COLS = ['raw', 'listing', 'review', 'assign', 'optimizing', 'final_review'];
export const STEP_LABEL = {
  raw: '原圖', listing: '上架', review: '首次審查', assign: '待指定優化',
  optimizing: '優化', final_review: '最終審查', done: '已完成',
};
export const REASON_LABEL = { photo: '照片', copy: '文案', price: '價格' };

const round1 = (n) => Math.round(n * 10) / 10;

// 同一段「停留」：一般步驟 = 連續且只因改派換人的 stints；優化 = 同一張優化單的所有輪次
function visitsOf(stints) {
  const sorted = [...stints].sort((a, b) => a.product_id - b.product_id || a.started_at - b.started_at || a.id - b.id);
  const visits = [];
  const optVisits = new Map();
  let cur = null;
  for (const s of sorted) {
    if (s.step === 'optimizing' && s.optimization_id) {
      let v = optVisits.get(s.optimization_id);
      if (!v) {
        v = { product_id: s.product_id, step: s.step, optimization_id: s.optimization_id, budget: s.budget_hours, stints: [] };
        optVisits.set(s.optimization_id, v);
        visits.push(v);
      }
      v.stints.push(s);
      continue;
    }
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

// 每個 stint 的經手時數與超出標準時數：只算這個人「接到工作之後」拿在手上的上班時間
// 超過標準的部分算給當時拿著的人；別人拖延的時間不會算到下一個人身上
export function computeStintHours(stints, optimizations, now, cfg) {
  const out = new Map();
  const held = (s) => workHoursBetween(s.started_at, s.ended_at ?? now, cfg);
  for (const v of visitsOf(stints)) {
    let acc = 0;
    for (const s of v.stints) {
      const h = held(s);
      let over = 0;
      if (v.budget != null) {
        over = Math.max(0, acc + h - v.budget) - Math.max(0, acc - v.budget);
      }
      acc += h;
      out.set(s.id, { held: h, over, visit_held: acc });
    }
  }
  return out;
}

// 優化者的標準時間 = 指定到截止的上班時間 − 最終審查的標準時間（急件用急件審查時數）
export function optimizerBudget(assignedAt, deadline, cfg, settings) {
  const windowH = workHoursBetween(assignedAt, deadline, cfg);
  const reviewH = windowH <= settings.rush_threshold_hours ? settings.rush_review_hours : settings.final_review_hours;
  return Math.max(0.5, round1(windowH - reviewH));
}

export function optRemaining(opt, now, cfg) {
  return now >= opt.deadline ? 0 : workHoursBetween(now, opt.deadline, cfg);
}

export function isRushNow(opt, now, cfg, settings) {
  return !!opt && opt.status !== 'passed' && optRemaining(opt, now, cfg) <= settings.rush_threshold_hours;
}

export function wasRush(opt, now, cfg, settings) {
  const end = opt.passed_at ?? now;
  return (end >= opt.deadline ? 0 : workHoursBetween(end, opt.deadline, cfg)) <= settings.rush_threshold_hours;
}

// 目前停留的顏色：rush / red / yellow / ok
export function stintColor(s, hours, opt, now, cfg, settings) {
  if (opt && (s.step === 'optimizing' || s.step === 'final_review')) {
    if (now > opt.deadline) return 'red';
    if (isRushNow(opt, now, cfg, settings)) return 'rush';
  }
  if (s.budget_hours == null || !hours) return 'ok';
  const total = hours.visit_held ?? hours.held;
  if (total > 2 * s.budget_hours) return 'red';
  if (total > s.budget_hours) return 'yellow';
  return 'ok';
}

function parseReasons(r) {
  if (!r) return [];
  try { return Array.isArray(r) ? r : JSON.parse(r); } catch { return []; }
}

// 被退件歸屬：依退回原因算到「做那部分的人」，不是依流程退到哪一關
// 照片 → 原圖的人；文案／價格 → 上架的人；最終審查退回 → 優化者
export function returnEvents(stints) {
  const sorted = [...stints].sort((a, b) => a.started_at - b.started_at || a.id - b.id);
  const events = [];
  for (const s of sorted) {
    if (s.start_reason !== 'return') continue;
    const reasons = parseReasons(s.reasons);
    const lastHolder = (step, extra = () => true) => {
      const prev = sorted.filter((x) => x.product_id === s.product_id && x.step === step && x.started_at < s.started_at && extra(x));
      return prev.length ? prev[prev.length - 1].member_id : null;
    };
    const blamed = new Map();
    if (s.step === 'optimizing') {
      const m = lastHolder('optimizing', (x) => x.optimization_id === s.optimization_id);
      if (m) blamed.set(m, reasons);
    } else {
      for (const r of reasons) {
        const m = lastHolder(r === 'photo' ? 'raw' : 'listing');
        if (m) blamed.set(m, [...(blamed.get(m) || []), r]);
      }
    }
    for (const [member_id, rs] of blamed) {
      events.push({
        member_id, reasons: rs, product_id: s.product_id, at: s.started_at, by_id: s.by_id,
        stage: s.step === 'optimizing' ? 'final' : 'first',
      });
    }
  }
  return events;
}

// 首頁全覽：每件商品一列，每一步一格
export function overviewRows({ products, stints, optimizations, hoursMap, now, cfg, settings }) {
  const byProduct = new Map();
  for (const s of stints) (byProduct.get(s.product_id) || byProduct.set(s.product_id, []).get(s.product_id)).push(s);
  const optsBy = new Map();
  for (const o of optimizations) (optsBy.get(o.product_id) || optsBy.set(o.product_id, []).get(o.product_id)).push(o);
  const returnsBy = new Map();
  for (const e of returnEvents(stints)) returnsBy.set(e.product_id, (returnsBy.get(e.product_id) || 0) + 1);

  return products.map((p) => {
    const ss = (byProduct.get(p.id) || []).sort((a, b) => a.started_at - b.started_at || a.id - b.id);
    const opts = (optsBy.get(p.id) || []).sort((a, b) => a.id - b.id);
    const activeOpt = opts.find((o) => o.status !== 'passed') || null;
    const lastOpt = opts[opts.length - 1] || null;
    const curIdx = STEPS.indexOf(p.step);
    let variance = 0;
    const cells = FLOW_COLS.map((step, i) => {
      const cell = { step, state: i < curIdx ? 'done' : i === curIdx ? 'current' : 'future', held: 0, budget: null, variance: null, holders: [], color: 'ok' };
      if (step === 'assign') {
        // 待指定優化：只記等待時間，不算任何人的延誤
        const passEnd = [...ss].reverse().find((s) => s.step === 'review' && s.end_reason === 'pass')?.ended_at;
        if (passEnd) {
          const until = p.step === 'assign' ? now : (opts.find((o) => o.assigned_at >= passEnd)?.assigned_at ?? passEnd);
          cell.held = round1(workHoursBetween(passEnd, until, cfg));
        }
        cell.owner = null;
        return cell;
      }
      const mine = ss.filter((s) => s.step === step && (step !== 'optimizing' && step !== 'final_review' ? true : !lastOpt || s.optimization_id === lastOpt.id));
      let held = 0, over = 0;
      for (const s of mine) {
        const h = hoursMap.get(s.id);
        held += h?.held || 0;
        over += h?.over || 0;
        if (s.member_id && !cell.holders.includes(s.member_id)) cell.holders.push(s.member_id);
      }
      const budgets = visitsOf(mine).map((v) => v.budget).filter((b) => b != null);
      cell.budget = budgets.length ? round1(budgets.reduce((a, b) => a + b, 0)) : null;
      cell.held = round1(held);
      cell.over = round1(over);
      cell.rounds = visitsOf(mine).length;
      if (cell.state === 'future' && mine.length) cell.state = 'done';
      if (cell.budget != null && mine.length) {
        cell.variance = cell.state === 'current' ? round1(Math.min(0, cell.budget - held)) : round1(cell.budget - held);
        variance += cell.variance;
      }
      const open = mine.find((s) => s.ended_at == null);
      if (open) {
        cell.color = stintColor(open, hoursMap.get(open.id), activeOpt, now, cfg, settings);
        cell.holder_id = open.member_id;
      }
      cell.owner = {
        raw: p.picker_id, listing: p.lister_id, review: p.reviewer_id, final_review: p.reviewer_id,
        optimizing: (activeOpt || lastOpt)?.optimizer_id ?? null,
      }[step] ?? null;
      return cell;
    });
    return {
      id: p.id, name: p.name, batch_id: p.batch_id, step: p.step, done: p.step === 'done',
      cells, variance: round1(variance), returns: returnsBy.get(p.id) || 0,
      opt: activeOpt || lastOpt ? {
        kind: (activeOpt || lastOpt).kind, deadline: (activeOpt || lastOpt).deadline,
        rush: isRushNow(activeOpt, now, cfg, settings), remaining_h: activeOpt ? round1(optRemaining(activeOpt, now, cfg)) : null,
      } : null,
      finished_at: p.step === 'done' ? p.updated_at : null,
    };
  });
}

const WAIT_TAG = {
  raw: '待上傳原圖', listing: '可上架', review: '等我首次審查', assign: '待指定優化',
  optimizing: '優化中', final_review: '等我最終審查',
};

// 我的待辦：急件 → @我／被退回 → 紅 → 黃 → 等我處理
export function buildRadar({ stints, optimizations, mentions, products, me, meRoles = [], scope, now, cfg, settings, hoursMap }) {
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
    if (opt && (color === 'rush' || color === 'red')) {
      group = 'rush';
      tags.push(now > opt.deadline
        ? { t: `逾期 ${round1(workHoursBetween(opt.deadline, now, cfg))}h`, k: 'red' }
        : { t: `急件 剩 ${round1(optRemaining(opt, now, cfg))}h`, k: 'rush' });
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
    items.set(`${s.product_id}:${s.id}`, {
      key: `${s.product_id}:${s.id}`, product_id: p.id, name: p.name, batch_id: p.batch_id, step: s.step,
      holder_id: s.member_id, started_at: s.started_at, held_h: round1(h.visit_held ?? h.held), over_h: round1(h.over),
      budget_h: s.budget_hours, color, group, tags, returned,
      deadline: opt?.deadline ?? null, remaining_h: opt ? round1(optRemaining(opt, now, cfg)) : null,
      budget_left_h: s.budget_hours != null ? round1(s.budget_hours - (h.visit_held ?? h.held)) : null,
    });
  }

  // 行銷：待指定優化的商品
  if (scope === 'me' && meRoles.includes('marketing')) {
    for (const p of products) {
      if (p.step !== 'assign') continue;
      items.set(`a${p.id}`, {
        key: `a${p.id}`, product_id: p.id, name: p.name, batch_id: p.batch_id, step: 'assign', holder_id: null,
        started_at: p.updated_at, held_h: 0, over_h: 0, budget_h: null, color: 'ok', group: 'mine',
        tags: [{ t: '待指定優化', k: 'wait' }], returned: null, deadline: null, remaining_h: null, budget_left_h: null,
      });
    }
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
          key: `m${m.id}`, product_id: p.id, name: p.name, batch_id: p.batch_id, step: p.step,
          holder_id: null, started_at: m.created_at, held_h: 0, over_h: 0, budget_h: null, color: 'ok',
          group: 'attention', tags: [tag], returned: null, deadline: null, remaining_h: null, mention_id: m.id, budget_left_h: null,
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

export function attributionFor(productId, stints, hoursMap) {
  const agg = new Map();
  for (const s of stints) {
    if (s.product_id !== productId || !s.member_id) continue;
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

export function deadlineBreakdown(opt, stints, hoursMap, now) {
  const end = opt.passed_at ?? now;
  if (end <= opt.deadline) return null;
  const rows = stints
    .filter((s) => s.optimization_id === opt.id && (hoursMap.get(s.id)?.over || 0) > 0)
    .map((s) => ({ member_id: s.member_id, step: s.step, over: round1(hoursMap.get(s.id).over) }));
  return { late: true, rows };
}

// 個人排行：超出標準時數、被退件次數、審查效率
export function ranking({ stints, optimizations, hoursMap, roleMembers, settings, now, cfg, filter }) {
  const optById = new Map(optimizations.map((o) => [o.id, o]));
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { member_id: id, roles: new Set(), held: 0, over: 0, late_count: 0, speed: 0, capacity: 0, returned: 0, returned_reasons: { photo: 0, copy: 0, price: 0 }, issued: 0, review_rounds: 0, review_held: 0 });
    return rows.get(id);
  };
  const scoped = (s) => {
    if (!filter(s)) return false;
    const opt = s.optimization_id ? optById.get(s.optimization_id) : null;
    const rush = opt ? wasRush(opt, now, cfg, settings) : false;
    if (filter.scope === 'rush' && !rush) return false;
    if (filter.scope === 'normal' && rush) return false;
    return true;
  };
  for (const s of stints) {
    if (!s.member_id || !scoped(s)) continue;
    const h = hoursMap.get(s.id);
    if (!h) continue;
    const r = row(s.member_id);
    r.roles.add(s.role);
    r.held += h.held;
    r.over += h.over;
    if (h.over > 0) {
      r.late_count++;
      r[diagnose(s, stints, roleMembers, settings.capacity_ratio).kind]++;
    }
    if ((s.step === 'review' || s.step === 'final_review') && s.ended_at != null) {
      r.review_rounds++;
      r.review_held += h.held;
    }
  }
  const stintById = new Map(stints.map((s) => [s.product_id + ':' + s.started_at, s]));
  for (const e of returnEvents(stints)) {
    const src = stintById.get(e.product_id + ':' + e.at);
    if (src && !scoped(src)) continue;
    const r = row(e.member_id);
    r.returned++;
    for (const k of e.reasons) if (k in r.returned_reasons) r.returned_reasons[k]++;
    if (e.by_id) row(e.by_id).issued++;
  }
  return [...rows.values()]
    .map((r) => ({
      ...r, roles: [...r.roles], held: round1(r.held), over: round1(r.over),
      review_avg: r.review_rounds ? round1(r.review_held / r.review_rounds) : null,
    }))
    .sort((a, b) => b.over - a.over || b.returned - a.returned || b.held - a.held);
}

export function metrics({ stints, optimizations, comments, hoursMap, now, cfg, filter }) {
  const commentsBy = new Map();
  for (const c of comments) (commentsBy.get(c.product_id) || commentsBy.set(c.product_id, []).get(c.product_id)).push(c);

  let dwellSum = 0, dwellN = 0, yellowEnded = 0, falseAlarm = 0;
  for (const v of visitsOf(stints.filter((s) => filter(s)))) {
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
    if (last.ended_at != null && ['complete', 'pass', 'submit'].includes(last.end_reason)) {
      yellowEnded++;
      if (!cs.some((c) => c.member_id !== last.member_id)) falseAlarm++;
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

  const reviewVisits = visitsOf(stints.filter((s) => s.step === 'review' && s.ended_at != null && filter(s)));
  const reviewAvg = reviewVisits.length
    ? reviewVisits.reduce((sum, v) => sum + v.stints.reduce((x, s) => x + (hoursMap.get(s.id)?.held || 0), 0), 0) / reviewVisits.length
    : null;

  const missed = optimizations.filter((o) => (o.passed_at ?? now) > o.deadline && (o.passed_at != null || now > o.deadline)).length;

  return {
    stuck_dwell_h: dwellN ? round1(dwellSum / dwellN) : null,
    stuck_n: dwellN,
    false_alarm_rate: yellowEnded ? Math.round((falseAlarm / yellowEnded) * 100) : null,
    false_alarm_n: yellowEnded,
    review_first_pass: firstPass('review', (s) => s.product_id),
    final_first_pass: firstPass('final_review', (s) => s.optimization_id),
    review_avg_h: reviewAvg == null ? null : round1(reviewAvg),
    returns_total: returnEvents(stints.filter(filter)).length,
    missed_deadlines: missed,
  };
}
