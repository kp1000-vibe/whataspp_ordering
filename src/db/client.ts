/**
 * One database interface, two drivers, chosen by DATABASE_URL:
 *   pglite://memory        -> in-process Postgres (tests)
 *   pglite://<dir>         -> in-process Postgres persisted to <dir> (local dev)
 *   postgres://... | postgresql://...  -> managed Postgres via postgres-js (staging/prod)
 *
 * PGlite IS Postgres (16) compiled to WASM. Same SQL, same migrations, same schema file.
 * Nothing above this module knows which driver is live.
 */
import * as schema from './schema';

export type Database = {
  /** Drizzle instance, typed with the full schema. */
  drizzle: any;
  /** Raw SQL escape hatch used by the migrator and analytics. */
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  close: () => Promise<void>;
  driver: 'pglite' | 'postgres-js';
};

/**
 * The connection is cached on globalThis, NOT in module scope.
 *
 * This is not a micro-optimisation, it is a correctness requirement. PGlite is a
 * single-writer embedded engine: two instances pointed at the same directory
 * abort the WASM runtime. Next.js dev (and route handlers vs server components)
 * can instantiate the same module more than once per process, so module-scoped
 * caching silently opens a second connection and crashes the database.
 * A promise is cached rather than the resolved value so concurrent first calls
 * cannot race into two connections.
 */
type DbGlobal = { __ttDb?: Promise<Database>; __ttDbUrl?: string };
const g = globalThis as unknown as DbGlobal;

export function databaseUrl(): string {
  return process.env.DATABASE_URL || 'pglite://.data/dev';
}

export async function getDb(url = databaseUrl()): Promise<Database> {
  if (g.__ttDb && g.__ttDbUrl === url) return g.__ttDb;

  if (g.__ttDb) {
    const previous = g.__ttDb;
    g.__ttDb = undefined;
    await previous.then((db) => db.close()).catch(() => {});
  }

  g.__ttDbUrl = url;
  g.__ttDb = (url.startsWith('pglite://') ? pgliteDb(url) : postgresJsDb(url))
    .catch((err) => {
      // Never cache a failed connection — the next request should retry.
      g.__ttDb = undefined;
      g.__ttDbUrl = undefined;
      throw err;
    });

  return g.__ttDb;
}

export async function resetDbCache(): Promise<void> {
  const previous = g.__ttDb;
  g.__ttDb = undefined;
  g.__ttDbUrl = undefined;
  if (previous) await previous.then((db) => db.close()).catch(() => {});
}

async function pgliteDb(url: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');

  const target = url.slice('pglite://'.length);
  let client: any;
  if (target === 'memory' || target === '') {
    client = new PGlite();
  } else {
    // PGlite does not create intermediate directories itself.
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(target), { recursive: true });
    client = new PGlite(target);
  }
  await client.waitReady;

  return {
    drizzle: drizzle(client, { schema }),
    execute: async (sql, params) => {
      const r = params?.length ? await client.query(sql, params as any[]) : await client.exec(sql);
      // exec() returns an array of results; query() returns one.
      const rows = Array.isArray(r) ? (r.at(-1)?.rows ?? []) : ((r as any).rows ?? []);
      return { rows };
    },
    close: () => client.close(),
    driver: 'pglite',
  };
}

async function postgresJsDb(url: string): Promise<Database> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const client = postgres(url, { max: 10, prepare: false });
  return {
    drizzle: drizzle(client, { schema }),
    execute: async (sql, params) => {
      const rows = params?.length
        ? await client.unsafe(sql, params as any[])
        : await client.unsafe(sql);
      return { rows: rows as unknown as any[] };
    },
    close: () => client.end({ timeout: 5 }),
    driver: 'postgres-js',
  };
}

export { schema };
