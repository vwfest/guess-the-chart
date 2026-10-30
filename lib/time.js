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
// Rounds run from one settle moment to the next (default: Friday 10:00 AM PT -> next Friday 10:00 AM PT).
// start = most recent settle-day/hour at or before `ms`; lock = first lock-day/hour after start; settle = start + 1 week (wall-clock, DST-aware).
function weekFor(ms, cfg) {
  const p = parts(ms);
  const base = Date.UTC(p.y, p.mo - 1, p.d);
  const dayAt = (dayMs, hour, min) => { const x = new Date(dayMs); return ptToUtc(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), hour, min); };
  const dowOf = dayMs => (new Date(dayMs).getUTCDay());
  let start = null;
  for (let i = 0; i <= 7 && start === null; i++) {
    const d = base - i * 86400000;
    if (dowOf(d) !== cfg.settleDay) continue;
    const t = dayAt(d, cfg.settleHour, cfg.settleMin);
    if (t <= ms) start = { t, d };
  }
  if (start === null) { // settle day was 7+ days back (cannot happen), fall back to the day 7 back
    const d = base - 7 * 86400000; start = { t: dayAt(d, cfg.settleHour, cfg.settleMin), d };
  }
  let lock = null;
  for (let i = 0; i <= 7 && lock === null; i++) {
    const d = start.d + i * 86400000;
    if (dowOf(d) !== cfg.lockDay) continue;
    const t = dayAt(d, cfg.lockHour, cfg.lockMin);
    if (t > start.t) lock = t;
  }
  const settle = dayAt(start.d + 7 * 86400000, cfg.settleHour, cfg.settleMin);
  return { start: start.t, lock, settle, next: settle };
}
module.exports = { TZ, parts, ptToUtc, weekFor };
