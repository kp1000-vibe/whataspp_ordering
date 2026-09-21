/**
 * Demo seed: "SpiceBox Biryani", Hyderabad. Realistic enough that the console
 * looks like a working restaurant the moment it loads.
 *
 * Idempotent: re-running wipes and rebuilds the demo tenant only.
 */
import { getDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  organizations, restaurants, locations, users, staff, restaurantSettings,
  businessHours, menuCategories, menuItems, modifierGroups, modifiers,
  customers, customerConsent, faqEntries, promotions, integrations, printers,
  orders, orderItems, orderItemModifiers, orderStatusHistory, segments,
} from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { newId, correlationId } from '../src/lib/ids';
import { hashPassword, sha256 } from '../src/lib/crypto';
import { SYSTEM_SEGMENTS } from '../src/server/segments/engine';
import { systemScope } from '../src/server/tenancy';
import { recomputeCustomerRollups } from '../src/server/crm/service';

const DEMO_SLUG = 'spicebox-biryani-demo';
const OWNER_EMAIL = 'owner@spicebox.demo';
const OWNER_PASSWORD = 'spicebox2026';

/* ── menu definition ── */

type ItemDef = {
  name: string; priceCents: number; description: string; prepMinutes: number;
  veg?: boolean; vegan?: boolean; aliases?: string[]; allergens?: string[] | null;
  groups?: Array<{
    name: string; required?: boolean; min?: number; max?: number;
    options: Array<{ name: string; delta: number; aliases?: string[]; isDefault?: boolean }>;
  }>;
};

const SPICE_GROUP = {
  name: 'Spice Level', required: true, min: 1, max: 1,
  options: [
    { name: 'Regular', delta: 0, aliases: ['normal', 'mild', 'saada', 'sada'], isDefault: true },
    { name: 'Spicy', delta: 0, aliases: ['teekha', 'tikha', 'hot', 'masaledar'] },
    { name: 'Extra Spicy', delta: 0, aliases: ['extra teekha', 'very spicy', 'double spicy'] },
  ],
};

const ADDONS_GROUP = {
  name: 'Add-ons', required: false, min: 0, max: 3,
  options: [
    { name: 'Extra Rice', delta: 4000, aliases: ['more rice', 'extra chawal'] },
    { name: 'Extra Raita', delta: 3000, aliases: ['more raita', 'extra dahi'] },
    { name: 'Extra Gravy', delta: 3500, aliases: ['more gravy', 'salan'] },
  ],
};

const MENU: Record<string, ItemDef[]> = {
  Biryani: [
    {
      name: 'Chicken Biryani', priceCents: 24000, prepMinutes: 22,
      description: 'Hyderabadi dum biryani with chicken, served with raita and salan',
      aliases: ['chicken dum biryani', 'murgh biryani', 'chkn biryani'],
      allergens: ['dairy'],
      groups: [SPICE_GROUP, ADDONS_GROUP],
    },
    {
      name: 'Mutton Biryani', priceCents: 34000, prepMinutes: 28,
      description: 'Slow-cooked mutton dum biryani with raita and salan',
      aliases: ['gosht biryani', 'lamb biryani'],
      allergens: ['dairy'],
      groups: [SPICE_GROUP, ADDONS_GROUP],
    },
    {
      name: 'Veg Biryani', priceCents: 19000, prepMinutes: 18,
      description: 'Mixed vegetable dum biryani with raita',
      veg: true, aliases: ['vegetable biryani', 'veggie biryani'],
      allergens: ['dairy'],
      groups: [SPICE_GROUP, ADDONS_GROUP],
    },
  ],
  Starters: [
    {
      name: 'Chicken 65', priceCents: 22000, prepMinutes: 15,
      description: 'Crispy fried chicken tossed with curry leaves and chilli',
      aliases: ['chicken sixty five', 'ch 65'],
      allergens: ['egg'],
      groups: [SPICE_GROUP],
    },
    {
      name: 'Paneer Tikka', priceCents: 21000, prepMinutes: 16,
      description: 'Char-grilled cottage cheese with peppers and onion',
      veg: true, aliases: ['panner tikka', 'grilled paneer'],
      allergens: ['dairy'],
      groups: [SPICE_GROUP],
    },
  ],
  Breads: [
    {
      name: 'Garlic Naan', priceCents: 7000, prepMinutes: 8,
      description: 'Tandoori naan with garlic and butter',
      veg: true, aliases: ['lehsuni naan', 'garlic bread naan'],
      allergens: ['gluten', 'dairy'],
    },
    {
      name: 'Butter Roti', priceCents: 4000, prepMinutes: 6,
      description: 'Whole wheat tandoori roti with butter',
      veg: true, aliases: ['roti', 'tandoori roti'],
      allergens: ['gluten', 'dairy'],
    },
  ],
  Drinks: [
    { name: 'Coke', priceCents: 6000, prepMinutes: 0, description: '300ml chilled', veg: true, vegan: true, aliases: ['coca cola', 'cola'], allergens: [] },
    { name: 'Pepsi', priceCents: 6000, prepMinutes: 0, description: '300ml chilled', veg: true, vegan: true, aliases: [], allergens: [] },
    { name: 'Mineral Water', priceCents: 2000, prepMinutes: 0, description: '1L bottle', veg: true, vegan: true, aliases: ['water', 'pani', 'bisleri'], allergens: [] },
    { name: 'Sweet Lassi', priceCents: 8000, prepMinutes: 4, description: 'Chilled sweet yoghurt drink', veg: true, aliases: ['lassi', 'meethi lassi'], allergens: ['dairy'] },
  ],
};

