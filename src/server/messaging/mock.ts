/**
 * In-memory messaging provider. Backs the simulator, the demo restaurant and
 * every test. It records what WOULD have been sent so assertions are exact.
 */
import type {
  MessagingProvider, OutboundMessage, SendResult, InboundMessage, StatusUpdate,
} from './provider';
import { parseMetaWebhook } from './meta-cloud';

export type Sent = OutboundMessage & { providerMessageId: string; at: Date };

export class MockProvider implements MessagingProvider {
  readonly name = 'mock';
  readonly outbox: Sent[] = [];
  private counter = 0;
  /** Set to make the next N sends fail — used to test retry/backoff. */
  failNext = 0;

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, error: 'simulated transport failure', retryable: true };
    }
    const providerMessageId = `mock.out.${++this.counter}`;
    this.outbox.push({ ...msg, providerMessageId, at: new Date() });
    return { ok: true, providerMessageId };
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    // Voice fixtures are keyed by media id; the mock STT provider reads the same key.
    return { bytes: new TextEncoder().encode(`fixture:${mediaId}`), mimeType: 'audio/ogg' };
  }

  parseWebhook(body: unknown) {
    return parseMetaWebhook(body);
  }

  /** Test helper: build a Meta-shaped inbound webhook body. */
  static inboundTextBody(args: { from: string; to: string; text: string; id?: string; name?: string }) {
    return {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA_ID',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: args.to.replace('+', ''), phone_number_id: 'PNID' },
            contacts: [{ profile: { name: args.name ?? 'Test Customer' }, wa_id: args.from.replace('+', '') }],
            messages: [{
              from: args.from.replace('+', ''),
              id: args.id ?? `wamid.${Math.random().toString(36).slice(2)}`,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: args.text },
            }],
          },
        }],
      }],
    };
  }

  static inboundAudioBody(args: { from: string; to: string; mediaId: string; id?: string }) {
    const body: any = MockProvider.inboundTextBody({ from: args.from, to: args.to, text: '', id: args.id });
    body.entry[0].changes[0].value.messages[0] = {
      from: args.from.replace('+', ''),
      id: args.id ?? `wamid.${Math.random().toString(36).slice(2)}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'audio',
      audio: { id: args.mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true },
    };
    return body;
  }

  clear(): void {
    this.outbox.length = 0;
  }

  lastBody(): string {
    const last = this.outbox.at(-1);
    if (!last) return '';
    return last.kind === 'TEXT' ? last.body : last.preview;
  }

  bodies(): string[] {
    return this.outbox.map((m) => (m.kind === 'TEXT' ? m.body : m.preview));
  }
}

export type { InboundMessage, StatusUpdate };
