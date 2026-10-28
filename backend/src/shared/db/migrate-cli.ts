import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  migrate(db);
  process.stdout.write('Database migrations applied.\n');
} finally {
  db.close();
}

