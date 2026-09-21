/**
 * Durable job queue backed by Postgres (`jobs` table) using the transactional
 * outbox pattern with SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Why not BullMQ as the default: this needs zero extra infrastructure, survives
 * process restarts, and is the same code path on PGlite and managed Postgres.
 * For very high throughput swap `claimBatch` for a BullMQ driver — the
 * `enqueue` / `register` API above it does not change.
 */
import { getDb } from '../../db/client';
import { jobs } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { newId } from '../../lib/ids';
import { log } from '../../lib/log';

export type JobHandler = (payload: any, ctx: { correlationId: string; jobId: string }) => Promise<void>;

const registry = new Map<string, JobHandler>();

export function register(name: string, handler: JobHandler): void {
  registry.set(name, handler);
}

export function registeredJobs(): string[] {
  return [...registry.keys()];
}

export async function enqueue(
  name: string,
  payload: Record<string, unknown>,
  opts: { correlationId?: string; delayMs?: number; maxAttempts?: number } = {},
): Promise<string> {
  const db = await getDb();
  const id = newId('job');
  await db.drizzle.insert(jobs).values({
    id,
    name,
    payload,
    status: 'PENDING',
    maxAttempts: opts.maxAttempts ?? 3,
    runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
    correlationId: opts.correlationId ?? '',
  });
  return id;
}

type ClaimedJob = { id: string; name: string; payload: any; attempts: number; max_attempts: number; correlation_id: string };

async function claimBatch(limit: number): Promise<ClaimedJob[]> {
  const db = await getDb();
  const { rows } = await db.execute(`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'PENDING' AND run_at <= now()
      ORDER BY run_at ASC
      LIMIT ${Math.max(1, Math.min(100, limit))}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
    WHERE id IN (SELECT id FROM claimed)
    RETURNING id, name, payload, attempts, max_attempts, correlation_id;
  `);
  return rows as ClaimedJob[];
}

/** Drains the queue until empty. Returns how many jobs ran. Used by dev, tests and the worker loop. */
export async function drain(maxPasses = 50): Promise<number> {
  const db = await getDb();
  let total = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const batch = await claimBatch(20);
    if (batch.length === 0) break;

    for (const job of batch) {
      const handler = registry.get(job.name);
      if (!handler) {
        await db.drizzle.update(jobs)
          .set({ status: 'DEAD', lastError: `no handler registered for "${job.name}"`, updatedAt: new Date() })
          .where(eq(jobs.id, job.id));
        log.error('job has no handler', { name: job.name, jobId: job.id });
        continue;
      }
      try {
        await handler(job.payload, { correlationId: job.correlation_id, jobId: job.id });
        await db.drizzle.update(jobs).set({ status: 'DONE', updatedAt: new Date() }).where(eq(jobs.id, job.id));
        total++;
      } catch (err: any) {
        const exhausted = job.attempts >= job.max_attempts;
        await db.drizzle.update(jobs).set({
          status: exhausted ? 'DEAD' : 'PENDING',
          lastError: String(err?.message ?? err).slice(0, 2000),
          // exponential backoff: 1s, 4s, 9s ...
          runAt: new Date(Date.now() + job.attempts * job.attempts * 1000),
          updatedAt: new Date(),
        }).where(eq(jobs.id, job.id));
        log.error('job failed', {
          name: job.name, jobId: job.id, attempt: job.attempts,
          dead: exhausted, error: err?.message, correlationId: job.correlation_id,
        });
      }
    }
  }
  return total;
}

export async function queueStats(): Promise<Record<string, number>> {
  const db = await getDb();
  const { rows } = await db.execute(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status;`);
  return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
}
