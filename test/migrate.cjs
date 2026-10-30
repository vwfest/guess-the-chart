// Startup migration test: a round created under the old schedule (Sat 6 PM lock / Sun 6 PM settle) with a guess in it
// is moved onto Mon 9 PM lock / Fri 10 AM settle (PT), guesses kept, old FIRST_ROUND_* env ignored, and re-running is a no-op.
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { weekFor, TZ } = require('../lib/time');
const PORT = 3197, BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FAIL:', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-mig-'));
const OLD = { FIRST_ROUND_LOCK_AT: '2026-11-01T01:00:00Z', FIRST_ROUND_SETTLE_AT: '2026-11-02T02:00:00Z' };
async function run(fn) {
  const p = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, PGLITE_DIR: dir, PRICE_FIXED: '95', DATABASE_URL: '', NODE_ENV: '', GTC_TEST: '', ...OLD } });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(300); }
  try { await fn(log); } finally { p.kill(); await sleep(800); }
}
(async () => {
  await run(async () => {}); // creates schema + a round
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite(dir);
  const old = { ws: '2026-10-26T07:00:00Z', lock: '2026-11-01T01:00:00Z', settle: '2026-11-02T02:00:00Z' };
  await db.query(`UPDATE gtc.rounds SET sched=1, week_start=$1, lock_at=$2, settle_at=$3 WHERE id=1`, [old.ws, old.lock, old.settle]);
  await db.query(`INSERT INTO gtc.users (email,pass_hash,name,emoji) VALUES ('m@example.com','x','MigUser','🔥')`);
  await db.query(`INSERT INTO gtc.guesses (round_id,user_id,price) VALUES (1,1,'123.45')`);
  await db.close();
  console.log('— restart with old round + old env');
  await run(async log => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const w = weekFor(Date.now(), { lockDay: 1, lockHour: 21, lockMin: 0, settleDay: 5, settleHour: 10, settleMin: 0 });
    const fmt = ms => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false });
    ok(st.round.id === 1, 'same round id kept (no duplicate round created)');
    ok(st.round.lockAt === w.lock && st.round.settleAt === w.settle, 'lock/settle moved to new schedule');
    ok(/^Mon,? 21:00$/.test(fmt(st.round.lockAt)), 'lock is Monday 9:00 PM PT (' + fmt(st.round.lockAt) + ')');
    ok(/^Fri,? 10:00$/.test(fmt(st.round.settleAt)), 'settle is Friday 10:00 AM PT (' + fmt(st.round.settleAt) + ')');
    ok(st.count === 1, 'existing guess kept');
    const lb = await (await fetch(BASE + '/api/leaderboard')).json();
    ok(lb.entries.length === 1 && lb.entries[0].guess === 123.45, 'leaderboard still shows the guess');
    ok(/migrated round 1/.test(log), 'migration logged');
  });
  console.log('— restart again (idempotent)');
  await run(async log => {
    const st = await (await fetch(BASE + '/api/state')).json();
    ok(st.round.id === 1 && st.count === 1, 'no change on second start');
    ok(!/migrated round/.test(log), 'migration did not run again');
  });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
