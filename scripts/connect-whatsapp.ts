/**
 * Connect (or disconnect) a WhatsApp Business Platform number for a restaurant.
 *
 * This is the one step that previously needed hand-written SQL. Credentials are
 * encrypted at rest with ENCRYPTION_KEY; only the display number and phone
 * number id are stored in the clear, because inbound webhooks are routed by
 * matching the display number.
 *
 * Works with Meta's FREE TEST NUMBER — you do not need to buy or register a
 * number to try this. Create an app at developers.facebook.com, add the
 * WhatsApp product, and Meta issues a test sender plus a temporary token.
 *
 *   npm run connect:whatsapp -- \
 *     --phone-number-id 123456789012345 \
 *     --display-number +15550001234 \
 *     --token EAAG... \
 *     --app-secret abc123 \
 *     --verify-token my-verify-token
 *
 *   npm run connect:whatsapp -- --status          # show current state
 *   npm run connect:whatsapp -- --disconnect      # back to the simulator
 */
import { getDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { integrations, restaurants } from '../src/db/schema';
import { and, eq } from 'drizzle-orm';
import { newId } from '../src/lib/ids';
import { encryptSecret } from '../src/lib/crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const db = await getDb();
await migrate(db);

/* ── pick the restaurant ── */

const slug = arg('restaurant');
const all = await db.drizzle.select().from(restaurants);

if (all.length === 0) fail('No restaurants yet. Run: npm run db:seed');

const restaurant = slug
  ? all.find((r: any) => r.slug === slug || r.id === slug)
  : all.length === 1 ? all[0] : all.find((r: any) => r.slug === 'spicebox-biryani-demo');

if (!restaurant) {
  fail(`Pick one with --restaurant <slug>:\n  ${all.map((r: any) => `${r.slug}  (${r.name})`).join('\n  ')}`);
}

const [existing] = await db.drizzle.select().from(integrations).where(and(
  eq(integrations.restaurantId, restaurant.id), eq(integrations.kind, 'whatsapp'))).limit(1);

/* ── status ── */

if (flag('status') || process.argv.length <= 2) {
  const publicConfig = (existing?.publicConfig ?? {}) as any;
  console.log(`\n  Restaurant : ${restaurant.name} (${restaurant.slug})`);
  console.log(`  WhatsApp   : ${existing?.status ?? 'NOT CONFIGURED'}`);
  if (publicConfig.displayPhoneNumber) console.log(`  Number     : ${publicConfig.displayPhoneNumber}`);
  if (publicConfig.phoneNumberId) console.log(`  Phone id   : ${publicConfig.phoneNumberId}`);
  if (existing?.lastError) console.log(`  Note       : ${existing.lastError}`);

  if (process.env.MESSAGING_PROVIDER === 'mock') {
    console.log(`\n  WARNING: MESSAGING_PROVIDER=mock is set, which forces the simulator`);
    console.log(`  regardless of what is configured here. Unset it to go live.`);
  }
  console.log('');
  await db.close();
  process.exit(0);
}

/* ── disconnect ── */

if (flag('disconnect')) {
  if (existing) {
    await db.drizzle.update(integrations).set({
      status: 'DISCONNECTED', configEncrypted: null,
      lastError: 'Disconnected manually. Falling back to the built-in simulator.',
      updatedAt: new Date(),
    }).where(eq(integrations.id, existing.id));
  }
  console.log(`\n  Disconnected. ${restaurant.name} is back on the simulator.\n`);
  await db.close();
  process.exit(0);
}

/* ── connect ── */

const phoneNumberId = arg('phone-number-id') ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
const accessToken   = arg('token')           ?? process.env.WHATSAPP_ACCESS_TOKEN;
const appSecret     = arg('app-secret')      ?? process.env.WHATSAPP_APP_SECRET;
const verifyToken   = arg('verify-token')    ?? process.env.WHATSAPP_VERIFY_TOKEN;
let displayNumber   = arg('display-number');

const missing = [
  !phoneNumberId && '--phone-number-id (WhatsApp > API Setup)',
  !accessToken && '--token (temporary or permanent access token)',
  !appSecret && '--app-secret (App Settings > Basic > App Secret)',
].filter(Boolean);

if (missing.length) fail(`Missing:\n  ${missing.join('\n  ')}\n\n  Run with --status to see current state.`);

if (!appSecret) fail('--app-secret is required; without it the webhook cannot verify signatures.');

/**
 * Ask Meta for the display number rather than trusting a typo. This is also the
 * first real call against the Graph API, so it doubles as a credential check.
 */
if (!displayNumber) {
  process.stdout.write('  Looking up the number from Meta... ');
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const json: any = await res.json();
    if (!res.ok) {
      console.log('failed.');
      fail(`Meta rejected the credentials: ${json?.error?.message ?? `HTTP ${res.status}`}`);
    }
    displayNumber = json.display_phone_number;
    console.log(`${displayNumber} (${json.verified_name ?? 'unnamed'})`);
  } catch (err: any) {
    console.log('failed.');
    fail(`Could not reach Meta: ${err?.message}. Pass --display-number to skip this check.`);
  }
}

