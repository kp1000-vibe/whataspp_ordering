'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Input, Empty, money } from '../../../components/ui';

type Customer = {
  id: string; name: string | null; phoneE164: string;
  totalOrders: number; lifetimeSpendCents: number; averageOrderCents: number;
  daysSinceLastOrder: number | null; marketingStatus: string; tags: string[];
  favouriteItems: Array<{ name: string; count: number }>;
};

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(async (q: string) => {
    const data = await fetch(`/api/customers?q=${encodeURIComponent(q)}`).then((r) => r.json());
    setCustomers(data.customers ?? []);
  }, []);

  useEffect(() => { const t = setTimeout(() => load(query), 200); return () => clearTimeout(t); }, [query, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Customers</h1>
        <Badge tone="neutral">{customers.length}</Badge>
        <div className="ml-auto w-72">
          <Input value={query} placeholder="Search name or number" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {customers.length === 0 ? (
        <Empty title="No customers yet" hint="A profile is created the first time someone messages you." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th className="px-3 py-2 text-left font-medium muted">Customer</th>
                <th className="px-3 py-2 text-right font-medium muted">Orders</th>
                <th className="px-3 py-2 text-right font-medium muted">Lifetime</th>
                <th className="px-3 py-2 text-right font-medium muted">Average</th>
                <th className="px-3 py-2 text-right font-medium muted">Last order</th>
                <th className="px-3 py-2 text-left font-medium muted">Usually orders</th>
                <th className="px-3 py-2 text-left font-medium muted">Marketing</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.name ?? 'Unknown'}</div>
                    <div className="text-xs muted">{c.phoneE164}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.totalOrders}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(c.lifetimeSpendCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(c.averageOrderCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {c.daysSinceLastOrder == null ? '—' : c.daysSinceLastOrder === 0 ? 'today' : `${c.daysSinceLastOrder}d ago`}
                  </td>
                  <td className="px-3 py-2">
                    {c.favouriteItems.length ? c.favouriteItems.slice(0, 2).map((f) => f.name).join(', ') : <span className="muted">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {c.marketingStatus === 'OPTED_IN'
                      ? <Badge tone="ok">opted in</Badge>
                      : c.marketingStatus === 'OPTED_OUT'
                        ? <Badge tone="danger">opted out</Badge>
                        : <Badge tone="neutral">unknown</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
