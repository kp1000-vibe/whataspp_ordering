/** Wall-clock helpers shared by every eval suite (no database imports here). */
import { localParts } from '../src/lib/time';

export const TZ = 'Asia/Kolkata';

/** An absolute Date for a given IST wall-clock time, `dayOffset` days from today (IST). */
export function istAt(hour: number, minute = 0, dayOffset = 0): Date {
  const today = localParts(new Date(), TZ);
  return new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute) - 330 * 60_000);
}

/** Days from today (IST) until the next given weekday (0 = Sunday). 0 means today. */
export function daysUntil(dayOfWeek: number): number {
  return (dayOfWeek - localParts(new Date(), TZ).dayOfWeek + 7) % 7;
}
