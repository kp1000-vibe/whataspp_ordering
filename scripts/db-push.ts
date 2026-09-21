import { getDb, databaseUrl } from '../src/db/client';
import { migrate } from '../src/db/migrate';

const db = await getDb();
console.log(`driver=${db.driver} url=${databaseUrl()}`);
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
const { rows } = await db.execute(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public';`
);
console.log(`tables in public schema: ${rows[0].n}`);
await db.close();
