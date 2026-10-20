-- Servers measured with stored credentials. Apply once to a database created before 2026-10-17:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/004-credentials.sql
ALTER TABLE servers ADD COLUMN measured_with_credentials INTEGER;
