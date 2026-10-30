// GUESS THE CHART — weekly SOL price guessing game for $209madness holders.
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./lib/db');
const price = require('./lib/price');
const sol = require('./lib/solana');
const { weekFor, TZ } = require('./lib/time');

const PROD = process.env.NODE_ENV === 'production';
const TEST = process.env.GTC_TEST === '1';
const int = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
const CFG = {
  lockDay: int(process.env.LOCK_DAY, 4), lockHour: int(process.env.LOCK_HOUR, 18), lockMin: int(process.env.LOCK_MIN, 0),         // Thu 6:00 PM PT
  settleDay: int(process.env.SETTLE_DAY, 0), settleHour: int(process.env.SETTLE_HOUR, 18), settleMin: int(process.env.SETTLE_MIN, 0), // Sun 6:00 PM PT
  mint: process.env.TOKEN_MINT || '5671ysSG8RL8dU5pMy9KVG95GrGGFyfaLbvaVWF6pump',
  requireHolding: process.env.REQUIRE_HOLDING !== 'false',
  minHold: int(process.env.MIN_HOLD, 1),
  prize: process.env.PRIZE_TEXT || '$25 SOL',
};
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const EMOJIS = ['🔥','💎','🚀','👑','🎯','🤑','⚡','🧊','🌊','🎰','🃏','🦁','🐺','🦅','🐉','🦈','🐻','🦍','🐸','🦄','🐯','🦊','🐙','🦂','🌵','🌙','☀️','⭐','💀','👽','🤖','😈','🥷','🧠','💰','🏆','🎲','♠️','♦️','🍀','🚗','🏎️','🌴','🍺','🎸','🎧','🧨','🌈'];
const EMOJI_SET = new Set(EMOJIS);

let clockOffset = 0;
const now = () => Date.now() + (TEST ? clockOffset : 0);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://s3.tradingview.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://*.tradingview.com', 'https://*.tradingview-widget.com', 'wss://*.tradingview.com'],
      frameSrc: ['https://*.tradingview.com', 'https://*.tradingview-widget.com'],
      objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(compression({ filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res) }));
app.use(express.json({ limit: '4kb' }));
app.use(cookieParser());

const lim = (windowMs, max, msg) => rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: msg || 'Too many requests, slow down.' } });
const userLim = (windowMs, max) => rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down.' }, keyGenerator: req => 'u' + (req.user ? req.user.id : 'anon') });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = n => crypto.randomBytes(n).toString('base64url');
const cookieOpts = (extra = {}) => ({ httpOnly: true, sameSite: 'lax', secure: PROD, path: '/', ...extra });
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/api', lim(60 * 1000, 240));

