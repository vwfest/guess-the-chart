# GUESS THE CHART

Weekly SOL/USD price-guessing game for **$209madness** holders. Closest price wins **$25 SOL**, every week. For fun, see rules.

Node 20 + Express 5 + Postgres (own schema `gtc`), vanilla JS front end, TradingView chart, SSE live leaderboard.

## Rules (in-app)
Hold $209madness in a linked Phantom wallet · one guess per week, no edits · guesses lock at the lock time · the final SOL/USD price is taken at settle time · closest wins, ties go to the earlier guess.

## Schedule (America/Los_Angeles, configurable)
Rounds run Monday 00:00 PT → next Monday. Defaults: **lock Thursday 6:00 PM PT**, **settle Sunday 6:00 PM PT** (final price = SOL/USD at that minute). A background job settles automatically; if the free host was asleep, it settles from the exact historical 1‑minute price at settle time.

| Env var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – | Postgres URL (omit locally → embedded PGlite) |
| `DB_SCHEMA` | `gtc` | Schema that holds every table (nothing else in the DB is touched) |
| `ADMIN_SECRET` | – | Enables `POST /api/admin/settle` (header `x-admin-secret`; body `{roundId?, price?}`) |
| `TOKEN_MINT` | `5671ysSG8RL8dU5pMy9KVG95GrGGFyfaLbvaVWF6pump` | $209madness SPL mint |
| `REQUIRE_HOLDING` | `true` | `false` turns the wallet/holding check off |
| `MIN_HOLD` | `1` | Minimum token balance (UI units) |
| `SOLANA_RPC` | mainnet-beta public | Comma-separated RPC URLs (tried in order) |
| `LOCK_DAY/HOUR/MIN`, `SETTLE_DAY/HOUR/MIN` | 4/18/0, 0/18/0 | Day 0=Sun…6=Sat, PT |
| `FIRST_ROUND_LOCK_AT`, `FIRST_ROUND_SETTLE_AT` | auto | ISO times for the very first (launch) round only |
| `PRIZE_TEXT` | `$25 SOL` | Prize label |
| `SIGNUP_LIMIT` | 8 | Sign-ups per IP per hour |

## Security
bcrypt passwords · server-side sessions in httpOnly SameSite cookies (`Secure` in prod) · CSRF double-submit token + Origin check · per-IP and per-user rate limits · strict validation · no `innerHTML` with data (textContent only) · Helmet + CSP · wallet ownership proven by Phantom message signature (ed25519) · one wallet per player · admin endpoint disabled unless `ADMIN_SECRET` set.

## Run / test
`npm install && npm start` (PGlite locally) · `npm test` runs a Playwright end-to-end suite (signup, emoji, wallet link, guess, live update, lock, settle, re-rank, archive, profile, security) with a mock Solana RPC and a controllable clock (`GTC_TEST=1`, never in production).
