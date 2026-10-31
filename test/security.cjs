// Security regression tests (local server only, PGlite). Usage: node test/security.cjs
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const PORT = 3194, B = `http://127.0.0.1:${PORT}`, ADMIN = 'test-admin-secret-0123456789';
let fails = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-sec-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, GTC_TEST: '1', PGLITE_DIR: dir, ADMIN_SECRET: ADMIN, RENDER: 'true', PRICE_FIXED: '150' }, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
srv.stderr.on('data', d => process.stderr.write(d));
const wait = async () => { for (let i = 0; i < 150; i++) { try { if ((await fetch(B + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('server did not start'); };
// minimal client with a cookie jar
const client = (ip, extra = {}) => {
  const jar = {}; let csrf = null;
  const hdr = () => ({ 'content-type': 'application/json', 'cf-connecting-ip': ip, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extra });
  const eat = r => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const call = async (m, p, body, h = {}) => { const r = await fetch(B + p, { method: m, headers: { ...hdr(), ...h }, body: body === undefined ? undefined : JSON.stringify(body) }); eat(r); let b = null; try { b = await r.json(); } catch {} return { s: r.status, b, h: r.headers }; };
  return { call, init: async () => { csrf = (await call('GET', '/api/csrf')).b.token; return csrf; } };
};
const sse = (ip) => new Promise(res => { const rq = http.get(B + '/api/events', { headers: { 'cf-connecting-ip': ip } }, r => { res({ s: r.statusCode, close: () => rq.destroy() }); }); rq.on('error', () => res({ s: 0, close() {} })); });
(async () => {
  await wait();
  // --- per-IP limits key on the real client, not a spoofable X-Forwarded-For
  const a = client('198.51.100.7'); await a.init();
  let last, got429 = false;
  for (let i = 0; i < 20; i++) { last = await a.call('POST', '/api/nick/join', { name: 'Rider' + (100 + i), emoji: '🔥' }, { 'x-forwarded-for': `10.0.${i}.1, 203.0.113.9` }); if (last.s === 429) { got429 = true; break; } }
  ok(got429, 'new-nickname limit still applies when X-Forwarded-For is rotated');
  const b = client('198.51.100.8'); await b.init();
  const jb = await b.call('POST', '/api/nick/join', { name: 'FreshRider', emoji: '🔥' }); ok(jb.s === 200, 'a different client IP has its own allowance');
  // --- SSE slots cannot be monopolised by one address
  const conns = []; for (let i = 0; i < 8; i++) conns.push(await sse('198.51.100.30'));
  ok(conns.slice(0, 6).every(c => c.s === 200) && conns[6].s === 429, 'SSE: 7th concurrent stream from one IP refused (429)');
  const other = await sse('198.51.100.31'); ok(other.s === 200, 'SSE: other IP unaffected'); conns.forEach(c => c.close()); other.close();
  // --- admin
  const c = client('198.51.100.40'); await c.init();
  let r = await c.call('POST', '/api/admin/settle', {}); ok(r.s === 401, 'admin settle without secret -> 401');
  r = await c.call('POST', '/api/admin/settle', {}, { 'x-admin-secret': 'x'.repeat(28) }); ok(r.s === 401, 'admin settle with wrong secret -> 401');
  r = await c.call('POST', '/api/admin/remove-player', { name: 'x' }, { 'x-admin-secret': 'nope' }); ok(r.s === 401, 'admin remove-player wrong secret -> 401');
  // --- CSRF / origin / content-type
  const d = client('198.51.100.41'); await d.init();
  r = await d.call('POST', '/api/nick/join', { name: 'CsrfTest1', emoji: '🔥' }, { 'x-csrf-token': 'bad' }); ok(r.s === 403, 'wrong CSRF token -> 403');
  r = await d.call('POST', '/api/nick/join', { name: 'CsrfTest2', emoji: '🔥' }, { origin: 'https://evil.example' }); ok(r.s === 403, 'foreign Origin -> 403');
  r = await d.call('POST', '/api/logout', undefined, { 'content-type': 'text/plain' }); ok(r.s === 415 || r.s === 403, 'non-JSON content type refused');
  // --- names: XSS / SQL / reserved / emoji allowlist
  for (const n of ['<script>1</script>', "x'; DROP TABLE users;--", 'admin', 'Vwfest', 'a b c', 'ab', 'x'.repeat(40)]) { r = await d.call('POST', '/api/nick/join', { name: n, emoji: '🔥' }); ok(r.s === 400, 'nickname rejected: ' + n.slice(0, 24)); }
  r = await d.call('POST', '/api/nick/join', { name: 'GoodName1', emoji: '<img src=x>' }); ok(r.s === 400, 'emoji outside the allowlist rejected');
  r = await d.call('POST', '/api/nick/join', { name: { $ne: 1 }, emoji: '🔥' }); ok(r.s === 400, 'non-string name rejected');
  // --- guess validation + auth
  const e = client('198.51.100.42'); await e.init();
  r = await e.call('POST', '/api/guess', { price: '150' }); ok(r.s === 401, 'guess without a session -> 401');
  await e.call('POST', '/api/nick/join', { name: 'Guesser1', emoji: '🚀' });
  for (const p of ['-5', '1e3', '0', '10001', 'abc', '12.345', [1], { a: 1 }, null]) { r = await e.call('POST', '/api/guess', { price: p }); ok(r.s === 400, 'bad guess rejected: ' + JSON.stringify(p)); }
  r = await e.call('POST', '/api/guess', { price: '150.25' }); ok(r.s === 200, 'valid guess accepted');
  r = await e.call('POST', '/api/guess', { price: '151' }); ok(r.s === 409, 'second guess refused (one per round)');
  // --- recovery key is not guessable / malformed rejected
  r = await e.call('POST', '/api/nick/resume', { token: "' OR 1=1 --" }); ok(r.s === 400, 'malformed recovery key -> 400');
  r = await e.call('POST', '/api/nick/resume', { token: 'A'.repeat(43) }); ok(r.s === 404, 'unknown recovery key -> 404');
  // --- headers
  const h = await fetch(B + '/'); const csp = h.headers.get('content-security-policy') || '';
  ok(!/script-src[^;]*unsafe-inline/.test(csp) && /frame-ancestors 'none'/.test(csp), 'CSP: no inline scripts, no framing');
  ok(h.headers.get('x-content-type-options') === 'nosniff' && !h.headers.get('x-powered-by'), 'nosniff, no X-Powered-By');
  const st = await fetch(B + '/api/state'); const body = await st.text();
  ok(!/created_ip|ip_hash|secret_hash|pass_hash|"email"/i.test(body), '/api/state leaks no IP hashes, secrets or emails');
  const lb = await (await fetch(B + '/api/leaderboard')).text(); ok(!/created_ip|ip_hash|secret_hash|pass_hash/i.test(lb), '/api/leaderboard leaks no private fields');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); srv.kill(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
