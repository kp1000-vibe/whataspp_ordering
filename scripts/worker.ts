/**
 * Background worker. Run this as a separate process in production
 * (WORKER_MODE=external) so the web tier never blocks on transcription,
 * campaign delivery or retries.
 */
import { getDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { bootstrap } from '../src/server/bootstrap';
import { drain, queueStats } from '../src/server/queue/queue';
import { log } from '../src/lib/log';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 1000);

const db = await getDb();
await migrate(db);
bootstrap();

log.info('worker started', { interval: INTERVAL_MS, driver: db.driver });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('worker stopping');
    stopping = true;
  });
}

while (!stopping) {
  try {
    const ran = await drain();
    if (ran > 0) log.info('jobs processed', { count: ran, ...(await queueStats()) });
  } catch (err: any) {
    log.error('worker loop error', { error: err?.message });
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

await db.close();
process.exit(0);
