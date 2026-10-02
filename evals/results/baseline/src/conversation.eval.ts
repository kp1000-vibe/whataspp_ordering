/**
 * Multi-turn conversation evals. Each case gets a fresh restaurant so that
 * sold-out items, pauses or full slots in one case cannot leak into another.
 */
import { Suite } from './harness';
import { freshWorld, newPhone, expectDraft, expectNoPriceableOrder, linesOf, L, TZ, BUSINESS, istAt } from './fixtures';
import { formatLocalTime } from '../src/lib/time';
import { MockProvider } from '../src/server/messaging/mock';
import { ingestInbound } from '../src/server/messaging/inbound';
import { drain } from '../src/server/queue/queue';
import { setHandledBy } from '../src/server/conversations/service';
import { delayOrder } from '../src/server/notifications/customer';
import { setAvailability } from '../src/server/menu/service';
import { newId } from '../src/lib/ids';

export const suite = new Suite('conversation');

const TIME_RE = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g;
const times = (s: string) => s.match(TIME_RE) ?? [];

/* ───────────── the spec's own worked examples ───────────── */

suite.case('CV01', 'spec §6: one chicken biryani → asks spice → "Spicy" → total + pickup → "yes"', async (t) => {
  const w = await freshWorld();
  const p = newPhone();

  const r1 = await w.say(p, 'One chicken biryani.');
  t.includes(r1, /regular|spicy/i, 'asks for the spice level');
  await expectNoPriceableOrder(t, w, p);

  const r2 = await w.say(p, 'Spicy');
  const draft = await expectDraft(t, w, p, [L('Chicken Biryani', 1, ['Spicy'])]);
  t.includes(r2, '₹252.00', 'quotes total (240 + 5% tax)');
  t.eq(times(r2).length > 0, true, 'quotes a pickup time');

  const r3 = await w.say(p, 'yes');
  const order = await w.latestOrder(p);
  t.eq(order?.status, 'RECEIVED', 'order is with the restaurant');
  t.includes(r3, /Confirmed/i);
  t.eq(r3.split('\n---\n').length, 1, 'exactly one message on confirmation');

  const promised = order?.promisedReadyAt ? formatLocalTime(order.promisedReadyAt, TZ) : null;
  t.eq(times(r2).at(-1), promised, 'time quoted BEFORE confirming = time promised');
  t.eq(times(r3).at(-1), promised, 'time in confirmation = time promised');
  void draft;
});

suite.case('CV02', "spec §1: '2 chicken biryani, one spicy, 2 Coke. I'll pick it up around 8'", async (t) => {
  const w = await freshWorld();
  const p = newPhone();
  const r1 = await w.say(p, "2 chicken biryani, one spicy, 2 Coke. I'll pick it up around 8");
  await expectDraft(t, w, p, [
    L('Chicken Biryani', 1, ['Spicy']), L('Chicken Biryani', 1, ['Regular']), L('Coke', 2),
  ]);
  t.includes(r1, '8:00 PM', 'honours the requested 8 PM');
  const r2 = await w.say(p, 'yes');
  const order = await w.latestOrder(p);
  t.eq(order?.promisedReadyAt ? formatLocalTime(order.promisedReadyAt, TZ) : null, '8:00 PM', 'promised 8:00 PM');
  t.includes(r2, '8:00 PM', 'confirmation repeats 8:00 PM');
});

/* ───────────── editing a draft ───────────── */

suite.case('CV03', 'add then "actually remove the naan"', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await w.say(p, 'actually remove the naan');
  await expectDraft(t, w, p, [L('Coke', 2)]);
});

suite.case('CV04', '"remove 1 coke" reduces quantity instead of deleting the line', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '3 coke');
  await w.say(p, 'remove 1 coke');
  await expectDraft(t, w, p, [L('Coke', 2)]);
});

suite.case('CV05', '"make it 3 cokes" sets the quantity (does not add 3 more)', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await w.say(p, 'make it 3 cokes');
  await expectDraft(t, w, p, [L('Coke', 3), L('Garlic Naan', 1)]);
});

suite.case('CV06', '"make it spicy" changes the modifier on the dish', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '1 chicken biryani regular and 1 coke');
  await w.say(p, 'make it spicy');
  await expectDraft(t, w, p, [L('Chicken Biryani', 1, ['Spicy']), L('Coke', 1)]);
});

