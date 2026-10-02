/**
 * HTTP evals against a running server (npm run eval:serve → :3100).
 * Cases run in order and share state; rate-limit cases live in a separate
 * suite that runs LAST so they cannot lock the other suites out.
 */
import { createHmac } from 'node:crypto';
import { Suite } from './harness';
import { Client, OWNER, KITCHEN, EVAL_APP_SECRET, EVAL_VERIFY_TOKEN, BASE } from './http-client';

export const suite = new Suite('http');
export const rateSuite = new Suite('http-ratelimit');

const owner = new Client();
const kitchen = new Client();
const tenantB = new Client();
const onboard = new Client();
const anon = new Client();

const state: Record<string, any> = {};

const PROTECTED = [
  '/api/orders', '/api/menu', '/api/customers', '/api/analytics', '/api/capacity',
  '/api/conversations', '/api/printers', '/api/me',
];

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', EVAL_APP_SECRET).update(body, 'utf8').digest('hex');
}

function inbound(from: string, text: string, id: string, to = '919999000001'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: to, phone_number_id: 'DEMO_PNID' },
      contacts: [{ profile: { name: 'HTTP Eval' }, wa_id: from.replace('+', '') }],
      messages: [{ from: from.replace('+', ''), id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
}

async function simulate(c: Client, phone: string, text: string) {
  const r = await c.post('/api/simulator', { phone, text });
  return { ...r, replies: (r.json?.replies ?? []).join('\n') as string };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/* ───────────── setup ───────────── */

suite.case('H00', 'server reachable; owner and kitchen can sign in', async (t) => {
  t.eq((await fetch(`${BASE}/login`)).status, 200, 'login page served');
  t.eq((await owner.signIn(OWNER.email, OWNER.password)).status, 200, 'owner signs in');
  t.eq((await kitchen.signIn(KITCHEN.email, KITCHEN.password)).status, 200, 'kitchen signs in');

  // A confirmed order and a conversation belonging to SpiceBox, used by later cases.
  await simulate(owner, '+919811100001', '2 coke and 1 garlic naan');
  await simulate(owner, '+919811100001', 'yes');
  const orders = (await owner.get('/api/orders?status=RECEIVED')).json?.orders ?? [];
  state.orderA = orders[0];
  const convs = (await owner.get('/api/conversations')).json?.conversations ?? [];
  state.convA = convs.find((c: any) => c.customer?.phone === '+919811100001');
  const menu = (await owner.get('/api/menu')).json;
  state.locationA = menu?.locationId;
  state.naanA = menu?.menu?.find((i: any) => i.name === 'Garlic Naan')?.id;
  state.customerA = ((await owner.get('/api/customers?q=9811100001')).json?.customers ?? [])[0];
  t.ok(!!state.orderA && !!state.convA && !!state.locationA && !!state.naanA && !!state.customerA, 'fixtures created');
});

/* ───────────── authentication ───────────── */

suite.case('HA01', 'every protected API refuses anonymous requests with 401', async (t) => {
  for (const path of PROTECTED) t.eq((await anon.get(path)).status, 401, `GET ${path}`);
});

suite.case('HA02', 'wrong password → 401 with a generic message', async (t) => {
  const r = await new Client().signIn(OWNER.email, 'not-the-password1');
  t.eq(r.status, 401, 'status');
  t.eq(r.json?.error, 'Invalid email or password.', 'does not reveal whether the email exists');
});

suite.case('HA03', 'email is case-insensitive; session cookie is HttpOnly', async (t) => {
  const c = new Client();
  const r = await c.signIn('OWNER@SpiceBox.Demo', OWNER.password);
  t.eq(r.status, 200, 'signs in');
  t.includes(r.headers.getSetCookie().join(';').toLowerCase(), 'httponly', 'cookie is HttpOnly');
});

suite.case('HA04', 'sign-out kills the session server-side', async (t) => {
  const c = new Client();
  await c.signIn(OWNER.email, OWNER.password);
  const token = c.cookie('tt_session')!;
  await c.post('/api/auth/signout');
  const replay = new Client(); replay.setCookie('tt_session', token);
  t.eq((await replay.get('/api/orders')).status, 401, 'old token no longer works');
});

suite.case('HA05', 'forged session cookie → 401', async (t) => {
  const c = new Client(); c.setCookie('tt_session', 'forged-token-value');
  t.eq((await c.get('/api/orders')).status, 401, 'status');
});

suite.case('HA06', 'weak password at signup → 400 (validation, not 401)', async (t) => {
  const r = await new Client().post('/api/auth/signup', {
    email: 'weak@eval.test', password: 'short', name: 'W', restaurantName: 'Weak' });
  t.eq(r.status, 400, 'status');
});

suite.case('HA07', 'duplicate email at signup → 409', async (t) => {
  const r = await new Client().post('/api/auth/signup', {
    email: OWNER.email.toUpperCase(), password: 'longenough1', name: 'D', restaurantName: 'Dup' });
  t.eq(r.status, 409, 'status');
});

/* ───────────── roles ───────────── */

suite.case('HR01', 'kitchen can see and move orders', async (t) => {
  t.eq((await kitchen.get('/api/orders')).status, 200, 'list orders');
  const r = await kitchen.patch(`/api/orders/${state.orderA.id}/status`, { status: 'ACCEPTED' });
  t.eq(r.status, 200, 'accept order');
});

suite.case('HR02', 'kitchen cannot pause the restaurant, change the menu, settings, printers or customers', async (t) => {
  t.eq((await kitchen.post('/api/capacity', { state: 'PAUSED' })).status, 403, 'pause');
  t.eq((await kitchen.post('/api/menu/availability', { locationId: state.locationA, menuItemId: state.naanA, status: 'SOLD_OUT' })).status, 403, 'sold out');
  t.eq((await kitchen.post('/api/menu/items', { categoryName: 'X', name: 'X', price: '1.00' })).status, 403, 'add item');
  t.eq((await kitchen.patch('/api/settings', { defaultPrepMinutes: 5 })).status, 403, 'settings');
  t.eq((await kitchen.post('/api/printers', { locationId: state.locationA, name: 'x' })).status, 403, 'printers');
  t.eq((await kitchen.del(`/api/customers/${state.customerA.id}`)).status, 403, 'erase customer');
});

/* ───────────── tenant isolation over HTTP ───────────── */

suite.case('HT00', 'tenant B signs up', async (t) => {
  const r = await tenantB.post('/api/auth/signup', {
    email: 'owner@tenantb.test', password: 'tenantbpass1', name: 'B Owner', restaurantName: 'Tenant B' });
  t.eq(r.status, 200, 'signup');
  state.restaurantB = r.json?.restaurantId;
});

suite.case('HT01', "B sees none of A's orders, customers or chats", async (t) => {
  const orders = (await tenantB.get('/api/orders')).json?.orders ?? [];
  t.eq(orders.filter((o: any) => o.id === state.orderA.id).length, 0, 'orders');
  const customers = (await tenantB.get('/api/customers')).json?.customers ?? [];
  t.eq(customers.length, 0, 'customers');
  const msgs = (await tenantB.get(`/api/conversations?id=${state.convA.id}`)).json?.messages ?? [];
  t.eq(msgs.length, 0, "A's transcript");
});

suite.case('HT02', "B cannot move A's order", async (t) => {
  t.eq((await tenantB.patch(`/api/orders/${state.orderA.id}/status`, { status: 'CANCELLED' })).status, 404, 'status');
  const mine = (await owner.get('/api/orders')).json.orders.find((o: any) => o.id === state.orderA.id);
  t.eq(mine?.status, 'ACCEPTED', "A's order untouched");
});

suite.case('HT03', "B cannot mark A's item sold out", async (t) => {
  const r = await tenantB.post('/api/menu/availability', { locationId: state.locationA, menuItemId: state.naanA, status: 'SOLD_OUT' });
  t.eq(r.status, 404, 'status');
  const naan = (await owner.get('/api/menu')).json.menu.find((i: any) => i.id === state.naanA);
  t.eq(naan?.availability, 'AVAILABLE', "A's item still available");
});

suite.case('HT04', "B cannot pause A's location", async (t) => {
  t.eq((await tenantB.post('/api/capacity', { locationId: state.locationA, state: 'PAUSED' })).status, 404, 'status');
  t.eq((await owner.get('/api/capacity')).json?.capacity?.state, 'OPEN', 'A still open');
});

suite.case('HT05', "B cannot take over A's chat", async (t) => {
  t.eq((await tenantB.post('/api/conversations', { conversationId: state.convA.id, action: 'takeover' })).status, 404, 'status');
  const conv = (await owner.get('/api/conversations')).json.conversations.find((c: any) => c.id === state.convA.id);
  t.eq(conv?.handledBy, 'AI', 'still AI');
});

suite.case('HT06', "switching the restaurant cookie to A's id does not grant access", async (t) => {
  const c = new Client();
  await c.signIn('owner@tenantb.test', 'tenantbpass1');
  c.setCookie('tt_restaurant', state.orderA.restaurantId);
  const orders = (await c.get('/api/orders')).json?.orders ?? [];
  t.eq(orders.filter((o: any) => o.restaurantId === state.orderA.restaurantId).length, 0, 'no A orders');
});

suite.case('HT07', "B cannot reprint or erase A's data", async (t) => {
  t.eq((await tenantB.post(`/api/orders/${state.orderA.id}/reprint`)).status, 404, 'reprint');
  t.eq((await tenantB.del(`/api/customers/${state.customerA.id}`)).status, 404, 'erase');
});

/* ───────────── input validation ───────────── */

suite.case('HV01', 'malformed JSON → 400, not 500', async (t) => {
  const r = await owner.req('PATCH', `/api/orders/${state.orderA.id}/status`, '{not json', { 'content-type': 'application/json' });
  t.eq(r.status, 400, 'status');
});

suite.case('HV02', 'unknown order status → 400', async (t) => {
  t.eq((await owner.patch(`/api/orders/${state.orderA.id}/status`, { status: 'TELEPORTED' })).status, 400, 'status');
});

suite.case('HV03', 'illegal transition (ACCEPTED → PICKED_UP) → 409', async (t) => {
  t.eq((await owner.patch(`/api/orders/${state.orderA.id}/status`, { status: 'PICKED_UP' })).status, 409, 'status');
});

/* ───────────── security ───────────── */

suite.case('HS01', 'security headers on pages and APIs', async (t) => {
  for (const path of ['/login', '/api/orders']) {
    const r = await fetch(`${BASE}${path}`);
    t.eq(r.headers.get('x-content-type-options'), 'nosniff', `${path} nosniff`);
    const frame = r.headers.get('x-frame-options') ?? '';
    const csp = r.headers.get('content-security-policy') ?? '';
    t.ok(/deny/i.test(frame) || /frame-ancestors 'none'/.test(csp), `${path} cannot be framed`, frame || csp);
    t.ok(!!r.headers.get('referrer-policy'), `${path} referrer-policy`);
  }
});

suite.case('HS02', 'cross-site POST with a valid session cookie is refused (CSRF)', async (t) => {
  const r = await owner.post('/api/capacity', { state: 'PAUSED' }, { origin: 'https://evil.example' });
  t.eq(r.status, 403, 'status');
  t.eq((await owner.get('/api/capacity')).json?.capacity?.state, 'OPEN', 'not paused');
});

suite.case('HS03', 'same-origin POST works', async (t) => {
  const r = await owner.post('/api/capacity', { state: 'OPEN', etaOffsetMinutes: 0, note: '' });
  t.eq(r.status, 200, 'status');
});

/* ───────────── WhatsApp webhook ───────────── */

suite.case('HW01', "Meta's verification handshake", async (t) => {
  const ok = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${EVAL_VERIFY_TOKEN}&hub.challenge=abc123`);
  t.eq(ok.status, 200, 'right token'); t.eq(await ok.text(), 'abc123', 'echoes challenge');
  const bad = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123`);
  t.eq(bad.status, 403, 'wrong token');
});

suite.case('HW02', 'signature is enforced', async (t) => {
  const body = inbound('+919811100002', '2 coke and 1 garlic naan', 'wamid.http1');
  const post = (b: string, sig?: string) => fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: b });
  t.eq((await post(body)).status, 401, 'unsigned');
  t.eq((await post(body, 'sha256=00')).status, 401, 'bad signature');
  t.eq((await post(body.replace('coke', 'pepsi'), sign(body))).status, 401, 'tampered body');
  t.eq((await post(body, sign(body))).status, 200, 'valid');
  const reply = await waitFor(async () => {
    const conv = (await owner.get('/api/conversations')).json.conversations.find((c: any) => c.customer?.phone === '+919811100002');
    if (!conv) return null;
    const msgs = (await owner.get(`/api/conversations?id=${conv.id}`)).json.messages;
    return msgs.find((m: any) => m.direction === 'OUTBOUND');
  });
  t.includes(reply?.body ?? '', "Here's your order", 'the signed message was processed and answered');
});

