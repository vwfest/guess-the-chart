// Minimal Solana helpers: base58, wallet-signature verification (ed25519), SPL balance via public RPC.
const crypto = require('crypto');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  if (typeof str !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(str)) throw new Error('bad base58');
  let n = 0n;
  for (const c of str) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  let bytes = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0; for (const c of str) { if (c === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}
function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifySignature(pubkeyB58, message, sigB64) {
  try {
    const pk = b58decode(pubkeyB58);
    if (pk.length !== 32) return false;
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch { return false; }
}
const isPubkey = s => { try { return b58decode(s).length === 32; } catch { return false; } };

const RPCS = () => (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean);
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('rpc unavailable');
}
const cache = new Map(); // wallet -> {t, v}
// Total UI-unit balance of `mint` held by `owner` (summed across token accounts).
async function tokenBalance(owner, mint) {
  const hit = cache.get(owner + mint);
  if (hit && Date.now() - hit.t < 30000) return hit.v;
  const res = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
  let total = 0;
  for (const a of res.value || []) total += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
  cache.set(owner + mint, { t: Date.now(), v: total });
  if (cache.size > 2000) cache.clear();
  return total;
}
module.exports = { b58decode, b58encode, verifySignature, isPubkey, tokenBalance };
