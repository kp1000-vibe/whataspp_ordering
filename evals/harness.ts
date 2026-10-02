/**
 * Minimal eval harness.
 *
 * Rules this file enforces so results cannot be quietly massaged:
 *  - A case passes only if it threw nothing AND every check passed.
 *  - Every check records what was expected and what was observed.
 *  - Results are written to evals/results/<suite>.json with a timestamp;
 *    the report is generated from those files, never typed by hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Check = { ok: boolean; label: string; expected?: unknown; actual?: unknown };

export type CaseResult = {
  suite: string;
  id: string;
  title: string;
  pass: boolean;
  checks: Check[];
  error?: string;
  ms: number;
  screenshot?: string;
};

export class T {
  readonly checks: Check[] = [];
  screenshot?: string;

  ok(condition: unknown, label: string, actual?: unknown): void {
    this.checks.push({ ok: !!condition, label, actual });
  }

  eq<V>(actual: V, expected: V, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.checks.push({ ok, label, expected, actual });
  }

  includes(haystack: string, needle: string | RegExp, label?: string): void {
    const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
    this.checks.push({ ok, label: label ?? `reply contains ${String(needle)}`, expected: String(needle), actual: haystack.slice(0, 400) });
  }

  excludes(haystack: string, needle: string | RegExp, label?: string): void {
    const ok = typeof needle === 'string' ? !haystack.includes(needle) : !needle.test(haystack);
    this.checks.push({ ok, label: label ?? `reply does not contain ${String(needle)}`, expected: `not ${String(needle)}`, actual: haystack.slice(0, 400) });
  }

  gte(actual: number, min: number, label: string): void {
    this.checks.push({ ok: actual >= min, label, expected: `>= ${min}`, actual });
  }

  lte(actual: number, max: number, label: string): void {
    this.checks.push({ ok: actual <= max, label, expected: `<= ${max}`, actual });
  }
}

type CaseFn = (t: T) => Promise<void>;

export class Suite {
  private cases: Array<{ id: string; title: string; fn: CaseFn }> = [];
  constructor(readonly name: string) {}

  case(id: string, title: string, fn: CaseFn): void {
    if (this.cases.some((c) => c.id === id)) throw new Error(`duplicate case id ${id}`);
    this.cases.push({ id, title, fn });
  }

  get size(): number {
    return this.cases.length;
  }

  async run(filter?: string): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    const selected = filter ? this.cases.filter((c) => c.id.includes(filter)) : this.cases;

    for (const c of selected) {
      const t = new T();
      const started = Date.now();
      let error: string | undefined;
      try {
        await c.fn(t);
      } catch (err: any) {
        error = String(err?.stack ?? err?.message ?? err).split('\n').slice(0, 4).join('\n');
      }
      const pass = !error && t.checks.length > 0 && t.checks.every((ch) => ch.ok);
      const result: CaseResult = {
        suite: this.name, id: c.id, title: c.title, pass,
        checks: t.checks, error, ms: Date.now() - started, screenshot: t.screenshot,
      };
      if (!error && t.checks.length === 0) result.error = 'case made no checks';
      results.push(result);

      const mark = pass ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${c.id.padEnd(8)} ${c.title}`);
      if (!pass) {
        if (result.error) console.log(`          error: ${result.error.split('\n')[0]}`);
        for (const ch of t.checks.filter((x) => !x.ok)) {
          console.log(`          x ${ch.label}`);
          if (ch.expected !== undefined) console.log(`            expected: ${short(ch.expected)}`);
          if (ch.actual !== undefined) console.log(`            actual:   ${short(ch.actual)}`);
        }
      }
    }
    return results;
  }
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 260 ? `${s.slice(0, 260)}…` : s;
}

export function writeResults(suite: string, results: CaseResult[]): void {
  const dir = join(process.cwd(), 'evals', 'results');
  mkdirSync(dir, { recursive: true });
  const passed = results.filter((r) => r.pass).length;
  writeFileSync(join(dir, `${suite}.json`), JSON.stringify({
    suite, ranAt: new Date().toISOString(), total: results.length, passed,
    failed: results.length - passed, results,
  }, null, 2));
  console.log(`\n  ${suite}: ${passed}/${results.length} passed\n`);
}
