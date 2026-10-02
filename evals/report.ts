/**
 * Builds evals/results/report.html from the JSON result files (never by hand),
 * including the baseline comparison and the expectation-integrity check, then
 * screenshots the report with the real browser.
 *
 *   npx tsx evals/report.ts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const RESULTS = 'evals/results';
const ORDER = ['nlu', 'conversation', 'business', 'http', 'ui', 'http-ratelimit', 'supplemental', 'supplemental-ui'];

type R = { suite: string; id: string; title: string; pass: boolean; checks: any[]; error?: string; screenshot?: string };
type File = { suite: string; ranAt: string; total: number; passed: number; failed: number; results: R[] };

function load(dir: string): Record<string, File> {
  const out: Record<string, File> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (data.suite) out[data.suite] = data;
  }
  return out;
}

const current = load(RESULTS);
const baseline = load(join(RESULTS, 'baseline'));
const integrity = existsSync(join(RESULTS, 'integrity.json'))
  ? JSON.parse(readFileSync(join(RESULTS, 'integrity.json'), 'utf8'))
  : null;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const suites = ORDER.filter((s) => current[s]);
const total = suites.reduce((n, s) => n + current[s].total, 0);
const passed = suites.reduce((n, s) => n + current[s].passed, 0);
const baseTotal = suites.reduce((n, s) => n + (baseline[s]?.total ?? 0), 0);
const basePassed = suites.reduce((n, s) => n + (baseline[s]?.passed ?? 0), 0);

const rows = suites.map((s) => {
  const c = current[s]; const b = baseline[s];
  return `<tr><td>${esc(s)}</td><td>${b ? `${b.passed}/${b.total}` : '—'}</td>
    <td class="${c.failed ? 'bad' : 'good'}">${c.passed}/${c.total}</td><td>${esc(c.ranAt.slice(0, 19).replace('T', ' '))} UTC</td></tr>`;
}).join('');

const detail = suites.map((s) => {
  const items = current[s].results.map((r) => {
    const wasFailing = baseline[s]?.results.find((x) => x.id === r.id && !x.pass);
    const failing = r.checks.filter((c) => !c.ok);
    return `<li class="${r.pass ? 'good' : 'bad'}">
      <span class="mark">${r.pass ? 'PASS' : 'FAIL'}</span>
      <code>${esc(r.id)}</code> ${esc(r.title)}
      ${wasFailing && r.pass ? '<span class="fixed">fixed since baseline</span>' : ''}
      ${r.error ? `<pre>${esc(r.error)}</pre>` : ''}
      ${failing.length ? `<pre>${failing.map((c) => `✗ ${esc(c.label)}\n  expected: ${esc(JSON.stringify(c.expected))}\n  actual:   ${esc(typeof c.actual === 'string' ? c.actual : JSON.stringify(c.actual))}`).join('\n')}</pre>` : ''}
      ${r.screenshot ? `<div><a href="../../${esc(r.screenshot)}"><img src="../../${esc(r.screenshot)}" loading="lazy" alt="${esc(r.id)} screenshot"></a></div>` : ''}
    </li>`;
  }).join('');
  return `<section><h2>${esc(s)} <small>${current[s].passed}/${current[s].total}</small></h2><ul>${items}</ul></section>`;
}).join('');

const integrityHtml = integrity
  ? `<p class="${integrity.changedFiles.length ? 'warn' : 'good'}"><b>Expectation integrity:</b> ${integrity.changedFiles.length
      ? `${integrity.changedFiles.length} eval file(s) differ from the frozen baseline — each change is listed below with its reason.`
      : 'eval files are byte-identical to the frozen baseline. No expectation was changed to make a test pass.'}</p>
     ${integrity.changedFiles.length ? `<pre>${esc(JSON.stringify(integrity.changedFiles, null, 2))}</pre>` : ''}
     ${integrity.notes?.length ? `<ul>${integrity.notes.map((n: string) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
  : '<p class="warn">No integrity check recorded yet.</p>';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Eval Report</title>
<style>
:root{--bg:#f6f7f9;--fg:#13161a;--muted:#646b75;--card:#fff;--line:#e4e7eb;--good:#1a7f4b;--bad:#c02626;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e8eaed;--muted:#9aa2ad;--card:#161a21;--line:#262c36;--good:#3fb27f;--bad:#e35d5d;--warn:#d99633}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:22px} h2{font-size:16px;margin:28px 0 8px} h2 small{color:var(--muted);font-weight:500}
.big{font-size:40px;font-weight:700;margin:12px 0} .muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
.good{color:var(--good)} .bad{color:var(--bad)} .warn{color:var(--warn)}
ul{list-style:none;padding:0;margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px}
li{padding:8px 12px;border-bottom:1px solid var(--line)} li:last-child{border-bottom:0}
li.good,li.bad{color:var(--fg)} .mark{display:inline-block;width:40px;font-weight:700;font-size:11px}
li.good .mark{color:var(--good)} li.bad .mark{color:var(--bad)}
.fixed{margin-left:8px;font-size:11px;color:var(--good);border:1px solid var(--good);border-radius:10px;padding:0 6px}
pre{white-space:pre-wrap;background:var(--bg);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto}
img{max-width:100%;max-height:260px;margin-top:8px;border:1px solid var(--line);border-radius:6px}
code{font-size:12px}
</style></head><body><main>
<h1>AI Takeaway Counter — eval report</h1>
<p class="muted">Generated from evals/results/*.json. Nothing on this page is typed by hand.</p>
<div class="big ${passed === total ? 'good' : 'bad'}">${passed} / ${total} passing</div>
<p class="muted">Baseline before any fix: ${basePassed} / ${baseTotal} passing.</p>
${integrityHtml}
<table><thead><tr><th>Suite</th><th>Baseline</th><th>Now</th><th>Ran at</th></tr></thead><tbody>${rows}</tbody></table>
${detail}
</main></body></html>`;

writeFileSync(join(RESULTS, 'report.html'), html);
console.log(`report: ${passed}/${total} passing (baseline ${basePassed}/${baseTotal}) → ${RESULTS}/report.html`);

if (process.argv.includes('--screenshot')) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto('file://' + join(process.cwd(), RESULTS, 'report.html').replace(/\\/g, '/'));
  await page.screenshot({ path: 'evals/screenshots/Z1-report-summary.png', fullPage: false });
  await page.screenshot({ path: 'evals/screenshots/Z2-report-full.png', fullPage: true });
  await browser.close();
  console.log('report screenshots written');
}
