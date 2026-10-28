ALTER TABLE jobs ADD COLUMN progress_current REAL NULL CHECK (progress_current IS NULL OR progress_current >= 0);
ALTER TABLE jobs ADD COLUMN progress_total REAL NULL CHECK (progress_total IS NULL OR progress_total > 0);
ALTER TABLE jobs ADD COLUMN progress_unit TEXT NULL CHECK (progress_unit IS NULL OR progress_unit IN ('bytes', 'seconds'));

ALTER TABLE upload_sessions ADD COLUMN assembled_bytes INTEGER NOT NULL DEFAULT 0 CHECK (assembled_bytes >= 0 AND assembled_bytes <= total_size_bytes);
