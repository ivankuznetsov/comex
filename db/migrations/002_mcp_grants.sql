-- Managed OAuth library tables are migrated separately using the pinned library.
CREATE TABLE mcp_grants (
  id text PRIMARY KEY, owner text NOT NULL, client_id text NOT NULL,
  session_id text NOT NULL UNIQUE, user_id text NOT NULL, client_name text NOT NULL,
  created_at bigint NOT NULL, revoked_at bigint
);
CREATE INDEX mcp_grants_owner ON mcp_grants(owner);
