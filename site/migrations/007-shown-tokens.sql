-- The Tokens column sorts by the number the board shows (exact count, else estimate). This index serves the
-- lists filtered by status, the most read ones; the two indexes on claude_tokens alone go. Building it writes
-- a row per server, about 42 000, so the probe workflow applies it on a day of its own inside the write budget:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/007-shown-tokens.sql
CREATE INDEX IF NOT EXISTS servers_status_shown ON servers (status, coalesce(claude_tokens, tools_tokens) DESC, name);
DROP INDEX IF EXISTS servers_claude;
DROP INDEX IF EXISTS servers_status_claude;
