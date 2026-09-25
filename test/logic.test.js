import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workHoursBetween, addWorkHours, localToEpoch } from '../src/worktime.js';
import { computeStintHours, buildRadar, diagnose, wasRush, metrics, optimizerBudget, returnEvents, overviewRows } from '../src/analytics.js';

const cfg = { days: [1, 2, 3, 4, 5], start: 9, end: 18, holidays: ['2026-10-09'], tz: 480 };
const settings = { rush_threshold_hours: 18, capacity_ratio: 1.5, rush_review_hours: 2, final_review_hours: 9 };
const at = (ymd, h, m = 0) => localToEpoch(ymd, h, cfg) + m * 60000;
// 2026-09-28 是週一
const MON = '2026-09-28', TUE = '2026-09-29', WED = '2026-09-30', FRI = '2026-10-02', SAT = '2026-10-03', NEXTMON = '2026-10-05';

test('規格例子：今天 17:00 指定、明天 15:00 截止 = 7 上班小時', () => {
  assert.equal(workHoursBetween(at(MON, 17), at(TUE, 15), cfg), 7);
});

test('週末與下班時間不計', () => {
  assert.equal(workHoursBetween(at(FRI, 17), at(NEXTMON, 10), cfg), 2);
  assert.equal(workHoursBetween(at(SAT, 10), at(SAT, 16), cfg), 0);
  assert.equal(workHoursBetween(at(MON, 20), at(TUE, 8), cfg), 0);
});

test('國定假日不計', () => {
  // 10/9 週五為假日
  assert.equal(workHoursBetween(at('2026-10-08', 9), at('2026-10-12', 9), cfg), 9);
});

test('addWorkHours 跨夜與跨週末', () => {
  assert.equal(addWorkHours(at(MON, 17), 3, cfg), at(TUE, 11));
  assert.equal(addWorkHours(at(FRI, 16), 4, cfg), at(NEXTMON, 11));
  assert.equal(addWorkHours(at(SAT, 12), 1, cfg), at(NEXTMON, 10));
});

test('一般步驟：超出預算的部分算給當時拿著的人（含改派）', () => {
  const stints = [
    { id: 1, product_id: 1, optimization_id: null, step: 'edit', member_id: 10, role: 'editor', started_at: at(MON, 9), ended_at: at(MON, 18), budget_hours: 12, start_reason: 'advance' },
    { id: 2, product_id: 1, optimization_id: null, step: 'edit', member_id: 11, role: 'editor', started_at: at(MON, 18), ended_at: at(TUE, 15), budget_hours: 12, start_reason: 'reassign' },
  ];
  const h = computeStintHours(stints, [], at(TUE, 15), cfg);
  assert.deepEqual([h.get(1).held, h.get(1).over], [9, 0]);
  assert.deepEqual([h.get(2).held, h.get(2).over], [6, 3]); // 累計 15h，預算 12h
});

test('優化者標準時間 = 指定到截止 − 審查時間；審查拖延不算優化者的', () => {
  // 規格例子：週一 17:00 指定、週二 15:00 截止 → 7h，急件審查 2h → 優化者 5h
  const budget = optimizerBudget(at(MON, 17), at(TUE, 15), cfg, settings);
  assert.equal(budget, 5);
  const opt = { id: 5, product_id: 1, deadline: at(TUE, 15), assigned_at: at(MON, 17), status: 'working' };
  const stints = [
    { id: 1, product_id: 1, optimization_id: 5, step: 'optimizing', member_id: 20, role: 'editor', started_at: at(MON, 17), ended_at: at(TUE, 12), budget_hours: budget, start_reason: 'assign' },
    // 審查 2h 標準，拖到週三 10:00 = 7h，超出 5h（算審查的人）
    { id: 2, product_id: 1, optimization_id: 5, step: 'final_review', member_id: 30, role: 'reviewer', started_at: at(TUE, 12), ended_at: at(WED, 10), budget_hours: 2, start_reason: 'submit', end_reason: 'return' },
    // 優化者重改 4h：累計 4 + 4 = 8h，超出自己的 5h 標準 3h
    { id: 3, product_id: 1, optimization_id: 5, step: 'optimizing', member_id: 20, role: 'editor', started_at: at(WED, 10), ended_at: at(WED, 14), budget_hours: budget, start_reason: 'return' },
  ];
  const h = computeStintHours(stints, [opt], at(WED, 14), cfg);
  assert.equal(h.get(1).over, 0);
  assert.equal(h.get(2).over, 5);
  assert.equal(h.get(3).over, 3);
});

test('被退件依原因算到做那部分的人（上架人員的文案錯也算）', () => {
  const stints = [
    { id: 1, product_id: 1, step: 'raw', member_id: 2, started_at: at(MON, 9), ended_at: at(MON, 10) },
    { id: 2, product_id: 1, step: 'listing', member_id: 8, started_at: at(MON, 10), ended_at: at(MON, 12) },
    { id: 3, product_id: 1, step: 'review', member_id: 11, started_at: at(MON, 12), ended_at: at(MON, 13), end_reason: 'return' },
    { id: 4, product_id: 1, step: 'raw', member_id: 2, started_at: at(MON, 13), ended_at: null, start_reason: 'return', reasons: '["photo","copy"]', by_id: 11 },
  ];
  const ev = returnEvents(stints);
  assert.deepEqual(ev.map((e) => [e.member_id, e.reasons]).sort(), [[2, ['photo']], [8, ['copy']]]);
});

