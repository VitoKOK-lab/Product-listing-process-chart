import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workHoursBetween, addWorkHours, localToEpoch } from '../src/worktime.js';
import {
  stintHours, stepTimes, teamAverages, compare, rushInfo, comparePriority, returnEvents, overviewRows, buildRadar, ranking, currentReturn, workOrder,
} from '../src/analytics.js';
import { statusCode, sheetKey, sheetRows, planSync, extractOgImage } from '../src/sheet.js';

const cfg = { days: [1, 2, 3, 4, 5], start: 9, end: 18, holidays: ['2026-10-09'], tz: 480 };
const settings = { rush_threshold_hours: 18 };
const at = (ymd, h, m = 0) => localToEpoch(ymd, h, cfg) + m * 60000;
// 2026-09-28 是週一
const MON = '2026-09-28', TUE = '2026-09-29', WED = '2026-09-30', FRI = '2026-10-02', SAT = '2026-10-03', NEXTMON = '2026-10-05';

test('上班時間：週末、下班、國定假日不計', () => {
  assert.equal(workHoursBetween(at(MON, 17), at(TUE, 15), cfg), 7);
  assert.equal(workHoursBetween(at(FRI, 17), at(NEXTMON, 10), cfg), 2);
  assert.equal(workHoursBetween(at(SAT, 10), at(SAT, 16), cfg), 0);
  assert.equal(workHoursBetween(at('2026-10-08', 9), at('2026-10-12', 9), cfg), 9);
  assert.equal(addWorkHours(at(FRI, 16), 4, cfg), at(NEXTMON, 11));
});

let sid = 0;
const st = (product_id, step, member_id, s, e, start_reason = 'advance', extra = {}) => ({
  id: ++sid, product_id, step, member_id, role: 'x', started_at: s, ended_at: e, start_reason, ...extra,
});

test('沒人認領的等待時間算在這一步，但另外記', () => {
  const stints = [
    st(1, 'cutout', null, at(MON, 9), at(MON, 13), 'advance'),
    st(1, 'cutout', 5, at(MON, 13), at(MON, 15), 'claim'),
  ];
  const t = stepTimes(stints, stintHours(stints, at(MON, 15), cfg)).get(1).cutout;
  assert.equal(t.held, 6);
  assert.equal(t.pool, 4);
  assert.equal(t.rounds, 1); // 認領不算新的一輪
});

test('團隊平均：用認領後的工作時間，只用走完這一步的商品，少於 3 件不比', () => {
  const stints = [];
  const products = [];
  for (let i = 1; i <= 3; i++) {
    stints.push(st(i, 'cutout', null, at(MON, 9), at(MON, 10), 'create')); // 空等 1h 不算
    stints.push(st(i, 'cutout', 1, at(MON, 10), at(MON, 10 + i), 'claim'));
    products.push({ id: i, step: 'listing' });
  }
  products.push({ id: 4, step: 'cutout' });
  stints.push(st(4, 'cutout', 1, at(MON, 9), null, 'claim'));
  const avgs = teamAverages(products, stepTimes(stints, stintHours(stints, at(MON, 18), cfg)));
  assert.equal(avgs.cutout.avg, 2); // 工作 (1+2+3)/3，進行中的第 4 件不算
  assert.equal(avgs.cutout.total_avg, 3); // 含空等
  assert.equal(avgs.cutout.pool_avg, 1);
  assert.equal(avgs.listing.avg, null);
});

test('跟平均比：1.5 倍偏慢、2 倍很慢、差不到半小時不算', () => {
  assert.equal(compare(3, 2).level, 'slow');
  assert.equal(compare(4, 2).level, 'very');
  assert.equal(compare(0.4, 0.1).level, 'ok');
  assert.equal(compare(5, null).diff, null);
});

test('插隊：截止 = 那天下班，剩 2 個上班日內是急件', () => {
  const p = { rush_date: WED, step: 'cutout' };
  assert.equal(rushInfo(p, at(MON, 9), cfg, settings).urgent, false); // 剩 27h
  assert.equal(rushInfo(p, at(TUE, 9), cfg, settings).urgent, true); // 剩 18h
  assert.equal(rushInfo(p, at('2026-10-01', 9), cfg, settings).overdue, true);
  assert.equal(rushInfo({ ...p, step: 'done', done_at: at(WED, 17) }, at(FRI, 9), cfg, settings).missed, false);
});

