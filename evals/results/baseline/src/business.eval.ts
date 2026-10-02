/**
 * Business-rule evals: opening hours, the slot/capacity engine, stale-state
 * races at confirmation, concurrency, expiry, printing, privacy, metrics and
 * scale. Each case builds its own world.
 */
import { Suite } from './harness';
import { freshWorld, newPhone, expectNoPriceableOrder, istAt, daysUntil, TZ, linesOf, L } from './fixtures';
import { formatLocalTime, localParts } from '../src/lib/time';
import { setClock } from '../src/lib/clock';
import { setCapacityState, listSlots } from '../src/server/capacity/slots';
import { setAvailability } from '../src/server/menu/service';
import { canTransition } from '../src/server/orders/state-machine';
import { queuePrintForOrder, claimJobs, reportJobResult } from '../src/server/printing/service';
import { eraseCustomer } from '../src/server/crm/service';
import { dashboardStats, usageForPeriod } from '../src/server/analytics/service';
import { signIn, signUp } from '../src/server/auth/service';
import { hashPassword } from '../src/lib/crypto';
import { systemScope } from '../src/server/tenancy';
import { newId } from '../src/lib/ids';
import { staffEditOrder } from '../src/server/orders/service';

export const suite = new Suite('business');

const TIME_RE = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g;
const minuteOf = (label: string) => {
  const m = label.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/)!;
  return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
};

/** Dynamic import so a not-yet-built function fails its case, not the suite. */
async function need<T = any>(path: string, name: string): Promise<T> {
  const mod: any = await import(path);
  if (typeof mod[name] !== 'function') throw new Error(`${name} is not implemented in ${path}`);
  return mod[name];
}

async function setScheduled(w: any, on: boolean) {
  await w.db.execute(`UPDATE restaurant_settings SET allow_scheduled_orders = $1 WHERE restaurant_id = $2;`, [on, w.restaurantId]);
}

/* ───────────── opening hours ───────────── */

suite.case('B01', '2 AM, scheduled orders ON → pickup offered only within opening hours', async (t) => {
  const w = await freshWorld({ clock: istAt(2, 0) });
  await setScheduled(w, true);
  const p = newPhone();
  const r = await w.say(p, '2 coke and 1 garlic naan');
  t.includes(r, /closed|open/i, 'tells the customer we are closed right now');
  const o = await w.latestOrder(p);
  if (o?.promisedReadyAt) {
    const m = localParts(o.promisedReadyAt, TZ).minuteOfDay;
    t.ok(m >= 11 * 60 && m <= 23 * 60, 'promised pickup is inside 11:00–23:00', formatLocalTime(o.promisedReadyAt, TZ));
  } else {
    t.ok(true, 'no pickup promised');
  }
  for (const label of r.match(TIME_RE) ?? []) {
    const m = minuteOf(label);
    t.ok(m >= 11 * 60 && m <= 23 * 60, `no quoted time outside opening hours (${label})`);
  }
});

suite.case('B02', '2 AM, scheduled orders OFF → refuses and says when we open', async (t) => {
  const w = await freshWorld({ clock: istAt(2, 0) });
  await setScheduled(w, false);
  const p = newPhone();
  const r = await w.say(p, '2 coke and 1 garlic naan');
  await expectNoPriceableOrder(t, w, p);
  t.includes(r, /closed/i);
  t.includes(r, '11:00 AM');
});

suite.case('B03', 'closed on Monday → says so and names the next opening', async (t) => {
  const monday = daysUntil(1);
  const w = await freshWorld({ clock: istAt(19, 0, monday), openAllWeek: false });
  await setScheduled(w, false);
  const p = newPhone();
  const r = await w.say(p, '2 coke and 1 garlic naan');
  await expectNoPriceableOrder(t, w, p);
  t.includes(r, /closed on Monday/i);
  t.includes(r, /tomorrow|Tuesday/i);
});

suite.case('B04', '10:50 PM (close 11 PM) → never promises a pickup after closing', async (t) => {
  const w = await freshWorld({ clock: istAt(22, 50) });
  await setScheduled(w, false);
  const p = newPhone();
  const r = await w.say(p, '2 coke and 1 garlic naan');
  const o = await w.latestOrder(p);
  if (o?.promisedReadyAt && o.status === 'READY_FOR_CONFIRMATION') {
    t.lte(localParts(o.promisedReadyAt, TZ).minuteOfDay, 23 * 60, 'pickup not after 11 PM');
  } else {
    t.includes(r, /clos/i, 'explains we are closing');
  }
});

