/**
 * Next.js calls this once per server process, before any request is handled.
 * It is where event handlers and job handlers get registered.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootstrap } = await import('./server/bootstrap');
  bootstrap();
}
