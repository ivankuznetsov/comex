CREATE TABLE operations (
  id text PRIMARY KEY, owner text NOT NULL, action text NOT NULL, request_key text NOT NULL,
  input_digest text NOT NULL, target_id text NOT NULL, grant_id text,
  expected_versions text NOT NULL, input_json text NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','succeeded','needs_review','failed','unknown_outcome','obsolete','revoked')),
  result_json text, lease_token text, lease_until bigint, fence bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE(owner,action,request_key)
);
CREATE INDEX operations_owner ON operations(owner,created_at);
CREATE TABLE operation_dispatch_intents (
  operation_id text PRIMARY KEY REFERENCES operations(id),
  state text NOT NULL CHECK(state IN ('pending','leased','delivered')),
  lease_token text, lease_until bigint, attempts bigint NOT NULL DEFAULT 0, workflow_run_id text
);
CREATE TABLE operation_steps (
  operation_id text NOT NULL REFERENCES operations(id), step_id text NOT NULL,
  input_digest text NOT NULL, state text NOT NULL CHECK(state IN ('running','completed','failed','unknown')),
  reservation_id text NOT NULL REFERENCES provider_reservations(id), result_json text,
  PRIMARY KEY(operation_id,step_id), UNIQUE(reservation_id)
);
CREATE TABLE operation_checkpoints (
  operation_id text NOT NULL REFERENCES operations(id), checkpoint_key text NOT NULL,
  value_json text NOT NULL, PRIMARY KEY(operation_id,checkpoint_key)
);