suite.case('HW03', 'malformed webhook JSON → 400', async (t) => {
  const r = await fetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  t.eq(r.status, 400, 'status');
});

suite.case('HW04', 'webhook for an unknown business number is acknowledged and ignored', async (t) => {
  const body = inbound('+919811100003', '2 coke', 'wamid.http2', '15550009999');
  const r = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
  t.eq(r.status, 200, 'acknowledged so Meta stops retrying');
});

/* ───────────── print agent ───────────── */

suite.case('HP01', 'print agent: bad token refused; good token claims and reports', async (t) => {
  const printers = (await owner.get('/api/printers')).json?.printers ?? [];
  const id = printers[0]?.id;
  const bad = await fetch(`${BASE}/api/print/jobs?printerId=${id}`, { headers: { authorization: 'Bearer wrong' } });
  t.eq(bad.status, 401, 'bad token');
  const good = await fetch(`${BASE}/api/print/jobs?printerId=${id}`, { headers: { authorization: 'Bearer pa_demo_spicebox_kitchen_token' } });
  t.eq(good.status, 200, 'good token');
  const jobs = (await good.json()).jobs ?? [];
  t.gte(jobs.length, 1, 'the accepted order has a KOT waiting');
  if (jobs[0]) {
    const rep = await fetch(`${BASE}/api/print/result`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pa_demo_spicebox_kitchen_token' },
      body: JSON.stringify({ printerId: id, jobId: jobs[0].id, ok: true }) });
    t.eq(rep.status, 200, 'result accepted');
  }
});