/* ── demo customers ── */

const DEMO_CUSTOMERS = [
  { name: 'Rahul Verma',   phone: '+919876500001', language: 'hi-Latn', ordersAgo: [2, 9, 16, 24, 31, 45], items: ['Chicken Biryani', 'Coke'] },
  { name: 'Priya Nair',    phone: '+919876500002', language: 'en',      ordersAgo: [1, 5, 12, 19], items: ['Veg Biryani', 'Garlic Naan'] },
  { name: 'Imran Sheikh',  phone: '+919876500003', language: 'hi-Latn', ordersAgo: [3, 11, 18, 26, 33, 40, 47, 55, 61, 70], items: ['Mutton Biryani', 'Sweet Lassi'] },
  { name: 'Ananya Rao',    phone: '+919876500004', language: 'en',      ordersAgo: [38, 52, 66], items: ['Paneer Tikka', 'Butter Roti'] },
  { name: 'Vikram Singh',  phone: '+919876500005', language: 'en',      ordersAgo: [4, 6, 13], items: ['Chicken 65', 'Pepsi'] },
  { name: 'Meera Joshi',   phone: '+919876500006', language: 'hi',      ordersAgo: [75, 88], items: ['Chicken Biryani'] },
  { name: 'Arjun Reddy',   phone: '+919876500007', language: 'en',      ordersAgo: [0], items: ['Chicken Biryani', 'Garlic Naan', 'Coke'] },
  { name: 'Fatima Khan',   phone: '+919876500008', language: 'hi-Latn', ordersAgo: [7, 14, 21, 28, 35, 42, 49], items: ['Mutton Biryani', 'Extra'] },
];

async function wipeDemo(): Promise<void> {
  const db = await getDb();
  const [existing] = await db.drizzle.select().from(restaurants).where(eq(restaurants.slug, DEMO_SLUG)).limit(1);
  if (!existing) return;
  // FK cascades from restaurants clean everything tenant-scoped.
  await db.drizzle.delete(restaurants).where(eq(restaurants.id, existing.id));
  await db.execute(`DELETE FROM users WHERE email = $1;`, [OWNER_EMAIL]);
  await db.execute(`DELETE FROM organizations WHERE name = 'SpiceBox Hospitality';`);
}

