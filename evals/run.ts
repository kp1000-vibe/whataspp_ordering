/**
 * Eval runner.
 *   npx tsx evals/run.ts nlu conversation business      (in-process, own DB)
 *   npx tsx evals/run.ts http ui http-ratelimit          (needs the eval server on :3100)
 *   npx tsx evals/run.ts nlu --only N1                   (filter case ids)
 */
import { writeResults, type Suite } from './harness';

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : undefined;
const names = args.filter((a, i) => !a.startsWith('--') && (onlyIdx === -1 || i !== onlyIdx + 1));

const loaders: Record<string, () => Promise<Suite>> = {
  nlu: async () => (await import('./nlu.eval')).suite,
  conversation: async () => (await import('./conversation.eval')).suite,
  business: async () => (await import('./business.eval')).suite,
  http: async () => (await import('./http.eval')).suite,
  'http-ratelimit': async () => (await import('./http.eval')).rateSuite,
  ui: async () => (await import('./ui.eval')).suite,
  supplemental: async () => (await import('./supplemental.eval')).suite,
  'supplemental-ui': async () => (await import('./supplemental-ui.eval')).suite,
};

let failed = 0;
for (const name of names) {
  const load = loaders[name];
  if (!load) { console.error(`unknown suite ${name}`); process.exit(2); }
  console.log(`\n=== ${name} ===`);
  const suite = await load();
  const results = await suite.run(only);
  if (!only) writeResults(name, results);
  failed += results.filter((r) => !r.pass).length;
  if (name === 'ui') await (await import('./ui.eval')).closeUi();
}
process.exit(failed ? 1 : 0);
