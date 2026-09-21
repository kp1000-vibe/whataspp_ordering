import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { signOut } from '../../../../server/auth/service';
import { SESSION_COOKIE, ACTIVE_RESTAURANT_COOKIE, json } from '../../../../server/http';

export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await signOut(token);

  const response = json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(ACTIVE_RESTAURANT_COOKIE);
  return response;
}
