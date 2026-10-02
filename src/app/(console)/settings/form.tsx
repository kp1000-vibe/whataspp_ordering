'use client';

/**
 * Editable restaurant settings: opening hours and pickup capacity — the two
 * things a new restaurant MUST set before the assistant can take an order.
 */
import { useEffect, useState } from 'react';
import { Card, Button, Field, Input } from '../../../components/ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Hours = { dayOfWeek: number; open: string | null; close: string | null; closed: boolean };

export function SettingsForm() {
  const [hours, setHours] = useState<Hours[]>([]);
  const [cap, setCap] = useState({ slotMinutes: 15, maxOrdersPerSlot: 8, minLeadMinutes: 10, defaultPrepMinutes: 20, allowScheduledOrders: false, pickupInstructions: '' });
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // A stale or duplicate load (React runs effects twice in dev; slow networks
    // reorder responses) must never overwrite what the manager has typed.
    let cancelled = false;
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      if (cancelled || !d.hours) return;
      setHours(d.hours.map((h: any) => ({ dayOfWeek: h.dayOfWeek, open: h.open ?? '11:00', close: h.close ?? '22:00', closed: h.closed })));
      setCap({
        slotMinutes: d.location.slotMinutes, maxOrdersPerSlot: d.location.maxOrdersPerSlot,
        minLeadMinutes: d.location.minLeadMinutes, defaultPrepMinutes: d.settings?.defaultPrepMinutes ?? 20,
        allowScheduledOrders: !!d.settings?.allowScheduledOrders, pickupInstructions: d.settings?.pickupInstructions ?? '',
      });
    });
    return () => { cancelled = true; };
  }, []);

  const setDay = (d: number, patch: Partial<Hours>) => setHours((hs) => hs.map((h) => (h.dayOfWeek === d ? { ...h, ...patch } : h)));

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const h = await fetch('/api/settings/hours', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours }),
      });
      if (!h.ok) { setStatus({ ok: false, text: (await h.json()).error ?? 'Could not save hours.' }); return; }
      const s = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotMinutes: Number(cap.slotMinutes), maxOrdersPerSlot: Number(cap.maxOrdersPerSlot),
          minLeadMinutes: Number(cap.minLeadMinutes), defaultPrepMinutes: Number(cap.defaultPrepMinutes),
          allowScheduledOrders: cap.allowScheduledOrders, pickupInstructions: cap.pickupInstructions,
        }),
      });
      const data = await s.json();
      if (!s.ok) { setStatus({ ok: false, text: [data.error, ...(data.details ?? [])].join(' ') }); return; }
      setStatus({ ok: true, text: 'Saved' });
    } finally {
      setBusy(false);
    }
  }

  if (!hours.length) return null;

  return (
    <Card className="p-4 lg:col-span-2">
      <h2 className="mb-3 text-sm font-semibold">Opening hours &amp; pickup capacity</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          {hours.map((h) => (
            <div key={h.dayOfWeek} className="flex flex-wrap items-end gap-2">
              <span className="w-24 text-sm font-medium">{DAYS[h.dayOfWeek]}</span>
              <label className="text-xs">
                <span className="sr-only">{DAYS[h.dayOfWeek]} opens</span>
                <input aria-label={`${DAYS[h.dayOfWeek]} opens`} type="time" value={h.open ?? ''} disabled={h.closed}
                  onChange={(e) => setDay(h.dayOfWeek, { open: e.target.value })}
                  className="rounded-lg px-2 py-1 text-sm" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
              </label>
              <span className="pb-1 text-xs muted">to</span>
              <label className="text-xs">
                <span className="sr-only">{DAYS[h.dayOfWeek]} closes</span>
                <input aria-label={`${DAYS[h.dayOfWeek]} closes`} type="time" value={h.close ?? ''} disabled={h.closed}
                  onChange={(e) => setDay(h.dayOfWeek, { close: e.target.value })}
                  className="rounded-lg px-2 py-1 text-sm" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
              </label>
              <label className="flex items-center gap-1 pb-1 text-xs muted">
                <input type="checkbox" checked={h.closed} onChange={(e) => setDay(h.dayOfWeek, { closed: e.target.checked })} />
                Closed
              </label>
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Orders per slot" hint="The kitchen will never be promised more than this per slot.">
            <Input type="number" min={1} value={cap.maxOrdersPerSlot} onChange={(e) => setCap({ ...cap, maxOrdersPerSlot: Number(e.target.value) })} />
          </Field>
          <Field label="Slot length (minutes)">
            <select value={cap.slotMinutes} onChange={(e) => setCap({ ...cap, slotMinutes: Number(e.target.value) })}
              className="w-full rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
              {[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Default prep time (minutes)">
            <Input type="number" min={1} value={cap.defaultPrepMinutes} onChange={(e) => setCap({ ...cap, defaultPrepMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Minimum lead time (minutes)">
            <Input type="number" min={0} value={cap.minLeadMinutes} onChange={(e) => setCap({ ...cap, minLeadMinutes: Number(e.target.value) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={cap.allowScheduledOrders} onChange={(e) => setCap({ ...cap, allowScheduledOrders: e.target.checked })} />
            Allow orders for later while we're closed
          </label>
          <div className="sm:col-span-2">
            <Field label="Pickup instructions the assistant may quote">
              <Input value={cap.pickupInstructions} onChange={(e) => setCap({ ...cap, pickupInstructions: e.target.value })} />
            </Field>
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={save}>Save settings</Button>
        {status ? <span className="text-sm" style={{ color: status.ok ? 'var(--ok)' : 'var(--danger)' }}>{status.text}</span> : null}
      </div>
    </Card>
  );
}