/* ───────────── operations features ───────────── */

suite.case('HN01', '/api/me tells the console the currency and timezone', async (t) => {
  const r = await owner.get('/api/me');
  t.eq(r.status, 200, 'status');
  t.eq(r.json?.restaurant?.currency, 'INR', 'currency');
  t.eq(r.json?.restaurant?.timezone, 'Asia/Kolkata', 'timezone');
});

suite.case('HN02', 'reprint a KOT over the API', async (t) => {
  const r = await owner.post(`/api/orders/${state.orderA.id}/reprint`);
  t.eq(r.status, 200, 'status');
  t.gte(r.json?.jobIds?.length ?? 0, 1, 'job queued');
});

suite.case('HN03', 'running late over the API moves the promise', async (t) => {
  const before = (await owner.get('/api/orders')).json.orders.find((o: any) => o.id === state.orderA.id);
  const r = await owner.patch(`/api/orders/${state.orderA.id}/status`, { action: 'delay', minutes: 15 });
  t.eq(r.status, 200, 'status');
  t.eq(new Date(r.json?.newReadyAt).getTime() - new Date(before.promisedReadyAt).getTime(), 15 * 60_000, 'moved 15 min');
});

suite.case('HN04', 'erase a customer (GDPR) over the API', async (t) => {
  await simulate(owner, '+919811100009', '2 coke and 1 garlic naan');
  const c = ((await owner.get('/api/customers?q=9811100009')).json?.customers ?? [])[0];
  const r = await owner.del(`/api/customers/${c?.id}`);
  t.eq(r.status, 200, 'status');
  const left = (await owner.get('/api/customers?q=9811100009')).json?.customers ?? [];
  t.eq(left.length, 0, 'no longer findable by phone');
});

