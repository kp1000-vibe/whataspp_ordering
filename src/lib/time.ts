/**
 * Timezone-correct local-time helpers with no dependencies.
 * Uses Intl (ICU ships with Node) rather than hand-rolled UTC offsets, so DST is correct.
 */

export type LocalParts = {
  year: number; month: number; day: number;
  hour: number; minute: number;
  dayOfWeek: number;         // 0 = Sunday
  minuteOfDay: number;
  dateKey: string;           // YYYY-MM-DD in the restaurant's timezone
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(at: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;

  const hour = Number(p.hour === '24' ? '0' : p.hour);
  const minute = Number(p.minute);
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour, minute,
    dayOfWeek: DOW.indexOf(p.weekday),
    minuteOfDay: hour * 60 + minute,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}

export function minutesToClock(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${ampm}`;
}

export function formatLocalTime(at: Date, timeZone: string): string {
  return minutesToClock(localParts(at, timeZone).minuteOfDay);
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "7:45 PM" today, "tomorrow at 11:30 AM", or "Friday at 1:00 PM". */
export function whenLabel(at: Date, now: Date, timeZone: string): string {
  const a = localParts(at, timeZone);
  const clock = minutesToClock(a.minuteOfDay);
  if (a.dateKey === localParts(now, timeZone).dateKey) return clock;
  if (a.dateKey === localParts(new Date(now.getTime() + 86_400_000), timeZone).dateKey) return `tomorrow at ${clock}`;
  return `${DAY_NAMES[a.dayOfWeek]} at ${clock}`;
}
