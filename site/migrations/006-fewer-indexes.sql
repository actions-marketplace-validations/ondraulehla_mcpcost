-- Four indexes fewer on servers: each one cost a write on every new or changed row of the daily import,
-- and the sorts they served are rare and read from a three-hour cache. Apply once to a database created before 2026-10-21:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/006-fewer-indexes.sql
DROP INDEX IF EXISTS servers_tokens_name;
DROP INDEX IF EXISTS servers_init_name;
DROP INDEX IF EXISTS servers_updated_name;
DROP INDEX IF EXISTS servers_protocol_name;
