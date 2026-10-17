-- The tool set of the publisher's open-source package, for servers that need auth. Apply once to a database created before 2026-10-17:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/005-derived.sql
ALTER TABLE servers ADD COLUMN derived_package TEXT;
ALTER TABLE servers ADD COLUMN derived_registry TEXT;
ALTER TABLE servers ADD COLUMN derived_status TEXT;
ALTER TABLE servers ADD COLUMN derived_probed_at TEXT;
ALTER TABLE servers ADD COLUMN derived_tool_count INTEGER;
ALTER TABLE servers ADD COLUMN derived_tools_tokens INTEGER;
ALTER TABLE servers ADD COLUMN derived_claude_tokens INTEGER;
ALTER TABLE servers ADD COLUMN derived_error TEXT;
