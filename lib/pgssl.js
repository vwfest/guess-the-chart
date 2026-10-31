// Postgres TLS. Default: encrypted AND verified against Supabase's public root CA (certs/supabase-prod-ca-2021.crt, committed).
// Overrides: PG_CA_CERT / PG_CA_FILE (your own CA, always strict), PGSSL_VERIFY=1 (system trust store, strict), PGSSL_STRICT=1 (never downgrade),
// PGSSL=off (local only; refused in production).
// Safety net: if the bundled CA cannot verify the server (e.g. Supabase rotated its CA), `await pgSsl.probe(url)` at startup falls back ONCE to the old
// encrypted-but-unverified mode and logs a loud warning, so a CA change degrades the app's TLS instead of taking it down. Network errors never trigger a downgrade.
'use strict';
const fs = require('fs');
const path = require('path');
const BUNDLED = path.join(__dirname, '..', 'certs', 'supabase-prod-ca-2021.crt');
const explicit = () => !!(process.env.PG_CA_CERT || process.env.PG_CA_FILE || process.env.PGSSL_VERIFY === '1' || process.env.PGSSL_STRICT === '1');
let downgraded = false;
function pgSsl() {
  const prod = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  if (process.env.PGSSL === 'off') { if (prod) throw new Error('PGSSL=off is not allowed in production'); return false; }
  const ca = process.env.PG_CA_CERT || (process.env.PG_CA_FILE && fs.readFileSync(process.env.PG_CA_FILE, 'utf8'));
  if (ca) return { ca, rejectUnauthorized: true };
  if (process.env.PGSSL_VERIFY === '1') return { rejectUnauthorized: true };
  if (downgraded) return { rejectUnauthorized: false };
  try { return { ca: fs.readFileSync(BUNDLED, 'utf8'), rejectUnauthorized: true }; } catch { return { rejectUnauthorized: false }; }
}
const CERT_ERR = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)$/;
pgSsl.probe = async function probe(url) {
  const ssl = pgSsl(); if (!url || !ssl || !ssl.rejectUnauthorized || explicit()) return pgSsl.mode();
  const { Client } = require('pg'); const c = new Client({ connectionString: url, ssl, connectionTimeoutMillis: 10000 });
  c.on('error', () => {});
  try { await c.connect(); await c.end(); }
  catch (e) {
    if (CERT_ERR.test(e.code || '')) { downgraded = true; console.error(`[pgssl] WARNING: TLS verification against the bundled Supabase CA failed (${e.code}); falling back to encrypted-but-unverified. Update certs/supabase-prod-ca-2021.crt or set PG_CA_FILE.`); }
    else console.error('[pgssl] probe could not connect (' + (e.code || e.message) + '); keeping verified TLS');
    try { await c.end(); } catch {}
  }
  return pgSsl.mode();
};
pgSsl.mode = () => { const s = pgSsl(); return !s ? 'off' : s.rejectUnauthorized ? 'verified' : 'unverified'; };
module.exports = pgSsl;
