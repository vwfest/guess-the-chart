// Production smoke test: runs the nickname browser flow against a live URL (BASE), then removes the test player + guess
// through the admin endpoint (needs ADMIN_SECRET). Usage: BASE=https://guess-the-chart.onrender.com ADMIN_SECRET=... node test/prod-check.cjs
const path = require('path'); const nickUi = require('./nick-ui.cjs');
const BASE = process.env.BASE || 'https://guess-the-chart.onrender.com', ADMIN = process.env.ADMIN_SECRET || '';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FAIL:', m); };
(async () => {
  const name = 'QA_' + Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, 'x');
  const st = await (await fetch(BASE + '/api/state')).json();
  ok(st.config.authNickname === true && st.config.authWallet === false && st.config.authEmail === false && st.config.requireHolding === false, 'live config: nickname on, wallet/email off, holding check off');
  try { await nickUi({ base: BASE, name, emoji: '🚗', guess: '151.25', shots: path.join(__dirname, '..', 'screenshots'), ok }); }
  catch (e) { fail++; console.log('  ✗ EXCEPTION', e.message); }
  if (ADMIN) {
    const r = await fetch(BASE + '/api/admin/remove-player', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN }, body: JSON.stringify({ name }) });
    ok(r.status === 200, 'test player + guess removed from production (' + r.status + ')');
    const lb = await (await fetch(BASE + '/api/leaderboard')).json();
    ok(!lb.entries.some(e => e.name === name), 'test guess no longer on the live leaderboard (' + lb.entries.length + ' real entries)');
  } else console.log('  ! ADMIN_SECRET not set: test player', name, 'NOT cleaned up');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