suite.case('B05', 'holiday closure → uses the holiday note', async (t) => {
  const w = await freshWorld();
  await setScheduled(w, false);
  const today = localParts(istAt(19, 0), TZ).dateKey;
  await w.db.execute(
    `INSERT INTO holiday_hours (id, restaurant_id, date, is_closed, note) VALUES ($1,$2,$3,true,'Closed today for Diwali.');`,
    [newId('hol'), w.restaurantId, today]);
  const p = newPhone();
  const r = await w.say(p, '2 coke and 1 garlic naan');
  await expectNoPriceableOrder(t, w, p);
  t.includes(r, 'Diwali');
});

/* ───────────── capacity reflected in answers ───────────── */

suite.case('B06', '"how long?" honours +30 min padding (same promise as the slot engine)', async (t) => {
  const w = await freshWorld();
  await setCapacityState(w.scope, w.locationId, { etaOffsetMinutes: 30 });
  const plan = await listSlots(w.scope, { locationId: w.locationId, menuItemIds: [] });
  const r = await w.say(newPhone(), 'how long will it take?');
  const mins = [...r.matchAll(/(\d+)\s*min/g)].map((m) => Number(m[1]));
  const clockTimes = (r.match(TIME_RE) ?? []).map(minuteOf);
  const nowMin = localParts(istAt(19, 0), TZ).minuteOfDay;
  const quoted = Math.max(...mins, ...clockTimes.map((m) => m - nowMin), 0);
  t.gte(quoted, plan.prepMinutes, 'quoted wait is at least the padded prep time');
});

/* ───────────── state changes between draft and "yes" ───────────── */

suite.case('B07', 'kitchen pauses after the draft → "yes" does not place the order', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await setCapacityState(w.scope, w.locationId, { state: 'PAUSED', note: 'Paused for 10 minutes.' });
  const r = await w.say(p, 'yes');
  t.eq((await w.latestOrder(p))?.status, 'READY_FOR_CONFIRMATION', 'not confirmed');
  t.includes(r, /Paused/);
});

suite.case('B08', 'item sells out after the draft → "yes" does not confirm it', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await setAvailability(w.scope, w.locationId, { menuItemId: await w.itemId('Garlic Naan') }, 'SOLD_OUT');
  const r = await w.say(p, 'yes');
  const o = await w.latestOrder(p);
  t.ok(!['CONFIRMED', 'RECEIVED'].includes(o!.status), 'not confirmed with a sold-out item', o!.status);
  t.includes(r, /Garlic Naan/);
  t.includes(r, /sold out|unavailable/i);
});

suite.case('B09', 'price changes after the draft → customer sees the new total before it is placed', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await w.db.execute(`UPDATE menu_items SET price_cents = 9000 WHERE restaurant_id = $1 AND name = 'Coke';`, [w.restaurantId]);
  const r = await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  t.ok(!['CONFIRMED', 'RECEIVED'].includes(o.status), 'not placed at a price the customer never saw', o.status);
  t.includes(r, '₹262.50', 'shows the new total (2×90 + 70 = 250, +5%)');
});

suite.case('B10', 'slot fills after the draft → not booked into the full slot; customer told', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r1 = await w.say(p, '2 coke and 1 garlic naan');
  const draft = (await w.latestOrder(p))!;
  const cust = (await w.customerId(p))!;
  for (let i = 0; i < 8; i++) {
    await w.db.execute(
      `INSERT INTO orders (id, restaurant_id, location_id, customer_id, order_number, status, channel,
         subtotal_cents, discount_cents, tax_cents, total_cents, prep_minutes, promised_ready_at, pickup_slot_start, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'RECEIVED','WHATSAPP_TEXT',10000,0,500,10500,20,$6,$7,'fill');`,
      [newId('ord'), w.restaurantId, w.locationId, cust, 6000 + i, draft.promisedReadyAt!.toISOString(), draft.pickupSlotStart!.toISOString()]);
  }
  const r2 = await w.say(p, 'yes');
  const { rows } = await w.db.execute(
    `SELECT count(*)::int AS n FROM orders WHERE restaurant_id = $1 AND pickup_slot_start = $2
       AND status IN ('CONFIRMED','RECEIVED','ACCEPTED','PREPARING','READY');`,
    [w.restaurantId, draft.pickupSlotStart!.toISOString()]);
  t.lte(rows[0].n, 8, 'slot never exceeds its 8-order ceiling');
  const oldTime = (r1.match(TIME_RE) ?? []).at(-1);
  t.ok(!!(r2.match(TIME_RE) ?? []).find((x) => x !== oldTime), 'customer told a different time', r2);
});

