import { runCleanup } from '../cleanup/service.js';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';

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

async function cleanup(): Promise<void> {
  const summary = await runCleanup({ config, db, apply });
  process.stdout.write(JSON.stringify({ apply, ...summary }) + '\n');
}

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
try {
  do {
    await cleanup();
    if (scheduleHours === null || stopping) break;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      };
      const timer = setTimeout(finish, scheduleHours * 3_600_000);
      const check = setInterval(() => {
        if (stopping) finish();
      }, 1_000);
    });
  } while (!stopping);
} finally {
  db.close();
}

