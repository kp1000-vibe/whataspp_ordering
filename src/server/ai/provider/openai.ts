/**
 * OpenAI provider — chat, JSON-schema structured output, Whisper transcription
 * and embeddings, over plain fetch.
 *
 * VERIFICATION STATUS: written against the documented API; not executed live in
 * this build (no OPENAI_API_KEY here). Present so the provider abstraction is
 * proven by more than one implementation, and so `transcribe` has a real home.
 */
import type {
  AIProvider, ChatMessage, ChatOptions, ChatResult, StructuredResult, TranscriptResult, Usage,
} from './types';
import { extractJson } from './anthropic';

const MODELS = { fast: 'gpt-4o-mini', strong: 'gpt-4o' } as const;
const PRICING: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
};

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  constructor(private apiKey: string, private apiBase = 'https://api.openai.com/v1') {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const { text, usage } = await this.completion(messages, opts);
    return { text, usage };
  }

  async structuredOutput<T>(
    messages: ChatMessage[], jsonSchema: Record<string, unknown>, opts?: ChatOptions,
  ): Promise<StructuredResult<T>> {
    const { text, usage } = await this.completion(messages, opts, {
      type: 'json_schema',
      json_schema: { name: 'interpretation', strict: true, schema: jsonSchema },
    });
    return { value: extractJson<T>(text), usage, raw: text };
  }

  private async completion(messages: ChatMessage[], opts?: ChatOptions, responseFormat?: unknown) {
    const model = MODELS[opts?.tier ?? 'fast'];
    const started = Date.now();

    const res = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: opts?.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? 1024,
        messages,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);

    const json: any = await res.json();
    const inTok = json?.usage?.prompt_tokens ?? 0;
    const outTok = json?.usage?.completion_tokens ?? 0;
    const [inPrice, outPrice] = PRICING[model] ?? [0, 0];

    return {
      text: json?.choices?.[0]?.message?.content ?? '',
      usage: {
        promptTokens: inTok, completionTokens: outTok,
        costMicroUsd: Math.round(inTok * inPrice + outTok * outPrice),
        model, provider: this.name, latencyMs: Date.now() - started,
      } as Usage,
    };
  }

  async transcribe(audio: Uint8Array, mimeType: string, hint?: string): Promise<TranscriptResult> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as BlobPart], { type: mimeType }), 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    if (hint) form.append('prompt', hint);

    const res = await fetch(`${this.apiBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcribe ${res.status}`);

    const json: any = await res.json();
    // Whisper reports avg_logprob per segment; convert to a coarse 0-1 confidence.
    const segments: any[] = json?.segments ?? [];
    const avgLogprob = segments.length
      ? segments.reduce((s, x) => s + (x.avg_logprob ?? -0.5), 0) / segments.length
      : -0.5;
    const confidence = Math.max(0, Math.min(1, Math.exp(avgLogprob)));

    return {
      text: json?.text ?? '',
      language: json?.language ?? 'en',
      confidence,
      usage: {
        promptTokens: 0, completionTokens: 0, costMicroUsd: 0,
        model: 'whisper-1', provider: this.name, latencyMs: Date.now() - started,
      },
    };
  }

  async embed(texts: string[]) {
    const started = Date.now();
    const res = await fetch(`${this.apiBase}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embed ${res.status}`);
    const json: any = await res.json();
    return {
      vectors: (json?.data ?? []).map((d: any) => d.embedding),
      usage: {
        promptTokens: json?.usage?.prompt_tokens ?? 0, completionTokens: 0, costMicroUsd: 0,
        model: 'text-embedding-3-small', provider: this.name, latencyMs: Date.now() - started,
      } as Usage,
    };
  }
}
