'use client';

/**
 * Test order — the WhatsApp simulator.
 *
 * Same webhook shape, same ingestion, same agent, same order records as a real
 * WhatsApp message. This is how a restaurant places a test order during
 * onboarding before their number is connected, and how anyone can see exactly
 * what a customer would be told.
 */
import { useState } from 'react';
import { Card, Button, Input, Field, Badge } from '../../../components/ui';

type Turn = { direction: 'INBOUND' | 'OUTBOUND'; authorType: string; body: string; at: string };

const SUGGESTIONS = [
  '2 chicken biryani, one spicy, and 2 coke',
  'Bhai do chicken biryani dena, ek spicy aur ek normal, aur ek coke',
  "I'll pick it up around 8",
  'same as last time',
  'does the chicken biryani contain peanuts?',
  'what vegetarian options do you have?',
  'how long will it take?',
  'yes',
];

export default function SimulatorPage() {
  const [phone, setPhone] = useState('+919000000001');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(false);
  const [history, setHistory] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(message?: string) {
    const body = (message ?? text).trim();
    if (!body || busy) return;

    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/simulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, text: body, voice }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed.'); return; }
      setHistory(data.history ?? []);
      setText('');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="flex h-[70vh] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-2 text-sm" style={{ borderColor: 'var(--border)' }}>
          <Badge tone="ok">simulated WhatsApp</Badge>
          <span className="muted">{phone}</span>
          {voice ? <Badge tone="info">sending as a voice note</Badge> : null}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {history.length === 0 ? (
            <p className="mt-10 text-center text-sm muted">
              Send a message the way a customer would. Everything below is the real ordering pipeline.
            </p>
          ) : (
            history.map((turn, i) => (
              <div key={i} className={`flex ${turn.direction === 'INBOUND' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className="max-w-[78%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm"
                  style={
                    turn.direction === 'INBOUND'
                      ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }
                      : { background: 'var(--bg)', border: '1px solid var(--border)' }
                  }
                >
                  {turn.body}
                  {turn.authorType === 'STAFF' ? (
                    <div className="mt-1 text-[10px] uppercase tracking-wide muted">sent by staff</div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          {error ? <div className="mb-2 text-xs" style={{ color: 'var(--danger)' }}>{error}</div> : null}
          <div className="flex gap-2">
            <Input
              value={text}
              placeholder="Type what a customer would send…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
            <Button variant="primary" disabled={busy} onClick={() => send()}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs muted">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            Send as a voice note (your text becomes the transcript, so the voice path runs end to end)
          </label>
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="p-4">
          <Field label="Customer number" hint="Each number is a separate customer with its own history.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </Card>

        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">Try one of these</div>
          <div className="space-y-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={busy}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs"
                style={{ border: '1px solid var(--border)' }}
              >
                {s}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
