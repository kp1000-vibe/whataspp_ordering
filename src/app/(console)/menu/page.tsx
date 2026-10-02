'use client';

/**
 * Menu + availability + menu management.
 *
 * The one action that matters during service is "sold out", so it is a single
 * tap on every row. Below the list, a restaurant can add an item or import a
 * CSV — the import is validated as a whole and publishes nothing if any row is
 * wrong. Everything the assistant says about an item comes from this screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Button, Empty, Field, Input } from '../../../components/ui';
import { useRestaurant } from '../../../components/restaurant';

type Modifier = { id: string; name: string; priceDeltaCents: number; availability: string };
type Group = { id: string; name: string; isRequired: boolean; modifiers: Modifier[] };
type Item = {
  id: string; name: string; categoryName: string; description: string;
  priceCents: number; prepMinutes: number; availability: string;
  isVegetarian: boolean; isVegan: boolean; allergens: string[] | null;
  aliases: string[]; modifierGroups: Group[];
};
type ImportResult = { valid: boolean; rows: number; errors: Array<{ line: number; message: string }>; created: number; updated: number };

const SAMPLE_CSV = 'Category,Item,Price,Description,Available\nDrinks,Masala Chai,45,Spiced tea,true\n';

export default function MenuPage() {
  const { money } = useRestaurant();
  const [items, setItems] = useState<Item[]>([]);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const [form, setForm] = useState({ categoryName: '', name: '', price: '', description: '' });
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [csv, setCsv] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState('');

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
          locationId, menuItemId: item.id,
          status: item.availability === 'AVAILABLE' ? 'SOLD_OUT' : 'AVAILABLE',
          reason: item.availability === 'AVAILABLE' ? 'marked sold out from the console' : '',
        }),
      });
      await load();
    } finally {
      setBusy('');
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setBusy('add');
    setFormMsg(null);
    try {
      const res = await fetch('/api/menu/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setFormMsg({ ok: false, text: data.error ?? 'Could not add the item.' }); return; }
      setFormMsg({ ok: true, text: `Added ${data.item.name}. Allergens start as "not verified" until you fill them in.` });
      setForm({ categoryName: form.categoryName, name: '', price: '', description: '' });
      await load();
    } finally {
      setBusy('');
    }
  }

  async function importCsv() {
    setBusy('import');
    setImportResult(null);
    setImportError('');
    try {
      const res = await fetch('/api/menu/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, dryRun: false }),
      });
      const data = await res.json();
      if (res.status >= 400 && res.status !== 422) { setImportError(data.error ?? 'Import failed.'); return; }
      setImportResult(data);
      if (data.valid) await load();
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
        <Empty title="No menu yet" hint="Add your first item below, or import a CSV." />
      ) : (
        categories.map((category) => (
          <section key={category} className="space-y-2">
            <h2 className="text-sm font-semibold muted">{category}</h2>
            <Card>
              {items.filter((i) => i.categoryName === category).map((item, idx) => (
                <div key={item.id} style={idx ? { borderTop: '1px solid var(--border)' } : undefined}>
                  <div className="flex flex-wrap items-center gap-3 p-3">
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        {item.isVegan ? <Badge tone="ok">vegan</Badge> : item.isVegetarian ? <Badge tone="ok">veg</Badge> : null}
                        {item.availability !== 'AVAILABLE' ? <Badge tone="danger">sold out</Badge> : null}
                        {item.allergens === null ? <Badge tone="warn">allergens not verified</Badge> : null}
                      </div>
                      <div className="truncate text-sm muted">{item.description}</div>
                      {item.aliases.length ? <div className="mt-0.5 text-xs muted">also called: {item.aliases.join(', ')}</div> : null}
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">{money(item.priceCents)}</div>
                      <div className="text-xs muted">{item.prepMinutes} min</div>
                    </div>
                    <Button size="sm" variant={item.availability === 'AVAILABLE' ? 'secondary' : 'primary'}
                      disabled={busy === item.id} onClick={() => toggle(item)}>
                      {item.availability === 'AVAILABLE' ? 'Mark sold out' : 'Back in stock'}
                    </Button>
                    {item.modifierGroups.length ? (
                      <button className="text-xs muted underline" onClick={() => setOpen(open === item.id ? null : item.id)}>
                        {open === item.id ? 'hide' : 'options'}
                      </button>
                    ) : null}
                  </div>
                  {open === item.id ? (
                    <div className="px-3 pb-3 pl-6 text-sm">
                      {item.modifierGroups.map((group) => (
                        <div key={group.id} className="mb-2">
                          <div className="text-xs font-semibold muted">{group.name}{group.isRequired ? ' (the assistant always asks)' : ''}</div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {group.modifiers.map((m) => (
                              <span key={m.id} className="rounded-full px-2 py-0.5 text-xs"
                                style={{ border: '1px solid var(--border)', opacity: m.availability === 'AVAILABLE' ? 1 : 0.45 }}>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">Add an item</h2>
          <form onSubmit={addItem} className="grid gap-3 sm:grid-cols-2">
            <Field label="Category">
              <Input value={form.categoryName} onChange={(e) => setForm({ ...form, categoryName: e.target.value })} required placeholder="Drinks" />
            </Field>
            <Field label="Item name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Masala Chai" />
            </Field>
            <Field label="Price">
              <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required inputMode="decimal" placeholder="45.00" />
            </Field>
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional" />
            </Field>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" disabled={busy === 'add'}>Add item</Button>
              {formMsg ? <span className="text-sm" style={{ color: formMsg.ok ? 'var(--ok)' : 'var(--danger)' }}>{formMsg.text}</span> : null}
            </div>
          </form>
        </Card>

        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold">Import from CSV</h2>
          <p className="mb-3 text-xs muted">Columns: Category, Item, Price, Description, Available. The whole file is checked first — if any row is wrong, nothing is published.</p>
          <label className="block">
            <span className="text-sm font-medium">CSV</span>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={SAMPLE_CSV}
              rows={6}
              className="mt-1 w-full rounded-lg px-3 py-2 font-mono text-xs"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
          </label>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="primary" disabled={busy === 'import' || !csv.trim()} onClick={importCsv}>Import CSV</Button>
            {importError ? <span className="text-sm" style={{ color: 'var(--danger)' }}>{importError}</span> : null}
          </div>
          {importResult ? (
            importResult.valid ? (
              <p className="mt-3 text-sm" style={{ color: 'var(--ok)' }}>
                Imported: {importResult.created} new, {importResult.updated} updated.
              </p>
            ) : (
              <div className="mt-3 rounded-lg p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
                <div className="font-medium" style={{ color: 'var(--danger)' }}>Nothing was published. Fix these and import again:</div>
                <ul className="mt-1 list-disc pl-5">
                  {importResult.errors.map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}
                </ul>
              </div>
            )
          ) : null}
        </Card>
      </div>
    </div>
  );
}
