CREATE TABLE jobs_v4 (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'pausing', 'paused', 'completed', 'failed', 'canceled')),
  phase TEXT NULL CHECK (phase IS NULL OR phase IN ('fetching', 'validating', 'converting', 'transcribing', 'exporting')),
  origin TEXT NOT NULL DEFAULT 'api' CHECK (origin IN ('web', 'api', 'unknown')),
  source_type TEXT NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload', 'youtube')),
  source_url TEXT NULL,
  created_at TEXT NOT NULL,
  queue_entered_at TEXT NOT NULL,
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
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
  error_code TEXT NULL,
  error_message TEXT NULL,
  result_base_path TEXT NULL,
  result_metadata_json TEXT NULL,
  idempotency_key TEXT NULL UNIQUE,
  request_hash TEXT NULL,
  next_attempt_at TEXT NULL,
  manual_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0),
  CHECK ((source_type = 'youtube' AND source_url IS NOT NULL) OR source_type = 'upload')
);

INSERT INTO jobs_v4 (
  id,status,phase,origin,source_type,source_url,created_at,queue_entered_at,updated_at,started_at,completed_at,
  original_filename,media_type,file_size_bytes,source_path,duration_seconds,language,
  requested_output_formats,provider,model,attempts,max_attempts,lease_owner,lease_expires_at,
  cancel_requested,pause_requested,error_code,error_message,result_base_path,result_metadata_json,
  idempotency_key,request_hash,next_attempt_at,manual_retry_count
)
SELECT
  id,status,phase,origin,'upload',NULL,created_at,queue_entered_at,updated_at,started_at,completed_at,
  original_filename,media_type,file_size_bytes,source_path,duration_seconds,language,
  requested_output_formats,provider,model,attempts,max_attempts,lease_owner,lease_expires_at,
  cancel_requested,pause_requested,error_code,error_message,result_base_path,result_metadata_json,
  idempotency_key,request_hash,next_attempt_at,manual_retry_count
FROM jobs;

CREATE TABLE job_attempts_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs_v4(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  outcome TEXT NULL CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'retrying', 'canceled', 'paused', 'lease_expired')),
  error_code TEXT NULL,
  error_message TEXT NULL,
  worker_id TEXT NOT NULL
);

INSERT INTO job_attempts_v4 (id,job_id,attempt,started_at,ended_at,outcome,error_code,error_message,worker_id)
SELECT id,job_id,attempt,started_at,ended_at,outcome,error_code,error_message,worker_id FROM job_attempts;

DROP TABLE job_attempts;
DROP TABLE jobs;
ALTER TABLE jobs_v4 RENAME TO jobs;
ALTER TABLE job_attempts_v4 RENAME TO job_attempts;

CREATE INDEX jobs_queue_idx ON jobs(status, next_attempt_at, queue_entered_at, id);
CREATE INDEX jobs_lease_idx ON jobs(lease_expires_at);
CREATE INDEX jobs_created_idx ON jobs(created_at, id);
CREATE INDEX jobs_origin_created_idx ON jobs(origin, created_at, id);
CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, id);