suite.case('B11', '3 customers confirm at once into the last seat of a slot → no overbooking', async (t) => {
  const w = await freshWorld();
  const phones = [newPhone(), newPhone(), newPhone()];
  for (const p of phones) await w.say(p, '2 coke and 1 garlic naan');
  const first = (await w.latestOrder(phones[0]))!;
  const cust = (await w.customerId(phones[0]))!;
  for (let i = 0; i < 7; i++) {
    await w.db.execute(
      `INSERT INTO orders (id, restaurant_id, location_id, customer_id, order_number, status, channel,
         subtotal_cents, discount_cents, tax_cents, total_cents, prep_minutes, promised_ready_at, pickup_slot_start, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'RECEIVED','WHATSAPP_TEXT',10000,0,500,10500,20,$6,$7,'fill');`,
      [newId('ord'), w.restaurantId, w.locationId, cust, 7000 + i, first.promisedReadyAt!.toISOString(), first.pickupSlotStart!.toISOString()]);
  }
  await Promise.all(phones.map((p) => w.say(p, 'yes')));
  const { rows } = await w.db.execute(
    `SELECT count(*)::int AS n FROM orders WHERE restaurant_id = $1 AND pickup_slot_start = $2
       AND status IN ('CONFIRMED','RECEIVED','ACCEPTED','PREPARING','READY');`,
    [w.restaurantId, first.pickupSlotStart!.toISOString()]);
  t.lte(rows[0].n, 8, 'at most 8 orders in the slot');
});

suite.case('B12', '5 new customers order at the same instant → every one gets an order and a reply', async (t) => {
  const w = await freshWorld();
  const phones = [newPhone(), newPhone(), newPhone(), newPhone(), newPhone()];
  const replies = await Promise.all(phones.map((p) => w.say(p, '2 coke and 1 garlic naan')));
  const orders = await Promise.all(phones.map((p) => w.latestOrder(p)));
  t.eq(orders.filter((o) => o?.status === 'READY_FOR_CONFIRMATION').length, 5, 'five drafts');
  t.eq(replies.filter((r) => r.includes("Here's your order")).length, 5, 'five replies');
  t.eq(new Set(orders.map((o) => o?.orderNumber)).size, 5, 'order numbers are unique');
});

/* ───────────── requested pickup times ───────────── */

suite.case('B13', 'requested time beyond the booking horizon → says so (not "full")', async (t) => {
  const w = await freshWorld({ clock: istAt(12, 0) });
  const r = await w.say(newPhone(), "2 coke and 1 garlic naan, I'll pick it up at 9 pm");
  t.excludes(r, /is full/i);
  t.includes(r, /advance|ahead|too far|later today/i);
});

suite.case('B14', 'requested time after closing → says we are closed by then; offers a time before close', async (t) => {
  const w = await freshWorld({ clock: istAt(21, 30) });
  const r = await w.say(newPhone(), "2 coke and 1 garlic naan, pick up at 11:30 pm");
  t.includes(r, /clos/i);
  t.excludes(r, /is full/i);
  for (const label of (r.match(TIME_RE) ?? []).filter((x) => x !== '11:30 PM')) {
    t.lte(minuteOf(label), 23 * 60, `offered ${label} is before closing`);
  }
});

suite.case('B15', 'requested "in 5 minutes" → too soon, offers the earliest real time', async (t) => {
  const w = await freshWorld();
  const r = await w.say(newPhone(), '2 coke and 1 garlic naan, pick up in 5 minutes');
  t.includes(r, /soon/i);
  t.ok((r.match(TIME_RE) ?? []).length > 0, 'offers a time', r);
});

