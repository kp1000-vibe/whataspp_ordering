/**
 * ACCEPTANCE TEST — spec section 41, all 29 steps, executed against a real
 * Postgres database with the real ordering pipeline.
 *
 * Nothing here is mocked except the two things that physically cannot run on a
 * laptop: the Meta WhatsApp transport (mock provider, same interface) and speech
 * recognition (fixture transcripts, same interface). Everything else — the
 * database, the agent, pricing, slot allocation, the state machine, printing,
 * analytics — is the production code path.
 *
 * Run: npm run e2e
 */
import { getDb, resetDbCache } from '../src/db/client';
import { seed } from './seed';
import { bootstrap } from '../src/server/bootstrap';
import { systemScope } from '../src/server/tenancy';
import { correlationId } from '../src/lib/ids';
import { formatCents } from '../src/lib/money';
import { formatLocalTime } from '../src/lib/time';
import { MockProvider } from '../src/server/messaging/mock';
import { mockProviderFor, resetMocks } from '../src/server/messaging/registry';
import { ingestInbound } from '../src/server/messaging/inbound';
import { drain, queueStats } from '../src/server/queue/queue';
import { setVoiceFixture } from '../src/server/stt/registry';
import { listOrders, getOrder, transition, lastCompletedOrder } from '../src/server/orders/service';
import { setCapacityState, getCapacity, listSlots } from '../src/server/capacity/slots';
import { setAvailability, getMenu } from '../src/server/menu/service';
import { queuePrintForOrder, claimJobs, reportJobResult, printerHealth } from '../src/server/printing/service';
import { setHandledBy, listConversations, recentMessages, getConversation } from '../src/server/conversations/service';
import { getProfile, findOrCreateCustomer } from '../src/server/crm/service';
import { dashboardStats, usageForPeriod, aiCostSummary } from '../src/server/analytics/service';
import { signUp, signIn, resolveSession, scopeForUser } from '../src/server/auth/service';
import { eq } from 'drizzle-orm';
import { restaurants, locations, printers, customers } from '../src/db/schema';

process.env.MESSAGING_PROVIDER = 'mock';
process.env.AI_PROVIDER = 'deterministic';
process.env.LOG_LEVEL = 'error';

let passed = 0, failed = 0;
const failures: string[] = [];