const normalised = displayNumber!.startsWith('+') ? displayNumber! : `+${displayNumber!.replace(/\D/g, '')}`;

// Another restaurant must not already own this number, or inbound routing breaks.
const clash = (await db.drizzle.select().from(integrations).where(eq(integrations.kind, 'whatsapp')))
  .find((row: any) =>
    row.restaurantId !== restaurant.id &&
    String((row.publicConfig ?? {}).displayPhoneNumber ?? '').replace(/\D/g, '') === normalised.replace(/\D/g, ''));

if (clash) fail(`${normalised} is already connected to another restaurant. One number, one tenant.`);

const configEncrypted = encryptSecret(JSON.stringify({ accessToken, phoneNumberId, appSecret }));
const publicConfig = { displayPhoneNumber: normalised, phoneNumberId };

if (existing) {
  await db.drizzle.update(integrations).set({
    status: 'CONNECTED', configEncrypted, publicConfig,
    lastCheckedAt: new Date(), lastError: '', updatedAt: new Date(),
  }).where(eq(integrations.id, existing.id));
} else {
  await db.drizzle.insert(integrations).values({
    id: newId('int'), restaurantId: restaurant.id, kind: 'whatsapp',
    status: 'CONNECTED', configEncrypted, publicConfig, lastCheckedAt: new Date(),
  });
}

console.log(`\n  CONNECTED  ${normalised} -> ${restaurant.name}\n`);
console.log(`  Next:`);
console.log(`    1. Expose your dev server:  npx cloudflared tunnel --url http://localhost:3000`);
console.log(`    2. In Meta > WhatsApp > Configuration, set the callback URL to`);
console.log(`       https://<your-tunnel>/api/webhooks/whatsapp`);
console.log(`       and the verify token to "${verifyToken ?? '<WHATSAPP_VERIFY_TOKEN>'}"`);
console.log(`    3. Subscribe to the "messages" field.`);
console.log(`    4. Add your own mobile under "To" in API Setup, then WhatsApp the test number.`);

if (!verifyToken) {
  console.log(`\n  Set WHATSAPP_VERIFY_TOKEN in .env.local — the GET handshake fails without it.`);
}
if (!process.env.ENCRYPTION_KEY) {
  console.log(`\n  WARNING: ENCRYPTION_KEY is unset, so the token is encrypted with the`);
  console.log(`  insecure dev fallback key. Fine for a test number, never for a real one.`);
}
if (process.env.MESSAGING_PROVIDER === 'mock') {
  console.log(`\n  WARNING: MESSAGING_PROVIDER=mock is set and overrides this. Unset it.`);
}
console.log('');

await db.close();
process.exit(0);
