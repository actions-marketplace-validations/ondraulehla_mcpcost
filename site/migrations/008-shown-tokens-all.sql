-- The same expression without the status, for the "All" list and the other lists over every status.
-- About 42 000 writes; the probe workflow applies it on the day after migration 007.
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/008-shown-tokens-all.sql
CREATE INDEX IF NOT EXISTS servers_shown ON servers (coalesce(claude_tokens, tools_tokens) DESC, name);
