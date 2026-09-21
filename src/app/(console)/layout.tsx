import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, activeRestaurantId } from '../../server/http';
import { getDb } from '../../db/client';
import { restaurants } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { ConsoleNav } from './nav';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.memberships.length === 0) redirect('/login?error=no-restaurant');

  const restaurantId = await activeRestaurantId(user);
  const db = await getDb();
  const [restaurant] = await db.drizzle.select().from(restaurants)
    .where(eq(restaurants.id, restaurantId!)).limit(1);

  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-20 flex items-center gap-4 px-4 py-3"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      >
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <span
            className="grid h-7 w-7 place-items-center rounded-lg text-xs font-bold text-white"
            style={{ background: 'var(--accent)' }}
          >
            AI
          </span>
          <span className="hidden sm:inline">{restaurant?.name ?? 'Console'}</span>
        </Link>

        <ConsoleNav />

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm muted md:inline">{user.name}</span>
          <form action="/api/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-sm"
              style={{ border: '1px solid var(--border)' }}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6">{children}</main>
    </div>
  );
}