/* ───────────── a brand-new restaurant, API only (spec §41 steps 1-4) ───────────── */

suite.case('HO01', 'new US restaurant signs up (USD, Los Angeles)', async (t) => {
  const r = await onboard.post('/api/auth/signup', {
    email: 'owner@harbor.test', password: 'harborpass1', name: 'Harbor Owner', restaurantName: 'Harbor Burgers',
    currency: 'USD', timezone: 'America/Los_Angeles', taxRateBps: 875 });
  t.eq(r.status, 200, 'signup');
  const me = (await onboard.get('/api/me')).json;
  t.eq(me?.restaurant?.currency, 'USD', 'currency stored');
});

suite.case('HO02', 'sets opening hours', async (t) => {
  const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, open: '06:00', close: '23:00', closed: false }));
  t.eq((await onboard.put('/api/settings/hours', { hours })).status, 200, 'saved');
  const got = (await onboard.get('/api/settings')).json?.hours ?? [];
  t.eq(got.filter((h: any) => h.open === '06:00' && h.close === '23:00').length, 7, 'all 7 days read back');
});

suite.case('HO03', 'adds menu items one by one', async (t) => {
  for (const [name, price] of [['Classic Burger', '12.99'], ['Fries', '3.99']]) {
    const r = await onboard.post('/api/menu/items', { categoryName: 'Mains', name, price, prepMinutes: 12 });
    t.eq(r.status, 201, `create ${name}`);
  }
  const menu = (await onboard.get('/api/menu')).json?.menu ?? [];
  t.eq(menu.find((i: any) => i.name === 'Classic Burger')?.priceCents, 1299, 'price stored in cents');
});

