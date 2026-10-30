// Pacific-time round scheduling without extra dependencies.
const TZ = 'America/Los_Angeles';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow: DOW[o.weekday] };
}
function offsetAt(ms) { const p = parts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
// Convert a wall-clock time in Pacific to a UTC epoch (ms).
function ptToUtc(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}
// Monday 00:00 PT of the week containing `ms`, plus lock/settle times from config.
function weekFor(ms, cfg) {
  const p = parts(ms);
  const sinceMon = (p.dow + 6) % 7;
  const base = Date.UTC(p.y, p.mo - 1, p.d - sinceMon); // midnight UTC of the Monday's calendar date
  const m = new Date(base);
  const at = (dayFromMon, hour, min) => { const x = new Date(base + dayFromMon * 86400000); return ptToUtc(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), hour, min); };
  const start = ptToUtc(m.getUTCFullYear(), m.getUTCMonth() + 1, m.getUTCDate(), 0, 0);
  return {
    start,
    lock: at((cfg.lockDay + 6) % 7, cfg.lockHour, cfg.lockMin),
    settle: at((cfg.settleDay + 6) % 7, cfg.settleHour, cfg.settleMin),
    next: ptToUtc(...(() => { const x = new Date(base + 7 * 86400000); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), 0, 0]; })()),
  };
}
module.exports = { TZ, parts, ptToUtc, weekFor };