/* ───────────── lifecycle ───────────── */

suite.case('B16', 'abandoned drafts expire', async (t) => {
  t.ok(canTransition('DRAFT', 'EXPIRED' as any), 'DRAFT → EXPIRED allowed');
  t.ok(canTransition('READY_FOR_CONFIRMATION', 'EXPIRED' as any), 'READY_FOR_CONFIRMATION → EXPIRED allowed');
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  setClock(istAt(21, 30));
  const expire = await need('../src/server/orders/service', 'expireStaleDrafts');
  await expire(w.scope, { olderThanMinutes: 60 });
  t.eq((await w.latestOrder(p))?.status, 'EXPIRED', 'draft expired after 2.5h');
});

suite.case('B17', 'staff edit re-prices from the menu and is audited', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  const { order } = await staffEditOrder({ ...w.scope, role: 'MANAGER', userId: null }, {
    orderId: o.id, userId: 'u', reason: 'customer called',
    specs: [{ menuItemId: await w.itemId('Coke'), quantity: 3, modifierIds: [] }],
  });
  t.eq(order.subtotalCents, 18000, 're-priced from the menu');
  const { rows } = await w.db.execute(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1;`, [o.id]);
  t.gte(rows[0].n, 1, 'audited');
});

/* ───────────── printing ───────────── */

suite.case('B18', 'reprint creates a fresh KOT job', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  await w.staff(o.id, 'ACCEPTED');
  const reprint = await need('../src/server/printing/service', 'reprint');
  const jobs = await reprint(w.scope, o.id);
  t.gte(jobs.length, 1, 'reprint job queued');
  const { rows } = await w.db.execute(`SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1;`, [o.id]);
  t.gte(rows[0].n, 2, 'original + reprint');
});

suite.case('B19', 'print failing 3 times → job FAILED and visible, never silently lost', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  await w.staff(o.id, 'ACCEPTED');
  const { rows: pr } = await w.db.execute(`SELECT id FROM printers WHERE restaurant_id = $1;`, [w.restaurantId]);
  const token = 'pa_demo_spicebox_kitchen_token';
  for (let i = 0; i < 3; i++) {
    const jobs = await claimJobs(pr[0].id, token, 5);
    for (const j of jobs) await reportJobResult(pr[0].id, token, j.id, false, 'paper jam');
  }
  const { rows } = await w.db.execute(`SELECT status, error FROM print_jobs WHERE order_id = $1;`, [o.id]);
  t.eq(rows[0]?.status, 'FAILED', 'job marked FAILED');
  t.includes(rows[0]?.error ?? '', 'paper jam', 'error kept');
});

/* ───────────── privacy ───────────── */

suite.case('B20', 'erasure removes the phone number and name from EVERY table', async (t) => {
  const w = await freshWorld(); const p = '+919812345678';
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  await w.staff(o.id, 'ACCEPTED');   // produces a KOT containing the name + masked phone
  const cid = (await w.customerId(p))!;
  await eraseCustomer(w.scope, cid);

  const { rows: cols } = await w.db.execute(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text','jsonb') AND table_name <> '_migrations';`);
  const hits: string[] = [];
  for (const c of cols as any[]) {
    const { rows } = await w.db.execute(
      `SELECT count(*)::int AS n FROM "${c.table_name}"
       WHERE "${c.column_name}"::text LIKE '%9812345678%' OR "${c.column_name}"::text LIKE '%Eval Customer%';`);
    if (rows[0].n > 0) hits.push(`${c.table_name}.${c.column_name}`);
  }
  t.eq(hits, [], 'no column still holds the phone or name');
});

/* ───────────── analytics & metering ───────────── */

suite.case('B21', 'an escalated chat is not counted as "handled by AI"', async (t) => {
  const w = await freshWorld();
  await w.say(newPhone(), "I'm allergic to nuts, what can I eat?");
  const after = await dashboardStats(w.scope, TZ);
  t.gte(after.humanHandoffRate, 0.01, 'escalation counts as a handoff');
  t.ok(after.aiContainmentRate < 1, 'containment is not 100% when a chat was escalated', after.aiContainmentRate);
});

