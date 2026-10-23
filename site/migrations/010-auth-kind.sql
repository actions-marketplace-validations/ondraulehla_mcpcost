-- How a client gets access to a server that needs auth, from its public OAuth metadata: the kind
-- (oauth-dcr, oauth, token, unknown) and the metadata itself as JSON (authorization servers, scopes,
-- dynamic registration, PKCE, grant types). Apply once to a database created before 2026-10-24:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/010-auth-kind.sql
ALTER TABLE servers ADD COLUMN auth_kind TEXT;
ALTER TABLE servers ADD COLUMN auth_metadata TEXT;
