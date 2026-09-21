/**
 * Provider-agnostic AI interface. Business logic imports ONLY this file.
 * Swapping Anthropic for OpenAI (or for the offline deterministic driver) is a
 * config change, not a code change.
 */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatOptions = {
  /** 'fast' for classification, 'strong' for reasoning. The registry maps these to real model ids. */
  tier?: 'fast' | 'strong';
  maxTokens?: number;
  temperature?: number;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  model: string;
  provider: string;
  latencyMs: number;
};

export type ChatResult = { text: string; usage: Usage };
export type StructuredResult<T> = { value: T; usage: Usage; raw: string };

export type TranscriptResult = {
  text: string;
  language: string;
  confidence: number;
  usage: Usage;
};

export interface AIProvider {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /**
   * Returns JSON matching `jsonSchema`. Implementations MUST validate before
   * returning — a provider that cannot produce valid JSON must throw, not guess.
   */
  structuredOutput<T>(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    opts?: ChatOptions,
  ): Promise<StructuredResult<T>>;
  transcribe(audio: Uint8Array, mimeType: string, hint?: string): Promise<TranscriptResult>;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: Usage }>;
}

export function emptyUsage(provider: string, model: string, latencyMs = 0): Usage {
  return { promptTokens: 0, completionTokens: 0, costMicroUsd: 0, model, provider, latencyMs };
}
