# GUESS THE CHART

Weekly SOL/USD price-guessing game. Free to play: pick a unique nickname + emoji, no sign-up. Closest price wins **$25 SOL**, every week. For fun, see rules.

Node 20 + Express 5 + Postgres (own schema `gtc`), vanilla JS front end, TradingView chart, SSE live leaderboard.

## Rules (in-app)
Free to play (nickname + emoji) · the $25 SOL winner must show $209madness holdings and provide a Solana wallet to claim · one guess per week, no edits · guesses lock at the lock time · the final SOL/USD price is taken at settle time · closest wins, ties go to the earlier guess.

## Schedule (America/Los_Angeles, DST-aware, configurable)
A round opens the moment the previous one settles. Defaults: **lock Monday 9:00 PM PT**, **settle Friday 10:00 AM PT** (final price = SOL/USD at that minute), and the next round opens right then. A background job settles automatically; if the free host was asleep, it settles from the exact historical 1‑minute price at settle time. Startup migration (`sched` column) moves a round created under an older schedule onto the current one, keeping its guesses; `FIRST_ROUND_*` only apply while no rounds exist.

| Env var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – | Postgres URL (omit locally → embedded PGlite) |
| `DB_SCHEMA` | `gtc` | Schema that holds every table (nothing else in the DB is touched) |
| `ADMIN_SECRET` | – | Enables `POST /api/admin/settle` (header `x-admin-secret`; body `{roundId?, price?}`) |
| `TOKEN_MINT` | `5671ysSG8RL8dU5pMy9KVG95GrGGFyfaLbvaVWF6pump` | $209madness SPL mint |
| `AUTH_NICKNAME` | `true` | Nickname + emoji play (secret token kept in the browser). `false` hides it |
| `AUTH_WALLET` | `false` | **Phantom wallet link** (set `true` to re-enable) |
| `AUTH_EMAIL` | `false` | **Email/password sign-up + login** (set `true` to re-enable) |
| `REQUIRE_HOLDING` | on only when `AUTH_WALLET=true` | Holding check needs a wallet, so it is always off while `AUTH_WALLET` is off; with the wallet on, `false` turns it off |
| `NICK_PER_HOUR` / `NICK_PER_DAY` | 6 / 20 | New nicknames per IP |
| `GUESS_PER_IP` | 10 | Guesses per IP per round (0 = unlimited) |
| `MIN_HOLD` | `1` | Minimum token balance (UI units) |
| `SOLANA_RPC` | mainnet-beta public | Comma-separated RPC URLs (tried in order) |
| `LOCK_DAY/HOUR/MIN`, `SETTLE_DAY/HOUR/MIN` | 1/21/0, 5/10/0 | Day 0=Sun…6=Sat, PT (next round opens at the settle time) |
| `FIRST_ROUND_LOCK_AT`, `FIRST_ROUND_SETTLE_AT` | auto | ISO times for the very first (launch) round only |
| `PRIZE_TEXT` | `$25 SOL` | Prize label |
| `SIGNUP_LIMIT` | 8 | Email sign-ups per IP per hour (only when `AUTH_EMAIL=true`) |

## Nickname identity
`POST /api/nick/join {name, emoji}` → unique (case-insensitive), filtered nickname; the server returns a random 256-bit token (only its SHA-256 is stored). The browser keeps it in localStorage and `POST /api/nick/resume` restores the same player if the cookie is lost; the Profile page shows it as a recovery key. `POST /api/admin/remove-player {name}` (admin secret) removes a player and their unsettled guesses.

## Security
bcrypt passwords · server-side sessions in httpOnly SameSite cookies (`Secure` in prod) · CSRF double-submit token + Origin check · per-IP and per-user rate limits · strict validation · no `innerHTML` with data (textContent only) · Helmet + CSP · wallet ownership proven by Phantom message signature (ed25519) · one wallet per player · admin endpoint disabled unless `ADMIN_SECRET` set.

## Run / test
`npm install && npm start` (PGlite locally) · `npm test` runs a Playwright end-to-end suite (signup, emoji, wallet link, guess, live update, lock, settle, re-rank, archive, profile, security) with a mock Solana RPC and a controllable clock (`GTC_TEST=1`, never in production).
