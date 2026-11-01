-- Applied only by the explicit migration command; never by application startup.
CREATE TABLE comics (
  id text PRIMARY KEY, owner text NOT NULL, revision integer NOT NULL,
  draft jsonb NOT NULL, edition jsonb, published_at timestamptz,
  import_batch_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX comics_owner ON comics(owner, created_at DESC);
CREATE TABLE comic_text_operations (
  comic_id text PRIMARY KEY REFERENCES comics(id), owner text NOT NULL,
  state text NOT NULL CHECK(state IN ('running','unknown'))
);
CREATE TABLE assets (id text PRIMARY KEY, object_path text NOT NULL, sha256 text NOT NULL);
CREATE TABLE publication_assets (
  comic_id text NOT NULL REFERENCES comics(id), asset_id text NOT NULL,
  object_path text NOT NULL, sha256 text NOT NULL, PRIMARY KEY(comic_id,asset_id)
);
CREATE TABLE provider_budget_guard (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO provider_budget_guard VALUES (1);
CREATE TABLE provider_reservations (
  id text PRIMARY KEY, state text NOT NULL CHECK(state IN ('running','completed','unknown')),
  created_at text NOT NULL, updated_at text NOT NULL, step_key text UNIQUE
);
-- Current email/guest authentication data is preserved; U3 owns OAuth tables and handoff.
CREATE TABLE auth_guard (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO auth_guard VALUES (1);
CREATE TABLE auth_users (email text PRIMARY KEY, owner text NOT NULL UNIQUE);
CREATE TABLE auth_sessions (token_hash text PRIMARY KEY, owner text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE auth_requests (email_hash text NOT NULL, requested_at bigint NOT NULL, request_id text, rejected integer NOT NULL DEFAULT 0);
CREATE INDEX auth_requests_time ON auth_requests(requested_at);
CREATE TABLE auth_guests (token_hash text PRIMARY KEY, owner text NOT NULL UNIQUE, email text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE auth_codes (email text PRIMARY KEY, code_hash text NOT NULL, salt text NOT NULL, browser_hash text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE auth_code_attempts (email_hash text NOT NULL, attempted_at bigint NOT NULL);
CREATE TABLE import_batches (id text PRIMARY KEY, fingerprint text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());