test('排序：插隊（依日期）> A > B > C > D > 其他', () => {
  const list = [
    { id: 1, status_code: 'D' }, { id: 2, status_code: '' }, { id: 3, status_code: 'A' },
    { id: 4, status_code: 'D', rush_date: '2026-10-05', step: 'open' }, { id: 5, status_code: 'B', rush_date: '2026-10-01', step: 'open' },
    { id: 6, status_code: 'C', rush_date: '2026-10-01', step: 'done' },
  ];
  assert.deepEqual(list.sort(comparePriority).map((p) => p.id), [5, 4, 3, 6, 1, 2]);
});

test('退件算在上一次做這一步的人身上', () => {
  const stints = [
    st(1, 'cutout', 7, at(MON, 9), at(MON, 10), 'claim'),
    st(1, 'listing', 8, at(MON, 10), at(MON, 11), 'claim'),
    st(1, 'cutout', 7, at(MON, 11), null, 'return', { note: '去背有白邊', by_id: 8 }),
  ];
  const ev = returnEvents(stints);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].member_id, ev[0].by_id, ev[0].note], [7, 8, '去背有白邊']);
  assert.equal(currentReturn(stints, stints[2]).note, '去背有白邊');
});

test('全覽：做圖和文案同時進行；進行中的步驟只在比平均慢時才算', () => {
  const stints = [];
  const products = [];
  for (let i = 1; i <= 3; i++) {
    stints.push(st(i, 'cutout', 2, at(MON, 9), at(MON, 10), 'claim'));
    stints.push(st(i, 'listing', 3, at(MON, 9), at(MON, 11), 'claim'));
    products.push({ id: i, step: 'optimizing', status_code: 'A' });
    stints.push(st(i, 'optimizing', 8, at(MON, 11), null));
  }
  products.push({ id: 9, step: 'cutout', status_code: 'B' });
  stints.push(st(9, 'cutout', null, at(MON, 9), at(MON, 10), 'create'));
  stints.push(st(9, 'cutout', 2, at(MON, 10), null, 'claim'));
  stints.push(st(9, 'listing', null, at(MON, 9), null, 'create'));
  const { rows } = overviewRows({ products, allProducts: products, stints, now: at(MON, 15), cfg, settings });
  const r9 = rows.find((r) => r.id === 9);
  assert.equal(r9.cells[0].state, 'current');
  assert.equal(r9.cells[1].state, 'current'); // 文案同時進行
  assert.equal(r9.cells[1].parallel, true);
  assert.equal(r9.cells[1].waiting, true);
  assert.equal(r9.cells[0].work, 5); // 認領後 5h，空等 1h 不算
  assert.equal(r9.cells[0].diff, 4);
  assert.equal(r9.cells[0].level, 'very');
  assert.equal(rows[0].status_code, 'A');
});

test('待辦：自己手上 + 同身分可認領；別人手上的不出現', () => {
  const products = [{ id: 1, name: 'a', step: 'cutout' }, { id: 2, name: 'b', step: 'cutout' }, { id: 3, name: 'c', step: 'listing' }];
  const stints = [
    { ...st(1, 'cutout', null, at(MON, 9), null), role: 'editor' },
    { ...st(2, 'cutout', 6, at(MON, 9), null, 'claim'), role: 'editor' },
    { ...st(3, 'listing', null, at(MON, 9), null), role: 'lister' },
  ];
  const r = buildRadar({ products, allProducts: products, stints, mentions: [], me: 5, meRoles: ['editor'], scope: 'me', now: at(MON, 12), cfg, settings });
  assert.deepEqual(r.items.map((i) => [i.product_id, i.claimable]), [[1, true]]);
});

