/**
 * Driver-agnostic migrator. Applies drizzle-kit generated SQL files in filename order
 * and records them in _migrations so re-running is a no-op.
 * Works identically on PGlite and managed Postgres — that is the whole point.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './client';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

export async function migrate(db: Database): Promise<string[]> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`No drizzle/ directory. Run: npx drizzle-kit generate`);
  }

  const { rows } = await db.execute(`SELECT name FROM _migrations;`);
  const applied = new Set(rows.map((r: any) => r.name));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await db.execute(stmt);
      } catch (err: any) {
        throw new Error(`Migration ${file} failed on statement:\n${stmt.slice(0, 300)}\n\n${err.message}`);
      }
    }
    await db.execute(`INSERT INTO _migrations (name) VALUES ($1);`, [file]);
    ran.push(file);
  }
  return ran;
}
