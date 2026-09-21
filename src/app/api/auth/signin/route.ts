import { NextResponse } from 'next/server';
import { signIn } from '../../../../server/auth/service';
import { SESSION_COOKIE, ACTIVE_RESTAURANT_COOKIE, errorResponse, json, rateLimit, clientKey } from '../../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  // Brute-force protection: 10 attempts per IP per 5 minutes.
  if (!rateLimit(clientKey(request, 'signin'), 10, 300_000)) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }
  try {
    const { email, password } = await request.json();
    const { token, user } = await signIn(String(email ?? ''), String(password ?? ''));

    const response = json({ user });
    const secure = process.env.NODE_ENV === 'production';
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    if (user.memberships[0]) {
      response.cookies.set(ACTIVE_RESTAURANT_COOKIE, user.memberships[0].restaurantId, {
        httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
