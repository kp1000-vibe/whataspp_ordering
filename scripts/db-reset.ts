/** Drops and rebuilds the local dev database, then reseeds the demo restaurant. */
import { rmSync, existsSync } from 'node:fs';
import { databaseUrl, resetDbCache } from '../src/db/client';

const url = databaseUrl();
if (!url.startsWith('pglite://')) {
  console.error(`Refusing to reset a non-PGlite database: ${url}`);
  console.error('Drop and recreate it yourself if that is really what you want.');
  process.exit(1);
}

const dir = url.slice('pglite://'.length);
await resetDbCache();
if (dir !== 'memory' && existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
}

const { seed } = await import('./seed');
const result = await seed();
console.log(`reseeded: ${result.restaurantId} (${result.ownerEmail})`);
process.exit(0);
