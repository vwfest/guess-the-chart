// Nickname-mode test (default flags): wallet/email off, nickname+emoji only, secret-token identity, filter, abuse limits,
// legacy email/wallet profiles keep working, admin cleanup. Plus the browser flow + screenshots.
const { request } = require('playwright');
const { spawn } = require('child_process'); const http = require('http'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const sol = require('../lib/solana'); const nickUi = require('./nick-ui.cjs');
const PORT = 3196, RPC_PORT = 3195, BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rpc = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 500 } } } } } }] } })); }); });
const wallet = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { pub: sol.b58encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)), sign: m => crypto.sign(null, Buffer.from(m), privateKey).toString('base64') }; };
async function api(ctx, method, url, body, hdrs = {}) {
  let csrf = ctx._csrf; if (!csrf && method !== 'GET') { csrf = (await (await ctx.get(BASE + '/api/csrf')).json()).token; ctx._csrf = csrf; }
  const r = await ctx.fetch(BASE + url, { method, data: body, headers: method === 'GET' ? hdrs : { 'x-csrf-token': csrf, 'content-type': 'application/json', ...hdrs } });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status(), j };
}
const ADMIN = 'test-admin-secret-0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-nick-'));
let slog = '';
async function boot(extra) {
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, GTC_TEST: '1', PGLITE_DIR: dir, SOLANA_RPC: `http://127.0.0.1:${RPC_PORT}`, PRICE_FIXED: '150', ADMIN_SECRET: ADMIN, DATABASE_URL: '', AUTH_EMAIL: '', AUTH_WALLET: '', AUTH_NICKNAME: '', REQUIRE_HOLDING: '', ...extra } });
  srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(300); }
  return srv;
}
const stop = async s => { s.kill(); await sleep(900); };
(async () => {
  rpc.listen(RPC_PORT);
  let legacyState;
  try {
    console.log('— phase A: old server with email+wallet on creates a legacy profile + guess');
    let srv = await boot({ AUTH_EMAIL: 'true', AUTH_WALLET: 'true', AUTH_NICKNAME: 'false', SIGNUP_LIMIT: '50' });
    const leg = await request.newContext(); const w = wallet();
    let r = await api(leg, 'POST', '/api/signup', { email: 'legacy@example.com', password: 'correct-horse-9', name: 'OldTimer', emoji: '👑' }); ok(r.s === 200, 'legacy signup');
    leg._csrf = null; r = await api(leg, 'POST', '/api/wallet/nonce'); r = await api(leg, 'POST', '/api/wallet/link', { publicKey: w.pub, signature: w.sign(r.j.message) }); ok(r.s === 200, 'legacy wallet linked');
    r = await api(leg, 'POST', '/api/guess', { price: '149.00' }); ok(r.s === 200, 'legacy guess placed');
    legacyState = await leg.storageState(); await leg.dispose(); await stop(srv);

    console.log('— phase B: default flags (nickname only)');
    srv = await boot({});
    const anon = await request.newContext();
    const st = (await (await anon.get(BASE + '/api/state')).json());
    ok(st.config.authNickname === true && st.config.authWallet === false && st.config.authEmail === false, 'config: nickname on, wallet off, email off by default');
    ok(st.config.requireHolding === false, 'holding check off while wallet is disabled');
    for (const [u, b] of [['/api/signup', { email: 'a@b.co', password: 'abcdefghij1', name: 'Newbie', emoji: '🔥' }], ['/api/login', { email: 'legacy@example.com', password: 'correct-horse-9' }], ['/api/wallet/nonce', {}], ['/api/wallet/link', {}], ['/api/wallet/check', {}]]) {
      r = await api(anon, 'POST', u, b); ok(r.s === 403 && r.j.code === 'auth_disabled', u + ' is disabled (403)');
    }
    console.log('— legacy profile keeps working');
    const legCtx = await request.newContext({ storageState: legacyState });
    const ls = await (await legCtx.get(BASE + '/api/state')).json();
    ok(ls.me && ls.me.name === 'OldTimer' && ls.me.kind === 'email' && ls.myGuess && ls.myGuess.guess === 149, 'existing session still signed in with its guess');
    let lb = await (await anon.get(BASE + '/api/leaderboard')).json(); ok(lb.entries.some(e => e.name === 'OldTimer' && e.emoji === '👑'), 'legacy guess still on the leaderboard');
    r = await api(legCtx, 'POST', '/api/guess', { price: '150' }); ok(r.s === 409 && r.j.code === 'dup', 'legacy player still limited to one guess');
    r = await api(legCtx, 'POST', '/api/nick/key'); ok(r.s === 200 && r.j.token.length >= 32, 'legacy player can get a recovery key to keep their identity');
    const legKey = r.j.token;
    const fresh = await request.newContext(); r = await api(fresh, 'POST', '/api/nick/resume', { token: legKey }); ok(r.s === 200 && r.j.me.name === 'OldTimer', 'recovery key restores the legacy profile on a new device');
    console.log('— nickname API');
    const pl = async (name, emoji = '🔥') => { const c = await request.newContext(); const x = await api(c, 'POST', '/api/nick/join', { name, emoji }); return { c, ...x }; };
    r = await api(anon, 'POST', '/api/guess', { price: '100' }); ok(r.s === 401, 'guess needs a nickname first');
    const bads = ['f.u.c.k', 'N1gger', 'admin', 'VWFest', 'ab', 'x'.repeat(17), 'has space', '<b>x</b>', '12345'];
    for (const b of bads) { const x = await pl(b); ok(x.s === 400, 'rejected nickname: ' + JSON.stringify(b)); }
    let x = await pl('Bus_Fan', 'zz'); ok(x.s === 400 && x.j.field === 'emoji', 'emoji must come from the grid');
    const p1 = await pl('Bus_Fan', '🚗'); ok(p1.s === 200 && p1.j.me.name === 'Bus_Fan' && p1.j.me.kind === 'nick' && p1.j.token.length >= 32, 'nickname + emoji creates a player and returns a secret token');
    x = await pl('bus_fan', '🔥'); ok(x.s === 409, 'nickname unique, case-insensitive');
    x = await pl('OldTimer', '🔥'); ok(x.s === 409, 'cannot take a legacy profile’s name');
    r = await api(p1.c, 'POST', '/api/guess', { price: '151.25' }); ok(r.s === 200, 'guess placed with just nickname+emoji (no wallet, no holding)');
    r = await api(p1.c, 'POST', '/api/guess', { price: '152' }); ok(r.s === 409 && r.j.code === 'dup', 'one guess per nickname per week');
    // a different browser can't impersonate: wrong / missing token
    const other = await request.newContext(); r = await api(other, 'POST', '/api/nick/resume', { token: 'x'.repeat(43) }); ok(r.s === 404, 'wrong token cannot resume');
    r = await api(other, 'POST', '/api/guess', { price: '1' }); ok(r.s === 401, 'no session, no guess');
    r = await api(other, 'POST', '/api/nick/resume', { token: p1.j.token }); ok(r.s === 200 && r.j.me.name === 'Bus_Fan', 'correct token resumes same nickname on another browser');
    r = await api(other, 'POST', '/api/guess', { price: '160' }); ok(r.s === 409 && r.j.code === 'dup', 'resumed player still can’t guess twice');
    r = await api(p1.c, 'POST', '/api/nick/key'); ok(r.s === 200, 'key rotation works'); r = await api(await request.newContext(), 'POST', '/api/nick/resume', { token: p1.j.token }); ok(r.s === 404, 'rotated-out key stops working');
    lb = await (await anon.get(BASE + '/api/leaderboard')).json(); ok(lb.entries.length === 2 && JSON.stringify(lb).indexOf(p1.j.token) < 0, 'leaderboard lists both, never exposes tokens');
    console.log('— admin cleanup');
    r = await anon.post(BASE + '/api/admin/remove-player', { data: { name: 'Bus_Fan' }, headers: { 'x-admin-secret': 'nope', 'content-type': 'application/json' } }); ok(r.status() === 401, 'remove-player needs the admin secret');
    r = await anon.post(BASE + '/api/admin/remove-player', { data: { name: 'Bus_Fan' }, headers: { 'x-admin-secret': ADMIN, 'content-type': 'application/json' } }); ok(r.status() === 200, 'admin can remove a test player + guess');
    lb = await (await anon.get(BASE + '/api/leaderboard')).json(); ok(lb.entries.length === 1, 'removed from leaderboard'); x = await pl('Bus_Fan', '🚗'); ok(x.s === 200, 'nickname free again after removal'); await anon.post(BASE + '/api/admin/remove-player', { data: { name: 'Bus_Fan' }, headers: { 'x-admin-secret': ADMIN, 'content-type': 'application/json' } });
    await stop(srv);

    console.log('— abuse limits (per-IP profile creation + guesses per round)');
    srv = await boot({ NICK_PER_HOUR: '5', NICK_PER_DAY: '9', GUESS_PER_IP: '3' });
    let made = 0, lim = null; const cs = [];
    for (let i = 0; i < 8; i++) { const y = await pl('Racer_' + i, '🏎️'); if (y.s === 200) { made++; cs.push(y.c); } else { lim = y; break; } }
    ok(made >= 2 && lim && lim.s === 429 && lim.j.code === 'ip_limit', `profile creation capped per IP (${made} created, then 429)`);
    let gOk = 0, gLim = null; for (const c of cs) { const g = await api(c, 'POST', '/api/guess', { price: String(140 + gOk) }); if (g.s === 200) gOk++; else { gLim = g; break; } }
    ok(gOk === 2 && gLim && gLim.s === 429 && gLim.j.code === 'ip_limit', 'guesses capped per IP per round (cap 3 incl. the legacy guess already from this IP → 2 more ok, then 429)');
    await stop(srv);

    console.log('— browser flow (fresh DB)');
    fs.rmSync(dir, { recursive: true, force: true });
    srv = await boot({});
    await nickUi({ base: BASE, name: 'Beetle_King', emoji: '🚗', guess: '151.25', shots: SHOTS, ok });
    await stop(srv);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e.stack || e); console.log(slog.slice(-2000)); }
  rpc.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
