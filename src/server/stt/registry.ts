/**
 * Speech-to-text abstraction.
 *
 * STT_PROVIDER = mock | openai   (default: mock)
 *
 * The mock resolves WhatsApp media ids against a fixture table, which is how the
 * voice-ordering path is testable end to end with no audio and no API key.
 * Real deployments set STT_PROVIDER=openai (Whisper) — the interface is identical.
 */
import { log } from '../../lib/log';
import type { TranscriptResult } from '../ai/provider/types';

/** mediaId -> transcript. Populated by tests, the simulator and the demo seed. */
export const VOICE_FIXTURES = new Map<string, { text: string; language: string; confidence: number }>();

export function setVoiceFixture(
  mediaId: string, text: string, opts: { language?: string; confidence?: number } = {},
): void {
  VOICE_FIXTURES.set(mediaId, {
    text, language: opts.language ?? 'en', confidence: opts.confidence ?? 0.92,
  });
}

export function clearVoiceFixtures(): void {
  VOICE_FIXTURES.clear();
}

export async function transcribeVoice(
  bytes: Uint8Array, mimeType: string, mediaId: string,
): Promise<{ text: string; language: string; confidence: number } | null> {
  const provider = (process.env.STT_PROVIDER || 'mock').toLowerCase();

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      log.warn('STT_PROVIDER=openai but OPENAI_API_KEY is unset; falling back to mock');
    } else {
      try {
        const { OpenAIProvider } = await import('../ai/provider/openai');
        const stt = new OpenAIProvider(key);
        // A vocabulary hint measurably improves food-name accuracy.
        const result: TranscriptResult = await stt.transcribe(bytes, mimeType, await menuHint());
        return { text: result.text, language: result.language, confidence: result.confidence };
      } catch (err: any) {
        log.error('transcription failed', { error: err?.message, mediaId });
        return null;
      }
    }
  }

  const fixture = VOICE_FIXTURES.get(mediaId);
  if (fixture) return fixture;

  // Mock media bytes are literally `fixture:<mediaId>`; nothing to transcribe.
  const decoded = new TextDecoder().decode(bytes);
  if (decoded.startsWith('fixture:')) {
    log.warn('no voice fixture registered for media id', { mediaId });
    return null;
  }
  return null;
}

/** Item names improve Whisper accuracy on menu-specific words. Cached per process. */
let hintCache: { at: number; value: string } | null = null;

async function menuHint(): Promise<string> {
  if (hintCache && Date.now() - hintCache.at < 300_000) return hintCache.value;
  try {
    const { getDb } = await import('../../db/client');
    const db = await getDb();
    const { rows } = await db.execute(`SELECT name FROM menu_items WHERE is_active = true LIMIT 120;`);
    const value = rows.map((r: any) => r.name).join(', ');
    hintCache = { at: Date.now(), value };
    return value;
  } catch {
    return '';
  }
}