suite.case('B22', 'outbound WhatsApp messages are metered (they are what Meta bills)', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const usage = await usageForPeriod(w.scope, new Date().toISOString().slice(0, 7));
  t.gte(usage.wa_messages_out ?? 0, 2, 'outbound messages counted');
});

suite.case('B23', '"Orders today" counts confirmed orders still in the kitchen', async (t) => {
  const w = await freshWorld();
  const before = (await dashboardStats(w.scope, TZ)).ordersToday;
  const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  t.eq((await dashboardStats(w.scope, TZ)).ordersToday, before + 1, 'a RECEIVED order counts today');
});

/* ───────────── scale ───────────── */

suite.case('B24', 'sign-in works for the 600th user (no hidden row cap)', async (t) => {
  const w = await freshWorld();
  const hash = hashPassword('longpassword1');
  const values: string[] = []; const params: string[] = [];
  for (let i = 0; i < 600; i++) {
    params.push(`usr_bulk_${i}`, `bulk${i}@example.com`, hash);
    values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length}, 'Bulk')`);
  }
  await w.db.execute(`INSERT INTO users (id, email, password_hash, name) VALUES ${values.join(',')};`, params);
  const { user } = await signIn('bulk599@example.com', 'longpassword1');
  t.eq(user.email, 'bulk599@example.com', 'signed in');
});

suite.case('B25', 'duplicate email is refused cleanly even with 600 users', async (t) => {
  const w = await freshWorld();
  const hash = hashPassword('longpassword1');
  const values: string[] = []; const params: string[] = [];
  for (let i = 0; i < 600; i++) {
    params.push(`usr_bulk_${i}`, `bulk${i}@example.com`, hash);
    values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length}, 'Bulk')`);
  }
  await w.db.execute(`INSERT INTO users (id, email, password_hash, name) VALUES ${values.join(',')};`, params);
  let message = '';
  try {
    await signUp({ email: 'BULK599@example.com', password: 'longpassword1', name: 'x', organizationName: 'x', restaurantName: 'x' });
  } catch (err: any) { message = err.message; }
  t.includes(message, /already exists/i, 'clear duplicate-account error, not a database crash');
});

/* ───────────── promotions ───────────── */

suite.case('B26', 'first-order-only promotion applies to a new customer and not a returning one', async (t) => {
  const w = await freshWorld();
  await w.db.execute(`UPDATE promotions SET is_active = false WHERE restaurant_id = $1;`, [w.restaurantId]);
  await w.db.execute(
    `INSERT INTO promotions (id, restaurant_id, name, type, value, first_order_only, is_active)
     VALUES ($1,$2,'Welcome 20%','PERCENT_OFF',2000,true,true);`, [newId('pro'), w.restaurantId]);
  const fresh = newPhone();
  await w.say(fresh, '2 coke and 1 garlic naan');
  t.eq((await w.latestOrder(fresh))?.discountCents, 3800, 'new customer gets 20% of 190');
  await w.say('+919876500003', '2 coke and 1 garlic naan');   // seeded regular with 10 orders
  t.eq((await w.latestOrder('+919876500003'))?.discountCents, 0, 'returning customer does not');
});

/* ───────────── tenancy at the service layer ───────────── */

suite.case('B27', "tenant B cannot change tenant A's item availability; A's own toggle still works", async (t) => {
  const w = await freshWorld();
  const b = await signUp({ email: 'b@tenant.test', password: 'tenantbpass1', name: 'B', organizationName: 'B', restaurantName: 'B Kitchen' });
  const scopeB = { ...systemScope(b.restaurantId), role: 'OWNER' as const };
  const naan = await w.itemId('Garlic Naan');
  let refused = false;
  try { await setAvailability(scopeB, w.locationId, { menuItemId: naan }, 'SOLD_OUT'); } catch { refused = true; }
  t.ok(refused, 'foreign location/item is refused');
  await setAvailability(w.scope, w.locationId, { menuItemId: naan }, 'SOLD_OUT');
  const item = (await w.menu()).find((i) => i.id === naan)!;
  t.eq(item.availability, 'SOLD_OUT', "A's own sold-out toggle takes effect");
});

void L; void linesOf;
