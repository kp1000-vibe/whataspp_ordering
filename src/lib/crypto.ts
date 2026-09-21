/**
 * Password hashing (scrypt), session token hashing (sha256), secret encryption
 * (AES-256-GCM) and WhatsApp webhook signature verification (HMAC-SHA256, timing-safe).
 * Zero external dependencies — node:crypto only.
 */
import {
  scryptSync, randomBytes, timingSafeEqual, createHash,
  createCipheriv, createDecipheriv, createHmac,
} from 'node:crypto';

const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: sha256(token) };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/* ── secret storage (integration credentials) ── */

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) {
    // Dev fallback keeps the app runnable without secrets; production MUST set the key.
    if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is required in production');
    return createHash('sha256').update('dev-only-insecure-key').digest();
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1') throw new Error('unsupported ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/* ── webhook signatures ── */

/** Meta sends `X-Hub-Signature-256: sha256=<hex>` over the RAW request body. */
export function whatsappSignature(rawBody: string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
}

export function verifyWhatsappSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = Buffer.from(whatsappSignature(rawBody, appSecret));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Print-agent auth: bearer token compared against a stored sha256, timing-safe. */
export function verifyTokenHash(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
