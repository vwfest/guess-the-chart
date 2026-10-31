// Postgres TLS options. Default keeps the historic behaviour (encrypted, certificate not verified) so nothing breaks on deploy;
// set PG_CA_FILE (path to a PEM, e.g. certs/supabase-prod-ca-2021.crt) or PG_CA_CERT to switch to full certificate verification,
// or PGSSL_VERIFY=1 to verify against the system trust store. PGSSL=off disables TLS (local only; refused in production).
'use strict';
const fs = require('fs');
module.exports = function pgSsl() {
  const prod = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  if (process.env.PGSSL === 'off') { if (prod) throw new Error('PGSSL=off is not allowed in production'); return false; }
  const ca = process.env.PG_CA_CERT || (process.env.PG_CA_FILE && fs.readFileSync(process.env.PG_CA_FILE, 'utf8'));
  if (ca) return { ca, rejectUnauthorized: true };
  if (process.env.PGSSL_VERIFY === '1') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
};