suite.case('HO04', 'CSV import validates before publishing', async (t) => {
  const bad = 'Category,Item,Price,Description,Available\nDrinks,Soda,1.99,Can,true\nDrinks,,2.00,No name,true\nDrinks,Shake,abc,Bad price,true\n';
  const r = await onboard.post('/api/menu/import', { csv: bad, dryRun: false });
  t.eq(r.json?.valid, false, 'invalid file rejected');
  t.eq((r.json?.errors ?? []).map((e: any) => e.line).sort(), [3, 4], 'errors point at lines 3 and 4');
  const menu = (await onboard.get('/api/menu')).json?.menu ?? [];
  t.eq(menu.some((i: any) => i.name === 'Soda'), false, 'nothing published from an invalid file');
});

suite.case('HO05', 'a valid CSV imports', async (t) => {
  const good = 'Category,Item,Price,Description,Available\nDrinks,Soda,1.99,Can,true\nDrinks,Shake,4.50,Vanilla,true\n';
  const r = await onboard.post('/api/menu/import', { csv: good, dryRun: false });
  t.eq(r.json?.valid, true, 'valid');
  t.eq(r.json?.created, 2, 'two items created');
});

suite.case('HO06', 'configures prep time and pickup capacity', async (t) => {
  const r = await onboard.patch('/api/settings', { defaultPrepMinutes: 15, slotMinutes: 10, maxOrdersPerSlot: 5 });
  t.eq(r.status, 200, 'saved');
  const cap = (await onboard.get('/api/capacity')).json?.capacity;
  t.eq(cap?.slotMinutes, 10, 'slot length'); t.eq(cap?.maxOrdersPerSlot, 5, 'orders per slot');
});

suite.case('HO07', 'takes a test order in dollars and hands it to the kitchen', async (t) => {
  const a = await simulate(onboard, '+14155550100', '2 classic burger and 1 fries');
  t.includes(a.replies, 'Classic Burger');
  t.includes(a.replies, '$');
  t.excludes(a.replies, '₹');
  const b = await simulate(onboard, '+14155550100', 'yes');
  t.includes(b.replies, /Confirmed/i);
  const orders = (await onboard.get('/api/orders?status=RECEIVED')).json?.orders ?? [];
  t.eq(orders.length, 1, 'order is in the new restaurant console');
});

/* ───────────── rate limits (separate suite, runs last) ───────────── */

rateSuite.case('HL01', 'brute force on one account is stopped even when X-Forwarded-For rotates', async (t) => {
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await new Client(BASE, { 'x-forwarded-for': `10.0.0.${i}` }).signIn('owner@tenantb.test', `wrong-password-${i}`);
    if (r.status === 429) { limited = true; break; }
  }
  t.ok(limited, 'locked out within 12 attempts');
});

rateSuite.case('HL02', 'signup flood from one client is limited', async (t) => {
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const r = await new Client().post('/api/auth/signup', {
      email: `flood${i}@eval.test`, password: 'floodpass12', name: 'F', restaurantName: `Flood ${i}` });
    if (r.status === 429) { limited = true; break; }
  }
  t.ok(limited, 'signups limited');
});
