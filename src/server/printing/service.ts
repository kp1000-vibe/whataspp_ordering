/**
 * Printing.
 *
 * The cloud never talks to a printer directly. It renders a plain-text KOT and
 * queues a PrintJob; a local agent (or the browser) claims it. That means a
 * printer on a restaurant LAN needs no inbound firewall rule, and a printer
 * being offline never blocks an order from being accepted.
 *
 * Transports:
 *   AGENT   - local print agent long-polls /api/print/jobs with a bearer token
 *   NETWORK - agent pushes to host:port (ESC/POS over TCP 9100)
 *   BROWSER - the console prints the job itself
 */
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { printers, printJobs, locations, restaurants } from '../../db/schema';
import { newId } from '../../lib/ids';
import { formatCents } from '../../lib/money';
import { formatLocalTime } from '../../lib/time';
import { maskPhone } from '../../lib/phone';
import { sha256, verifyTokenHash } from '../../lib/crypto';
import { emit, on } from '../events/bus';
import { systemScope, type TenantScope } from '../tenancy';
import { getOrder, type OrderView } from '../orders/service';
import { log } from '../../lib/log';

/* ─────────────── KOT rendering ─────────────── */

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function rule(width: number, ch = '-'): string {
  return ch.repeat(width);
}

function twoCol(left: string, right: string, width: number): string {
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

export type KotOptions = {
  width?: number;
  kind?: 'KITCHEN' | 'RECEIPT';
  restaurantName: string;
  timezone: string;
  currency: string;
  customerName?: string | null;
  customerPhone?: string | null;
};

/**
 * Kitchen tickets deliberately omit money — cooks need items, not totals.
 * Receipts include the money and mask the phone number.
 */
export function renderKot(order: OrderView, opts: KotOptions): string {
  const width = opts.width ?? 32;
  const kind = opts.kind ?? 'KITCHEN';
  const out: string[] = [];

  out.push(center(opts.restaurantName.toUpperCase().slice(0, width), width));
  out.push(center(kind === 'KITCHEN' ? 'KITCHEN ORDER' : 'RECEIPT', width));
  out.push(rule(width, '='));
  out.push(`ORDER #${order.orderNumber}`);
  if (order.promisedReadyAt) out.push(`PICKUP ${formatLocalTime(order.promisedReadyAt, opts.timezone)}`);
  out.push(`PLACED ${formatLocalTime(order.createdAt, opts.timezone)}`);
  out.push(rule(width));

  for (const item of order.items) {
    out.push(`${item.quantity} x ${item.name.toUpperCase()}`.slice(0, width));
    for (const mod of item.modifiers) out.push(`   + ${mod.name}`.slice(0, width));
    if (item.notes) out.push(`   ! ${item.notes}`.slice(0, width));
    if (kind === 'RECEIPT') {
      out.push(twoCol('', formatCents(item.lineTotalCents, opts.currency), width));
    }
  }

  if (order.specialInstructions) {
    out.push(rule(width));
    out.push('NOTE:');
    out.push(order.specialInstructions.slice(0, width * 2));
  }

  out.push(rule(width));
  if (kind === 'RECEIPT') {
    out.push(twoCol('Subtotal', formatCents(order.subtotalCents, opts.currency), width));
    if (order.discountCents > 0) out.push(twoCol('Discount', `-${formatCents(order.discountCents, opts.currency)}`, width));
    if (order.taxCents > 0) out.push(twoCol('Tax', formatCents(order.taxCents, opts.currency), width));
    out.push(twoCol('TOTAL', formatCents(order.totalCents, opts.currency), width));
    out.push(twoCol('Payment', order.paymentStatus === 'PAID' ? 'PAID' : 'PAY AT PICKUP', width));
  }

  out.push(rule(width));
  out.push(`CUSTOMER: ${(opts.customerName ?? 'Guest').slice(0, width - 10)}`);
  if (opts.customerPhone) out.push(`PHONE: ${maskPhone(opts.customerPhone)}`);
  out.push(rule(width, '='));
  out.push('');
  out.push('');

  return out.join('\n');
}

/* ─────────────── printers ─────────────── */

export async function listPrinters(scope: TenantScope, locationId?: string) {
  const db = await getDb();
  const conds = [eq(printers.restaurantId, scope.restaurantId)];
  if (locationId) conds.push(eq(printers.locationId, locationId));
  return db.drizzle.select().from(printers).where(and(...conds));
}

export async function createPrinter(
  scope: TenantScope,
  args: {
    locationId: string; name: string; kind?: 'KITCHEN' | 'RECEIPT';
    transport?: 'AGENT' | 'NETWORK' | 'BROWSER';
    paperWidthChars?: number; copies?: number;
    networkHost?: string; networkPort?: number;
  },
): Promise<{ printerId: string; agentToken: string | null }> {
  const db = await getDb();
  const id = newId('prn');

  // The agent token is shown ONCE; only its hash is stored.
  const agentToken = (args.transport ?? 'AGENT') === 'AGENT'
    ? `pa_${newId('t').split('_')[1]}${newId('t').split('_')[1]}`
    : null;

  await db.drizzle.insert(printers).values({
    id, restaurantId: scope.restaurantId, locationId: args.locationId,
    name: args.name, kind: args.kind ?? 'KITCHEN', transport: args.transport ?? 'AGENT',
    paperWidthChars: args.paperWidthChars ?? 32, copies: args.copies ?? 1,
    networkHost: args.networkHost ?? null, networkPort: args.networkPort ?? null,
    agentTokenHash: agentToken ? sha256(agentToken) : null,
  });
  return { printerId: id, agentToken };
}

/* ─────────────── print jobs ─────────────── */

export async function queuePrintForOrder(
  scope: TenantScope, orderId: string,
): Promise<string[]> {
  const db = await getDb();
  const order = await getOrder(scope, orderId);
  if (!order) return [];

  const [restaurant] = await db.drizzle.select().from(restaurants)
    .where(eq(restaurants.id, scope.restaurantId)).limit(1);
  const { rows: customerRows } = await db.execute(
    `SELECT name, phone_e164 FROM customers WHERE id = $1;`, [order.customerId]);
  const customer = customerRows[0] ?? {};

  const targets = await db.drizzle.select().from(printers).where(and(
    eq(printers.restaurantId, scope.restaurantId),
    eq(printers.locationId, order.locationId),
    eq(printers.isActive, true),
  ));

  if (targets.length === 0) {
    log.warn('no active printer configured; order is visible on screen only', {
      orderId, restaurantId: scope.restaurantId,
    });
    return [];
  }

  const jobIds: string[] = [];
  for (const printer of targets) {
    const payload = renderKot(order, {
      width: printer.paperWidthChars,
      kind: printer.kind,
      restaurantName: restaurant?.name ?? '',
      timezone: restaurant?.timezone ?? 'UTC',
      currency: restaurant?.currency ?? 'USD',
      customerName: customer.name,
      customerPhone: customer.phone_e164,
    });

    for (let copy = 0; copy < Math.max(1, printer.copies); copy++) {
      const jobId = newId('pj');
      await db.drizzle.insert(printJobs).values({
        id: jobId, restaurantId: scope.restaurantId, printerId: printer.id,
        orderId, status: 'QUEUED', payload, correlationId: order.correlationId,
      });
      jobIds.push(jobId);

      await emit({
        name: 'printer.job.created', restaurantId: scope.restaurantId,
        payload: { jobId, printerId: printer.id, orderId },
        correlationId: order.correlationId,
      });
    }
  }
  return jobIds;
}

/** Local agent claims work. Token auth, tenant-scoped by the printer row. */
export async function claimJobs(
  printerId: string, token: string, limit = 5,
): Promise<Array<{ id: string; payload: string }>> {
  const db = await getDb();
  const [printer] = await db.drizzle.select().from(printers).where(eq(printers.id, printerId)).limit(1);
  if (!printer || !verifyTokenHash(token, printer.agentTokenHash)) {
    throw new Error('printer authentication failed');
  }

  await db.drizzle.update(printers).set({ lastSeenAt: new Date() }).where(eq(printers.id, printerId));

  const { rows } = await db.execute(`
    WITH claimed AS (
      SELECT id FROM print_jobs
      WHERE printer_id = $1 AND status = 'QUEUED'
      ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(20, limit))}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status = 'CLAIMED', claimed_at = now(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM claimed)
    RETURNING id, payload;
  `, [printerId]);

  return rows as Array<{ id: string; payload: string }>;
}

export async function reportJobResult(
  printerId: string, token: string, jobId: string, ok: boolean, error = '',
): Promise<void> {
  const db = await getDb();
  const [printer] = await db.drizzle.select().from(printers).where(eq(printers.id, printerId)).limit(1);
  if (!printer || !verifyTokenHash(token, printer.agentTokenHash)) {
    throw new Error('printer authentication failed');
  }

  const [job] = await db.drizzle.select().from(printJobs).where(and(
    eq(printJobs.id, jobId), eq(printJobs.printerId, printerId))).limit(1);
  if (!job) throw new Error('print job not found for this printer');

  await db.drizzle.update(printJobs).set({
    status: ok ? 'PRINTED' : (job.attempts >= 3 ? 'FAILED' : 'QUEUED'),
    printedAt: ok ? new Date() : null,
    error: ok ? '' : error.slice(0, 1000),
  }).where(eq(printJobs.id, jobId));

  await emit({
    name: ok ? 'printer.job.printed' : 'printer.job.failed',
    restaurantId: printer.restaurantId,
    payload: { jobId, printerId, orderId: job.orderId, error },
    correlationId: job.correlationId,
  });
}

export async function reprint(scope: TenantScope, orderId: string): Promise<string[]> {
  return queuePrintForOrder(scope, orderId);
}

export async function printerHealth(scope: TenantScope) {
  const db = await getDb();
  const rows = await db.drizzle.select().from(printers)
    .where(eq(printers.restaurantId, scope.restaurantId));

  const { rows: failures } = await db.execute(
    `SELECT printer_id, count(*)::int AS n FROM print_jobs
     WHERE restaurant_id = $1 AND status IN ('QUEUED','FAILED')
     GROUP BY printer_id;`, [scope.restaurantId]);
  const pendingBy = new Map(failures.map((f: any) => [f.printer_id, f.n]));

  return rows.map((p: any) => ({
    id: p.id, name: p.name, kind: p.kind, transport: p.transport,
    lastSeenAt: p.lastSeenAt,
    online: p.transport === 'BROWSER' || (p.lastSeenAt ? Date.now() - new Date(p.lastSeenAt).getTime() < 120_000 : false),
    pendingJobs: pendingBy.get(p.id) ?? 0,
  }));
}

/** Auto-print on accept, when the restaurant has it switched on. */
export function registerPrintHandlers(): void {
  on('order.accepted', async (e) => {
    const db = await getDb();
    const [settings] = await db.execute(
      `SELECT auto_print_on_accept FROM restaurant_settings WHERE restaurant_id = $1;`,
      [e.restaurantId],
    ).then((r) => r.rows);
    if (!settings?.auto_print_on_accept) return;

    await queuePrintForOrder(systemScope(e.restaurantId!, e.correlationId), e.payload.orderId as string);
  }, 'print:auto-on-accept');
}
