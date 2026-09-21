'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Button, Input, Field } from '../../components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [form, setForm] = useState({
    email: '', password: '', name: '', restaurantName: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const endpoint = mode === 'signin' ? '/api/auth/signin' : '/api/auth/signup';
      const payload = mode === 'signin'
        ? { email: form.email, password: form.password }
        : { ...form, organizationName: form.restaurantName };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'That did not work.'); return; }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl text-sm font-bold text-white"
            style={{ background: 'var(--accent)' }}
          >
            AI
          </div>
          <h1 className="text-xl font-semibold">AI Takeaway Counter</h1>
          <p className="mt-1 text-sm muted">
            Your WhatsApp number takes the orders. You cook.
          </p>
        </div>

        <Card className="p-5">
          <form onSubmit={submit} className="space-y-3">
            {mode === 'signup' ? (
              <>
                <Field label="Your name">
                  <Input value={form.name} onChange={set('name')} required autoComplete="name" />
                </Field>
                <Field label="Restaurant name">
                  <Input value={form.restaurantName} onChange={set('restaurantName')} required />
                </Field>
              </>
            ) : null}

            <Field label="Email">
              <Input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
            </Field>
            <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters, with a number.' : undefined}>
              <Input
                type="password" value={form.password} onChange={set('password')} required
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
            </Field>

            {error ? (
              <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
            ) : null}

            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create restaurant'}
            </Button>
          </form>

          <button
            className="mt-4 w-full text-center text-xs muted underline"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}
          >
            {mode === 'signin' ? 'Set up a new restaurant' : 'I already have an account'}
          </button>
        </Card>

        <p className="mt-4 text-center text-xs muted">
          Demo restaurant: owner@spicebox.demo / spicebox2026
        </p>
      </div>
    </div>
  );
}
