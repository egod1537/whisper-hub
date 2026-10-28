import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';
import { removePath } from '../shared/storage/files.js';
import { resolveInside } from '../shared/storage/paths.js';
import { uploadSessionRelativePath } from '../shared/uploads/paths.js';
import { UploadRepository } from '../shared/uploads/repository.js';

interface CleanupRow {
  id: string;
  status: string;
  source_path: string;
  result_base_path: string | null;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const scheduleIndex = args.indexOf('--schedule-hours');
const scheduleHours = scheduleIndex >= 0 ? Number(args[scheduleIndex + 1]) : null;
if (scheduleHours !== null && (!Number.isFinite(scheduleHours) || scheduleHours <= 0)) {
  throw new Error('--schedule-hours requires a positive number');
}
const config = loadConfig();
const db = openDatabase(config.dbPath);
migrate(db);
const uploadRepository = new UploadRepository(db);

async function cleanup(): Promise<void> {
  const now = Date.now();
  const completedCutoff = new Date(now - config.completedRetentionDays * 86_400_000).toISOString();
  const failedCutoff = new Date(now - config.failedRetentionDays * 86_400_000).toISOString();
  const sourceCutoff = new Date(now - config.sourceRetentionDays * 86_400_000).toISOString();
  const expired = db.prepare(`
    SELECT id, status, source_path, result_base_path FROM jobs
    WHERE (status = 'completed' AND completed_at < ?)
       OR (status IN ('failed', 'canceled') AND completed_at < ?)
    ORDER BY created_at, id
  `).all(completedCutoff, failedCutoff) as CleanupRow[];
  const sourceOnly = db.prepare(`
    SELECT id, status, source_path, result_base_path FROM jobs
    WHERE status IN ('completed', 'canceled') AND completed_at < ?
  `).all(sourceCutoff) as CleanupRow[];
  const expiredUploads = db.prepare("SELECT id FROM upload_sessions WHERE status='uploading' AND expires_at <= ?").all(new Date(now).toISOString()) as Array<{ id: string }>;
  const terminalUploads = db.prepare("SELECT id FROM upload_sessions WHERE status IN ('expired','aborted','completed')").all() as Array<{ id: string }>;

  process.stdout.write(JSON.stringify({ apply, expiredJobs: expired.length, sourceFiles: sourceOnly.length, expiringUploads: expiredUploads.length, terminalUploadStaging: terminalUploads.length }) + '\n');
  if (!apply) return;
  uploadRepository.expireSessions(new Date(now));
  for (const row of expired) {
    const deleted = db.prepare(`DELETE FROM jobs WHERE id = ? AND status = ?`).run(row.id, row.status);
    if (deleted.changes !== 1) continue;
    await removePath(path.dirname(resolveInside(config.dataDir, row.source_path)));
    if (row.result_base_path) await removePath(resolveInside(config.dataDir, row.result_base_path));
  }
  const expiredIds = new Set(expired.map((row) => row.id));
  for (const row of sourceOnly) {
    if (expiredIds.has(row.id)) continue;
    const current = db.prepare('SELECT status FROM jobs WHERE id = ?').get(row.id) as { status: string } | undefined;
    if (!current || !['completed', 'canceled'].includes(current.status)) continue;
    await removePath(path.dirname(resolveInside(config.dataDir, row.source_path)));
  }
  const stagedCleanup = db.prepare("SELECT id FROM upload_sessions WHERE status IN ('expired','aborted','completed')").all() as Array<{ id: string }>;
  for (const row of stagedCleanup) {
    await removePath(resolveInside(config.dataDir, uploadSessionRelativePath(row.id)));
    db.transaction(() => {
      db.prepare('DELETE FROM upload_part_claims WHERE upload_id=?').run(row.id);
      db.prepare('DELETE FROM upload_parts WHERE upload_id=?').run(row.id);
    }).immediate();
  }
  db.prepare("DELETE FROM upload_sessions WHERE status IN ('expired','aborted') AND updated_at < ?").run(failedCutoff);
  const tempRoot = resolveInside(config.dataDir, '.tmp');
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  const tempCutoff = now - 86_400_000;
  for (const entry of entries) {
    const target = path.join(tempRoot, entry.name);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat && stat.mtimeMs < tempCutoff) await removePath(target);
  }
  const sessionsRoot = resolveInside(config.dataDir, path.posix.join('uploads', '.sessions'));
  const sessionEntries = await fs.promises.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  for (const sessionEntry of sessionEntries.filter((entry) => entry.isDirectory())) {
    const sessionRoot = path.join(sessionsRoot, sessionEntry.name);
    const sessionFiles = await fs.promises.readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
    for (const artifact of sessionFiles.filter((entry) => entry.isFile() && entry.name.startsWith('assembled.partial.'))) {
      const target = path.join(sessionRoot, artifact.name);
      const stat = await fs.promises.stat(target).catch(() => null);
      if (stat && stat.mtimeMs < tempCutoff) await removePath(target);
    }
    const partialRoot = path.join(sessionRoot, 'parts');
    const parts = await fs.promises.readdir(partialRoot, { withFileTypes: true }).catch(() => []);
    for (const part of parts.filter((entry) => entry.isFile() && entry.name.includes('.partial.'))) {
      const target = path.join(partialRoot, part.name);
      const stat = await fs.promises.stat(target).catch(() => null);
      if (stat && stat.mtimeMs < tempCutoff) await removePath(target);
    }
  }
}

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
try {
  do {
    await cleanup();
    if (scheduleHours === null || stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, scheduleHours * 3_600_000);
      const check = setInterval(() => {
        if (stopping) { clearTimeout(timer); clearInterval(check); resolve(); }
      }, 1_000);
    });
  } while (!stopping);
} finally {
  db.close();
}

