import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/shared/db/connection.js';
import { migrate } from '../../src/shared/db/migrate.js';

it('upgrades an existing v2 database without losing jobs, attempts, or upload sessions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-migration-'));
  const db = openDatabase(path.join(directory, 'db.sqlite'));
  const migrations = path.resolve(import.meta.dirname, '../../migrations');
  try {
    for (const version of ['0001_initial.sql', '0002_resumable_uploads.sql']) {
      db.exec(fs.readFileSync(path.join(migrations, version), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(version, '2026-10-28T00:00:00.000Z');
    }
    db.prepare(`INSERT INTO jobs (
      id,status,phase,created_at,updated_at,original_filename,media_type,file_size_bytes,source_path,
      language,requested_output_formats,provider,model,max_attempts
    ) VALUES ('historical','queued',NULL,?,?,?,?,?,?,?,'["txt"]','whisper_cpp','base',3)`)
      .run('2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'old.wav', 'audio/wav', 3, 'uploads/historical/source', 'ko');
    db.prepare(`INSERT INTO job_attempts(job_id,attempt,started_at,ended_at,outcome,worker_id)
      VALUES ('historical',1,?,?, 'retrying','old-worker')`)
      .run('2026-10-28T00:00:00.000Z', '2026-10-28T00:00:01.000Z');
    db.prepare(`INSERT INTO upload_sessions (
      id,status,display_filename,total_size_bytes,language,formats_json,chunk_size_bytes,total_chunks,
      created_at,updated_at,expires_at,create_request_hash
    ) VALUES ('old-upload','uploading','large.wav',3,'ko','["txt"]',1048576,1,?,?,?,'hash')`)
      .run('2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', '2026-10-29T00:00:00.000Z');

    migrate(db);

    expect(db.prepare('SELECT origin,source_type,source_url,queue_entered_at,pause_requested,progress_current,progress_total,progress_unit FROM jobs WHERE id=?').get('historical')).toEqual({
      origin: 'api', source_type: 'upload', source_url: null, queue_entered_at: '2026-10-28T00:00:00.000Z', pause_requested: 0,
      progress_current: null, progress_total: null, progress_unit: null,
    });
    expect(db.prepare('SELECT outcome,worker_id FROM job_attempts WHERE job_id=?').get('historical')).toEqual({ outcome: 'retrying', worker_id: 'old-worker' });
    expect(db.prepare('SELECT origin,assembled_bytes FROM upload_sessions WHERE id=?').get('old-upload')).toEqual({ origin: 'api', assembled_bytes: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
