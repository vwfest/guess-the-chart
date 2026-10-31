// Postgres via DATABASE_URL (production, own schema) or embedded PGlite (local dev/tests).
// All tables live in their own schema (default "gtc") so nothing else in the database is touched.
const path = require('path');
const pgSsl = require('./pgssl');
const SCHEMA_NAME = (process.env.DB_SCHEMA || 'gtc').replace(/[^a-z0-9_]/gi, '');
let q, txImpl;

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME};
CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  wallet TEXT,
  wallet_balance NUMERIC,
  wallet_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gtc_users_email ON ${SCHEMA_NAME}.users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS gtc_users_name ON ${SCHEMA_NAME}.users (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS gtc_users_wallet ON ${SCHEMA_NAME}.users (wallet) WHERE wallet IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES ${SCHEMA_NAME}.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.wallet_nonces (
  user_id BIGINT PRIMARY KEY REFERENCES ${SCHEMA_NAME}.users(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.rounds (
  id BIGSERIAL PRIMARY KEY,
  week_start TIMESTAMPTZ NOT NULL UNIQUE,
  lock_at TIMESTAMPTZ NOT NULL,
  settle_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  final_price NUMERIC,
  winner_guess_id BIGINT,
  settled_at TIMESTAMPTZ,
  settled_late BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE ${SCHEMA_NAME}.rounds ADD COLUMN IF NOT EXISTS sched INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.guesses (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES ${SCHEMA_NAME}.rounds(id),
  user_id BIGINT NOT NULL REFERENCES ${SCHEMA_NAME}.users(id),
  price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  holding NUMERIC,
  diff NUMERIC,
  rank INTEGER,
  UNIQUE (round_id, user_id)
);
CREATE INDEX IF NOT EXISTS gtc_guesses_round ON ${SCHEMA_NAME}.guesses (round_id, created_at);
ALTER TABLE ${SCHEMA_NAME}.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE ${SCHEMA_NAME}.users ALTER COLUMN pass_hash DROP NOT NULL;
ALTER TABLE ${SCHEMA_NAME}.users ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'email';
ALTER TABLE ${SCHEMA_NAME}.users ADD COLUMN IF NOT EXISTS secret_hash TEXT;
ALTER TABLE ${SCHEMA_NAME}.users ADD COLUMN IF NOT EXISTS created_ip TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS gtc_users_secret ON ${SCHEMA_NAME}.users (secret_hash) WHERE secret_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS gtc_users_ip ON ${SCHEMA_NAME}.users (created_ip, created_at);
ALTER TABLE ${SCHEMA_NAME}.guesses ADD COLUMN IF NOT EXISTS ip_hash TEXT;
CREATE INDEX IF NOT EXISTS gtc_guesses_ip ON ${SCHEMA_NAME}.guesses (round_id, ip_hash);
`;

// Defence in depth: the shared Supabase project's REST API must never be able to read these tables (RLS on, no policies). The server role owns the tables and bypasses RLS.
const RLS = ['users', 'sessions', 'wallet_nonces', 'rounds', 'guesses'].map(t => `ALTER TABLE ${SCHEMA_NAME}.${t} ENABLE ROW LEVEL SECURITY`);
async function init() {
  const stmts = DDL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL, max: 5,
      ssl: pgSsl(),
    });
    pool.on('connect', c => { c.query(`SET search_path TO ${SCHEMA_NAME}`).catch(() => {}); });
    pool.on('error', e => console.error('pg pool error', e.message));
    q = (t, p) => pool.query(t, p);
    txImpl = async fn => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn((t, p) => c.query(t, p)); await c.query('COMMIT'); return r; }
      catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
      finally { c.release(); }
    };
    for (const s of stmts) await pool.query(s);
    for (const s of RLS) await pool.query(s).catch(e => console.error('rls:', e.message)); // best effort
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE_DIR || path.join(__dirname, '..', '.localdb'));
    q = (t, p) => db.query(t, p);
    txImpl = fn => db.transaction(tx => fn((t, p) => tx.query(t, p)));
    for (const s of stmts) await db.exec(s);
    for (const s of RLS) await db.exec(s);
  }
}
// Always schema-qualify via the S helper so queries are safe regardless of search_path.
const S = SCHEMA_NAME;
module.exports = { init, S, query: (t, p) => q(t, p), tx: fn => txImpl(fn) };
