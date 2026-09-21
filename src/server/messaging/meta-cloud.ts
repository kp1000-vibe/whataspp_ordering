/**
 * Official WhatsApp Business Platform (Meta Cloud API) provider.
 *
 * NOTE ON VERIFICATION STATUS: this code is written against the documented
 * Graph API v21.0 contract. It has NOT been executed against live Meta
 * infrastructure in this build — no credentials exist here. The webhook parser
 * and signature verification ARE tested against recorded Meta payload fixtures.
 */
import type {
  MessagingProvider, OutboundMessage, SendResult, InboundMessage, StatusUpdate,
} from './provider';
import { log } from '../../lib/log';

const GRAPH_VERSION = 'v21.0';

export type MetaCloudConfig = {
  accessToken: string;
  phoneNumberId: string;
  apiBase?: string;
};

export class MetaCloudProvider implements MessagingProvider {
  readonly name = 'meta-cloud';
  constructor(private cfg: MetaCloudConfig) {}

  private url(path: string): string {
    return `${this.cfg.apiBase ?? 'https://graph.facebook.com'}/${GRAPH_VERSION}/${path}`;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const payload = msg.kind === 'TEXT'
      ? {
          messaging_product: 'whatsapp', recipient_type: 'individual',
          to: msg.to, type: 'text', text: { preview_url: false, body: msg.body },
        }
      : {
          messaging_product: 'whatsapp', recipient_type: 'individual',
          to: msg.to, type: 'template',
          template: {
            name: msg.templateName,
            language: { code: msg.languageCode },
            components: msg.variables.length
              ? [{ type: 'body', parameters: msg.variables.map((v) => ({ type: 'text', text: v })) }]
              : [],
          },
        };

    try {
      const res = await fetch(this.url(`${this.cfg.phoneNumberId}/messages`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const json: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        // 4xx = our fault (bad template, opted-out user). 5xx / 429 = retry.
        const retryable = res.status >= 500 || res.status === 429;
        const error = json?.error?.message ?? `HTTP ${res.status}`;
        log.error('whatsapp send failed', { status: res.status, error, to: msg.to });
        return { ok: false, error, retryable };
      }
      const providerMessageId = json?.messages?.[0]?.id ?? '';
      return { ok: true, providerMessageId };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err), retryable: true };
    }
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    try {
      const metaRes = await fetch(this.url(mediaId), {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      });
      if (!metaRes.ok) return null;
      const meta: any = await metaRes.json();
      if (!meta?.url) return null;

      const binRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      });
      if (!binRes.ok) return null;
      return {
        bytes: new Uint8Array(await binRes.arrayBuffer()),
        mimeType: meta.mime_type ?? 'audio/ogg',
      };
    } catch (err: any) {
      log.error('whatsapp media download failed', { mediaId, error: err?.message });
      return null;
    }
  }

  parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
    return parseMetaWebhook(body);
  }
}

/** Exported standalone so tests can exercise it without constructing a provider. */
export function parseMetaWebhook(body: any): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const displayPhone: string = value?.metadata?.display_phone_number ?? '';
      const contacts: any[] = value?.contacts ?? [];
      const nameByWaId = new Map<string, string>(
        contacts.map((c) => [c?.wa_id, c?.profile?.name ?? '']),
      );

      for (const m of value?.messages ?? []) {
        const from: string = m?.from ?? '';
        const base = {
          providerMessageId: m?.id ?? '',
          from: from.startsWith('+') ? from : `+${from}`,
          to: displayPhone.startsWith('+') ? displayPhone : `+${displayPhone}`,
          profileName: nameByWaId.get(from) || undefined,
          timestamp: new Date(Number(m?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
        };

        if (m?.type === 'text') {
          messages.push({ ...base, kind: 'TEXT', text: m?.text?.body ?? '' });
        } else if (m?.type === 'audio' || m?.type === 'voice') {
          messages.push({ ...base, kind: 'AUDIO', mediaId: m?.audio?.id ?? m?.voice?.id ?? '' });
        } else if (m?.type === 'image') {
          messages.push({ ...base, kind: 'IMAGE', mediaId: m?.image?.id ?? '' });
        } else if (m?.type === 'interactive') {
          const reply = m?.interactive?.button_reply ?? m?.interactive?.list_reply;
          messages.push({ ...base, kind: 'INTERACTIVE', text: reply?.title ?? reply?.id ?? '' });
        }
      }

      for (const s of value?.statuses ?? []) {
        statuses.push({
          providerMessageId: s?.id ?? '',
          status: s?.status ?? 'sent',
          timestamp: new Date(Number(s?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
          error: s?.errors?.[0]?.title,
        });
      }
    }
  }
  return { messages, statuses };
}
