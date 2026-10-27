-- listed_in: for a server from outside the official registry that a public catalog lists (registry_status "listed",
-- see probe/sources.ts), the catalogs that list it, as JSON [{"name","url"}]; null for every other row. Apply once to a
-- database created before 2026-10-27:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/013-listed-in.sql
ALTER TABLE servers ADD COLUMN listed_in TEXT;
