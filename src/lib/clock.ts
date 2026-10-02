/**
 * The application clock.
 *
 * Opening hours, pickup slots and promotions all depend on "now". Reading
 * `new Date()` directly makes every one of those behaviours untestable at a
 * chosen time — the acceptance suite used to pass only because it happened to
 * run during opening hours.
 *
 * Defaults to real time. It can be shifted (not frozen — time still advances)
 * by setting TT_CLOCK_START to an ISO timestamp, or with setClock() in-process.
 */
let offsetMs: number | null = null;

function offset(): number {
  if (offsetMs === null) {
    const start = process.env.TT_CLOCK_START;
    offsetMs = start && !Number.isNaN(Date.parse(start)) ? Date.parse(start) - Date.now() : 0;
  }
  return offsetMs;
}

export function now(): Date {
  return new Date(Date.now() + offset());
}

/** Shift the clock so that it reads `at` right now. Pass null for real time. */
export function setClock(at: Date | null): void {
  offsetMs = at ? at.getTime() - Date.now() : 0;
}