test('個人成效：跟同一步的團隊平均比', () => {
  const stints = [
    st(1, 'cutout', 5, at(MON, 9), at(MON, 10)), st(2, 'cutout', 5, at(MON, 9), at(MON, 10)),
    st(3, 'cutout', 6, at(MON, 9), at(MON, 13)),
  ];
  const r = ranking({ stints, now: at(MON, 18), cfg });
  assert.equal(r.team_avg.cutout, 2);
  const m6 = r.rows.find((x) => x.member_id === 6);
  assert.deepEqual([m6.steps.cutout.avg, m6.steps.cutout.diff], [4, 2]);
  assert.equal(r.rows[0].member_id, 6);
});

test('試算表狀態對應與商品識別', () => {
  assert.equal(statusCode('投放中'), 'A');
  assert.equal(statusCode('優先製作'), 'B');
  assert.equal(statusCode('可投放'), 'C');
  assert.equal(statusCode('待製作'), 'D');
  assert.equal(statusCode('暫停'), '');
  assert.equal(sheetKey('x', 'https://Shop.TW/products/abc/?utm=1'), 'url:https://shop.tw/products/abc');
  assert.equal(sheetKey(' 耳環 ', ''), 'name:耳環');
});

test('試算表列：空名稱略過，同一商品保留最高優先', () => {
  const rows = sheetRows([
    { status: '待製作', name: '耳環', link: 'https://s.tw/p/1' },
    { status: '投放中', name: '耳環', link: 'https://s.tw/p/1?a=b' },
    { status: '投放中', name: '', link: '' },
    { status: '可投放', name: '週年慶活動', link: '' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, 'A');
  assert.equal(rows[1].link, '');
});

test('同步計畫：新增、更新、下架、恢復；手動開單不會被下架', () => {
  const existing = [
    { id: 1, sheet_key: 'name:a', name: 'a', link: '', sheet_status: '待製作', status_code: 'D', source: 'sheet', sheet_row: 0 },
    { id: 2, sheet_key: 'name:b', name: 'b', link: '', sheet_status: '待製作', status_code: 'D', source: 'sheet' },
    { id: 3, sheet_key: 'name:c', name: 'c', link: '', sheet_status: '', status_code: '', source: 'sheet', delisted_at: 1, sheet_row: 1 },
    { id: 4, sheet_key: null, name: 'm', source: 'manual' },
  ];
  const rows = sheetRows([
    { status: '投放中', name: 'a', link: '' }, { status: '', name: 'c', link: '' }, { status: '待製作', name: 'n', link: '' },
  ]);
  const plan = planSync(existing, rows);
  assert.deepEqual(plan.inserts.map((r) => r.name), ['n']);
  assert.deepEqual(plan.updates.map((u) => u.id), [1]);
  assert.deepEqual(plan.delist, [2]);
  assert.deepEqual(plan.restore.map((r) => r.id), [3]);
});

test('讀首圖：og:image，屬性順序不同、相對網址也可以', () => {
  assert.equal(extractOgImage('<meta content="https://img.x/a.jpg?a=1&amp;b=2" property="og:image">', 'https://s.tw/p'), 'https://img.x/a.jpg?a=1&b=2');
  assert.equal(extractOgImage("<meta property='og:image' content='//cdn.x/b.png' />", 'https://s.tw/p'), 'https://cdn.x/b.png');
  assert.equal(extractOgImage('<meta name="twitter:image" content="/c.webp">', 'https://s.tw/p/1'), 'https://s.tw/c.webp');
  assert.equal(extractOgImage('<title>x</title>', 'https://s.tw'), null);
});

test('已停止／已更名失效：已有的下架，沒有的不建立', () => {
  assert.equal(statusCode('已停止'), 'X');
  assert.equal(statusCode('已更名失效'), 'X');
  const existing = [{ id: 1, sheet_key: 'url:https://s.tw/p/old', name: '舊名', link: 'https://s.tw/p/old', sheet_status: '投放中', status_code: 'A', source: 'sheet', sheet_row: 0 }];
  const rows = sheetRows([
    { status: '投放中', name: '新名', link: 'https://s.tw/p/new' },
    { status: '已更名失效', name: '舊名', link: 'https://s.tw/p/old' },
    { status: '已停止', name: '沒做過的', link: 'https://s.tw/p/x' },
  ]);
  const plan = planSync(existing, rows);
  assert.deepEqual(plan.inserts.map((r) => r.name), ['新名']);
  assert.deepEqual(plan.delist, [1]);
});

test('去背從試算表最下面往上做；其他依優先序、試算表由上往下', () => {
  const cut = [{ step: 'cutout', sheet_row: 3, started_at: 0 }, { step: 'cutout', sheet_row: 9, started_at: 0 }, { step: 'cutout', sheet_row: null, started_at: 0 }];
  assert.deepEqual(cut.sort(workOrder).map((x) => x.sheet_row), [9, 3, null]);
  const opt = [
    { step: 'optimizing', status_code: 'B', sheet_row: 1, started_at: 0 }, { step: 'optimizing', status_code: 'A', sheet_row: 5, started_at: 0 },
    { step: 'optimizing', status_code: 'A', sheet_row: 2, started_at: 0 },
  ];
  assert.deepEqual(opt.sort(workOrder).map((x) => x.sheet_row), [2, 5, 1]);
});

test('整批匯入的舊件不算團隊平均，也不判偏慢；待辦標出建議先做的那一件', () => {
  const products = [];
  const stints = [];
  for (let i = 1; i <= 4; i++) {
    products.push({ id: i, name: `p${i}`, step: 'optimizing', status_code: i === 3 ? 'A' : 'C', sheet_row: i });
    stints.push({ ...st(i, 'optimizing', 8, at(MON, 9), null, 'import'), role: 'designer' });
  }
  const r = buildRadar({ products, allProducts: products, stints, mentions: [], me: 8, meRoles: ['designer'], scope: 'me', now: at(WED, 9), cfg, settings });
  assert.equal(r.items[0].product_id, 3);
  assert.equal(r.items[0].suggest, true);
  assert.ok(r.items.every((i) => i.level === 'ok'));
  const t = stepTimes(stints, stintHours(stints, at(WED, 9), cfg));
  assert.equal(teamAverages(products.map((p) => ({ ...p, step: 'mkt_check' })), t).optimizing.n, 0);
});

test('手動新增的商品：Excel 出現同一個網址就視為同一件，改用 Excel 的狀態；沒出現前不會下架', () => {
  const existing = [{ id: 7, sheet_key: sheetKey('手動耳環', 'https://s.tw/p/m'), name: '手動耳環', link: 'https://s.tw/p/m', source: 'manual' }];
  let plan = planSync(existing, sheetRows([{ status: '投放中', name: '別的', link: 'https://s.tw/p/x' }]));
  assert.deepEqual(plan.delist, []);
  plan = planSync(existing, sheetRows([{ status: '優先製作', name: '手動耳環', link: 'https://s.tw/p/m?utm=ad' }]));
  assert.deepEqual(plan.inserts, []);
  assert.equal(plan.updates[0].id, 7);
  assert.equal(plan.updates[0].row.code, 'B');
});

test('換過網址以系統為主：Excel 還是舊網址也對得上，不重複建、不下架，名稱網址不被蓋掉', () => {
  const existing = [{ id: 5, sheet_key: sheetKey('新名', 'https://s.tw/p/new'), name: '新名', link: 'https://s.tw/p/new', source: 'sheet', status_code: 'A', sheet_status: '投放中', sheet_row: 0 }];
  const aliases = [{ key: sheetKey('舊名', 'https://s.tw/p/old'), product_id: 5 }];
  let plan = planSync(existing, sheetRows([{ status: '優先製作', name: '舊名', link: 'https://s.tw/p/old' }]), aliases);
  assert.deepEqual([plan.inserts.length, plan.delist.length, plan.updates.length], [0, 0, 0]);
  assert.equal(plan.stale[0].id, 5);
  assert.equal(plan.stale[0].row.code, 'B');
  // Excel 同時有新舊兩列：以新網址那列為準
  plan = planSync(existing, sheetRows([
    { status: '已更名失效', name: '舊名', link: 'https://s.tw/p/old' }, { status: '投放中', name: '新名', link: 'https://s.tw/p/new' },
  ]), aliases);
  assert.deepEqual([plan.inserts.length, plan.delist.length, plan.stale.length], [0, 0, 0]);
});
