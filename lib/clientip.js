// Real client IP behind Render (Cloudflare -> Render load balancer -> app).
// X-Forwarded-For's FIRST entry is client-controlled (spoofable) and its LAST entry is the Cloudflare edge, so neither is safe for
// rate limits. Cloudflare overwrites CF-Connecting-IP with the connecting client's address, so prefer that; otherwise use the
// entry just before the edge (the address Cloudflare itself saw). Outside Render (local dev/tests) use the socket address.
'use strict';
const net = require('net');
const BEHIND_PROXY = () => process.env.RENDER === 'true' || process.env.TRUST_CF === '1';
function clientIp(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '0.0.0.0';
  if (!BEHIND_PROXY()) return req.ip || sock;
  const h = req.headers || {};
  const cf = typeof h['cf-connecting-ip'] === 'string' ? h['cf-connecting-ip'].trim() : '';
  if (cf && net.isIP(cf)) return cf;
  const x = String(h['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (x.length >= 2 && net.isIP(x[x.length - 2])) return x[x.length - 2];
  if (x.length && net.isIP(x[x.length - 1])) return x[x.length - 1];
  return sock;
}
// Express middleware: make req.ip the real client address everywhere (rate limiters, hashes, logs).
function useClientIp(app) {
  app.use((req, res, next) => { const ip = clientIp(req); Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true }); next(); });
}
module.exports = { clientIp, useClientIp };
