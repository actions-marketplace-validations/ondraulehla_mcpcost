-- down_since: failing_since once the server is down, that is after two days of failed probes (isConfirmedDown),
-- else null. The probe computes it from the real probe times; the board reads it. probed_at in D1 is the time of
-- the last change, so the board cannot compute it. Apply once to a database created before 2026-10-26:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/012-down-since.sql
ALTER TABLE servers ADD COLUMN down_since TEXT;