// ---------- Admin (secret header, no cookies involved) ----------
const adminLimiter = lim(60 * 1000, 10);
app.post('/api/admin/settle', adminLimiter, async (req, res) => {
  if (!ADMIN_SECRET) return res.status(404).json({ error: 'Not found' });
  if (!safeEq(req.get('x-admin-secret') || '', ADMIN_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  let round;
  if (b.roundId !== undefined) round = (await db.query(`SELECT * FROM ${db.S}.rounds WHERE id=$1`, [+b.roundId])).rows[0];
  else round = (await db.query(`SELECT * FROM ${db.S}.rounds WHERE status<>'settled' ORDER BY week_start LIMIT 1`)).rows[0];
  if (!round) return res.status(404).json({ error: 'No unsettled round' });
  let p = b.price !== undefined ? +b.price : null;
  if (p !== null && !(p > 0 && p < 1e6)) return res.status(400).json({ error: 'Bad price' });
  let source = 'admin';
  if (p === null) { const r = await priceForSettle(round); if (!r) return res.status(503).json({ error: 'No price available' }); p = r.usd; source = r.source; }
  const out = await settleRound(round.id, p, { late: now() > +new Date(round.settle_at) + 120000, source });
  res.json(out);
});

// ---------- CSRF (double-submit, httpOnly cookie + header) + Origin check ----------
app.get('/api/csrf', (req, res) => {
  let t = req.cookies.csrf;
  if (!t || !/^[\w-]{20,64}$/.test(t)) { t = rand(24); res.cookie('csrf', t, cookieOpts({ maxAge: 30 * 864e5 })); }
  res.set('Cache-Control', 'no-store').json({ token: t });
});
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) { try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' }); } catch { return res.status(403).json({ error: 'Bad origin' }); } }
  const c = req.cookies.csrf, h = req.get('x-csrf-token');
  if (!c || !h || !safeEq(c, h)) return res.status(403).json({ error: 'Security token missing. Refresh the page and try again.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});

// ---------- Sessions ----------
app.use('/api', async (req, res, next) => {
  req.user = null;
  const sid = req.cookies.sid;
  if (typeof sid === 'string' && /^[\w-]{20,64}$/.test(sid)) {
    const r = await db.query(`SELECT u.* FROM ${db.S}.sessions s JOIN ${db.S}.users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()`, [hash(sid)]);
    if (r.rows[0]) req.user = r.rows[0];
  }
  next();
});
async function startSession(res, userId) {
  const sid = rand(32);
  await db.query(`INSERT INTO ${db.S}.sessions (id,user_id,expires_at) VALUES ($1,$2,now()+interval '30 days')`, [hash(sid), userId]);
  res.cookie('sid', sid, cookieOpts({ maxAge: 30 * 864e5 }));
}
const needAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Log in first.' });

// ---------- Rounds ----------
async function ensureRound() {
  const w = weekFor(now(), CFG);
  const ex = (await db.query(`SELECT * FROM ${db.S}.rounds WHERE week_start=$1`, [new Date(w.start)])).rows[0];
  if (ex) return ex;
  let lock = w.lock, settle = w.settle;
  const first = !(await db.query(`SELECT 1 FROM ${db.S}.rounds LIMIT 1`)).rows[0];
  if (first) { // launch round: make sure players actually get a window to guess
    const fl = Date.parse(process.env.FIRST_ROUND_LOCK_AT || ''), fs = Date.parse(process.env.FIRST_ROUND_SETTLE_AT || '');
    if (fl && fs && fs > fl) { lock = fl; settle = fs; }
    else if (lock < now() + 12 * 3600e3) { lock = Math.ceil((now() + 24 * 3600e3) / 36e5) * 36e5; settle = lock + 24 * 3600e3; }
  }
  await db.query(`INSERT INTO ${db.S}.rounds (week_start,lock_at,settle_at) VALUES ($1,$2,$3) ON CONFLICT (week_start) DO NOTHING`, [new Date(w.start), new Date(lock), new Date(settle)]);
  return (await db.query(`SELECT * FROM ${db.S}.rounds WHERE week_start=$1`, [new Date(w.start)])).rows[0];
}
const phaseOf = r => r.status === 'settled' ? 'settled' : now() < +new Date(r.lock_at) ? 'open' : now() < +new Date(r.settle_at) ? 'locked' : 'settling';
const roundDto = r => r && ({
  id: +r.id, phase: phaseOf(r), lockAt: +new Date(r.lock_at), settleAt: +new Date(r.settle_at), weekStart: +new Date(r.week_start),
  finalPrice: r.final_price === null ? null : +r.final_price, settledLate: !!r.settled_late,
  nextOpenAt: weekFor(+new Date(r.week_start) + 3 * 864e5, CFG).next,
});
async function priceForSettle(round) {
  const at = +new Date(round.settle_at);
  if (now() - at > 90000 && !TEST) { const h = await price.historical(at); if (h) return h; }
  await price.refresh(true);
  if (price.state.usd && Date.now() - price.state.at < 120000) return { usd: price.state.usd, source: price.state.source };
  return null;
}
async function settleRound(roundId, finalPrice, { late = false, source = '' } = {}) {
  const fp = Math.round(finalPrice * 100) / 100;
  const out = await db.tx(async q => {
    const r = (await q(`SELECT * FROM ${db.S}.rounds WHERE id=$1 FOR UPDATE`, [roundId])).rows[0];
    if (!r) return { error: 'No such round' };
    if (r.status === 'settled') return { already: true, roundId: +r.id, finalPrice: +r.final_price };
    await q(`UPDATE ${db.S}.guesses g SET diff=abs(g.price-$2::numeric), rank=x.rn FROM (SELECT id, row_number() OVER (ORDER BY abs(price-$2::numeric), created_at, id) rn FROM ${db.S}.guesses WHERE round_id=$1) x WHERE g.id=x.id`, [roundId, fp]);
    const w = (await q(`SELECT id FROM ${db.S}.guesses WHERE round_id=$1 AND rank=1`, [roundId])).rows[0];
    await q(`UPDATE ${db.S}.rounds SET status='settled', final_price=$2, winner_guess_id=$3, settled_at=now(), settled_late=$4 WHERE id=$1`, [roundId, fp, w ? w.id : null, late]);
    return { settled: true, roundId: +roundId, finalPrice: fp, winnerGuessId: w ? +w.id : null, source };
  });
  if (out.settled) { console.log('settled round', roundId, fp, source, late ? '(late)' : ''); broadcast('settled', { roundId: +roundId }); }
  return out;
}
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    await ensureRound();
    const due = (await db.query(`SELECT * FROM ${db.S}.rounds WHERE status<>'settled' AND settle_at<=$1 ORDER BY week_start`, [new Date(now())])).rows;
    for (const r of due) {
      const p = await priceForSettle(r);
      if (!p) { console.warn('settle: no price yet for round', r.id); continue; }
      await settleRound(r.id, p.usd, { late: now() > +new Date(r.settle_at) + 120000, source: p.source });
    }
  } catch (e) { console.error('tick error', e.message); } finally { ticking = false; }
}

// ---------- Live events (SSE) ----------
const clients = new Set();
function broadcast(type, data) { const msg = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`; for (const c of clients) { try { c.write(msg); } catch {} } }
app.get('/api/events', (req, res) => {
  if (clients.size >= 800) return res.status(503).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.write('retry: 4000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => { for (const c of clients) { try { c.write(': hb\n\n'); } catch {} } }, 25000).unref();

// ---------- DTOs ----------
const meDto = async u => {
  if (!u) return null;
  const hist = (await db.query(`SELECT g.id, g.round_id, g.price, g.created_at, g.diff, g.rank, r.final_price, r.status, r.settle_at,
      (SELECT count(*) FROM ${db.S}.guesses x WHERE x.round_id=g.round_id) AS players
    FROM ${db.S}.guesses g JOIN ${db.S}.rounds r ON r.id=g.round_id WHERE g.user_id=$1 ORDER BY g.round_id DESC LIMIT 200`, [u.id])).rows;
  const settled = hist.filter(h => h.status === 'settled' && h.rank);
  return {
    id: +u.id, name: u.name, emoji: u.emoji, wallet: u.wallet || null,
    holder: u.wallet ? (u.wallet_balance !== null && +u.wallet_balance >= CFG.minHold) : false,
    walletBalance: u.wallet_balance === null ? null : +u.wallet_balance,
    totalGuesses: hist.length,
    wins: settled.filter(h => h.rank === 1).length,
    bestRank: settled.length ? Math.min(...settled.map(h => h.rank)) : null,
    history: hist.map(h => ({ roundId: +h.round_id, guess: +h.price, at: +new Date(h.created_at), rank: h.rank, diff: h.diff === null ? null : +h.diff, finalPrice: h.final_price === null ? null : +h.final_price, players: +h.players, settled: h.status === 'settled' })),
  };
};
async function leaderboard(roundId) {
  const rows = (await db.query(`SELECT g.id, g.price, g.created_at, g.diff, g.rank, u.name, u.emoji FROM ${db.S}.guesses g JOIN ${db.S}.users u ON u.id=g.user_id WHERE g.round_id=$1
    ORDER BY (g.rank IS NULL), g.rank, g.created_at, g.id LIMIT 2000`, [roundId])).rows;
  return rows.map((r, i) => ({ pos: i + 1, name: r.name, emoji: r.emoji, guess: +r.price, at: +new Date(r.created_at), rank: r.rank, diff: r.diff === null ? null : +r.diff }));
}
async function winnerOf(roundId) {
  const r = (await db.query(`SELECT g.price, g.diff, u.name, u.emoji FROM ${db.S}.guesses g JOIN ${db.S}.users u ON u.id=g.user_id WHERE g.round_id=$1 AND g.rank=1`, [roundId])).rows[0];
  return r ? { name: r.name, emoji: r.emoji, guess: +r.price, diff: +r.diff } : null;
}

// ---------- Public API ----------
app.get('/api/state', async (req, res) => {
  const round = await ensureRound();
  await price.refresh();
  const dto = roundDto(round);
  const count = +(await db.query(`SELECT count(*) c FROM ${db.S}.guesses WHERE round_id=$1`, [round.id])).rows[0].c;
  const winner = dto.phase === 'settled' ? await winnerOf(round.id) : null;
  let myGuess = null;
  if (req.user) { const g = (await db.query(`SELECT price, created_at FROM ${db.S}.guesses WHERE round_id=$1 AND user_id=$2`, [round.id, req.user.id])).rows[0]; if (g) myGuess = { guess: +g.price, at: +new Date(g.created_at) }; }
  res.set('Cache-Control', 'no-store').json({
    now: now(), tz: TZ, round: dto, count, winner, myGuess,
    price: { usd: price.state.usd, at: price.state.at, history: price.state.history.slice(-90) },
    me: req.user ? { id: +req.user.id, name: req.user.name, emoji: req.user.emoji, wallet: req.user.wallet || null, holder: !!req.user.wallet && req.user.wallet_balance !== null && +req.user.wallet_balance >= CFG.minHold } : null,
    config: { requireHolding: CFG.requireHolding, minHold: CFG.minHold, mint: CFG.mint, prize: CFG.prize, emojis: EMOJIS },
  });
});
app.get('/api/leaderboard', async (req, res) => {
  const round = req.query.round ? (await db.query(`SELECT * FROM ${db.S}.rounds WHERE id=$1`, [/^\d{1,12}$/.test(req.query.round) ? +req.query.round : 0])).rows[0] : await ensureRound();
  if (!round) return res.status(404).json({ error: 'No such round' });
  const dto = roundDto(round);
  res.set('Cache-Control', 'no-store').json({ round: dto, entries: await leaderboard(round.id), winner: dto.phase === 'settled' ? await winnerOf(round.id) : null });
});
app.get('/api/rounds', async (req, res) => {
  const rows = (await db.query(`SELECT r.id, r.week_start, r.settle_at, r.final_price, r.settled_late,
      (SELECT count(*) FROM ${db.S}.guesses g WHERE g.round_id=r.id) players,
      w.price wprice, w.diff wdiff, u.name wname, u.emoji wemoji
    FROM ${db.S}.rounds r LEFT JOIN ${db.S}.guesses w ON w.id=r.winner_guess_id LEFT JOIN ${db.S}.users u ON u.id=w.user_id
    WHERE r.status='settled' ORDER BY r.week_start DESC LIMIT 100`)).rows;
  res.set('Cache-Control', 'no-store').json({ rounds: rows.map(r => ({ id: +r.id, weekStart: +new Date(r.week_start), settleAt: +new Date(r.settle_at), finalPrice: +r.final_price, players: +r.players, late: !!r.settled_late, winner: r.wname ? { name: r.wname, emoji: r.wemoji, guess: +r.wprice, diff: +r.wdiff } : null })) });
});

// ---------- Accounts ----------
const NAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
app.post('/api/signup', lim(3600e3, int(process.env.SIGNUP_LIMIT, 8), 'Too many sign-ups from this network. Try later.'), async (req, res) => {
  const { email, password, name, emoji } = req.body || {};
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Enter a valid email.' });
  if (typeof password !== 'string' || password.length < 10 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Password must be 10–72 characters.' });
  if (typeof name !== 'string' || !NAME_RE.test(name)) return res.status(400).json({ error: 'Display name: 3–16 letters, numbers, _ . -' });
  if (typeof emoji !== 'string' || !EMOJI_SET.has(emoji)) return res.status(400).json({ error: 'Pick an emoji from the grid.' });
  const em = email.trim().toLowerCase();
  if ((await db.query(`SELECT 1 FROM ${db.S}.users WHERE lower(name)=lower($1)`, [name])).rows[0]) return res.status(409).json({ error: 'That display name is taken.', field: 'name' });
  if ((await db.query(`SELECT 1 FROM ${db.S}.users WHERE lower(email)=$1`, [em])).rows[0]) return res.status(409).json({ error: 'That email is already registered. Try logging in.', field: 'email' });
  const ph = await bcrypt.hash(password, 11);
  let u;
  try { u = (await db.query(`INSERT INTO ${db.S}.users (email,pass_hash,name,emoji) VALUES ($1,$2,$3,$4) RETURNING *`, [em, ph, name, emoji])).rows[0]; }
  catch (e) { return res.status(409).json({ error: 'That email or display name is already taken.' }); }
  await startSession(res, u.id);
  res.json({ me: await meDto(u) });
});
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' },
  keyGenerator: req => (req.ip || '') + '|' + String((req.body && req.body.email) || '').toLowerCase().slice(0, 100), validate: { keyGeneratorIpFallback: false } });
app.post('/api/login', lim(15 * 60e3, 60, 'Too many login attempts.'), loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 200) return res.status(400).json({ error: 'Invalid email or password.' });
  const u = (await db.query(`SELECT * FROM ${db.S}.users WHERE lower(email)=$1`, [email.trim().toLowerCase()])).rows[0];
  const ok = await bcrypt.compare(password, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'Invalid email or password.' });
  await startSession(res, u.id);
  res.json({ me: await meDto(u) });
});
app.post('/api/logout', async (req, res) => {
  const sid = req.cookies.sid;
  if (typeof sid === 'string') await db.query(`DELETE FROM ${db.S}.sessions WHERE id=$1`, [hash(sid)]);
  res.clearCookie('sid', cookieOpts());
  res.json({ ok: true });
});
app.get('/api/me', needAuth, async (req, res) => res.set('Cache-Control', 'no-store').json({ me: await meDto(req.user) }));

// ---------- Wallet (Phantom): sign a message to prove ownership, then check $209madness balance ----------
const walletMsg = (u, nonce) => `GUESS THE CHART wallet link\nAccount: ${u.name}\nNonce: ${nonce}`;
app.post('/api/wallet/nonce', needAuth, userLim(60e3, 10), async (req, res) => {
  const nonce = rand(16);
  await db.query(`INSERT INTO ${db.S}.wallet_nonces (user_id,nonce,expires_at) VALUES ($1,$2,now()+interval '10 minutes') ON CONFLICT (user_id) DO UPDATE SET nonce=$2, expires_at=now()+interval '10 minutes'`, [req.user.id, nonce]);
  res.json({ message: walletMsg(req.user, nonce) });
});
async function checkBalance(wallet) {
  try { return { bal: await sol.tokenBalance(wallet, CFG.mint) }; } catch (e) { console.warn('rpc fail', e.message); return { err: true }; }
}
app.post('/api/wallet/link', needAuth, userLim(60e3, 10), async (req, res) => {
  const { publicKey, signature } = req.body || {};
  if (typeof publicKey !== 'string' || typeof signature !== 'string' || !sol.isPubkey(publicKey) || signature.length > 200) return res.status(400).json({ error: 'Bad wallet data.' });
  const n = (await db.query(`SELECT nonce FROM ${db.S}.wallet_nonces WHERE user_id=$1 AND expires_at>now()`, [req.user.id])).rows[0];
  if (!n) return res.status(400).json({ error: 'Link request expired. Try again.' });
  if (!sol.verifySignature(publicKey, walletMsg(req.user, n.nonce), signature)) return res.status(400).json({ error: 'Signature did not verify.' });
  const other = (await db.query(`SELECT id FROM ${db.S}.users WHERE wallet=$1 AND id<>$2`, [publicKey, req.user.id])).rows[0];
  if (other) return res.status(409).json({ error: 'That wallet is already linked to another player.' });
  const b = await checkBalance(publicKey);
  try { await db.query(`UPDATE ${db.S}.users SET wallet=$2, wallet_balance=$3, wallet_checked_at=now() WHERE id=$1`, [req.user.id, publicKey, b.err ? null : b.bal]); }
  catch { return res.status(409).json({ error: 'That wallet is already linked to another player.' }); }
  await db.query(`DELETE FROM ${db.S}.wallet_nonces WHERE user_id=$1`, [req.user.id]);
  const u = (await db.query(`SELECT * FROM ${db.S}.users WHERE id=$1`, [req.user.id])).rows[0];
  res.json({ me: await meDto(u), rpcError: !!b.err });
});
app.post('/api/wallet/check', needAuth, userLim(60e3, 10), async (req, res) => {
  if (!req.user.wallet) return res.status(400).json({ error: 'No wallet linked.' });
  const b = await checkBalance(req.user.wallet);
  if (b.err) return res.status(503).json({ error: 'Could not reach Solana right now. Try again.' });
  await db.query(`UPDATE ${db.S}.users SET wallet_balance=$2, wallet_checked_at=now() WHERE id=$1`, [req.user.id, b.bal]);
  const u = (await db.query(`SELECT * FROM ${db.S}.users WHERE id=$1`, [req.user.id])).rows[0];
  res.json({ me: await meDto(u) });
});

// ---------- Guess ----------
app.post('/api/guess', needAuth, userLim(60e3, 20), async (req, res) => {
  const round = await ensureRound();
  if (phaseOf(round) !== 'open') return res.status(409).json({ error: 'Guessing is locked for this round.', code: 'locked' });
  const raw = req.body && req.body.price;
  const p = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(p) || !(+p >= 1 && +p <= 10000)) return res.status(400).json({ error: 'Enter a SOL price between $1 and $10,000 (up to 2 decimals).' });
  const dup = (await db.query(`SELECT 1 FROM ${db.S}.guesses WHERE round_id=$1 AND user_id=$2`, [round.id, req.user.id])).rows[0];
  if (dup) return res.status(409).json({ error: 'You already placed your guess this week. No changes.', code: 'dup' });
  let holding = null;
  if (CFG.requireHolding) {
    if (!req.user.wallet) return res.status(403).json({ error: 'Link your Phantom wallet that holds $209madness to play.', code: 'wallet_required' });
    const b = await checkBalance(req.user.wallet);
    if (b.err) return res.status(503).json({ error: 'Could not verify your $209madness balance right now. Try again.', code: 'rpc' });
    holding = b.bal;
    await db.query(`UPDATE ${db.S}.users SET wallet_balance=$2, wallet_checked_at=now() WHERE id=$1`, [req.user.id, b.bal]);
    if (b.bal < CFG.minHold) return res.status(403).json({ error: 'You must hold $209madness in your linked wallet to guess.', code: 'not_holder' });
  }
  if (phaseOf(round) !== 'open') return res.status(409).json({ error: 'Guessing is locked for this round.', code: 'locked' });
  try { await db.query(`INSERT INTO ${db.S}.guesses (round_id,user_id,price,holding,created_at) VALUES ($1,$2,$3,$4,$5)`, [round.id, req.user.id, p, holding, new Date(now())]); }
  catch { return res.status(409).json({ error: 'You already placed your guess this week. No changes.', code: 'dup' }); }
  broadcast('guess', { roundId: +round.id });
  res.json({ ok: true, guess: +p, me: await meDto(req.user) });
});

// ---------- Test-only hooks ----------
if (TEST) {
  app.post('/api/test/advance', (req, res) => { clockOffset += +req.body.ms || 0; res.json({ now: now() }); });
  app.post('/api/test/price', (req, res) => { process.env.PRICE_FIXED = String(req.body.price); price.setForTest(+req.body.price); res.json({ ok: true }); });
  app.post('/api/test/tick', async (req, res) => { await tick(); res.json({ ok: true }); });
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0, etag: true }));
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => {
  console.error('error', err.message);
  if (res.headersSent) return;
  if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ error: 'Bad request' });
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
(async () => {
  if (PROD && TEST) throw new Error('GTC_TEST must not be set in production');
  await db.init();
  await ensureRound();
  if (!process.env.PRICE_FIXED) await price.seedHistory();
  await price.refresh(true);
  setInterval(() => price.refresh(true).then(() => broadcast('price', { usd: price.state.usd, at: price.state.at })).catch(() => {}), 15000).unref();
  setInterval(tick, 20000).unref();
  tick();
  app.listen(PORT, () => console.log(`GUESS THE CHART on :${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
