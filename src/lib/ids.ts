import { randomUUID, randomBytes } from 'node:crypto';

/** Prefixed, sortable-enough ids. Readable in logs, unique enough for our volume. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}
export function correlationId(): string {
  return randomUUID();
}
