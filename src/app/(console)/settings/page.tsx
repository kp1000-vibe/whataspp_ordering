import { redirect } from 'next/navigation';
import { currentUser, activeRestaurantId } from '../../../server/http';
import { scopeForUser } from '../../../server/auth/service';
import { correlationId } from '../../../lib/ids';
import { getDb } from '../../../db/client';
import { restaurants, restaurantSettings } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { whatsappStatus } from '../../../server/messaging/registry';
import { printerHealth } from '../../../server/printing/service';
import { SettingsForm } from './form';

export const dynamic = 'force-dynamic';


export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const restaurantId = (await activeRestaurantId(user))!;
  const scope = await scopeForUser(user, restaurantId, correlationId());
  const db = await getDb();

  const [restaurant] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, restaurantId)).limit(1);

  const wa = await whatsappStatus(restaurantId);
  const printers = await printerHealth(scope);

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-4 py-1.5 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SettingsForm />
      <section className="surface rounded-xl p-4">
        <h2 className="mb-3 text-sm font-semibold">Restaurant</h2>
        <Row label="Name" value={restaurant?.name ?? '—'} />
        <Row label="Timezone" value={restaurant?.timezone ?? '—'} />
        <Row label="Currency" value={restaurant?.currency ?? '—'} />
        <Row label="Tax rate" value={`${((restaurant?.taxRateBps ?? 0) / 100).toFixed(2)}%`} />
        <Row label="Live" value={restaurant?.isLive ? 'yes' : 'no'} />
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-3 text-sm font-semibold">WhatsApp</h2>
        <Row label="Status" value={wa.connected ? 'CONNECTED' : 'ACTION REQUIRED'} />
        <Row label="Provider" value={wa.provider} />
        <Row label="Number" value={wa.displayPhoneNumber ?? '—'} />
        {!wa.connected ? (
          <p className="mt-3 text-xs muted">
            This restaurant is using the built-in simulator. To go live, connect a WhatsApp Business
            Platform number: set <code>WHATSAPP_ACCESS_TOKEN</code>, <code>WHATSAPP_PHONE_NUMBER_ID</code>,{' '}
            <code>WHATSAPP_APP_SECRET</code> and <code>WHATSAPP_VERIFY_TOKEN</code>, then point the Meta webhook at{' '}
            <code>/api/webhooks/whatsapp</code>. Unofficial WhatsApp automation is never used.
          </p>
        ) : null}
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-3 text-sm font-semibold">Printers</h2>
        {printers.length === 0 ? (
          <p className="text-sm muted">No printer configured — orders are still visible on screen.</p>
        ) : (
          printers.map((p: any) => (
            <div key={p.id}>
              <Row label={p.name} value={`${p.kind} · ${p.transport} · ${p.online ? 'online' : 'offline'}`} />
              {p.pendingJobs ? <Row label="Pending jobs" value={String(p.pendingJobs)} /> : null}
            </div>
          ))
        )}
        <p className="mt-3 text-xs muted">
          The cloud never connects into your network. The local print agent polls{' '}
          <code>/api/print/jobs</code> with its own token and reports back.
        </p>
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-3 text-sm font-semibold">Pickup instructions the assistant may quote</h2>
        <p className="text-sm">{settings?.pickupInstructions || '—'}</p>
        <p className="mt-2 text-sm muted">{settings?.parkingInfo || ''}</p>
        <p className="mt-2 text-xs muted">Cancellation: {settings?.cancellationPolicy}</p>
      </section>
    </div>
  );
}
