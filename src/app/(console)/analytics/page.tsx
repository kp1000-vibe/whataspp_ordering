'use client';

/**
 * Analytics.
 *
 * The headline is AI containment, not revenue — the product's promise is that
 * staff stop taking orders by hand, and this is the number that proves it.
 * Everything here is computed from the database; nothing is estimated.
 */
import { useEffect, useState } from 'react';
import { Card, Stat, Empty, money } from '../../../components/ui';

export default function AnalyticsPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch('/api/analytics').then((r) => r.json()).then(setData);
  }, []);

  if (!data?.stats) return <Empty title="Loading analytics…" />;

  const { stats, topItems, peakHours, usage, ai, currency } = data;
  const peakMax = Math.max(1, ...peakHours.map((h: any) => h.orders));
  const itemMax = Math.max(1, ...topItems.map((i: any) => i.units));

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold muted">How much work the assistant absorbed</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="AI containment" value={`${Math.round(stats.aiContainmentRate * 100)}%`} tone="ok"
            hint="chats finished with no staff involvement" />
          <Stat label="Handed to a person" value={`${Math.round(stats.humanHandoffRate * 100)}%`}
            tone={stats.humanHandoffRate > 0.2 ? 'warn' : 'default'} />
          <Stat label="Interactions avoided" value={String(stats.staffInteractionsAvoided)}
            hint="messages staff did not have to answer" />
          <Stat label="Needed clarifying" value={`${Math.round(stats.clarificationRate * 100)}%`}
            tone={stats.clarificationRate > 0.35 ? 'warn' : 'default'} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold muted">Service</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Orders today" value={String(stats.ordersToday)} />
          <Stat label="Revenue today" value={money(stats.revenueTodayCents, currency)} />
          <Stat label="Average prep" value={`${stats.averagePrepMinutes} min`} />
          <Stat label="Pickup delay" value={`${stats.averagePickupDelayMinutes} min`}
            tone={stats.averagePickupDelayMinutes > 5 ? 'warn' : 'ok'}
            hint="how far off the promised time we run" />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Busiest hours (last 30 days)</h3>
          {peakHours.length === 0 ? <p className="text-sm muted">Not enough data yet.</p> : (
            <div className="flex h-40 items-end gap-1">
              {peakHours.map((h: any) => (
                <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t"
                    style={{ height: `${(h.orders / peakMax) * 100}%`, background: 'var(--accent)', minHeight: '2px' }}
                    title={`${h.orders} orders at ${h.hour}:00`}
                  />
                  <span className="text-[10px] muted">{h.hour}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Top items (last 30 days)</h3>
          {topItems.length === 0 ? <p className="text-sm muted">Not enough data yet.</p> : (
            <ul className="space-y-2">
              {topItems.map((item: any) => (
                <li key={item.name}>
                  <div className="flex justify-between text-sm">
                    <span>{item.name}</span>
                    <span className="tabular-nums muted">{item.units} · {money(item.revenue_cents, currency)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full" style={{ background: 'var(--bg)' }}>
                    <div className="h-full rounded-full" style={{ width: `${(item.units / itemMax) * 100}%`, background: 'var(--accent)' }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold muted">Usage this month (what you are billed on)</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Orders" value={String(usage.orders ?? 0)} />
          <Stat label="Messages in" value={String(usage.wa_messages_in ?? 0)} />
          <Stat label="Voice notes" value={String(usage.voice_messages ?? 0)} />
          <Stat
            label="AI cost"
            value={`$${((ai.reduce((s: number, r: any) => s + Number(r.cost_micro_usd), 0)) / 1_000_000).toFixed(4)}`}
            hint={ai.map((r: any) => `${r.provider}/${r.model}`).join(', ') || 'no calls yet'}
          />
        </div>
      </section>
    </div>
  );
}
