'use client';

/**
 * Kitchen display.
 *
 * Read from two metres away by someone holding a ladle. Three columns, huge
 * type, two buttons per card, no money, no customer details, no navigation
 * chrome to mis-tap. Cards turn amber then red as the promised pickup time
 * approaches, which is the only warning a cook actually needs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../components/ui';

type Order = {
  id: string; orderNumber: number; status: string;
  promisedReadyAt: string | null; createdAt: string; specialInstructions: string;
  items: Array<{ id: string; name: string; quantity: number; notes: string; modifiers: Array<{ name: string }> }>;
};

const COLUMNS = [
  { title: 'NEW', statuses: ['RECEIVED', 'ACCEPTED'], action: { label: 'START', status: 'PREPARING' } },
  { title: 'COOKING', statuses: ['PREPARING'], action: { label: 'READY', status: 'READY' } },
  { title: 'READY', statuses: ['READY'], action: { label: 'PICKED UP', status: 'PICKED_UP' } },
];

/** Minutes until the promised pickup; negative means we are already late. */
function minutesLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function urgencyStyle(left: number | null): Record<string, string> {
  if (left == null) return { border: '1px solid var(--border)' };
  if (left < 0) return { border: '2px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, var(--surface))' };
  if (left <= 5) return { border: '2px solid var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))' };
  return { border: '1px solid var(--border)' };
}

export default function KitchenPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch('/api/orders?status=RECEIVED,ACCEPTED,PREPARING,READY&limit=60');
    const data = await res.json();
    if (data.orders) setOrders(data.orders);
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 4000);
    // Separate 30s tick so the countdown stays live between fetches.
    const clockTick = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => { clearInterval(poll); clearInterval(clockTick); };
  }, [load]);

  async function move(orderId: string, status: string) {
    setBusy(true);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-tick={tick}>
      {COLUMNS.map((column) => {
        const columnOrders = orders
          .filter((o) => column.statuses.includes(o.status))
          .sort((a, b) => {
            const at = a.promisedReadyAt ? new Date(a.promisedReadyAt).getTime() : Infinity;
            const bt = b.promisedReadyAt ? new Date(b.promisedReadyAt).getTime() : Infinity;
            return at - bt;   // soonest pickup first — this is the cooking order
          });

        return (
          <section key={column.title} className="space-y-3">
            <h2 className="px-1 text-lg font-bold tracking-wide">
              {column.title}
              <span className="ml-2 text-base font-normal muted">{columnOrders.length}</span>
            </h2>

            {columnOrders.length === 0 ? (
              <div className="rounded-xl p-8 text-center text-sm muted" style={{ border: '1px dashed var(--border)' }}>
                —
              </div>
            ) : (
              columnOrders.map((order) => {
                const left = minutesLeft(order.promisedReadyAt);
                return (
                  <article
                    key={order.id}
                    className="kitchen-card rounded-xl p-4"
                    style={{ background: 'var(--surface)', ...urgencyStyle(left) }}
                  >
                    <header className="flex items-baseline justify-between">
                      <span className="text-2xl font-extrabold">#{order.orderNumber}</span>
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: left != null && left < 0 ? 'var(--danger)' : left != null && left <= 5 ? 'var(--warn)' : 'var(--muted)' }}
                      >
                        {left == null ? '' : left < 0 ? `${Math.abs(left)} MIN LATE` : `${left} MIN`}
                      </span>
                    </header>

                    <ul className="mt-3 space-y-2">
                      {order.items.map((item) => (
                        <li key={item.id} className="leading-tight">
                          <span className="qty">{item.quantity}</span>
                          <span className="ml-2 font-semibold uppercase">{item.name}</span>
                          {item.modifiers.map((m) => (
                            <div key={m.name} className="ml-8 text-sm font-medium" style={{ color: 'var(--accent)' }}>
                              + {m.name}
                            </div>
                          ))}
                          {item.notes ? (
                            <div className="ml-8 text-sm font-semibold" style={{ color: 'var(--warn)' }}>
                              ! {item.notes}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    {order.specialInstructions ? (
                      <p className="mt-3 rounded px-2 py-1 text-sm font-medium"
                        style={{ background: 'color-mix(in srgb, var(--warn) 16%, transparent)' }}>
                        {order.specialInstructions}
                      </p>
                    ) : null}

                    <div className="mt-4">
                      <Button variant="primary" size="lg" disabled={busy} onClick={() => move(order.id, column.action.status)}>
                        {column.action.label}
                      </Button>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
