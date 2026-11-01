-- Exact source credentials captured by the trusted importer, scoped to a batch.
CREATE TABLE mcp_import_identity_proofs (
  batch_id text NOT NULL REFERENCES import_batches(id),
  kind text NOT NULL CHECK(kind IN ('auth','guest','legacy')),
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  source_owner text NOT NULL CHECK(source_owner ~ '^[a-f0-9]{64}$'),
  expires_at bigint NOT NULL,
  PRIMARY KEY(batch_id,kind,token_hash)
);
CREATE INDEX mcp_import_identity_proofs_lookup ON mcp_import_identity_proofs(kind,token_hash,expires_at);
