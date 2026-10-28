import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/shared/config.js';
import { openDatabase } from '../src/shared/db/connection.js';
import { migrate } from '../src/shared/db/migrate.js';
import type { TranscriptionProvider } from '../src/shared/providers/interface.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-hub-openapi-'));
const config = loadConfig({ TEST_MODE: 'true', DATA_DIR: directory, DB_PATH: path.join(directory, 'db.sqlite'), LOG_LEVEL: 'silent' });
const db = openDatabase(config.dbPath);
migrate(db);
const provider: TranscriptionProvider = {
  name: 'fake',
  async transcribe() { return { text: '', segments: [] }; },
  async health() { return true; },
};
const app = await buildApp({ config, db, provider, logger: false });
const output = path.resolve(import.meta.dirname, '../openapi.json');
fs.writeFileSync(output, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
db.close();
fs.rmSync(directory, { recursive: true, force: true });
process.stdout.write(`OpenAPI written to ${output}\n`);
