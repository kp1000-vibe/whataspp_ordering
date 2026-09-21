'use client';

/**
 * Live order board + capacity controls.
 *
 * Design rule for this screen: a manager in the middle of a 7pm rush must be
 * able to act without reading. Hence big single-purpose buttons, a colour for
 * each state, and the capacity controls at the top where a panicking human
 * looks first.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Stat, Badge, Button, Empty, STATUS_TONE, money, clock, ago } from '../../../components/ui';

type Order = {
  id: string; orderNumber: number; status: string; channel: string;
  totalCents: number; promisedReadyAt: string | null; createdAt: string;
  specialInstructions: string; needsHuman: boolean; aiConfidence: number | null;
  customerRequestedTime: boolean; originalReadyAt: string | null; delayNotifiedAt: string | null;
  items: Array<{
    id: string; name: string; quantity: number; notes: string; lineTotalCents: number;
    modifiers: Array<{ name: string }>;
  }>;
};

type Capacity = {
  state: 'OPEN' | 'BUSY' | 'VERY_BUSY' | 'PAUSED' | 'CLOSED';
  etaOffsetMinutes: number; maxOrdersPerSlot: number; slotMinutes: number; note: string;
};

type Slot = { label: string; rangeLabel: string; booked: number; capacity: number; available: boolean };

const COLUMNS: Array<{ key: string; title: string; statuses: string[]; next?: { label: string; status: string } }> = [
  { key: 'new', title: 'New', statuses: ['RECEIVED'], next: { label: 'Accept', status: 'ACCEPTED' } },
  { key: 'accepted', title: 'Accepted', statuses: ['ACCEPTED'], next: { label: 'Start cooking', status: 'PREPARING' } },
  { key: 'preparing', title: 'Preparing', statuses: ['PREPARING'], next: { label: 'Mark ready', status: 'READY' } },
  { key: 'ready', title: 'Ready', statuses: ['READY'], next: { label: 'Picked up', status: 'PICKED_UP' } },
];

const STATE_TONE: Record<string, string> = {
  OPEN: 'ok', BUSY: 'warn', VERY_BUSY: 'warn', PAUSED: 'danger', CLOSED: 'danger',
};

export default function DashboardPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [currency, setCurrency] = useState('INR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [o, c, a] = await Promise.all([
        fetch('/api/orders?status=RECEIVED,ACCEPTED,PREPARING,READY&limit=100').then((r) => r.json()),
        fetch('/api/capacity').then((r) => r.json()),
        fetch('/api/analytics').then((r) => r.json()),
      ]);
      if (o.orders) setOrders(o.orders);
      if (c.capacity) { setCapacity(c.capacity); setSlots(c.slots ?? []); }
      if (a.stats) { setStats(a.stats); setCurrency(a.currency ?? 'INR'); }
      setError('');
    } catch {
      setError('Could not reach the server. Retrying…');
    }
  }, []);

  useEffect(() => {
    load();
    // Polling, not websockets: a kitchen tablet on flaky wifi reconnects for free.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function move(orderId: string, status: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) setError((await res.json()).error ?? 'That change was refused.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function delay(orderId: string, minutes: number) {
    setBusy(true);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delay', minutes, reason: 'Kitchen is running behind.' }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setCapacityState(patch: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch('/api/capacity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg px-4 py-2 text-sm" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}

      {/* ── capacity controls: the panic buttons ── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="live-dot h-2 w-2 rounded-full" style={{ background: 'var(--ok)' }} />
            <span className="text-sm font-medium">Kitchen status</span>
            {capacity ? <Badge tone={STATE_TONE[capacity.state]}>{capacity.state.replace('_', ' ')}</Badge> : null}
            {capacity && capacity.etaOffsetMinutes > 0 ? (
              <Badge tone="warn">+{capacity.etaOffsetMinutes} min on every ETA</Badge>
            ) : null}
          </div>

          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => setCapacityState({ state: 'OPEN', etaOffsetMinutes: 0, note: '' })}>Open</Button>
            <Button size="sm" disabled={busy} onClick={() => setCapacityState({ state: 'BUSY' })}>Busy</Button>
            <Button size="sm" disabled={busy} onClick={() => setCapacityState({ state: 'VERY_BUSY' })}>Very busy</Button>
            <Button size="sm" disabled={busy} onClick={() => setCapacityState({ etaOffsetMinutes: (capacity?.etaOffsetMinutes ?? 0) + 15 })}>+15 min</Button>
            <Button size="sm" disabled={busy} onClick={() => setCapacityState({ etaOffsetMinutes: (capacity?.etaOffsetMinutes ?? 0) + 30 })}>+30 min</Button>
            <Button size="sm" variant="danger" disabled={busy}
              onClick={() => setCapacityState({ state: 'PAUSED', note: 'We have paused new orders for a few minutes while the kitchen catches up.' })}>
              Pause orders
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setCapacityState({ state: 'CLOSED' })}>Close today</Button>
          </div>
        </div>

        {slots.length ? (
          <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
            {slots.map((s) => (
              <div
                key={s.label}
                title={`${s.rangeLabel} — ${s.booked}/${s.capacity} booked`}
                className="min-w-[74px] rounded-lg px-2 py-1.5 text-center text-xs"
                style={{
                  border: '1px solid var(--border)',
                  background: s.available
                    ? 'transparent'
                    : 'color-mix(in srgb, var(--danger) 12%, transparent)',
                  opacity: s.available ? 1 : 0.75,
                }}
              >
                <div className="font-medium">{s.label}</div>
                <div className="muted tabular-nums">{s.booked}/{s.capacity}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ── today's numbers ── */}
      {stats ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Orders today" value={String(stats.ordersToday)} />
          <Stat label="Revenue today" value={money(stats.revenueTodayCents, currency)} />
          <Stat label="Average order" value={money(stats.averageOrderCents, currency)} />
          <Stat label="In the kitchen" value={String(stats.activeOrders)} tone={stats.activeOrders > 8 ? 'warn' : 'default'} />
          <Stat label="AI handled" value={`${Math.round(stats.aiContainmentRate * 100)}%`} tone="ok"
            hint={`${stats.staffInteractionsAvoided} interactions avoided`} />
          <Stat label="Avg pickup delay" value={`${stats.averagePickupDelayMinutes} min`}
            tone={stats.averagePickupDelayMinutes > 5 ? 'warn' : 'ok'} />
        </div>
      ) : null}

      {/* ── the board ── */}
      <div className="grid gap-4 lg:grid-cols-4">
        {COLUMNS.map((column) => {
          const columnOrders = orders.filter((o) => column.statuses.includes(o.status));
          return (
            <div key={column.key} className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold">{column.title}</h2>
                <Badge tone={columnOrders.length ? 'info' : 'neutral'}>{columnOrders.length}</Badge>
              </div>

              {columnOrders.length === 0 ? (
                <Card className="p-6 text-center text-xs muted">Nothing here</Card>
              ) : (
                columnOrders.map((order) => (
                  <Card key={order.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold">#{order.orderNumber}</div>
                        <div className="text-xs muted">{ago(order.createdAt)} · {order.channel.replace('WHATSAPP_', '').toLowerCase()}</div>
                      </div>
                      <div className="text-right">
                        <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status.toLowerCase()}</Badge>
                        <div className="mt-1 text-sm font-semibold tabular-nums">{money(order.totalCents, currency)}</div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {order.needsHuman ? <Badge tone="danger">needs a person</Badge> : null}
                      {order.aiConfidence != null && order.aiConfidence < 0.62 ? <Badge tone="warn">check with customer</Badge> : null}
                      {order.customerRequestedTime ? <Badge tone="info">requested time</Badge> : null}
                      {order.delayNotifiedAt ? <Badge tone="warn">delayed, customer told</Badge> : null}
                    </div>

                    <ul className="mt-2 space-y-1 text-sm">
                      {order.items.map((item) => (
                        <li key={item.id}>
                          <span className="font-medium tabular-nums">{item.quantity}×</span> {item.name}
                          {item.modifiers.length || item.notes ? (
                            <span className="muted"> — {[...item.modifiers.map((m) => m.name), item.notes].filter(Boolean).join(', ')}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    {order.specialInstructions ? (
                      <div className="mt-2 rounded px-2 py-1 text-xs" style={{ background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                        {order.specialInstructions}
                      </div>
                    ) : null}

                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="muted">Pickup {clock(order.promisedReadyAt)}</span>
                      {order.status === 'PREPARING' || order.status === 'ACCEPTED' ? (
                        <button className="muted underline" disabled={busy} onClick={() => delay(order.id, 15)}>
                          running late +15
                        </button>
                      ) : null}
                    </div>

                    {column.next ? (
                      <div className="mt-2 flex gap-2">
                        <Button variant="primary" size="sm" disabled={busy}
                          onClick={() => move(order.id, column.next!.status)}>
                          {column.next.label}
                        </Button>
                        {order.status === 'RECEIVED' ? (
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => move(order.id, 'REJECTED')}>
                            Reject
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                ))
              )}
            </div>
          );
        })}
      </div>

      {orders.length === 0 ? (
        <Empty title="No live orders right now" hint="New WhatsApp orders appear here the moment a customer confirms." />
      ) : null}
    </div>
  );
}
