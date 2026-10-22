-- The publisher's guide to getting access, from the OAuth protected-resource metadata (RFC 9728, resource_documentation).
-- Apply once to a database created before 2026-10-22:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/009-auth-documentation.sql
ALTER TABLE servers ADD COLUMN auth_documentation TEXT;
