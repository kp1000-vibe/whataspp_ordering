/**
 * All money is integer cents. There is no float money anywhere in this codebase.
 * Tax is basis points (850 = 8.50%) so rates are exact integers too.
 */
export function formatCents(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '\u20ac' : currency === 'INR' ? '\u20b9' : '';
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`;
}

/** Banker-free, deterministic: round half up on the cent. */
export function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}

export function parsePriceToCents(input: string): number | null {
  const m = String(input).trim().replace(/[^0-9.]/g, '');
  if (!m || !/^\d+(\.\d{1,2})?$/.test(m)) return null;
  const [whole, frac = ''] = m.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
