/**
 * Minimal, explicit E.164 normalisation. We do NOT guess country codes silently:
 * a number with no country code is assumed to be DEFAULT_COUNTRY_CODE and that
 * assumption is returned so callers can surface it.
 */
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '1';

export function toE164(raw: string): { phone: string; assumedCountryCode: boolean } {
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return { phone: digits, assumedCountryCode: false };
  const bare = digits.replace(/\D/g, '');
  if (bare.length > 10) return { phone: `+${bare}`, assumedCountryCode: false };
  return { phone: `+${DEFAULT_CC}${bare}`, assumedCountryCode: true };
}

export function maskPhone(e164: string): string {
  return e164.length <= 4 ? '****' : `***${e164.slice(-4)}`;
}