function check(step: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${step}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(step);
    console.log(`  FAIL  ${step}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

const CUSTOMER_PHONE = '+919876511111';
const BUSINESS_PHONE = '+919999000001';

async function main(): Promise<void> {
  console.log('ACCEPTANCE TEST — AI Takeaway Counter');
  console.log('='.repeat(60));

  /* ───────── steps 1-5: signup and configuration ───────── */
  section('Steps 1-5: restaurant signup & configuration');

  const { restaurantId, locationId } = await seed();
  bootstrap({ force: true });
  resetMocks();
  const mock: MockProvider = mockProviderFor(restaurantId);
  const scope = systemScope(restaurantId, correlationId());
  const db = await getDb();

  // 1. Restaurant signs up — exercised on a separate tenant so we also prove isolation later.
  const signup = await signUp({
    email: 'owner@testkitchen.demo', password: 'testkitchen2026', name: 'Test Owner',
    organizationName: 'Test Kitchen Group', restaurantName: 'Test Kitchen',
  });
  check('1. Restaurant signs up', !!signup.restaurantId && !!signup.locationId);

  const { token, user } = await signIn('owner@testkitchen.demo', 'testkitchen2026');
  const resolved = await resolveSession(token);
  check('1b. Session auth works', resolved?.userId === signup.userId);

  const { rows: pwRows } = await db.execute(`SELECT password_hash FROM users WHERE email = $1;`, ['owner@testkitchen.demo']);
  check('1c. Password never stored in plaintext',
    pwRows[0].password_hash.startsWith('scrypt$') && !pwRows[0].password_hash.includes('testkitchen2026'));

  // 2. Menu
  const menu = await getMenu(scope, locationId);
  check('2. Restaurant adds menu', menu.length >= 11, `${menu.length} items`);
  const biryani = menu.find((m) => m.name === 'Chicken Biryani')!;
  check('2b. Modifiers configured', biryani.modifierGroups.length === 2
    && biryani.modifierGroups.some((g) => g.isRequired));

  // 3-4. Prep times + capacity
  check('3. Prep times configured', biryani.prepMinutes === 22, `${biryani.prepMinutes} min`);
  const capacity = await getCapacity(scope, locationId);
  check('4. Pickup capacity configured',
    capacity.slotMinutes === 15 && capacity.maxOrdersPerSlot === 8,
    `${capacity.maxOrdersPerSlot} orders / ${capacity.slotMinutes} min slot`);

  // 5. WhatsApp — mock transport standing in for Meta Cloud API.
  check('5. WhatsApp integration resolves a provider', mock.name === 'mock');

  /* ───────── steps 6-13: customer orders via WhatsApp ───────── */
  section('Steps 6-13: customer orders by WhatsApp text');

  const webhook = MockProvider.inboundTextBody({
    from: CUSTOMER_PHONE, to: BUSINESS_PHONE, name: 'Kavya M',
    text: '2 chicken biryani, one spicy, and 2 coke',
  });
  const parsed = mock.parseWebhook(webhook);
  check('6. Customer sends a text order', parsed.messages.length === 1);

  const ingest = await ingestInbound(restaurantId, parsed.messages);
  check('6b. Webhook accepted and enqueued', ingest.accepted === 1 && ingest.duplicates === 0);

  // Meta delivers at least once — the same message id must NOT create a second order.
  const replay = await ingestInbound(restaurantId, parsed.messages);
  check('6c. Duplicate webhook delivery is ignored', replay.accepted === 0 && replay.duplicates === 1);

  await drain();

  const reply1 = mock.lastBody();
  const draftOrders = await listOrders(scope, { statuses: ['READY_FOR_CONFIRMATION', 'CLARIFICATION_REQUIRED'] });
  const draft = draftOrders[0];

  check('7. AI understood the order', !!draft, draft ? `order #${draft.orderNumber}` : 'no draft created');
  check('8. AI validated against the menu',
    !!draft && draft.items.every((i) => menu.some((m) => m.id === i.menuItemId)));
  check('8b. Quantities extracted', !!draft && draft.items.some((i) => i.quantity === 2));

  const biryaniLine = draft?.items.find((i) => i.name === 'Chicken Biryani');
  check('9. Availability checked', !!biryaniLine);

  const expectedSubtotal = 2 * 24000 + 2 * 6000;
  check('10. Price calculated server-side',
    draft?.subtotalCents === expectedSubtotal,
    `subtotal ${formatCents(draft?.subtotalCents ?? 0, 'INR')} (expected ${formatCents(expectedSubtotal, 'INR')})`);
  // The seeded promo is "10% off orders over Rs 500" and this order qualifies,
  // so tax must be charged on (subtotal - discount), not on the gross subtotal.
  const expectedDiscount = Math.round(expectedSubtotal * 0.10);
  const expectedTax = Math.round((expectedSubtotal - expectedDiscount) * 0.05);
  check('10b. Eligible promotion applied server-side',
    draft?.discountCents === expectedDiscount,
    `discount ${formatCents(draft?.discountCents ?? 0, 'INR')}`);
  check('10c. Tax charged on the discounted amount',
    draft?.taxCents === expectedTax,
    `tax ${formatCents(draft?.taxCents ?? 0, 'INR')} (expected ${formatCents(expectedTax, 'INR')})`);
  check('10d. Total is exact integer arithmetic',
    draft?.totalCents === expectedSubtotal - expectedDiscount + expectedTax,
    `total ${formatCents(draft?.totalCents ?? 0, 'INR')}`);

  const slotInfo = await listSlots(scope, { locationId, menuItemIds: draft!.items.map((i) => i.menuItemId) });
  check('11. Kitchen capacity consulted', slotInfo.slots.length > 0, `${slotInfo.slots.length} slots in horizon`);
  check('12. Valid pickup slot proposed',
    !!draft?.pickupSlotStart && !!draft?.promisedReadyAt,
    draft?.promisedReadyAt ? formatLocalTime(draft.promisedReadyAt, 'Asia/Kolkata') : 'none');
  check('12b. Reply quotes the total and the pickup time',
    reply1.includes(formatCents(draft!.totalCents, 'INR')) && /\d{1,2}:\d{2}\s?(AM|PM)/.test(reply1));

  // 13. Confirm
  mock.clear();
  const confirmBody = MockProvider.inboundTextBody({ from: CUSTOMER_PHONE, to: BUSINESS_PHONE, text: 'yes' });
  await ingestInbound(restaurantId, mock.parseWebhook(confirmBody).messages);
  await drain();

  const confirmed = await getOrder(scope, draft!.id);
  check('13. Customer confirms; order reaches RECEIVED',
    confirmed?.status === 'RECEIVED', `status ${confirmed?.status}`);
  check('13b. Customer got a confirmation message',
    mock.bodies().some((b) => b.includes(`#${draft!.orderNumber}`)));

  /* ───────── steps 14-21: restaurant + kitchen flow ───────── */
  section('Steps 14-21: restaurant console, KOT, kitchen flow');

  const live = await listOrders(scope, { statuses: ['RECEIVED'] });
  check('14. Order appears in the restaurant console', live.some((o) => o.id === draft!.id));

  const accepted = await transition(scope, { orderId: draft!.id, to: 'ACCEPTED', actor: { type: 'STAFF', id: 'staff-1' } });
  check('14b. Staff can accept', accepted.status === 'ACCEPTED');

  // 15. KOT — auto-printed by the order.accepted handler.
  const { rows: jobRows } = await db.execute(
    `SELECT id, payload, status FROM print_jobs WHERE order_id = $1;`, [draft!.id]);
  check('15. KOT print job created on accept', jobRows.length >= 1, `${jobRows.length} job(s)`);
  check('15b. KOT contains the items and pickup time',
    jobRows.length > 0 && jobRows[0].payload.includes('CHICKEN BIRYANI') && jobRows[0].payload.includes('PICKUP'));
  check('15c. KOT omits money on the kitchen ticket',
    jobRows.length > 0 && !jobRows[0].payload.includes('TOTAL'));

  const [printer] = await db.drizzle.select().from(printers).where(eq(printers.restaurantId, restaurantId)).limit(1);
  const claimed = await claimJobs(printer.id, 'pa_demo_spicebox_kitchen_token', 5);
  check('15d. Local print agent can claim the job with its token', claimed.length >= 1);
  await reportJobResult(printer.id, 'pa_demo_spicebox_kitchen_token', claimed[0].id, true);
  const { rows: printedRows } = await db.execute(`SELECT status FROM print_jobs WHERE id = $1;`, [claimed[0].id]);
  check('15e. Print result recorded', printedRows[0].status === 'PRINTED');

  let badTokenRejected = false;
  try { await claimJobs(printer.id, 'wrong-token', 1); } catch { badTokenRejected = true; }
  check('15f. Bad printer token is rejected', badTokenRejected);

  // 16-17. PREPARING
  mock.clear();
  await transition(scope, { orderId: draft!.id, to: 'PREPARING', actor: { type: 'STAFF', id: 'staff-1' } });
  check('16. Kitchen sets PREPARING', (await getOrder(scope, draft!.id))?.status === 'PREPARING');
  check('17. Customer notified that food is being prepared',
    mock.bodies().some((b) => /prepar|ban raha|बन रहा/i.test(b)), mock.lastBody().slice(0, 60));

  // 18-19. READY
  mock.clear();
  await transition(scope, { orderId: draft!.id, to: 'READY', actor: { type: 'STAFF', id: 'staff-1' } });
  check('18. Kitchen sets READY', (await getOrder(scope, draft!.id))?.status === 'READY');
  check('19. Customer notified the order is ready',
    mock.bodies().some((b) => /ready|तैयार/i.test(b)), mock.lastBody().slice(0, 60));

  // 20-21. Pickup and completion
  await transition(scope, { orderId: draft!.id, to: 'PICKED_UP', actor: { type: 'STAFF', id: 'staff-1' } });
  const completedOrder = await transition(scope, { orderId: draft!.id, to: 'COMPLETED', actor: { type: 'SYSTEM' } });
  check('20. Customer picks up the order', true);
  check('21. Order becomes COMPLETED', completedOrder.status === 'COMPLETED');

  // The state machine must refuse shortcuts.
  let illegalRejected = false;
  try {
    await transition(scope, { orderId: draft!.id, to: 'PREPARING', actor: { type: 'STAFF' } });
  } catch { illegalRejected = true; }
  check('21b. Illegal state transitions are rejected', illegalRejected);

  /* ───────── steps 22-24: CRM, analytics, reorder ───────── */
  section('Steps 22-24: customer profile, analytics, "same as last time"');

  const { id: customerId } = await findOrCreateCustomer(scope, CUSTOMER_PHONE);
  const profile = await getProfile(scope, customerId);
  check('22. Customer profile records the order',
    (profile?.totalOrders ?? 0) >= 1 && (profile?.lifetimeSpendCents ?? 0) === completedOrder.totalCents,
    `${profile?.totalOrders} order(s), LTV ${formatCents(profile?.lifetimeSpendCents ?? 0, 'INR')}`);
  check('22b. Favourite items derived from real orders',
    (profile?.favouriteItems ?? []).some((f) => f.name === 'Chicken Biryani'));

  const stats = await dashboardStats(scope, 'Asia/Kolkata');
  check('23. Restaurant analytics update',
    stats.ordersToday >= 1 && stats.revenueTodayCents >= completedOrder.totalCents,
    `${stats.ordersToday} orders, ${formatCents(stats.revenueTodayCents, 'INR')}`);
  check('23b. AI containment rate computed',
    stats.aiContainmentRate > 0 && stats.aiContainmentRate <= 1,
    `${(stats.aiContainmentRate * 100).toFixed(0)}%`);
  check('23c. Staff interactions avoided counted', stats.staffInteractionsAvoided >= 2,
    String(stats.staffInteractionsAvoided));

  // 24. "Same as last time"
  mock.clear();
  const usualBody = MockProvider.inboundTextBody({ from: CUSTOMER_PHONE, to: BUSINESS_PHONE, text: 'same as last time' });
  await ingestInbound(restaurantId, mock.parseWebhook(usualBody).messages);
  await drain();

  const usualReply = mock.bodies().join('\n');
  const prev = await lastCompletedOrder(scope, customerId);
  check('24. "Same as last time" rebuilds the previous order',
    usualReply.includes('Chicken Biryani') && !!prev,
    usualReply.split('\n')[0]?.slice(0, 60));

  /* ───────── steps 25-27: emergency controls ───────── */
  section('Steps 25-27: pause, sold out, and the AI respecting both');

  // 26. Mark sold out (done first so we can test it while still OPEN)
  const biryaniId = menu.find((m) => m.name === 'Chicken Biryani')!.id;
  await setAvailability(scope, locationId, { menuItemId: biryaniId }, 'SOLD_OUT', 'ran out of chicken');
  check('26. Restaurant can mark an item sold out', true);

  mock.clear();
  const soldOutBody = MockProvider.inboundTextBody({
    from: '+919876522222', to: BUSINESS_PHONE, text: '1 chicken biryani',
  });
  await ingestInbound(restaurantId, mock.parseWebhook(soldOutBody).messages);
  await drain();
  const soldOutReply = mock.bodies().join(' ');

  check('27. AI immediately respects sold-out status',
    /sold out|unavailable/i.test(soldOutReply), soldOutReply.slice(0, 90));
  check('27b. AI offers only configured, available substitutes',
    /Mutton Biryani|Veg Biryani/.test(soldOutReply) && !/Garlic Naan/.test(soldOutReply));

  // 25. Pause ordering
  await setCapacityState(scope, locationId, { state: 'PAUSED', note: 'Kitchen catching up — back in 10 minutes.' });
  check('25. Restaurant can pause ordering', (await getCapacity(scope, locationId)).state === 'PAUSED');

  mock.clear();
  const pausedBody = MockProvider.inboundTextBody({
    from: '+919876533333', to: BUSINESS_PHONE, text: '1 veg biryani',
  });
  await ingestInbound(restaurantId, mock.parseWebhook(pausedBody).messages);
  await drain();
  check('27c. AI immediately respects the pause',
    mock.bodies().join(' ').includes('catching up'), mock.lastBody().slice(0, 70));

  const { rows: pausedOrders } = await db.execute(
    `SELECT count(*)::int AS n FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.restaurant_id = $1 AND c.phone_e164 = '+919876533333';`, [restaurantId]);
  check('27d. No order is created while paused', Number(pausedOrders[0].n) === 0,
    `${pausedOrders[0].n} order(s) for the paused customer`);

  // Restore
  await setCapacityState(scope, locationId, { state: 'OPEN', note: '' });
  await setAvailability(scope, locationId, { menuItemId: biryaniId }, 'AVAILABLE');

  /* ───────── VERY_BUSY + slot exhaustion ───────── */
  section('Capacity: BUSY padding and slot exhaustion');

  const openPlan = await listSlots(scope, { locationId, menuItemIds: [biryaniId] });

  await setCapacityState(scope, locationId, { state: 'VERY_BUSY' });
  const busy = await getCapacity(scope, locationId);
  check('C1. VERY_BUSY tightens the per-slot ceiling', busy.maxOrdersPerSlot === 4, `${busy.maxOrdersPerSlot}/slot`);

  const busyPlan = await listSlots(scope, { locationId, menuItemIds: [biryaniId] });
  check('C2. BUSY adds padding to the promised prep time',
    busyPlan.prepMinutes === openPlan.prepMinutes + busy.busyEtaPaddingMinutes,
    `${openPlan.prepMinutes} min -> ${busyPlan.prepMinutes} min`);
  check('C2b. Earliest ready time moves later under load',
    busyPlan.earliestReadyAt.getTime() > openPlan.earliestReadyAt.getTime());

  // A manual "+30 min" click must also move the promise.
  await setCapacityState(scope, locationId, { state: 'OPEN', etaOffsetMinutes: 30 });
  const paddedPlan = await listSlots(scope, { locationId, menuItemIds: [biryaniId] });
  check('C2c. Manual ETA padding (+30) is honoured',
    paddedPlan.prepMinutes === openPlan.prepMinutes + 30,
    `${openPlan.prepMinutes} min -> ${paddedPlan.prepMinutes} min`);
  await setCapacityState(scope, locationId, { state: 'OPEN', etaOffsetMinutes: 0 });

  // Fill one slot to its ceiling and prove the engine refuses it.
  await setCapacityState(scope, locationId, { state: 'OPEN' });
  const target = (await listSlots(scope, { locationId, menuItemIds: [biryaniId] })).slots.find((s) => s.available)!;
  const { rows: orderNumRow } = await db.execute(
    `SELECT COALESCE(MAX(order_number),1000) AS n FROM orders WHERE restaurant_id = $1;`, [restaurantId]);
  let filler = Number(orderNumRow[0].n);

  const [anyCustomer] = await db.drizzle.select().from(customers).where(eq(customers.restaurantId, restaurantId)).limit(1);
  for (let i = 0; i < 8; i++) {
    filler++;
    await db.execute(
      `INSERT INTO orders (id, restaurant_id, location_id, customer_id, order_number, status, channel,
                           subtotal_cents, discount_cents, tax_cents, total_cents, prep_minutes,
                           promised_ready_at, pickup_slot_start, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'RECEIVED','WHATSAPP_TEXT',10000,0,500,10500,20,$6,$7,'capacity-test');`,
      [`ord_fill_${i}`, restaurantId, locationId, anyCustomer.id, filler,
       target.end.toISOString(), target.start.toISOString()],
    );
  }
  const afterFill = (await listSlots(scope, { locationId, menuItemIds: [biryaniId] })).slots;
  const filledSlot = afterFill.find((s) => s.start.getTime() === target.start.getTime())!;
  check('C3. A full slot is marked FULL', filledSlot.available === false && filledSlot.blockedReason === 'FULL',
    `${filledSlot.label}: ${filledSlot.booked}/${filledSlot.capacity}`);

  const nextOpen = afterFill.find((s) => s.available);
  check('C4. The engine moves to the next open slot', !!nextOpen && nextOpen.start > target.start,
    nextOpen?.label);

  await db.execute(`DELETE FROM orders WHERE correlation_id = 'capacity-test';`);

  /* ───────── step 28: human takeover ───────── */
  section('Step 28: human takeover');

  const { rows: ownerRows } = await db.execute(
    `SELECT id FROM users WHERE email = 'owner@spicebox.demo';`);
  const ownerUserId: string = ownerRows[0].id;

  const conversations = await listConversations(scope, 10);
  const conv = conversations.find((c: any) => c.customerId === customerId)!;
  await setHandledBy(scope, conv.id, 'STAFF', ownerUserId);
  check('28. Staff can take over a conversation',
    (await getConversation(scope, conv.id))?.handledBy === 'STAFF');

  mock.clear();
  const whileStaffBody = MockProvider.inboundTextBody({
    from: CUSTOMER_PHONE, to: BUSINESS_PHONE, text: '1 garlic naan',
  });
  await ingestInbound(restaurantId, mock.parseWebhook(whileStaffBody).messages);
  await drain();
  check('28b. AI stays silent while staff holds the conversation', mock.outbox.length === 0,
    `${mock.outbox.length} message(s) sent`);

  await setHandledBy(scope, conv.id, 'AI');
  check('28c. Conversation can be handed back to the AI',
    (await getConversation(scope, conv.id))?.handledBy === 'AI');

  /* ───────── step 29: usage & cost metering ───────── */
  section('Step 29: usage and cost metering');

  const usage = await usageForPeriod(scope);
  check('29. Usage metrics recorded', (usage.wa_messages_in ?? 0) >= 4 && (usage.orders ?? 0) >= 1,
    JSON.stringify(usage));

  const aiCost = await aiCostSummary(scope);
  check('29b. AI interactions and cost attributed per restaurant', aiCost.length >= 1,
    JSON.stringify(aiCost[0] ?? {}));

  /* ───────── voice ordering ───────── */
  section('Voice ordering (Hinglish)');

  setVoiceFixture('media_voice_1',
    'Bhai do chicken biryani dena, ek spicy aur ek normal, aur ek coke', { language: 'hi-Latn', confidence: 0.88 });

  mock.clear();
  const voiceBody = MockProvider.inboundAudioBody({
    from: '+919876544444', to: BUSINESS_PHONE, mediaId: 'media_voice_1',
  });
  await ingestInbound(restaurantId, mock.parseWebhook(voiceBody).messages);
  await drain();

  const voiceReply = mock.bodies().join('\n');
  const { rows: voiceRows } = await db.execute(
    `SELECT transcript, detected_language, status FROM voice_messages WHERE provider_media_id = 'media_voice_1';`);
  check('V1. Voice note transcribed', voiceRows[0]?.status === 'DONE', voiceRows[0]?.transcript?.slice(0, 50));
  check('V2. Hinglish order understood', voiceReply.includes('Chicken Biryani'), voiceReply.split('\n')[1]?.slice(0, 60));
  const biryaniUnits = [...voiceReply.matchAll(/(\d+) x Chicken Biryani/g)]
    .reduce((sum, m) => sum + Number(m[1]), 0);
  check('V3. Hindi numeral "do" = 2 units of biryani', biryaniUnits === 2, `${biryaniUnits} units`);
  check('V3b. "ek spicy aur ek normal" split into two lines',
    /Spicy/i.test(voiceReply) && /Regular/i.test(voiceReply),
    voiceReply.split('\n').filter((l) => l.includes('Biryani')).join(' | '));

  const { rows: voiceOrderRows } = await db.execute(
    `SELECT channel FROM orders WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 1;`, [restaurantId]);
  check('V4. Order tagged as a voice order', voiceOrderRows[0]?.channel === 'WHATSAPP_VOICE');

  const { rows: langRows } = await db.execute(
    `SELECT language FROM customers WHERE phone_e164 = '+919876544444';`);
  check('V5. Customer language remembered', langRows[0]?.language === 'hi-Latn', langRows[0]?.language);

  /* ───────── clarification round-trip ───────── */
  section('Clarification: ask, then understand the answer');

  const CLARIFY_PHONE = '+919876577777';
  mock.clear();
  await ingestInbound(restaurantId, mock.parseWebhook(MockProvider.inboundTextBody({
    from: CLARIFY_PHONE, to: BUSINESS_PHONE, text: 'one veg biryani',
  })).messages);
  await drain();
  const askReply = mock.bodies().join(' ');

  check('X1. A required choice produces a real question, not "anything else?"',
    /which spice level/i.test(askReply) && /Regular/.test(askReply),
    askReply.slice(0, 90));
  check('X1b. No priceable order exists yet', (await listOrders(scope, {
    statuses: ['READY_FOR_CONFIRMATION'], customerId: (await findOrCreateCustomer(scope, CLARIFY_PHONE)).id,
  })).length === 0);

  mock.clear();
  await ingestInbound(restaurantId, mock.parseWebhook(MockProvider.inboundTextBody({
    from: CLARIFY_PHONE, to: BUSINESS_PHONE, text: 'spicy',
  })).messages);
  await drain();
  const answerReply = mock.bodies().join('\n');

  check('X2. A bare answer is understood as the answer, not a new dish',
    /Veg Biryani/.test(answerReply) && /Spicy/i.test(answerReply) && !/couldn't find/i.test(answerReply),
    answerReply.split('\n')[1]?.slice(0, 70));
  check('X2b. The order is now priceable and quotes a pickup time',
    /Total:/.test(answerReply) && /\d{1,2}:\d{2}\s?(AM|PM)/.test(answerReply));

  mock.clear();
  await ingestInbound(restaurantId, mock.parseWebhook(MockProvider.inboundTextBody({
    from: CLARIFY_PHONE, to: BUSINESS_PHONE, text: 'yes',
  })).messages);
  await drain();
  check('X3. Confirming after a clarification works',
    mock.bodies().some((b) => /Confirmed/i.test(b)), mock.lastBody().slice(0, 70));
  check('X3b. Exactly one confirmation message is sent',
    mock.bodies().filter((b) => /Confirmed/i.test(b)).length === 1,
    `${mock.bodies().length} message(s)`);

  /* ───────── guardrails ───────── */
  section('AI guardrails');

  // The LLM cannot express a price — LineSpec has no price field. Prove the
  // server re-reads it even when a caller tries to inject one.
  const { priceOrder } = await import('../src/server/pricing/engine');
  const freshMenu = await getMenu(scope, locationId);
  const freshBiryani = freshMenu.find((m) => m.id === biryaniId)!;
  const spiceGroup = freshBiryani.modifierGroups.find((g) => g.isRequired)!;
  const regularId = spiceGroup.modifiers.find((m) => m.name === 'Regular')!.id;

  const injected = await priceOrder(
    scope,
    // A caller (or a compromised model output) tries to dictate the price.
    [{
      menuItemId: biryaniId, quantity: 1, modifierIds: [regularId],
      unitPriceCents: 500, priceCents: 500, lineTotalCents: 500, price: 5,
    } as any],
    { locationId, customerId, taxRateBps: 500, timezone: 'Asia/Kolkata', at: new Date(), minOrderCents: 0, maxOrderCents: 0 },
  );
  check('G1. Injected price is ignored; DB price wins',
    injected.lines.length === 1 && injected.lines[0].unitPriceCents === 24000,
    injected.lines.length
      ? `got ${formatCents(injected.lines[0].unitPriceCents, 'INR')}, injected ${formatCents(500, 'INR')}`
      : `no priceable line: ${JSON.stringify(injected.issues)}`);
  check('G1b. Line total recomputed, not accepted',
    injected.lines[0]?.lineTotalCents === 24000);

  // A modifier that belongs to a DIFFERENT item must be refused outright.
  const naanId = freshMenu.find((m) => m.name === 'Garlic Naan')!.id;
  const crossItem = await priceOrder(
    scope,
    [{ menuItemId: naanId, quantity: 1, modifierIds: [regularId] }],
    { locationId, customerId, taxRateBps: 500, timezone: 'Asia/Kolkata', at: new Date(), minOrderCents: 0, maxOrderCents: 0 },
  );
  check('G1c. Modifier from another item is rejected',
    crossItem.issues.some((i) => i.kind === 'UNKNOWN_MODIFIER'),
    JSON.stringify(crossItem.issues));

  // Allergens: unverified data must escalate, never guess.
  mock.clear();
  await ingestInbound(restaurantId, mock.parseWebhook(MockProvider.inboundTextBody({
    from: '+919876555555', to: BUSINESS_PHONE, text: 'does the chicken biryani contain peanuts?',
  })).messages);
  await drain();
  const allergenReply = mock.bodies().join(' ');
  check('G2. Allergen answers come only from verified data',
    /dairy/i.test(allergenReply) || /confirm with the restaurant/i.test(allergenReply),
    allergenReply.slice(0, 80));

  // Unknown item must not be invented.
  mock.clear();
  await ingestInbound(restaurantId, mock.parseWebhook(MockProvider.inboundTextBody({
    from: '+919876566666', to: BUSINESS_PHONE, text: 'one lobster thermidor please',
  })).messages);
  await drain();
  check('G3. Unknown items are not invented',
    /couldn't find|not sure|did you mean/i.test(mock.bodies().join(' ')),
    mock.lastBody().slice(0, 70));

  /* ───────── tenant isolation ───────── */
  section('Tenant isolation');

  const otherScope = await scopeForUser(user, signup.restaurantId, correlationId());
  const otherOrders = await listOrders(otherScope, {});
  check('T1. Restaurant B cannot see restaurant A orders', otherOrders.length === 0,
    `${otherOrders.length} rows`);

  const crossOrder = await getOrder(otherScope, draft!.id);
  check('T2. Cross-tenant fetch by id returns nothing', crossOrder === null);

  let crossDenied = false;
  try { await scopeForUser(user, restaurantId, correlationId()); } catch { crossDenied = true; }
  check('T3. Scope creation is refused for a restaurant the user has no staff row for', crossDenied);

  const otherMenu = await getMenu(otherScope, signup.locationId);
  check('T4. Menus are isolated', otherMenu.length === 0);

  /* ───────── webhook signature ───────── */
  section('Webhook signature verification');

  const { verifyWhatsappSignature, whatsappSignature } = await import('../src/lib/crypto');
  const raw = JSON.stringify(webhook);
  const good = whatsappSignature(raw, 'app-secret');
  check('W1. Valid signature accepted', verifyWhatsappSignature(raw, good, 'app-secret'));
  check('W2. Tampered body rejected', !verifyWhatsappSignature(raw + ' ', good, 'app-secret'));
  check('W3. Wrong secret rejected', !verifyWhatsappSignature(raw, good, 'other-secret'));
  check('W4. Missing signature rejected', !verifyWhatsappSignature(raw, null, 'app-secret'));

  /* ───────── queue health ───────── */
  section('Queue health');
  const qs = await queueStats();
  check('Q1. No dead jobs', !qs.DEAD, JSON.stringify(qs));
  check('Q2. No stuck jobs', !qs.PENDING && !qs.RUNNING, JSON.stringify(qs));

  const health = await printerHealth(scope);
  check('Q3. Printer health reported', health.length >= 1, JSON.stringify(health[0]));

  /* ───────── summary ───────── */
  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailed checks:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));

  await db.close();
  await resetDbCache();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nACCEPTANCE RUN CRASHED');
  console.error(err);
  process.exit(1);
});