suite.case('CV07', '"actually add a coke" adds to the draft', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '1 chicken biryani regular');
  await w.say(p, 'actually add a coke');
  await expectDraft(t, w, p, [L('Chicken Biryani', 1, ['Regular']), L('Coke', 1)]);
});

/* ───────────── cancelling ───────────── */

suite.case('CV08', '"cancel" on a draft cancels it', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke');
  const r = await w.say(p, 'cancel');
  t.eq((await w.latestOrder(p))?.status, 'CANCELLED', 'draft cancelled');
  t.includes(r, /cancel/i);
});

suite.case('CV09', 'cancel after the kitchen started → not cancelled, handed to staff', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  await w.staff(o.id, 'ACCEPTED'); await w.staff(o.id, 'PREPARING');
  const r = await w.say(p, 'cancel my order');
  t.eq((await w.latestOrder(p))?.status, 'PREPARING', 'order not cancelled');
  t.includes(r, /already being prepared/i);
  t.eq((await w.conversationFor(p))?.handled_by, 'STAFF', 'handed to staff');
});

suite.case('CV10', 'cancel after confirming but before cooking → cancelled', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  await w.say(p, 'cancel my order');
  t.eq((await w.latestOrder(p))?.status, 'CANCELLED', 'cancelled');
});

/* ───────────── "same as last time" ───────────── */

suite.case('CV11', 'seeded regular (history lacks the spice choice) → shows usual and asks spice', async (t) => {
  const w = await freshWorld();
  const rahul = '+919876500001';            // seed: history of Chicken Biryani + Coke, no modifiers
  const r = await w.say(rahul, 'same as last time');
  t.includes(r, 'Chicken Biryani');
  t.includes(r, 'Coke');
  t.includes(r, /spice level|regular or spicy/i, 'asks the missing required choice');
  t.excludes(r, /Your usual is:\s*\n\s*\n/, 'usual is never shown as an empty list');
});

suite.case('CV12', 'repeat reproduces the exact previous order including modifiers', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '1 mutton biryani extra spicy with extra raita and 2 coke'); await w.say(p, 'yes');
  const first = (await w.latestOrder(p))!;
  for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED']) await w.staff(first.id, s);
  await w.say(p, 'same as last time');
  await expectDraft(t, w, p, [L('Mutton Biryani', 1, ['Extra Spicy', 'Extra Raita']), L('Coke', 2)]);
});

suite.case('CV13', 'repeat when an item is now sold out → tells the customer', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const first = (await w.latestOrder(p))!;
  for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED']) await w.staff(first.id, s);
  await setAvailability(w.scope, w.locationId, { menuItemId: await w.itemId('Garlic Naan') }, 'SOLD_OUT');
  const r = await w.say(p, 'same as last time');
  t.includes(r, /Garlic Naan/);
  t.includes(r, /sold out|unavailable/i);
});

/* ───────────── status & privacy ───────────── */

suite.case('CV14', '"where is my order?" after confirming → reports that order', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  const r = await w.say(p, 'where is my order?');
  t.includes(r, `#${o.orderNumber}`);
});

suite.case('CV15', "one customer cannot see another customer's order by number", async (t) => {
  const w = await freshWorld(); const a = newPhone(); const b = newPhone();
  await w.say(a, '2 coke and 1 garlic naan'); await w.say(a, 'yes');
  const o = (await w.latestOrder(a))!;
  const r = await w.say(b, `what is the status of order ${o.orderNumber}?`);
  t.excludes(r, `#${o.orderNumber} is`, "does not report someone else's order");
  t.excludes(r, '₹', 'does not reveal amounts');
});

/* ───────────── human handoff ───────────── */

suite.case('CV16', 'staff takeover silences the AI; hand-back resumes it', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, 'hi');
  const conv = await w.conversationFor(p);
  await setHandledBy(w.scope, conv.id, 'STAFF', null);
  t.eq(await w.say(p, '2 coke'), '', 'AI silent while staff hold the chat');
  await setHandledBy(w.scope, conv.id, 'AI', null);
  t.ok((await w.say(p, '2 coke')).length > 0, 'AI answers after hand-back');
});

