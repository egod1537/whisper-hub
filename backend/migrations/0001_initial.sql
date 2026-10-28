CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'canceled')),
  phase TEXT NULL CHECK (phase IS NULL OR phase IN ('validating', 'converting', 'transcribing', 'exporting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL,
  original_filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
  source_path TEXT NOT NULL,
  duration_seconds REAL NULL,
  language TEXT NOT NULL DEFAULT 'auto',
  requested_output_formats TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'whisper_cpp',
  model TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  lease_owner TEXT NULL,
  lease_expires_at TEXT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  error_code TEXT NULL,
  error_message TEXT NULL,
  result_base_path TEXT NULL,
  result_metadata_json TEXT NULL,
  idempotency_key TEXT NULL UNIQUE,
  request_hash TEXT NULL,
  next_attempt_at TEXT NULL,
  manual_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(lease_expires_at);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at, id);

CREATE TABLE IF NOT EXISTS job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  outcome TEXT NULL CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'retrying', 'canceled', 'lease_expired')),
  error_code TEXT NULL,
  error_message TEXT NULL,
  worker_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts(job_id, id);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  current_job_id TEXT NULL
);

