-- Internal accounting. No public/API read surface. Retain costs if comics are removed.
CREATE TABLE IF NOT EXISTS provider_costs (
  reservation_id text PRIMARY KEY, comic_id text NOT NULL, operation_id text, step_id text,
  endpoint text, model text, request_id text, usage_json text, cost_usd numeric(20,10),
  pricing_version text, rates_json text, cost_state text NOT NULL,
  created_at text NOT NULL, updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_costs_comic ON provider_costs(comic_id,created_at);

-- Historical durable calls can be attributed, but their token usage was not saved.
-- NULL means unavailable, never zero or a fabricated reconstruction.
INSERT INTO provider_costs(reservation_id,comic_id,operation_id,step_id,cost_state,created_at,updated_at)
SELECT r.id,o.target_id,o.id,s.step_id,'legacy_usage_missing',r.created_at,r.updated_at
FROM provider_reservations r JOIN operation_steps s ON s.reservation_id=r.id
JOIN operations o ON o.id=s.operation_id
ON CONFLICT(reservation_id) DO NOTHING;

CREATE OR REPLACE VIEW comic_cost_totals AS
SELECT c.id AS comic_id,c.draft->>'title' AS title,
 count(p.reservation_id)::integer AS tracked_requests,
 count(p.cost_usd)::integer AS priced_requests,
 count(p.reservation_id) FILTER (WHERE p.cost_usd IS NULL)::integer AS unpriced_requests,
 sum(p.cost_usd) AS recorded_cost_usd,
 min(p.created_at) AS first_tracked_request,max(p.updated_at) AS last_updated_at
FROM comics c LEFT JOIN provider_costs p ON p.comic_id=c.id
GROUP BY c.id;
