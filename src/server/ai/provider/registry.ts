/**
 * Provider selection + a failure-tolerant wrapper.
 *
 * AI_PROVIDER = deterministic | anthropic | openai   (default: deterministic)
 *
 * `withFallback` is the guardrail for section 45: if the hosted model errors or
 * times out, ordering does NOT stop — we fall back to the deterministic driver
 * and flag the interaction, rather than telling the customer "sorry, try later".
 */
import type { AIProvider } from './types';
import { DeterministicProvider } from './deterministic';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { log } from '../../../lib/log';

let cached: AIProvider | null = null;

export function aiProvider(): AIProvider {
  if (cached) return cached;
  const name = (process.env.AI_PROVIDER || 'deterministic').toLowerCase();

  if (name === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      log.warn('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; using deterministic provider');
      cached = new DeterministicProvider();
    } else {
      cached = new AnthropicProvider(key);
    }
  } else if (name === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      log.warn('AI_PROVIDER=openai but OPENAI_API_KEY is unset; using deterministic provider');
      cached = new DeterministicProvider();
    } else {
      cached = new OpenAIProvider(key);
    }
  } else {
    cached = new DeterministicProvider();
  }
  return cached;
}

export function setAiProvider(p: AIProvider | null): void {
  cached = p;
}

export const fallbackProvider = new DeterministicProvider();

export async function withFallback<T>(
  label: string,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  timeoutMs = Number(process.env.AI_TIMEOUT_MS || 12000),
): Promise<{ value: T; usedFallback: boolean; error?: string }> {
  try {
    const value = await Promise.race([
      primary(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { value, usedFallback: false };
  } catch (err: any) {
    log.warn('ai primary failed, falling back', { label, error: err?.message });
    return { value: await fallback(), usedFallback: true, error: String(err?.message ?? err) };
  }
}