suite.case('CV17', 'allergy escalation hands the chat to staff and the AI stays out', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, "I'm allergic to nuts, what can I eat?");
  t.eq(await w.say(p, '2 coke'), '', 'AI stays silent after escalating');
});

/* ───────────── voice & media ───────────── */

suite.case('CV18', 'Hinglish voice note becomes the right order, tagged as voice', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.voice(p, 'Bhai do chicken biryani dena, ek spicy aur ek normal, aur ek coke', 0.9);
  const o = await expectDraft(t, w, p, [
    L('Chicken Biryani', 1, ['Spicy']), L('Chicken Biryani', 1, ['Regular']), L('Coke', 1)]);
  t.eq(o?.channel, 'WHATSAPP_VOICE', 'channel recorded as voice');
});

suite.case('CV19', 'low-confidence transcript → reads it back and asks', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r = await w.voice(p, '2 coke and 1 garlic naan', 0.6);
  t.includes(r, /I heard/i);
});

suite.case('CV20', 'untranscribable voice note → asks the customer to type', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r = await w.voice(p, null);
  t.includes(r, /couldn't make out|type/i);
  await expectNoPriceableOrder(t, w, p);
});

suite.case('CV21', 'photo message → polite "please type", no crash', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r = await w.image(p);
  t.includes(r, /type/i);
});

suite.case('CV22', 'Meta re-delivers the same message → one order, one reply', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const body = MockProvider.inboundTextBody({ from: p, to: BUSINESS, text: '2 coke and 1 garlic naan', id: 'wamid.dup1' });
  const before = w.mock.outbox.length;
  await ingestInbound(w.restaurantId, w.mock.parseWebhook(body).messages);
  await ingestInbound(w.restaurantId, w.mock.parseWebhook(body).messages);
  await drain();
  t.eq((await w.ordersFor(p)).length, 1, 'one order');
  t.eq(w.mock.outbox.slice(before).filter((m) => m.to === p).length, 1, 'one reply');
});

/* ───────────── confirmations & acknowledgements ───────────── */

suite.case('CV23', '👍 confirms a ready draft', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await w.say(p, '👍');
  t.eq((await w.latestOrder(p))?.status, 'RECEIVED', 'confirmed');
});

suite.case('CV24', '"ok" after the order is confirmed → friendly acknowledgement', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const r = await w.say(p, 'ok');
  t.ok(r.length > 0, 'replies');
  t.excludes(r, /don't have an order ready/i);
});

/* ───────────── pickup times ───────────── */

suite.case('CV25', 'draft then "can I pick it up at 8?" → rescheduled to 8:00 PM', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  const r = await w.say(p, 'can I pick it up at 8?');
  const o = await w.latestOrder(p);
  t.eq(o?.promisedReadyAt ? formatLocalTime(o.promisedReadyAt, TZ) : null, '8:00 PM', 'draft moved to 8 PM');
  t.includes(r, '8:00 PM');
});

suite.case('CV26', 'pickup time first, then the order → time is remembered', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r1 = await w.say(p, "I'll come at 8:30");
  t.includes(r1, /what would you like/i);
  await w.say(p, '2 coke and 1 garlic naan');
  const o = await w.latestOrder(p);
  t.eq(o?.promisedReadyAt ? formatLocalTime(o.promisedReadyAt, TZ) : null, '8:30 PM', 'uses the 8:30 PM request');
});

suite.case('CV27', 'requested slot full → offered alternative → "yes" books THAT alternative', async (t) => {
  const w = await freshWorld();
  const probe = newPhone();
  await w.say(probe, "2 coke and 1 garlic naan, I'll pick it up at 8");
  const probeOrder = (await w.latestOrder(probe))!;
  const slot = probeOrder.pickupSlotStart!;
  const cust = (await w.customerId(probe))!;
  for (let i = 0; i < 8; i++) {
    await w.db.execute(
      `INSERT INTO orders (id, restaurant_id, location_id, customer_id, order_number, status, channel,
         subtotal_cents, discount_cents, tax_cents, total_cents, prep_minutes, promised_ready_at,
         pickup_slot_start, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'RECEIVED','WHATSAPP_TEXT',10000,0,500,10500,20,$6,$7,'fill');`,
      [newId('ord'), w.restaurantId, w.locationId, cust, 5000 + i, probeOrder.promisedReadyAt!.toISOString(), slot.toISOString()]);
  }
  const p = newPhone();
  const r1 = await w.say(p, "2 coke and 1 garlic naan, I'll pick it up at 8");
  t.includes(r1, /full/i, 'says 8 PM is full');
  const offered = times(r1).filter((x) => x !== '8:00 PM').at(-1);
  t.ok(!!offered, 'offers a different time', r1);
  const r2 = await w.say(p, 'yes');
  const o = await w.latestOrder(p);
  t.eq(o?.status, 'RECEIVED', 'confirmed');
  t.eq(o?.promisedReadyAt ? formatLocalTime(o.promisedReadyAt, TZ) : null, offered ?? '(none)', 'booked the offered time');
  t.includes(r2, offered ?? '(none)');
});

