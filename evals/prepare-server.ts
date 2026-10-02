/**
 * Builds the database the eval SERVER runs on (.data/eval): the SpiceBox seed,
 * hours open 11:00-23:00 every day (fixture), and a KITCHEN-role user.
 * Run before starting the eval server.
 */
process.env.DATABASE_URL = 'pglite://.data/eval';
import { rmSync } from 'node:fs';
import { getDb } from '../src/db/client';
import { seed } from '../scripts/seed';
import { hashPassword } from '../src/lib/crypto';
import { newId } from '../src/lib/ids';
import { KITCHEN } from './http-client';

rmSync('.data/eval', { recursive: true, force: true });
const { restaurantId, locationId } = await seed();
const db = await getDb();
await db.execute(
  `UPDATE business_hours SET is_closed = false, open_minute = 660, close_minute = 1380 WHERE restaurant_id = $1;`,
  [restaurantId]);
const userId = newId('usr');
await db.execute(`INSERT INTO users (id, email, password_hash, name) VALUES ($1,$2,$3,'Kitchen Tablet');`,
  [userId, KITCHEN.email, hashPassword(KITCHEN.password)]);
await db.execute(`INSERT INTO staff (id, user_id, restaurant_id, location_id, role) VALUES ($1,$2,$3,$4,'KITCHEN');`,
  [newId('stf'), userId, restaurantId, locationId]);
console.log(`eval database ready: ${restaurantId}`);
await db.close();
process.exit(0);
