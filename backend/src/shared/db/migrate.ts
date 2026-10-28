import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase } from './connection.js';

function migrationDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../migrations'),
    path.resolve(here, '../../../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'backend/migrations'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Migration directory not found');
  return found;
}

export function migrate(db: SqliteDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  const files = fs.readdirSync(migrationDirectory()).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.get(file)) continue;
    const sql = fs.readFileSync(path.join(migrationDirectory(), file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    }).immediate();
  }
}

