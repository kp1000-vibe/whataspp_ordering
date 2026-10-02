/**
 * Cases ADDED AFTER the baseline was frozen. Kept in their own file so the
 * baseline eval files stay byte-identical (see the integrity report).
 *
 * Why this exists: baseline case CV05 ("make it 3 cokes" on a 2-coke draft)
 * passed at baseline BY ACCIDENT — the old code added one more coke, and 2+1
 * happens to equal 3. These cases make the "set the quantity" semantics
 * impossible to satisfy by adding.
 */
import { Suite } from './harness';
import { freshWorld, newPhone, expectDraft, L } from './fixtures';

export const suite = new Suite('supplemental');

suite.case('S-CV05b', '"make it 2 cokes" on a 4-coke draft REDUCES to 2 (cannot pass by adding)', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '4 coke and 1 garlic naan');
  await w.say(p, 'make it 2 cokes');
  await expectDraft(t, w, p, [L('Coke', 2), L('Garlic Naan', 1)]);
});

suite.case('S-CV05c', '"only 1 garlic naan" on a 3-naan draft sets it to 1', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 3 garlic naan');
  await w.say(p, 'only 1 garlic naan');
  await expectDraft(t, w, p, [L('Coke', 2), L('Garlic Naan', 1)]);
});

suite.case('S-CV05d', '"change coke to 5" sets coke to exactly 5', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, '2 coke and 1 garlic naan');
  await w.say(p, 'change coke to 5');
  await expectDraft(t, w, p, [L('Coke', 5), L('Garlic Naan', 1)]);
});

/* Found by reviewing the U03 screenshot, not by any baseline eval: after a
   clarification answer the reply said "Pickup at 7:30 PM works." — wording that
   is only correct when the CUSTOMER asked for a time. */
suite.case('S-W01', 'a pickup time the customer never asked for is never described as "works"', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  await w.say(p, 'One chicken biryani.');
  const r = await w.say(p, 'Spicy');
  t.excludes(r, /works\./, 'no "works" for an unrequested time');
  t.includes(r, /earliest pickup/i, 'says it is the earliest pickup');
  const o = await w.latestOrder(p);
  t.eq(o?.customerRequestedTime, false, 'order not flagged as a customer-requested time');
});

suite.case('S-W02', 'a time the customer DID ask for keeps "works" and the requested flag through confirmation', async (t) => {
  const w = await freshWorld(); const p = newPhone();
  const r = await w.say(p, "2 coke and 1 garlic naan, I'll pick it up at 8");
  t.includes(r, 'Pickup at 8:00 PM works.');
  await w.say(p, 'yes');
  const o = await w.latestOrder(p);
  t.eq(o?.status, 'RECEIVED', 'confirmed');
  t.eq(o?.customerRequestedTime, true, 'still flagged as requested after confirmation');
});