/* ───────────── promotions ───────────── */

suite.case('CV28', 'a typed promo code is applied', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.db.execute(
    `INSERT INTO promotions (id, restaurant_id, code, name, type, value, min_subtotal_cents, is_active)
     VALUES ($1,$2,'SAVE50','Rs 50 off','FIXED_OFF',5000,0,true);`, [newId('pro'), w.restaurantId]);
  const r = await w.say(p, '2 coke and 1 garlic naan, code SAVE50');
  const o = await expectDraft(t, w, p, [L('Coke', 2), L('Garlic Naan', 1)]);
  t.eq(o?.discountCents, 5000, 'Rs 50 discount applied');
  t.includes(r, '-₹50.00');
});

/* ───────────── consent vs transactional ───────────── */

suite.case('CV29', 'opted-out customer still gets transactional order messages', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, 'STOP');
  await w.say(p, '2 coke and 1 garlic naan');
  const r = await w.say(p, 'yes');
  t.includes(r, /Confirmed/i);
});

/* ───────────── after confirmation ───────────── */

suite.case('CV30', '"also add a coke" after confirming → a separate new order, first untouched', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const first = (await w.latestOrder(p))!;
  const r = await w.say(p, 'also add 2 more coke');
  const after = await w.ordersFor(p);
  t.eq(linesOf(after.find((o) => o.id === first.id)!), [L('Coke', 2), L('Garlic Naan', 1)], 'confirmed order unchanged');
  t.includes(r, /new order|separate/i, 'tells the customer it is a new order');
});

suite.case('CV31', 'Hinglish customer gets Hinglish confirmation', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, 'do coke aur ek garlic naan dena');
  const r = await w.say(p, 'haan');
  t.includes(r, /Aapka order/);
});

/* ───────────── kitchen → customer notifications ───────────── */

suite.case('CV32', 'kitchen PREPARING and READY each send exactly one message', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  await w.staff(o.id, 'ACCEPTED');
  const prep = await w.repliesDuring(p, () => w.staff(o.id, 'PREPARING'));
  const ready = await w.repliesDuring(p, () => w.staff(o.id, 'READY'));
  t.eq(prep.split('\n---\n').filter(Boolean).length, 1, 'one "preparing" message');
  t.includes(prep, /prepared/i);
  t.eq(ready.split('\n---\n').filter(Boolean).length, 1, 'one "ready" message');
  t.includes(ready, /ready/i);
});

suite.case('CV33', 'running late: customer is told the new time', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  const r = await w.repliesDuring(p, () => delayOrder(w.scope, o.id, 15));
  const after = (await w.latestOrder(p))!;
  t.includes(r, formatLocalTime(after.promisedReadyAt!, TZ), 'message carries the new time');
  t.eq(after.promisedReadyAt!.getTime() - o.promisedReadyAt!.getTime(), 15 * 60_000, 'promise moved 15 min');
});

suite.case('CV34', 'conversation audit: the order links to the full transcript', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan'); await w.say(p, 'yes');
  const o = (await w.latestOrder(p))!;
  t.ok(!!o.conversationId, 'order has a conversation id');
  const { rows } = await w.db.execute(
    `SELECT direction, author_type FROM conversation_messages WHERE conversation_id = $1;`, [o.conversationId]);
  t.gte(rows.filter((r: any) => r.direction === 'INBOUND').length, 2, 'customer messages kept');
  t.gte(rows.filter((r: any) => r.direction === 'OUTBOUND').length, 2, 'replies kept');
});

void istAt;
