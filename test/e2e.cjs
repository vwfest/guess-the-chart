// End-to-end test: signup, emoji, wallet link (mock Phantom + mock Solana RPC), guess, live updates, lock, settle, re-rank, archive, profile, security.
const { chromium, request } = require('playwright');
const { spawn } = require('child_process');
const http = require('http'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const sol = require('../lib/solana');
const PORT = 3199, RPC_PORT = 3198, BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
const shotFull = async (pg, f) => { await pg.addStyleTag({ content: '.top{position:static!important}' }); await pg.screenshot({ path: SHOTS + '/' + f, fullPage: true }); };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const balances = new Map();
const rpc = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const j = JSON.parse(b); const owner = j.params[0]; const amt = balances.get(owner) || 0;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: amt ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: amt } } } } } }] : [] } }));
}); });
function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = sol.b58encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { pub, sign: msg => crypto.sign(null, Buffer.from(msg), privateKey).toString('base64') };
}
async function api(ctx, method, url, body, hdrs = {}) {
  let csrf = ctx._csrf; if (!csrf && method !== 'GET') { csrf = (await (await ctx.get(BASE + '/api/csrf')).json()).token; ctx._csrf = csrf; }
  const r = await ctx.fetch(BASE + url, { method, data: body, headers: method === 'GET' ? hdrs : { 'x-csrf-token': csrf, 'content-type': 'application/json', ...hdrs } });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status(), j };
}
const EM = ['🔥','💎','🚀','👑','🎯','🤑','⚡','🧊','🌊','🎰','🃏','🦁'];
async function makePlayer(i, bal) {
  const ctx = await request.newContext(); const w = newWallet(); balances.set(w.pub, bal);
  const name = 'Player' + i;
  let r = await api(ctx, 'POST', '/api/signup', { email: `p${i}@example.com`, password: 'correct-horse-9', name, emoji: EM[i % EM.length] });
  if (r.s !== 200) throw new Error('signup failed ' + JSON.stringify(r));
  ctx._csrf = null;
  r = await api(ctx, 'POST', '/api/wallet/nonce'); const lk = await api(ctx, 'POST', '/api/wallet/link', { publicKey: w.pub, signature: w.sign(r.j.message) });
  if (lk.s !== 200) throw new Error('link failed ' + JSON.stringify(lk));
  return { ctx, name, w };
}
const post = (ctx, u, b) => api(ctx, 'POST', u, b);

