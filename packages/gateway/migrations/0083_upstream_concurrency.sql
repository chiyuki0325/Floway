ALTER TABLE upstreams ADD COLUMN max_concurrent_requests INTEGER;

CREATE TABLE upstream_concurrency_observations (
  hour TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  limit_value INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  active_sum INTEGER NOT NULL DEFAULT 0,
  active_max INTEGER NOT NULL DEFAULT 0,
  queued_sum INTEGER NOT NULL DEFAULT 0,
  queued_max INTEGER NOT NULL DEFAULT 0,
  wait_ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, upstream_id)
);

CREATE INDEX idx_upstream_concurrency_observations_hour
  ON upstream_concurrency_observations (hour);
