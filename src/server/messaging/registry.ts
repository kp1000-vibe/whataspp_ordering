/**
 * Picks the messaging provider for a restaurant.
 * Live credentials live in `integrations.config_encrypted`; if a restaurant has
 * not connected WhatsApp, it transparently gets the mock provider so the whole
 * product is usable in demo/dev without Meta approval.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { integrations } from '../../db/schema';
import { decryptSecret } from '../../lib/crypto';
import { MetaCloudProvider } from './meta-cloud';
import { MockProvider } from './mock';
import type { MessagingProvider } from './provider';

/** Shared mock instance per restaurant so tests can inspect the outbox. */
const mocks = new Map<string, MockProvider>();

export function mockProviderFor(restaurantId: string): MockProvider {
  let m = mocks.get(restaurantId);
  if (!m) { m = new MockProvider(); mocks.set(restaurantId, m); }
  return m;
}

export function resetMocks(): void {
  mocks.clear();
}

export type WhatsappStatus = {
  connected: boolean;
  provider: 'meta-cloud' | 'mock';
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  lastError?: string;
};

export async function whatsappStatus(restaurantId: string): Promise<WhatsappStatus> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(integrations).where(
    and(eq(integrations.restaurantId, restaurantId), eq(integrations.kind, 'whatsapp'))).limit(1);

  if (!row || row.status !== 'CONNECTED' || !row.configEncrypted) {
    return { connected: false, provider: 'mock', lastError: row?.lastError };
  }
  return {
    connected: true, provider: 'meta-cloud',
    phoneNumberId: (row.publicConfig as any)?.phoneNumberId,
    displayPhoneNumber: (row.publicConfig as any)?.displayPhoneNumber,
  };
}

export async function messagingFor(restaurantId: string): Promise<MessagingProvider> {
  if (process.env.MESSAGING_PROVIDER === 'mock') return mockProviderFor(restaurantId);

  const db = await getDb();
  const [row] = await db.drizzle.select().from(integrations).where(
    and(eq(integrations.restaurantId, restaurantId), eq(integrations.kind, 'whatsapp'))).limit(1);

  if (!row || row.status !== 'CONNECTED' || !row.configEncrypted) {
    return mockProviderFor(restaurantId);
  }
  const cfg = JSON.parse(decryptSecret(row.configEncrypted));
  return new MetaCloudProvider({ accessToken: cfg.accessToken, phoneNumberId: cfg.phoneNumberId });
}

/** App secret used to verify inbound webhook signatures for this restaurant. */
export async function appSecretFor(restaurantId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(integrations).where(
    and(eq(integrations.restaurantId, restaurantId), eq(integrations.kind, 'whatsapp'))).limit(1);
  if (!row?.configEncrypted) return process.env.WHATSAPP_APP_SECRET || null;
  try {
    return JSON.parse(decryptSecret(row.configEncrypted)).appSecret ?? null;
  } catch {
    return null;
  }
}
