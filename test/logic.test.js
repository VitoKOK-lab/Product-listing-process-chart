import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workHoursBetween, addWorkHours, localToEpoch } from '../src/worktime.js';
import { computeStintHours, buildRadar, diagnose, wasRush, metrics } from '../src/analytics.js';

const cfg = { days: [1, 2, 3, 4, 5], start: 9, end: 18, holidays: ['2026-10-09'], tz: 480 };
const settings = { rush_threshold_hours: 18, capacity_ratio: 1.5 };
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

test('優化者只看截止時間；審核超時延後優化者的有效截止', () => {
  const opt = { id: 5, product_id: 1, deadline: at(TUE, 15), assigned_at: at(MON, 17), status: 'working' };
  const stints = [
    // 優化者週一 17:00 → 週二 12:00 交件（截止前，正常）
    { id: 1, product_id: 1, optimization_id: 5, step: 'optimizing', member_id: 20, role: 'editor', started_at: at(MON, 17), ended_at: at(TUE, 12), budget_hours: null, start_reason: 'assign' },
    // 審核急件預算 2h，實際 12:00 → 周三 10:00 = 7h，超時 5h，退回
    { id: 2, product_id: 1, optimization_id: 5, step: 'opt_review', member_id: 30, role: 'reviewer', started_at: at(TUE, 12), ended_at: at(WED, 10), budget_hours: 2, start_reason: 'submit', end_reason: 'return' },
    // 優化者重改 周三 10:00 → 14:00。原截止已過，但有效截止 = 截止 + 5h = 周三 11:00 → 超出 3h
    { id: 3, product_id: 1, optimization_id: 5, step: 'optimizing', member_id: 20, role: 'editor', started_at: at(WED, 10), ended_at: at(WED, 14), budget_hours: null, start_reason: 'return' },
  ];
  const h = computeStintHours(stints, [opt], at(WED, 14), cfg);
  assert.equal(h.get(1).over, 0);
  assert.equal(h.get(2).over, 5);
  assert.equal(h.get(3).over, 3);
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
