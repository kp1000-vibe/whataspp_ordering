/** Tiny cookie-aware HTTP client for evals against a running server. */
export const BASE = process.env.EVAL_BASE_URL || 'http://localhost:3100';

export type Res = { status: number; json: any; text: string; headers: Headers };

export class Client {
  private cookies = new Map<string, string>();
  constructor(readonly base = BASE, private extraHeaders: Record<string, string> = {}) {}

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...this.extraHeaders, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['content-type'] ??= 'application/json';
      h.origin ??= this.base;               // a real browser sends Origin on same-site POSTs
    }
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      const expired = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim())) || value === '';
      if (expired) this.cookies.delete(name.trim()); else this.cookies.set(name.trim(), value);
    }
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  get(path: string, headers?: Record<string, string>) { return this.req('GET', path, undefined, headers); }
  post(path: string, body?: unknown, headers?: Record<string, string>) { return this.req('POST', path, body ?? {}, headers); }
  patch(path: string, body?: unknown, headers?: Record<string, string>) { return this.req('PATCH', path, body ?? {}, headers); }
  put(path: string, body?: unknown, headers?: Record<string, string>) { return this.req('PUT', path, body ?? {}, headers); }
  del(path: string, headers?: Record<string, string>) { return this.req('DELETE', path, {}, headers); }

  async signIn(email: string, password: string): Promise<Res> {
    return this.post('/api/auth/signin', { email, password });
  }
}

export const OWNER = { email: 'owner@spicebox.demo', password: 'spicebox2026' };
export const KITCHEN = { email: 'kitchen@spicebox.demo', password: 'kitchenpass1' };
export const EVAL_APP_SECRET = 'eval-app-secret';
export const EVAL_VERIFY_TOKEN = 'eval-verify';
