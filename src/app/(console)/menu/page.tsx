'use client';

/**
 * Menu + availability.
 *
 * The one action that matters during service is "sold out", so it is a single
 * tap on every row. Everything the AI says about an item comes from this screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Button, Empty, money } from '../../../components/ui';

type Modifier = { id: string; name: string; priceDeltaCents: number; availability: string };
type Group = { id: string; name: string; isRequired: boolean; modifiers: Modifier[] };
type Item = {
  id: string; name: string; categoryName: string; description: string;
  priceCents: number; prepMinutes: number; availability: string;
  isVegetarian: boolean; isVegan: boolean; allergens: string[] | null;
  aliases: string[]; modifierGroups: Group[];
};

export default function MenuPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await fetch('/api/menu').then((r) => r.json());
    setItems(data.menu ?? []);
    setLocationId(data.locationId ?? '');
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(item: Item) {
    setBusy(item.id);
    try {
      await fetch('/api/menu/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId,
          menuItemId: item.id,
          status: item.availability === 'AVAILABLE' ? 'SOLD_OUT' : 'AVAILABLE',
          reason: item.availability === 'AVAILABLE' ? 'marked sold out from the console' : '',
        }),
      });
      await load();
    } finally {
      setBusy('');
    }
  }

  const categories = [...new Set(items.map((i) => i.categoryName))];
  const soldOut = items.filter((i) => i.availability !== 'AVAILABLE').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Menu</h1>
        <Badge tone="neutral">{items.length} items</Badge>
        {soldOut ? <Badge tone="danger">{soldOut} sold out</Badge> : null}
        <p className="ml-auto text-sm muted">
          Marking an item sold out changes what the assistant tells customers immediately.
        </p>
      </div>

      {items.length === 0 ? (
        <Empty title="No menu yet" hint="Import a CSV or add items to start taking orders." />
      ) : (
        categories.map((category) => (
          <section key={category} className="space-y-2">
            <h2 className="text-sm font-semibold muted">{category}</h2>
            <Card className="divide-y">
              {items.filter((i) => i.categoryName === category).map((item) => (
                <div key={item.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        {item.isVegan ? <Badge tone="ok">vegan</Badge> : item.isVegetarian ? <Badge tone="ok">veg</Badge> : null}
                        {item.availability !== 'AVAILABLE' ? <Badge tone="danger">sold out</Badge> : null}
                        {item.allergens === null ? <Badge tone="warn">allergens not verified</Badge> : null}
                      </div>
                      <div className="truncate text-sm muted">{item.description}</div>
                      {item.aliases.length ? (
                        <div className="mt-0.5 text-xs muted">also called: {item.aliases.join(', ')}</div>
                      ) : null}
                    </div>

                    <div className="text-right">
                      <div className="font-semibold tabular-nums">{money(item.priceCents)}</div>
                      <div className="text-xs muted">{item.prepMinutes} min</div>
                    </div>

                    <Button
                      size="sm"
                      variant={item.availability === 'AVAILABLE' ? 'secondary' : 'primary'}
                      disabled={busy === item.id}
                      onClick={() => toggle(item)}
                    >
                      {item.availability === 'AVAILABLE' ? 'Mark sold out' : 'Back in stock'}
                    </Button>

                    {item.modifierGroups.length ? (
                      <button
                        className="text-xs muted underline"
                        onClick={() => setOpen(open === item.id ? null : item.id)}
                      >
                        {open === item.id ? 'hide' : 'options'}
                      </button>
                    ) : null}
                  </div>

                  {open === item.id ? (
                    <div className="px-3 pb-3 pl-6 text-sm">
                      {item.modifierGroups.map((group) => (
                        <div key={group.id} className="mb-2">
                          <div className="text-xs font-semibold muted">
                            {group.name}{group.isRequired ? ' (the assistant always asks)' : ''}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {group.modifiers.map((m) => (
                              <span
                                key={m.id}
                                className="rounded-full px-2 py-0.5 text-xs"
                                style={{
                                  border: '1px solid var(--border)',
                                  opacity: m.availability === 'AVAILABLE' ? 1 : 0.45,
                                }}
                              >
                                {m.name}{m.priceDeltaCents ? ` +${money(m.priceDeltaCents)}` : ''}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                      <div className="text-xs muted">
                        Allergens: {item.allergens === null
                          ? 'not verified — the assistant will refuse to answer and hand the customer to staff'
                          : item.allergens.length ? item.allergens.join(', ') : 'none declared'}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </Card>
          </section>
        ))
      )}
    </div>
  );
}
