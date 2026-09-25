// 上班時間計算（純函式，前後端與測試共用邏輯）
// 所有時間為 epoch 毫秒；cfg = { days:[1..5], start:9, end:18, holidays:['YYYY-MM-DD'], tz:480 }

const H = 3600000;
const DAY = 86400000;
const MAX_DAYS = 3660;

function offset(cfg) { return (cfg.tz ?? 480) * 60000; }

function localDayStart(t, off) {
  return Math.floor((t + off) / DAY) * DAY - off;
}

function isWorkDay(dayStart, cfg, off) {
  const d = new Date(dayStart + off);
  const ymd = d.toISOString().slice(0, 10);
  return cfg.days.includes(d.getUTCDay()) && !(cfg.holidays || []).includes(ymd);
}

export function dayHours(cfg) {
  return cfg.end - cfg.start;
}

// a 到 b 之間的上班小時數
export function workHoursBetween(a, b, cfg) {
  if (!(b > a)) return 0;
  const off = offset(cfg);
  let total = 0;
  let ds = localDayStart(a, off);
  for (let i = 0; ds < b && i < MAX_DAYS; i++, ds += DAY) {
    if (!isWorkDay(ds, cfg, off)) continue;
    const s = Math.max(a, ds + cfg.start * H);
    const e = Math.min(b, ds + cfg.end * H);
    if (e > s) total += e - s;
  }
  return total / H;
}

// 從 a 起往後加 hours 個上班小時，回傳時間點
export function addWorkHours(a, hours, cfg) {
  if (!(hours > 0)) return a;
  const off = offset(cfg);
  let left = hours * H;
  let ds = localDayStart(a, off);
  for (let i = 0; i < MAX_DAYS; i++, ds += DAY) {
    if (!isWorkDay(ds, cfg, off)) continue;
    const s = Math.max(a, ds + cfg.start * H);
    const e = ds + cfg.end * H;
    if (e <= s) continue;
    if (e - s >= left) return s + left;
    left -= e - s;
  }
  return a + hours * H; // 設定異常時的保底
}

// 'YYYY-MM-DD' + 整點 → epoch 毫秒（依 cfg.tz）
export function localToEpoch(ymd, hour, cfg) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour) - offset(cfg);
}

export function localYmd(t, cfg) {
  return new Date(t + offset(cfg)).toISOString().slice(0, 10);
}
