import { NextResponse } from 'next/server';
import { signUp, signIn } from '../../../../server/auth/service';
import { SESSION_COOKIE, ACTIVE_RESTAURANT_COOKIE, errorResponse, json, rateLimit, clientKey, readJson } from '../../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  if (!rateLimit(clientKey(request, 'signup'), 5, 3_600_000)) {
    return json({ error: 'Too many signups from this address.' }, 429);
  }
  try {
    const body = await readJson(request);
    const result = await signUp({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      name: String(body.name ?? ''),
      organizationName: String(body.organizationName ?? body.restaurantName ?? ''),
      restaurantName: String(body.restaurantName ?? ''),
      timezone: body.timezone ? String(body.timezone) : undefined,
      currency: body.currency ? String(body.currency) : undefined,
      taxRateBps: body.taxRateBps != null ? Number(body.taxRateBps) : undefined,
    });

    const { token } = await signIn(String(body.email), String(body.password));
    const response = json({ ok: true, restaurantId: result.restaurantId });
    const secure = process.env.NODE_ENV === 'production';
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    response.cookies.set(ACTIVE_RESTAURANT_COOKIE, result.restaurantId, {
      httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
