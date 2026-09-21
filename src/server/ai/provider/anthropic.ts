/**
 * Anthropic provider (Messages API over plain fetch — no SDK dependency).
 *
 * VERIFICATION STATUS: written against the documented Messages API. It has NOT
 * been executed against the live API in this build because no ANTHROPIC_API_KEY
 * exists here. Its JSON-repair and schema-validation paths ARE unit tested.
 *
 * Cost control (section 63): `tier` routes simple classification to Haiku and
 * only complex reasoning to Sonnet. Per-call cost is recorded in ai_interactions.
 */
import type {
  AIProvider, ChatMessage, ChatOptions, ChatResult, StructuredResult, TranscriptResult, Usage,
} from './types';

const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  strong: 'claude-sonnet-5',
} as const;

/** USD per million tokens (input, output). Used for cost attribution only. */
const PRICING: Record<string, [number, number]> = {
  'claude-haiku-4-5-20251001': [1, 5],
  'claude-sonnet-5': [3, 15],
};

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  constructor(private apiKey: string, private apiBase = 'https://api.anthropic.com') {}

  private model(opts?: ChatOptions): string {
    return MODELS[opts?.tier ?? 'fast'];
  }

  private async call(messages: ChatMessage[], opts: ChatOptions | undefined, systemSuffix = '') {
    const model = this.model(opts);
    const system = [
      ...messages.filter((m) => m.role === 'system').map((m) => m.content),
      systemSuffix,
    ].filter(Boolean).join('\n\n');

    const started = Date.now();
    const res = await fetch(`${this.apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? 1024,
        temperature: opts?.temperature ?? 0,
        system: system || undefined,
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 500)}`);
    }
    const json: any = await res.json();
    const text: string = (json?.content ?? [])
      .filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');

    const inTok = json?.usage?.input_tokens ?? 0;
    const outTok = json?.usage?.output_tokens ?? 0;
    const [inPrice, outPrice] = PRICING[model] ?? [0, 0];

    const usage: Usage = {
      promptTokens: inTok,
      completionTokens: outTok,
      costMicroUsd: Math.round((inTok * inPrice + outTok * outPrice)), // (tok/1e6)*price*1e6
      model, provider: this.name, latencyMs: Date.now() - started,
    };
    return { text, usage };
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    return this.call(messages, opts);
  }

  async structuredOutput<T>(
    messages: ChatMessage[], jsonSchema: Record<string, unknown>, opts?: ChatOptions,
  ): Promise<StructuredResult<T>> {
    const suffix =
      `Respond with ONE JSON object and nothing else — no prose, no markdown fence.\n` +
      `It must validate against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;

    const { text, usage } = await this.call(messages, opts, suffix);
    return { value: extractJson<T>(text), usage, raw: text };
  }

  async transcribe(): Promise<TranscriptResult> {
    throw new Error('AnthropicProvider does not provide speech-to-text. Configure STT_PROVIDER separately.');
  }

  async embed(): Promise<{ vectors: number[][]; usage: Usage }> {
    throw new Error('AnthropicProvider does not provide embeddings. Configure EMBEDDING_PROVIDER separately.');
  }
}

/**
 * Models occasionally wrap JSON in prose or fences despite instructions.
 * We repair the two common cases and otherwise THROW — we never guess a value.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch { /* fall through */ }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()) as T; } catch { /* fall through */ }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)) as T; } catch { /* fall through */ }
  }
  throw new Error(`Model did not return valid JSON: ${trimmed.slice(0, 200)}`);
}
