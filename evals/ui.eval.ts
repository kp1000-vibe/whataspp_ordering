/**
 * UI evals: real Chrome (playwright-core, channel "chrome"), real server on
 * :3100, browser clock pinned to the same instant as the server clock.
 * Every screenshot belongs to a case that ALSO asserts on the DOM — a picture
 * of a broken page cannot pass.
 */
import { mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Suite, type T } from './harness';
import { BASE, OWNER, EVAL_APP_SECRET } from './http-client';
import { istAt } from './time';

export const suite = new Suite('ui');

const SHOTS = 'evals/screenshots';
mkdirSync(SHOTS, { recursive: true });

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const dialogs: string[] = [];

async function newContext(viewport = { width: 1440, height: 900 }): Promise<{ ctx: BrowserContext; page: Page }> {
  if (!browser) browser = await chromium.launch({ channel: 'chrome', headless: true });
  const c = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.clock.install({ time: istAt(19, 0) });
  p.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  return { ctx: c, page: p };
}

async function shot(t: T, p: Page, name: string): Promise<void> {
  const path = `${SHOTS}/${name}.png`;
  await p.screenshot({ path, fullPage: true });
  t.screenshot = path;
}

async function text(p: Page): Promise<string> {
  return p.locator('body').innerText();
}

async function signIn(p: Page, email: string, password: string): Promise<void> {
  await p.goto(`${BASE}/login`);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

async function simulatorSend(p: Page, message: string, expect: RegExp): Promise<void> {
  const before = await p.locator('.whitespace-pre-wrap').count();
  await p.getByPlaceholder('Type what a customer would send…').fill(message);
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await p.waitForFunction(
    ([n, src, flags]) => {
      const nodes = [...document.querySelectorAll('.whitespace-pre-wrap')];
      return nodes.length > (n as number) && new RegExp(src as string, flags as string).test(nodes.slice(n as number).map((x) => x.textContent).join('\n'));
    },
    // Harness fix after baseline: the regex flags (e.g. /i) were being dropped.
    [before, expect.source, expect.flags], { timeout: 30_000 });
}

async function api(p: Page, path: string): Promise<any> {
  const r = await p.request.get(`${BASE}${path}`);
  return r.json();
}

/* ───────────── login ───────────── */

suite.case('U01', 'login page: labelled fields; wrong password shows an error', async (t) => {
  ({ ctx, page } = await newContext());
  await page.goto(`${BASE}/login`);
  t.ok(await page.getByLabel('Email').isVisible(), 'email field has a label');
  t.ok(await page.getByLabel('Password').isVisible(), 'password field has a label');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('wrong-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Invalid email or password.').waitFor({ timeout: 15_000 });
  t.ok(true, 'error shown');
  await shot(t, page, 'U01-login-error');
});

suite.case('U02', 'sign in → dashboard with kitchen status, pickup slots and stats', async (t) => {
  await signIn(page, OWNER.email, OWNER.password);
  await page.getByText('Kitchen status').waitFor();
  await page.getByText('ORDERS TODAY', { exact: false }).first().waitFor({ timeout: 20_000 });
  const body = await text(page);
  t.includes(body, 'OPEN');
  t.includes(body, /\d{1,2}:\d{2} [AP]M/, 'pickup slots rendered');
  t.includes(body, /AI HANDLED/i);
  await shot(t, page, 'U02-dashboard');
});

/* ───────────── ordering through the simulator ───────────── */

suite.case('U03', 'simulator: spec §6 conversation end to end', async (t) => {
  await page.goto(`${BASE}/simulator`);
  await page.getByLabel('Customer number').fill('+919822200001');
  await simulatorSend(page, 'One chicken biryani.', /regular|spicy/i);
  await simulatorSend(page, 'Spicy', /₹252\.00/);
  await simulatorSend(page, 'yes', /Confirmed/);
  const body = await text(page);
  t.includes(body, 'Chicken Biryani (Spicy)');
  t.includes(body, '₹252.00');
  t.includes(body, /Confirmed! Your order #\d+/);
  await shot(t, page, 'U03-simulator-english');
});

suite.case('U04', 'simulator: Hinglish voice note', async (t) => {
  await page.goto(`${BASE}/simulator`);
  await page.getByLabel('Customer number').fill('+919822200002');
  await page.getByText('Send as a voice note').click();
  await simulatorSend(page, 'Bhai do chicken biryani dena, ek spicy aur ek normal, aur ek coke', /Here's your order/);
  const body = await text(page);
  t.includes(body, 'Chicken Biryani (Spicy)');
  t.includes(body, 'Chicken Biryani (Regular)');
  t.includes(body, '1 x Coke');
  await shot(t, page, 'U04-simulator-hinglish-voice');
});

/* ───────────── restaurant console ───────────── */

suite.case('U05', 'dashboard: accept → start cooking moves the card across the board', async (t) => {
  await page.goto(`${BASE}/dashboard`);
  await page.getByRole('button', { name: 'Accept' }).first().waitFor({ timeout: 20_000 });
  const before = (await api(page, '/api/orders?status=RECEIVED')).orders.length;
  await page.getByRole('button', { name: 'Accept' }).first().click();
  await page.getByRole('button', { name: 'Start cooking' }).first().waitFor();
  await page.getByRole('button', { name: 'Start cooking' }).first().click();
  await page.getByRole('button', { name: 'Mark ready' }).first().waitFor();
  const after = await api(page, '/api/orders?status=RECEIVED,ACCEPTED,PREPARING');
  t.eq(after.orders.filter((o: any) => o.status === 'RECEIVED').length, before - 1, 'one fewer new order');
  t.gte(after.orders.filter((o: any) => o.status === 'PREPARING').length, 1, 'one is cooking');
  await shot(t, page, 'U05-dashboard-board');
});

suite.case('U06', 'kitchen display: big readable cards, soonest pickup first', async (t) => {
  await page.goto(`${BASE}/kitchen`);
  await page.getByText('COOKING', { exact: true }).waitFor();
  await page.locator('article.kitchen-card').first().waitFor({ timeout: 20_000 });
  const qtySize = await page.locator('.kitchen-card .qty').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  t.gte(qtySize, 24, 'quantities are at least 24px');
  t.gte(await page.locator('article.kitchen-card').count(), 2, 'cards present');
  await shot(t, page, 'U06-kitchen');
});

suite.case('U19', 'dashboard: reprint the KOT from an order card', async (t) => {
  await page.goto(`${BASE}/dashboard`);
  const btn = page.getByRole('button', { name: 'Reprint KOT' }).first();
  await btn.waitFor({ timeout: 20_000 });
  await btn.click();
  await page.getByText('Sent to printer').waitFor({ timeout: 10_000 });
  t.ok(true, 'reprint acknowledged');
  await shot(t, page, 'U19-reprint');
});

suite.case('U07', 'pause orders: badge turns PAUSED and the assistant refuses new orders', async (t) => {
  await page.goto(`${BASE}/dashboard`);
  await page.getByRole('button', { name: 'Pause orders' }).click();
  await page.getByText('PAUSED', { exact: true }).waitFor({ timeout: 10_000 });
  const r = await page.request.post(`${BASE}/api/simulator`, {
    data: { phone: '+919822200003', text: '2 coke and 1 garlic naan' }, headers: { origin: BASE } });
  const replies = ((await r.json()).replies ?? []).join(' ');
  t.includes(replies, /paused/i, 'assistant refuses while paused');
  await shot(t, page, 'U07-paused');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByText('OPEN', { exact: true }).waitFor();
});

suite.case('U08', 'menu: one tap marks an item sold out', async (t) => {
  await page.goto(`${BASE}/menu`);
  const row = page.locator('div.flex.items-center.gap-3.p-3', { hasText: 'Garlic Naan' });
  await row.getByRole('button', { name: 'Mark sold out' }).click();
  await row.getByText('sold out', { exact: true }).waitFor();
  t.ok(true, 'sold-out badge shown');
  await shot(t, page, 'U08-menu-sold-out');
  await row.getByRole('button', { name: 'Back in stock' }).click();
  await row.getByRole('button', { name: 'Mark sold out' }).waitFor();
});

suite.case('U09', 'menu: add a new item from the console', async (t) => {
  await page.goto(`${BASE}/menu`);
  await page.getByLabel('Category').fill('Drinks');
  await page.getByLabel('Item name').fill('Masala Chai');
  await page.getByLabel('Price').fill('45');
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByText('Masala Chai').first().waitFor({ timeout: 10_000 });
  const menu = await api(page, '/api/menu');
  t.eq(menu.menu.find((i: any) => i.name === 'Masala Chai')?.priceCents, 4500, 'stored at ₹45.00');
  await shot(t, page, 'U09-menu-add-item');
});

suite.case('U10', 'menu: CSV import shows line-numbered errors and publishes nothing', async (t) => {
  await page.goto(`${BASE}/menu`);
  await page.getByLabel('CSV').fill('Category,Item,Price,Description,Available\nDrinks,Rose Milk,60,Cold,true\nDrinks,,50,No name,true\n');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await page.getByText(/Line 3/).waitFor({ timeout: 10_000 });
  const menu = await api(page, '/api/menu');
  t.eq(menu.menu.some((i: any) => i.name === 'Rose Milk'), false, 'invalid file publishes nothing');
  await shot(t, page, 'U10-menu-csv-errors');
});

suite.case('U11', 'chats: take over, reply as staff, hand back', async (t) => {
  await page.goto(`${BASE}/conversations`);
  await page.getByRole('button', { name: 'Take over' }).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Take over' }).first().click();
  await page.getByPlaceholder('Reply as the restaurant…').fill('Hi, this is Sana from SpiceBox — your food is almost ready!');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('your food is almost ready').waitFor({ timeout: 10_000 });
  t.ok(await page.getByRole('button', { name: 'Return to AI' }).isVisible(), 'staff mode shown');
  await shot(t, page, 'U11-chats-takeover');
  await page.getByRole('button', { name: 'Return to AI' }).click();
  await page.getByRole('button', { name: 'Take over' }).first().waitFor();
});

suite.case('U12', 'customers: search by name', async (t) => {
  await page.goto(`${BASE}/customers`);
  await page.getByPlaceholder('Search name or number').fill('Rahul');
  await page.getByText('Rahul Verma').waitFor({ timeout: 10_000 });
  const rows = await page.locator('tbody tr').count();
  t.eq(rows, 1, 'exactly one match');
  await shot(t, page, 'U12-customers-search');
});

suite.case('U13', 'analytics: containment, peak hours, top items, usage', async (t) => {
  await page.goto(`${BASE}/analytics`);
  await page.getByText('AI containment').waitFor({ timeout: 20_000 });
  const body = await text(page);
  t.includes(body, 'Busiest hours');
  t.includes(body, 'Top items');
  t.includes(body, 'Chicken Biryani');
  await shot(t, page, 'U13-analytics');
});

suite.case('U14', 'settings: edit hours and capacity, and they persist', async (t) => {
  await page.goto(`${BASE}/settings`);
  await page.getByLabel('Tuesday closes').fill('22:30');
  await page.getByLabel('Orders per slot').fill('6');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Saved').waitFor({ timeout: 10_000 });
  await page.reload();
  t.eq(await page.getByLabel('Tuesday closes').inputValue(), '22:30', 'hours persisted');
  t.eq(await page.getByLabel('Orders per slot').inputValue(), '6', 'capacity persisted');
  await shot(t, page, 'U14-settings');
});

suite.case('U15', 'a US restaurant sees dollars and its own local time', async (t) => {
  const us = await newContext();
  await signIn(us.page, 'owner@harbor.test', 'harborpass1');
  await us.page.goto(`${BASE}/menu`);
  await us.page.getByText('Classic Burger').waitFor({ timeout: 20_000 });
  const menuText = await text(us.page);
  t.includes(menuText, '$12.99');
  t.excludes(menuText, '₹', 'no rupee symbol anywhere');
  await shot(t, us.page, 'U15a-us-menu');
  await us.page.goto(`${BASE}/dashboard`);
  await us.page.getByText('Kitchen status').waitFor();
  await us.page.getByText(/Pickup \d/).first().waitFor({ timeout: 20_000 });
  const dash = await text(us.page);
  // 19:00 IST is 06:30 in Los Angeles; the card must show LA morning, not an IST evening time.
  t.includes(dash, /Pickup [67]:\d{2} AM/, 'pickup shown in Los Angeles time');
  t.excludes(dash, '₹');
  await shot(t, us.page, 'U15b-us-dashboard');
  await us.ctx.close();
});

suite.case('U16', 'a hostile customer name is shown as text, never executed', async (t) => {
  const evil = '<img src=x onerror="window.__xss=1;alert(1)">';
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '919999000001', phone_number_id: 'DEMO_PNID' },
    contacts: [{ profile: { name: evil }, wa_id: '919822200099' }],
    messages: [{ from: '919822200099', id: 'wamid.xss1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }],
  } }] }] });
  const sig = 'sha256=' + createHmac('sha256', EVAL_APP_SECRET).update(body).digest('hex');
  await page.request.post(`${BASE}/api/webhooks/whatsapp`, { data: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  await page.goto(`${BASE}/customers`);
  await page.getByPlaceholder('Search name or number').fill('9822200099');
  await page.getByText('onerror', { exact: false }).waitFor({ timeout: 15_000 });
  t.eq(await page.evaluate(() => (window as any).__xss ?? null), null, 'script did not run');
  t.eq(dialogs.length, 0, 'no alert dialog');
  await shot(t, page, 'U16-xss-name-rendered-as-text');
});

suite.case('U17', 'mobile: dashboard and kitchen fit a 390px phone', async (t) => {
  const m = await newContext({ width: 390, height: 844 });
  await signIn(m.page, OWNER.email, OWNER.password);
  await m.page.getByText('Kitchen status').waitFor();
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  t.lte(overflow, 0, 'no horizontal scroll on dashboard');
  await shot(t, m.page, 'U17a-mobile-dashboard');
  await m.page.goto(`${BASE}/kitchen`);
  await m.page.getByText('COOKING', { exact: true }).waitFor();
  const overflowK = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  t.lte(overflowK, 0, 'no horizontal scroll on kitchen display');
  await shot(t, m.page, 'U17b-mobile-kitchen');
  await m.ctx.close();
});

suite.case('U18', 'accessibility basics: every dashboard button has a name', async (t) => {
  await page.goto(`${BASE}/dashboard`);
  await page.getByText('Kitchen status').waitFor();
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim())).length);
  t.eq(unnamed, 0, 'buttons without an accessible name');
});

export async function closeUi(): Promise<void> {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
