-- bundle: a registry entry whose remotes are three or more servers (com.cloudflare.mcp/mcp lists 15) is measured server
-- by server, see probe/bundles.ts. On the entry, JSON {"members":[{"name","host"}],"servers"}; on each of its other
-- servers (registry_status "bundled"), {"entry","servers","listedIn"?}; null on every other row. Apply once to a database
-- created before 2026-10-28:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/014-bundle.sql
ALTER TABLE servers ADD COLUMN bundle TEXT;