export async function seed(): Promise<{ restaurantId: string; locationId: string; ownerEmail: string }> {
  const db = await getDb();
  await migrate(db);
  await wipeDemo();

  const organizationId = newId('org');
  const restaurantId = newId('rst');
  const locationId = newId('loc');
  const ownerId = newId('usr');
  const scope = systemScope(restaurantId, correlationId());

  await db.drizzle.insert(organizations).values({ id: organizationId, name: 'SpiceBox Hospitality', plan: 'GROWTH' });
  await db.drizzle.insert(restaurants).values({
    id: restaurantId, organizationId, name: 'SpiceBox Biryani', slug: DEMO_SLUG,
    timezone: 'Asia/Kolkata', currency: 'INR', taxRateBps: 500, isLive: true,
  });
  await db.drizzle.insert(locations).values({
    id: locationId, restaurantId, name: 'Banjara Hills',
    addressLine1: 'Road No. 12, Banjara Hills', city: 'Hyderabad', region: 'TS',
    postalCode: '500034', phone: '+914023551234', timezone: 'Asia/Kolkata',
    isDefault: true, capacityState: 'OPEN',
    slotMinutes: 15, maxOrdersPerSlot: 8, maxOrdersPerSlotBusy: 4,
    minLeadMinutes: 15, maxAdvanceMinutes: 240, busyEtaPaddingMinutes: 10,
  });
  await db.drizzle.insert(restaurantSettings).values({
    restaurantId,
    defaultPrepMinutes: 20, peakPrepBufferMinutes: 10, maxConcurrentOrders: 16,
    minutesPerQueuedOrder: 1.5, minOrderCents: 10000, maxOrderCents: 500000,
    allowScheduledOrders: true,
    pickupInstructions: 'Pickup counter is to the right of the main entrance. Please show your order number.',
    parkingInfo: 'Free parking for 20 minutes in the basement.',
    cancellationPolicy: 'Orders can be cancelled free of charge until the kitchen starts preparing them.',
    allergenPolicy: 'Allergen information is provided where verified. Please tell us about severe allergies.',
    greeting: 'What can I get started for you today?',
    autoPrintOnAccept: true,
  });

  await db.drizzle.insert(users).values({
    id: ownerId, email: OWNER_EMAIL, passwordHash: hashPassword(OWNER_PASSWORD), name: 'Sana Qureshi',
  });
  await db.drizzle.insert(staff).values({
    id: newId('stf'), userId: ownerId, restaurantId, locationId, role: 'OWNER',
  });

  // Hours: 11:00-23:00 every day, closed Monday.
  for (let day = 0; day < 7; day++) {
    await db.drizzle.insert(businessHours).values({
      id: newId('bh'), restaurantId, locationId, dayOfWeek: day,
      openMinute: 11 * 60, closeMinute: 23 * 60, isClosed: day === 1,
    });
  }

  /* ── menu ── */
  const itemIdByName = new Map<string, string>();
  let categorySort = 0;

  for (const [categoryName, items] of Object.entries(MENU)) {
    const categoryId = newId('cat');
    await db.drizzle.insert(menuCategories).values({
      id: categoryId, restaurantId, name: categoryName, sortOrder: categorySort++,
    });

    let itemSort = 0;
    for (const def of items) {
      const itemId = newId('itm');
      itemIdByName.set(def.name, itemId);
      await db.drizzle.insert(menuItems).values({
        id: itemId, restaurantId, categoryId, name: def.name,
        description: def.description, priceCents: def.priceCents, prepMinutes: def.prepMinutes,
        isVegetarian: !!def.veg, isVegan: !!def.vegan,
        allergens: def.allergens === undefined ? null : def.allergens,
        aliases: def.aliases ?? [], sortOrder: itemSort++,
      });

      let groupSort = 0;
      for (const group of def.groups ?? []) {
        const groupId = newId('mg');
        await db.drizzle.insert(modifierGroups).values({
          id: groupId, restaurantId, menuItemId: itemId, name: group.name,
          minSelect: group.min ?? 0, maxSelect: group.max ?? 1,
          isRequired: !!group.required, sortOrder: groupSort++,
        });
        let modSort = 0;
        for (const option of group.options) {
          await db.drizzle.insert(modifiers).values({
            id: newId('mod'), restaurantId, modifierGroupId: groupId, name: option.name,
            priceDeltaCents: option.delta, aliases: option.aliases ?? [],
            isDefault: !!option.isDefault, sortOrder: modSort++,
          });
        }
      }
    }
  }

  // Configured substitutes — the AI may only offer these.
  await db.drizzle.update(menuItems)
    .set({ substituteItemIds: [itemIdByName.get('Mutton Biryani')!, itemIdByName.get('Veg Biryani')!] })
    .where(eq(menuItems.id, itemIdByName.get('Chicken Biryani')!));
  await db.drizzle.update(menuItems)
    .set({ substituteItemIds: [itemIdByName.get('Chicken Biryani')!, itemIdByName.get('Veg Biryani')!] })
    .where(eq(menuItems.id, itemIdByName.get('Mutton Biryani')!));

  /* ── FAQ, promo, integrations, printer ── */
  for (const faq of [
    { question: 'Do you have parking?', answer: 'Yes — free parking for 20 minutes in the basement.', keywords: ['parking', 'park', 'car'] },
    { question: 'Where do I pick up my order?', answer: 'The pickup counter is to the right of the main entrance. Show your order number.', keywords: ['pickup', 'collect', 'counter'] },
    { question: 'Do you deliver?', answer: 'We are takeaway only right now — pickup from Banjara Hills.', keywords: ['deliver', 'delivery', 'home'] },
  ]) {
    await db.drizzle.insert(faqEntries).values({ id: newId('faq'), restaurantId, ...faq });
  }

  await db.drizzle.insert(promotions).values({
    id: newId('pro'), restaurantId, name: '10% off orders over Rs 500',
    type: 'PERCENT_OFF', value: 1000, minSubtotalCents: 50000, isActive: true,
  });

  await db.drizzle.insert(integrations).values({
    id: newId('int'), restaurantId, kind: 'whatsapp', status: 'DISCONNECTED',
    publicConfig: { displayPhoneNumber: '+919999000001', phoneNumberId: 'DEMO_PNID' },
    lastError: 'Demo tenant uses the mock provider. Connect a real number in Settings > WhatsApp.',
  });

  const printerToken = 'pa_demo_spicebox_kitchen_token';
  await db.drizzle.insert(printers).values({
    id: newId('prn'), restaurantId, locationId, name: 'Kitchen Thermal',
    kind: 'KITCHEN', transport: 'AGENT', paperWidthChars: 32, copies: 1,
    agentTokenHash: sha256(printerToken),
  });

  /* ── segments ── */
  for (const s of SYSTEM_SEGMENTS) {
    await db.drizzle.insert(segments).values({
      id: newId('seg'), restaurantId, name: s.name, description: s.description,
      rule: s.rule, isSystem: true,
    });
  }

  /* ── customers + order history ── */
  let orderNumber = 1000;
  const taxBps = 500;

  for (const person of DEMO_CUSTOMERS) {
    const customerId = newId('cus');
    await db.drizzle.insert(customers).values({
      id: customerId, restaurantId, phoneE164: person.phone, name: person.name,
      language: person.language, preferredLocationId: locationId,
      lastInteractionAt: new Date(Date.now() - person.ordersAgo[0] * 86_400_000),
    });
    await db.drizzle.insert(customerConsent).values({
      id: newId('con'), restaurantId, customerId,
      marketingStatus: person.phone.endsWith('6') ? 'OPTED_OUT' : 'OPTED_IN', source: 'seed',
    });

    for (const daysAgo of person.ordersAgo) {
      const createdAt = new Date(Date.now() - daysAgo * 86_400_000 - (2 + (orderNumber % 5)) * 3_600_000);
      const orderId = newId('ord');
      orderNumber++;

      const lineDefs = person.items
        .map((name) => ({ name, id: itemIdByName.get(name) }))
        .filter((x): x is { name: string; id: string } => !!x.id);
      if (lineDefs.length === 0) continue;

      let subtotal = 0;
      const lines: Array<{ id: string; itemId: string; name: string; qty: number; unit: number }> = [];
      for (const def of lineDefs) {
        const [item] = await db.drizzle.select().from(menuItems).where(eq(menuItems.id, def.id)).limit(1);
        const qty = def.name.includes('Biryani') ? ((orderNumber % 2) + 1) : 1;
        const unit = item.priceCents;
        subtotal += unit * qty;
        lines.push({ id: newId('oi'), itemId: def.id, name: def.name, qty, unit });
      }
      const tax = Math.round((subtotal * taxBps) / 10000);

      await db.drizzle.insert(orders).values({
        id: orderId, restaurantId, locationId, customerId, orderNumber,
        status: 'COMPLETED', channel: orderNumber % 4 === 0 ? 'WHATSAPP_VOICE' : 'WHATSAPP_TEXT',
        subtotalCents: subtotal, discountCents: 0, taxCents: tax, totalCents: subtotal + tax,
        prepMinutes: 25,
        promisedReadyAt: new Date(createdAt.getTime() + 25 * 60_000),
        pickupSlotStart: new Date(Math.floor((createdAt.getTime() + 25 * 60_000) / 900_000) * 900_000),
        confirmedAt: createdAt, completedAt: new Date(createdAt.getTime() + 40 * 60_000),
        createdAt, updatedAt: createdAt, correlationId: `seed-${orderNumber}`,
      });

      for (const line of lines) {
        await db.drizzle.insert(orderItems).values({
          id: line.id, restaurantId, orderId, menuItemId: line.itemId,
          nameSnapshot: line.name, quantity: line.qty, unitPriceCents: line.unit,
          modifiersTotalCents: 0, lineTotalCents: line.unit * line.qty,
        });
      }
      await db.drizzle.insert(orderStatusHistory).values({
        id: newId('osh'), restaurantId, orderId, fromStatus: 'PICKED_UP', toStatus: 'COMPLETED',
        actorType: 'SYSTEM', reason: 'seed', createdAt,
      });
    }

    await recomputeCustomerRollups(scope, customerId);
  }

  return { restaurantId, locationId, ownerEmail: OWNER_EMAIL };
}

// Run directly: npm run db:seed
// import.meta.url percent-encodes spaces on Windows, so compare on the path suffix.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed.ts')) {
  const result = await seed();
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT
       (SELECT count(*)::int FROM menu_items WHERE restaurant_id = $1) AS items,
       (SELECT count(*)::int FROM customers WHERE restaurant_id = $1) AS customers,
       (SELECT count(*)::int FROM orders WHERE restaurant_id = $1) AS orders;`,
    [result.restaurantId],
  );
  console.log('seeded SpiceBox Biryani');
  console.log(`  restaurant: ${result.restaurantId}`);
  console.log(`  login:      ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  console.log(`  menu items: ${rows[0].items}, customers: ${rows[0].customers}, orders: ${rows[0].orders}`);
  await db.close();
}
