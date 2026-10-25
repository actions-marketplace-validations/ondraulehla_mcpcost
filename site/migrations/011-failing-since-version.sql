-- failing_since: the first probe of the current run of failed probes (ISO time), unset while the server answers or
-- is gated. The board calls a server down only after DOWN_AFTER_DAYS days of failed probes; one failed probe is
-- "no answer". version: the version of the registry entry that was probed. Apply once to a database created before
-- 2026-10-26:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/011-failing-since-version.sql
-- Then seed failing_since from the probes history (see the README of the probe, "Down after two days").
ALTER TABLE servers ADD COLUMN failing_since TEXT;
ALTER TABLE servers ADD COLUMN version TEXT;
