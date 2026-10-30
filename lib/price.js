// Server-cached SOL/USD price from public APIs (Coinbase, falling back to CoinGecko / Kraken).
const SOURCES = [
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot', pick: j => +j.data.amount },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', pick: j => +j.solana.usd },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD', pick: j => +Object.values(j.result)[0].c[0] },
];
const state = { usd: null, at: 0, source: null, history: [] };
let inflight = null;
const TTL = 10000;
async function fetchOnce() {
  if (process.env.PRICE_FIXED) return { usd: +process.env.PRICE_FIXED, source: 'fixed' };
  for (const s of SOURCES) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const v = s.pick(await r.json());
      if (Number.isFinite(v) && v > 0 && v < 1e6) return { usd: v, source: s.name };
    } catch {}
  }
  return null;
}
async function refresh(force) {
  if (!force && state.usd && Date.now() - state.at < TTL) return state;
  if (!inflight) inflight = fetchOnce().then(r => {
    if (r) {
      state.usd = r.usd; state.at = Date.now(); state.source = r.source;
      state.history.push([state.at, r.usd]);
      if (state.history.length > 180) state.history.shift();
    }
    return state;
  }).finally(() => { inflight = null; });
  return inflight;
}
// SOL/USD at a past moment (open of the 1-minute Coinbase candle containing it). Used when the free host was asleep at settle time.
async function historical(ms) {
  if (process.env.PRICE_FIXED) return { usd: +process.env.PRICE_FIXED, source: 'fixed' };
  try {
    const m = Math.floor(ms / 60000) * 60;
    const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
    const r = await fetch(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start=${iso(m)}&end=${iso(m + 59)}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const c = (await r.json()).find(x => x[0] === m);
    if (c && c[3] > 0) return { usd: +c[3], source: 'coinbase-candle' };
  } catch {}
  return null;
}
// Seed the little tick tape with the last few hours of 5-minute candles so it is never empty.
async function seedHistory() {
  try {
    const r = await fetch('https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=300', { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const rows = (await r.json()).slice(0, 60).reverse().map(c => [c[0] * 1000, +c[4]]);
    if (rows.length > 3 && !state.history.length) state.history.push(...rows);
  } catch {}
}
function setForTest(v) { state.usd = v; state.at = Date.now(); state.source = 'test'; state.history.push([state.at, v]); }
module.exports = { state, refresh, historical, seedHistory, setForTest, TTL };
