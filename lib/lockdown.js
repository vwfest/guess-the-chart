// No client role (anon/authenticated, used by Supabase's REST API) may touch our schema; RLS (no policies) is the second lock and is verified at boot, not assumed.
function lockdownSql(S) { return `
DO $lock$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ${S} FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${S} FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${S} FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END
$lock$`; }
// run(sql) executes a statement; one(sql, params) returns {rows}. Throws (fails startup / disables the DB) unless RLS is on for every table; warns if a client role still has schema USAGE.
async function lockdown(run, one, S, tables) {
  for (const t of tables) await run(`ALTER TABLE ${S}.${t} ENABLE ROW LEVEL SECURITY`);
  await run(lockdownSql(S)).catch(e => console.error('lockdown (non-fatal, RLS still on):', e.message));
  const r = await one(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${S}' AND c.relname = ANY($1) AND NOT c.relrowsecurity`, [tables]);
  if (r.rows.length) throw new Error('RLS is not enabled on: ' + r.rows.map(x => x.relname).join(', '));
  const g = await one(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') AND has_schema_privilege(rolname, '${S}', 'USAGE')`);
  if (g.rows.length) console.error('[lockdown] WARNING: client roles still have USAGE on schema ' + S + ' (RLS is on, so tables stay unreadable): ' + g.rows.map(x => x.rolname).join(', '));
}
module.exports = { lockdown, lockdownSql };
