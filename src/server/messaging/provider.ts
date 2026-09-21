/**
 * Messaging abstraction. Two implementations:
 *   meta-cloud : official WhatsApp Business Platform (Graph API). No scraping, ever.
 *   mock       : in-memory, used by tests, the simulator and demo mode.
 *
 * WhatsApp policy is encoded in the TYPE system: a MARKETING message must be sent
 * with an approved template name. There is no way to send free-form marketing.
 */
export type OutboundText = {
  to: string;
  kind: 'TEXT';
  category: 'TRANSACTIONAL' | 'SERVICE';
  body: string;
};

export type OutboundTemplate = {
  to: string;
  kind: 'TEMPLATE';
  category: 'MARKETING' | 'TRANSACTIONAL';
  templateName: string;
  languageCode: string;
  /** Ordered substitutions for the approved template's {{1}}, {{2}}, ... */
  variables: string[];
  /** Rendered copy, stored for the audit trail and console preview. */
  preview: string;
};

export type OutboundMessage = OutboundText | OutboundTemplate;

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean };

export type InboundMessage = {
  providerMessageId: string;
  from: string;
  to: string;
  kind: 'TEXT' | 'AUDIO' | 'IMAGE' | 'INTERACTIVE';
  text?: string;
  mediaId?: string;
  profileName?: string;
  timestamp: Date;
};

export type StatusUpdate = {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  error?: string;
};

export interface MessagingProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Downloads WhatsApp media (voice notes) as bytes. */
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /** Parses a provider webhook body into our normalised shapes. */
  parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] };
}