test('全覽：只算自己拿到工作後的時間，已完成步驟計入領先／落後', () => {
  const now = at(TUE, 12);
  const products = [{ id: 1, name: 'A', batch_id: 1, step: 'review', picker_id: 2, lister_id: 8, reviewer_id: 11, updated_at: now }];
  const stints = [
    { id: 1, product_id: 1, step: 'raw', member_id: 2, started_at: at(MON, 9), ended_at: at(MON, 13), budget_hours: 9, start_reason: 'create' },
    { id: 2, product_id: 1, step: 'listing', member_id: 8, started_at: at(MON, 13), ended_at: at(TUE, 10), budget_hours: 9, start_reason: 'advance' },
    { id: 3, product_id: 1, step: 'review', member_id: 11, started_at: at(TUE, 10), ended_at: null, budget_hours: 9, start_reason: 'advance' },
  ];
  const hoursMap = computeStintHours(stints, [], now, cfg);
  const [row] = overviewRows({ products, stints, optimizations: [], hoursMap, now, cfg, settings });
  const cell = (st) => row.cells.find((c) => c.step === st);
  assert.equal(cell('raw').variance, 5); // 標準 9h，用了 4h → 領先 5h
  assert.equal(cell('listing').variance, 3); // 用了 6h（13–18 點 + 隔天 9–10 點）→ 領先 3h
  assert.equal(cell('review').variance, 0); // 進行中且未超時，不提前算領先
  assert.equal(row.variance, 8);
});

test('雷達排序：急件 → 被退回 → 紅 → 黃 → 等我處理', () => {
  const now = at(TUE, 10);
  const products = [1, 2, 3, 4, 5].map((id) => ({ id, name: 'P' + id, batch_id: 1, step: 'edit' }));
  const opt = { id: 9, product_id: 1, deadline: at(TUE, 17), status: 'working' };
  const stints = [
    { id: 1, product_id: 1, optimization_id: 9, step: 'optimizing', member_id: 7, role: 'editor', started_at: at(MON, 9), ended_at: null, budget_hours: null, start_reason: 'assign' },
    { id: 2, product_id: 2, optimization_id: null, step: 'edit', member_id: 7, role: 'editor', started_at: at(TUE, 9), ended_at: null, budget_hours: 27, start_reason: 'return', reasons: '["photo"]', note: '背景太暗' },
    { id: 3, product_id: 3, optimization_id: null, step: 'review', member_id: 7, role: 'reviewer', started_at: at('2026-09-24', 9), ended_at: null, budget_hours: 9, start_reason: 'advance' },
    { id: 4, product_id: 4, optimization_id: null, step: 'review', member_id: 7, role: 'reviewer', started_at: at(MON, 9), ended_at: null, budget_hours: 9, start_reason: 'advance' },
    { id: 5, product_id: 5, optimization_id: null, step: 'listing', member_id: 7, role: 'lister', started_at: at(TUE, 9), ended_at: null, budget_hours: 9, start_reason: 'advance' },
  ];
  const hoursMap = computeStintHours(stints, [opt], now, cfg);
  const r = buildRadar({ stints, optimizations: [opt], mentions: [], products, me: 7, scope: 'me', now, cfg, settings, hoursMap });
  assert.deepEqual(r.items.map((i) => [i.product_id, i.group]), [[1, 'rush'], [2, 'attention'], [3, 'red'], [4, 'yellow'], [5, 'mine']]);
});

test('產能不足 vs 個人速度', () => {
  const t = at(MON, 9);
  const mk = (id, member) => ({ id, product_id: id, member_id: member, role: 'editor', started_at: t, ended_at: null });
  const stints = [mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 1), mk(5, 2), mk(6, 3)];
  const roles = { editor: [1, 2, 3] };
  assert.equal(diagnose(stints[0], stints, roles, 1.5).kind, 'capacity'); // 4 件 vs 平均 2
  assert.equal(diagnose(stints[4], stints, roles, 1.5).kind, 'speed');
});

test('急件判定：距截止 ≤ 18 上班小時', () => {
  const opt = { deadline: at(WED, 17), passed_at: null, status: 'working' };
  assert.equal(wasRush(opt, at(MON, 9), cfg, settings), false); // 26h
  assert.equal(wasRush(opt, at(TUE, 9), cfg, settings), true); // 17h
});

test('誤報：變黃後沒人催，負責人自己完成', () => {
  const stints = [
    { id: 1, product_id: 1, optimization_id: null, step: 'listing', member_id: 5, role: 'lister', started_at: at(MON, 9), ended_at: at(TUE, 12), budget_hours: 9, start_reason: 'advance', end_reason: 'complete' },
    { id: 2, product_id: 2, optimization_id: null, step: 'listing', member_id: 5, role: 'lister', started_at: at(MON, 9), ended_at: at(TUE, 12), budget_hours: 9, start_reason: 'advance', end_reason: 'complete' },
  ];
  const comments = [{ product_id: 2, member_id: 99, created_at: at(TUE, 10) }];
  const hoursMap = computeStintHours(stints, [], at(TUE, 12), cfg);
  const m = metrics({ stints, optimizations: [], comments, undoCount: 0, hoursMap, now: at(TUE, 12), cfg, filter: () => true });
  assert.equal(m.false_alarm_rate, 50);
  assert.equal(m.stuck_n, 2);
  assert.equal(m.stuck_dwell_h, 2); // (3h + 1h) / 2
});
