-- Only the trusted import operator may populate this mapping. It is not a
-- public API: imported draft owner values come from the recorded batch itself.
CREATE TABLE mcp_import_owners (
  batch_id text NOT NULL REFERENCES import_batches(id), source_owner text NOT NULL,
  claimed_at bigint, destination_owner text, PRIMARY KEY(batch_id,source_owner)
);
