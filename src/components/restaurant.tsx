'use client';

/**
 * The signed-in restaurant's currency and timezone, provided once by the
 * console layout. Every price and time in the console formats through these —
 * there is no hard-coded "₹" or "Asia/Kolkata" default anywhere in the pages.
 */
import { createContext, useContext, type ReactNode } from 'react';

export type RestaurantInfo = { name: string; currency: string; timezone: string };

const Ctx = createContext<RestaurantInfo>({ name: '', currency: 'USD', timezone: 'UTC' });

export function RestaurantProvider({ value, children }: { value: RestaurantInfo; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRestaurant() {
  const info = useContext(Ctx);
  const symbol = info.currency === 'INR' ? '₹' : info.currency === 'USD' ? '$' : info.currency === 'EUR' ? '€' : info.currency === 'GBP' ? '£' : '';
  return {
    ...info,
    money(cents: number): string {
      const sign = cents < 0 ? '-' : '';
      const abs = Math.abs(cents);
      const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
      return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${info.currency}`;
    },
    clock(iso: string | null | undefined): string {
      if (!iso) return '—';
      return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: info.timezone });
    },
  };
}
