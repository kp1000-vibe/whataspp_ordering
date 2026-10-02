/**
 * UI cases ADDED AFTER the baseline. U17 passed at baseline-review time while
 * measuring a HALF-LOADED page (its screenshot shows "Rendering…" and no data),
 * so its no-horizontal-scroll check proved little. This version waits for the
 * real content — kitchen badge, pickup slots, stats — before measuring.
 */
import { chromium } from 'playwright-core';
import { Suite } from './harness';
import { BASE, OWNER } from './http-client';
import { istAt } from './time';

export const suite = new Suite('supplemental-ui');

suite.case('S-U17c', 'mobile dashboard fits 390px AFTER its data has rendered', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.clock.install({ time: istAt(19, 0) });
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
    await page.getByText('OPEN', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByText(/^\d{1,2}:\d{2} [AP]M$/).first().waitFor({ timeout: 30_000 });
    await page.getByText('ORDERS TODAY', { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    t.lte(overflow, 0, 'no horizontal page scroll with real data on screen');
    const statsVisible = await page.getByText('AI HANDLED', { exact: false }).isVisible();
    t.ok(statsVisible, 'stats rendered');
    const path = 'evals/screenshots/S-U17c-mobile-dashboard-loaded.png';
    await page.screenshot({ path, fullPage: true });
    t.screenshot = path;
  } finally {
    await browser.close();
  }
});
