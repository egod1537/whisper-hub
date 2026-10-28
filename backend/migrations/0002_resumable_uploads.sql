CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'finalizing', 'completed', 'aborted', 'expired')),
  display_filename TEXT NOT NULL,
  total_size_bytes INTEGER NOT NULL CHECK (total_size_bytes > 0),
  expected_sha256 TEXT NULL,
  computed_sha256 TEXT NULL,
  language TEXT NOT NULL,
  formats_json TEXT NOT NULL,
  chunk_size_bytes INTEGER NOT NULL CHECK (chunk_size_bytes > 0),
  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0 AND total_chunks <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  job_id TEXT NULL UNIQUE,
  finalize_owner TEXT NULL,
  finalize_lease_expires_at TEXT NULL,
  create_idempotency_key TEXT NULL UNIQUE,
  create_request_hash TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL
);

CREATE INDEX upload_sessions_status_expiry_idx ON upload_sessions(status, expires_at);
CREATE INDEX upload_sessions_finalize_lease_idx ON upload_sessions(status, finalize_lease_expires_at);

CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY(upload_id, idx)
);

CREATE TABLE upload_part_claims (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  PRIMARY KEY(upload_id, idx)
);

CREATE INDEX upload_part_claims_lease_idx ON upload_part_claims(lease_expires_at);
