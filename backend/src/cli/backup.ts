import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node dist/cli/backup.js <destination.sqlite>');
const resolved = path.resolve(destination);
fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  migrate(db);
  await db.backup(resolved);
  await fs.promises.chmod(resolved, 0o600);
  process.stdout.write(`SQLite backup written to ${resolved}\n`);
} finally {
  db.close();
}