(async () => {
  rpc.listen(RPC_PORT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-'));
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, GTC_TEST: '1', PGLITE_DIR: dir, SOLANA_RPC: `http://127.0.0.1:${RPC_PORT}`, PRICE_FIXED: '150', ADMIN_SECRET: 'test-admin-secret-0123456789', SIGNUP_LIMIT: '200', DATABASE_URL: '' } });
  let slog = ''; srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(300); }
  const anon = await request.newContext();
  const browser = await chromium.launch();
  try {
    console.log('— basics & security');
    const st0 = await (await anon.get(BASE + '/api/state')).json();
    ok(st0.round.phase === 'open' && st0.price.usd === 150, 'state: round open, live price served');
    ok(st0.round.lockAt > st0.now + 3600e3, 'launch round has a real guessing window');
    const hd = (await anon.get(BASE + '/')).headers();
    ok(/script-src 'self' https:\/\/s3.tradingview.com/.test(hd['content-security-policy'] || ''), 'CSP header set');
    ok(hd['x-content-type-options'] === 'nosniff' && !hd['x-powered-by'], 'helmet headers, no x-powered-by');
    let r = await anon.post(BASE + '/api/signup', { data: { email: 'x@example.com', password: 'abcdefghij1', name: 'Hacker1', emoji: '🔥' } });
    ok(r.status() === 403, 'signup without CSRF token rejected (403)');
    r = await anon.post(BASE + '/api/login', { data: {}, headers: { origin: 'https://evil.example', 'x-csrf-token': 'a' } });
    ok(r.status() === 403, 'cross-origin POST rejected');
    r = await anon.post(BASE + '/api/admin/settle', { data: {} });
    ok(r.status() === 401, 'admin settle without secret → 401');
    r = await api(anon, 'POST', '/api/signup', { email: 'bad', password: 'short', name: '<img src=x onerror=1>', emoji: 'x' });
    ok(r.s === 400, 'signup validation rejects bad input');
    r = await api(anon, 'POST', '/api/guess', { price: '100' });
    ok(r.s === 401, 'guess requires login');

    console.log('— seed players');
    const ps = []; for (let i = 1; i <= 8; i++) ps.push(await makePlayer(i, 1000 * i));
    const poor = await makePlayer(20, 0);
    r = await post(poor.ctx, '/api/guess', { price: '151' });
    ok(r.s === 403 && r.j.code === 'not_holder', 'wallet without $209madness cannot guess (403 not_holder)');
    r = await post(ps[0].ctx, '/api/guess', { price: '0' }); ok(r.s === 400, 'guess price validated');
    r = await post(ps[0].ctx, '/api/guess', { price: '99999999' }); ok(r.s === 400, 'guess price upper bound');
    // duplicate wallet link
    const nn = await post(ps[1].ctx, '/api/wallet/nonce'); const dupL = await post(ps[1].ctx, '/api/wallet/link', { publicKey: ps[0].w.pub, signature: ps[0].w.sign(nn.j.message) });
    ok(dupL.s === 400 || dupL.s === 409, 'cannot link another player’s wallet (bad signature/duplicate)');
    const guesses = [[0, '138.50'], [1, '152.00'], [2, '149.75'], [3, '160.00'], [4, '145.10'], [5, '150.00']];
    for (const [i, g] of guesses) { r = await post(ps[i].ctx, '/api/guess', { price: g }); ok(r.s === 200, `${ps[i].name} guessed ${g}`); }
    r = await post(ps[0].ctx, '/api/guess', { price: '140' }); ok(r.s === 409 && r.j.code === 'dup', 'second guess blocked (no edits)');

    console.log('— UI: signup flow, emoji pick, wallet connect, guess, live update');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    const me = newWallet(); balances.set(me.pub, 5000);
    await page.exposeFunction('__sign', msg => me.sign(msg));
    await page.addInitScript(pub => {
      const prov = { isPhantom: true, connect: async () => ({ publicKey: { toString: () => pub } }), signMessage: async msg => { const b64 = await window.__sign(new TextDecoder().decode(msg)); const bin = atob(b64); return { signature: Uint8Array.from(bin, c => c.charCodeAt(0)) }; } };
      window.phantom = { solana: prov };
    }, me.pub);
    await page.goto(BASE + '/'); await page.waitForSelector('#lbList .row');
    ok((await page.textContent('#livePrice')).includes('150.00'), 'big live price rendered');
    ok((await page.textContent('h1')).replace(/\s+/g, ' ').includes('GUESS THE CHART'), 'hero title');
    ok((await page.textContent('.sub')).includes('Closest price to SOL wins $25. Every week.'), 'hero subtitle');
    ok(await page.locator('#lbList .row').count() === 6, 'leaderboard shows 6 guesses');
    const prices = await page.$$eval('#lbList .row .gs', els => els.map(e => parseFloat(e.textContent.replace(/[$,]/g, ''))));
    ok(prices.every((p, i) => i === 0 || p >= prices[i - 1]), 'open round sorted by price low→high');
    await page.click('#sortbar button[data-sort="time"]');
    const first = await page.$eval('#lbList .row .nm', e => e.textContent); ok(first.startsWith('Player1'), 'sort by time puts first submitter first');
    await page.click('#sortbar button[data-sort="price"]');
    await page.waitForTimeout(500);
    await shotFull(page, 'desktop-1-home-open.png');
    await page.click('#ctaGuess');
    await page.waitForSelector('#egrid');
    ok(await page.locator('#egrid label').count() >= 40, 'emoji grid has 40+ choices');
    await page.fill('#f-email', 'ui@example.com'); await page.fill('#f-pass', 'a-strong-pass-1'); await page.fill('#f-name', 'UIGambler');
    await page.click('#egrid label:has-text("👑")'); await page.waitForTimeout(200);
    await page.screenshot({ path: SHOTS + '/desktop-2-signup-emoji.png' });
    await page.click('#authSubmit'); await page.waitForSelector('#authbox .chip');
    ok((await page.textContent('#authbox .chip')).includes('👑') && (await page.textContent('#authbox .chip')).includes('UIGambler'), 'signed up: name + emoji chip');
    ok(await page.isDisabled('#ctaGuess'), 'guess disabled until wallet holding verified');
    await page.click('#linkWalletBtn'); await page.waitForSelector('#placeGuess',{timeout:8000}).catch(async()=>{console.log('TOAST:',await page.textContent('#toast'));throw new Error('wallet')});
    ok(true, 'Phantom (mock) signature verified, holder detected, guess box shown');
    await page.screenshot({ path: SHOTS + '/desktop-3-guess-ready.png' });
    await page.fill('#guessInput', '151.25'); await page.click('#placeGuess');
    ok((await page.textContent('#placeGuess')).includes('CONFIRM'), 'guess requires a confirm click');
    await page.click('#placeGuess'); await page.waitForSelector('#myGuessBig');
    ok((await page.textContent('#myGuessBig')).includes('151.25'), 'guess locked in');
    await page.waitForSelector('#lbList .row.me');
    ok(await page.locator('#lbList .row').count() === 7, 'own guess appears on the board');
    const live = await page.locator('#lbList .row').count();
    await post(ps[6].ctx, '/api/guess', { price: '155.55' });
    await page.waitForFunction(n => document.querySelectorAll('#lbList .row').length > n, live, { timeout: 8000 });
    ok(true, 'real-time: another player’s guess appeared without reload (SSE)');
    await shotFull(page, 'desktop-4-live-board.png');

    console.log('— lock');
    const sNow = await (await anon.get(BASE + '/api/state')).json(); const rnd = sNow.round;
    await api(anon, 'POST', '/api/test/advance', { ms: rnd.lockAt - sNow.now + 60000 });
    const st1 = await (await anon.get(BASE + '/api/state')).json();
    ok(st1.round.phase === 'locked', 'round locked after lock time (countdown phase)');
    r = await post(ps[7].ctx, '/api/guess', { price: '150' }); ok(r.s === 409 && r.j.code === 'locked', 'guess after lock rejected');
    await page.reload(); await page.waitForSelector('#lockedMsg');
    ok((await page.textContent('#lockedMsg')).includes('locked'), 'UI shows guesses locked');
    await page.screenshot({ path: SHOTS + '/desktop-5-locked.png' });

    console.log('— settle + re-rank');
    await api(anon, 'POST', '/api/test/advance', { ms: rnd.settleAt - st1.now + 60000 });
    await api(anon, 'POST', '/api/test/price', { price: 151.2 });
    await api(anon, 'POST', '/api/test/tick', {});
    const lb = await (await anon.get(BASE + '/api/leaderboard')).json();
    ok(lb.round.phase === 'settled' && lb.round.finalPrice === 151.2, 'round settled at final price 151.20');
    // diffs: 151.25→0.05 wins; 152.00→0.8; 150→1.2; 149.75→1.45
    ok(lb.entries[0].name === 'UIGambler' && lb.entries[0].rank === 1 && Math.abs(lb.entries[0].diff - 0.05) < 1e-9, 'closest guess ranked #1 (UIGambler, ±$0.05)');
    ok(lb.entries.every((e, i) => i === 0 || e.diff >= lb.entries[i - 1].diff), 'leaderboard re-ranked by closeness');
    ok(lb.winner && lb.winner.name === 'UIGambler', 'winner recorded');
    await page.reload(); await page.waitForSelector('#winnerCard');
    ok((await page.textContent('#winnerCard')).includes('$25 SOL WINNER') && (await page.textContent('#winnerCard')).includes('UIGambler'), 'big winner display with $25 SOL WINNER badge');
    ok((await page.textContent('#lbList .row.top1')).includes('WINNER'), '#1 row has glowing Winner badge');
    await page.waitForTimeout(500);
    await shotFull(page, 'desktop-6-winner.png');

    console.log('— profile & archive');
    await page.goto(BASE + '/#/profile'); await page.waitForSelector('#histTable');
    ok((await page.textContent('#profName')) === 'UIGambler' && (await page.textContent('#profEmoji')) === '👑', 'profile shows name + emoji');
    ok((await page.textContent('#statGuesses')) === '1', 'profile total guesses');
    ok((await page.textContent('#histTable')).includes('1st'), 'profile placement history shows 1st');
    await page.screenshot({ path: SHOTS + '/desktop-7-profile.png' });
    await page.goto(BASE + '/#/archive'); await page.waitForSelector('#archiveList .arow');
    ok((await page.textContent('#archiveList')).includes('UIGambler'), 'archive lists past round + winner');
    await page.screenshot({ path: SHOTS + '/desktop-8-archive.png' });
    await page.click('#archiveList .arow'); await page.waitForSelector('#view-archive .row');
    ok(await page.locator('#view-archive .row').count() >= 8, 'archived round shows full leaderboard');

    console.log('— next round + admin settle + tie-break');
    await api(anon, 'POST', '/api/test/advance', { ms: 3 * 864e5 }); // → next week (Mon after)
    let s2 = await (await anon.get(BASE + '/api/state')).json();
    for (let k = 0; k < 8 && s2.round.id === rnd.id; k++) { await api(anon, 'POST', '/api/test/advance', { ms: 864e5 }); s2 = await (await anon.get(BASE + '/api/state')).json(); }
    ok(s2.round.id !== rnd.id && s2.round.phase === 'open', 'new weekly round opened automatically');
    r = await post(ps[0].ctx, '/api/guess', { price: '100.00' }); ok(r.s === 200, 'players can guess again in the new round');
    await post(ps[1].ctx, '/api/guess', { price: '102.00' }); await post(ps[2].ctx, '/api/guess', { price: '98.00' });
    const ad = await anon.post(BASE + '/api/admin/settle', { data: { price: 100 }, headers: { 'x-admin-secret': 'wrong', 'content-type': 'application/json' } }); ok(ad.status() === 401, 'admin wrong secret rejected');
    const ad2 = await anon.post(BASE + '/api/admin/settle', { data: { price: 100 }, headers: { 'x-admin-secret': 'test-admin-secret-0123456789', 'content-type': 'application/json' } });
    const aj = await ad2.json(); ok(ad2.status() === 200 && aj.settled, 'admin manual settle with secret works');
    const lb2 = await (await anon.get(BASE + `/api/leaderboard?round=${s2.round.id}`)).json();
    ok(lb2.entries[0].name === ps[0].name && lb2.entries[1].diff === 2 && lb2.entries[2].diff === 2 && lb2.entries[1].at <= lb2.entries[2].at, 'exact hit wins; equal distance broken by earlier guess');
    const again = await anon.post(BASE + '/api/admin/settle', { data: { roundId: s2.round.id, price: 90 }, headers: { 'x-admin-secret': 'test-admin-secret-0123456789', 'content-type': 'application/json' } });
    ok((await again.json()).already === true, 'settle is idempotent');

    console.log('— XSS escaping');
    const x = await makePlayer(30, 10); // names are validated, so test display via stored text path is not injectable
    const bad = await api(anon, 'POST', '/api/signup', { email: 'xss@example.com', password: 'abcdefghij1', name: '"><script>1</script>', emoji: '🔥' });
    ok(bad.s === 400, 'script-like display name rejected');

    console.log('— mobile screenshots');
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mp = await m.newPage(); await mp.goto(BASE + '/'); await mp.waitForSelector('#lbList .row'); await mp.waitForTimeout(600);
    await mp.screenshot({ path: SHOTS + '/mobile-1-home.png' });
    await shotFull(mp, 'mobile-2-full.png');
    await mp.click('#signupBtn'); await mp.waitForSelector('#egrid'); await mp.click('#egrid label:has-text("🚀")'); await mp.waitForTimeout(200);
    await mp.screenshot({ path: SHOTS + '/mobile-3-signup.png' });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    ok(!overflow, 'no horizontal overflow on mobile');
    ok(errs.length === 0, 'no uncaught page errors ' + errs.join('|'));
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e.stack || e); console.log(slog.slice(-1500)); }
  await browser.close(); srv.kill(); rpc.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
