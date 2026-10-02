/**
 * Single source of truth for the relational model.
 * Money is ALWAYS integer minor units (cents). Never float.
 * Every tenant-scoped table carries restaurant_id (and location_id where relevant).
 */
import {
  pgTable, pgEnum, text, integer, boolean, timestamp, jsonb,
  uniqueIndex, index, real,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () => text('id').primaryKey();
const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const upd = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ───────────────────────── enums ───────────────────────── */

export const orderStatusEnum = pgEnum('order_status', [
  'DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION', 'CONFIRMED',
  'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED',
  'CANCELLED', 'REJECTED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'CUSTOMER_NO_SHOW',
]);
export const orderChannelEnum = pgEnum('order_channel', ['WHATSAPP_TEXT', 'WHATSAPP_VOICE', 'CONSOLE', 'SIMULATOR']);
export const paymentStatusEnum = pgEnum('payment_status', ['PAY_AT_PICKUP', 'PENDING', 'PAID', 'REFUNDED', 'FAILED']);
export const staffRoleEnum = pgEnum('staff_role', ['OWNER', 'MANAGER', 'STAFF', 'KITCHEN']);
export const msgDirectionEnum = pgEnum('msg_direction', ['INBOUND', 'OUTBOUND']);
export const msgKindEnum = pgEnum('msg_kind', ['TEXT', 'AUDIO', 'IMAGE', 'TEMPLATE', 'SYSTEM']);
export const msgCategoryEnum = pgEnum('msg_category', ['TRANSACTIONAL', 'MARKETING', 'SERVICE']);
export const handledByEnum = pgEnum('handled_by', ['AI', 'STAFF']);
export const consentStatusEnum = pgEnum('consent_status', ['OPTED_IN', 'OPTED_OUT', 'UNKNOWN']);
export const promoTypeEnum = pgEnum('promo_type', ['PERCENT_OFF', 'FIXED_OFF', 'BOGO', 'FREE_ITEM']);
export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED',
]);
export const printerTransportEnum = pgEnum('printer_transport', ['AGENT', 'NETWORK', 'BROWSER']);
export const printerKindEnum = pgEnum('printer_kind', ['KITCHEN', 'RECEIPT']);
export const printJobStatusEnum = pgEnum('print_job_status', ['QUEUED', 'CLAIMED', 'PRINTED', 'FAILED', 'CANCELLED']);
export const availabilityEnum = pgEnum('availability', ['AVAILABLE', 'SOLD_OUT', 'TEMP_UNAVAILABLE']);
export const capacityStateEnum = pgEnum('capacity_state', ['OPEN', 'BUSY', 'VERY_BUSY', 'PAUSED', 'CLOSED']);
export const planEnum = pgEnum('plan', ['STARTER', 'GROWTH', 'PRO', 'ENTERPRISE']);
export const jobStatusEnum = pgEnum('job_status', ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD']);

/* ───────────────────── identity & tenancy ───────────────────── */

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  plan: planEnum('plan').notNull().default('STARTER'),
  createdAt: now(), updatedAt: upd(),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),   // scrypt$N$r$p$salt$hash — never plaintext
  name: text('name').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: now(), updatedAt: upd(),
}, (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)]);

export const sessions = pgTable('sessions', {
  id: id(),                                        // sha256 of the cookie token
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: now(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export const restaurants = pgTable('restaurants', {
  id: id(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  currency: text('currency').notNull().default('USD'),
  taxRateBps: integer('tax_rate_bps').notNull().default(0),   // basis points: 850 = 8.50%
  /** Last order number issued. Incremented atomically so concurrent orders never collide. */
  orderSeq: integer('order_seq').notNull().default(1000),
  isLive: boolean('is_live').notNull().default(false),
  createdAt: now(), updatedAt: upd(),
}, (t) => [uniqueIndex('restaurants_slug_uq').on(t.slug)]);

export const locations = pgTable('locations', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  addressLine1: text('address_line1').notNull().default(''),
  city: text('city').notNull().default(''),
  region: text('region').notNull().default(''),
  postalCode: text('postal_code').notNull().default(''),
  phone: text('phone').notNull().default(''),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),

  /* ── live capacity control (section 9 / 28): changing these changes what the AI says ── */
  capacityState: capacityStateEnum('capacity_state').notNull().default('OPEN'),
  /** Manual ETA padding the manager adds with one click: +15, +30. Cleared by setting 0. */
  etaOffsetMinutes: integer('eta_offset_minutes').notNull().default(0),
  /** Pickup slot granularity in minutes. */
  slotMinutes: integer('slot_minutes').notNull().default(15),
  /** Hard ceiling of pickups per slot. The slot engine refuses beyond this. */
  maxOrdersPerSlot: integer('max_orders_per_slot').notNull().default(8),
  /** Ceiling applied when capacityState = VERY_BUSY. */
  maxOrdersPerSlotBusy: integer('max_orders_per_slot_busy').notNull().default(4),
  /** Nothing can be promised sooner than this from now. */
  minLeadMinutes: integer('min_lead_minutes').notNull().default(10),
  /** How far ahead a customer may schedule a pickup. */
  maxAdvanceMinutes: integer('max_advance_minutes').notNull().default(240),
  /** Minutes added to every estimate while BUSY. */
  busyEtaPaddingMinutes: integer('busy_eta_padding_minutes').notNull().default(10),
  capacityNote: text('capacity_note').notNull().default(''),
  capacityChangedAt: timestamp('capacity_changed_at', { withTimezone: true }),

  createdAt: now(), updatedAt: upd(),
}, (t) => [index('locations_restaurant_idx').on(t.restaurantId)]);

export const staff = pgTable('staff', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').references(() => locations.id, { onDelete: 'set null' }),
  role: staffRoleEnum('role').notNull().default('STAFF'),
  createdAt: now(), updatedAt: upd(),
}, (t) => [uniqueIndex('staff_user_restaurant_uq').on(t.userId, t.restaurantId)]);

/* ───────────────────── restaurant config ───────────────────── */

export const restaurantSettings = pgTable('restaurant_settings', {
  restaurantId: text('restaurant_id').primaryKey().references(() => restaurants.id, { onDelete: 'cascade' }),
  defaultPrepMinutes: integer('default_prep_minutes').notNull().default(20),
  peakPrepBufferMinutes: integer('peak_prep_buffer_minutes').notNull().default(10),
  maxConcurrentOrders: integer('max_concurrent_orders').notNull().default(15),
  minutesPerQueuedOrder: real('minutes_per_queued_order').notNull().default(1.5),
  minOrderCents: integer('min_order_cents').notNull().default(0),
  maxOrderCents: integer('max_order_cents').notNull().default(50000),
  allowScheduledOrders: boolean('allow_scheduled_orders').notNull().default(false),
  cancellationPolicy: text('cancellation_policy').notNull().default('Orders can be cancelled until preparation starts.'),
  pickupInstructions: text('pickup_instructions').notNull().default(''),
  parkingInfo: text('parking_info').notNull().default(''),
  allergenPolicy: text('allergen_policy').notNull().default(''),
  reviewUrl: text('review_url').notNull().default(''),
  autoPrintOnAccept: boolean('auto_print_on_accept').notNull().default(true),
  notifyBrowser: boolean('notify_browser').notNull().default(true),
  notifySound: boolean('notify_sound').notNull().default(true),
  automatedCampaignsEnabled: boolean('automated_campaigns_enabled').notNull().default(false),
  greeting: text('greeting').notNull().default('Hi! What can I get started for you today?'),
  updatedAt: upd(),
});

export const businessHours = pgTable('business_hours', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  dayOfWeek: integer('day_of_week').notNull(),      // 0=Sunday
  openMinute: integer('open_minute').notNull(),     // minutes from local midnight
  closeMinute: integer('close_minute').notNull(),
  isClosed: boolean('is_closed').notNull().default(false),
}, (t) => [index('hours_restaurant_idx').on(t.restaurantId, t.dayOfWeek)]);

export const holidayHours = pgTable('holiday_hours', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),                     // YYYY-MM-DD local
  isClosed: boolean('is_closed').notNull().default(true),
  openMinute: integer('open_minute'),
  closeMinute: integer('close_minute'),
  note: text('note').notNull().default(''),
}, (t) => [uniqueIndex('holiday_uq').on(t.restaurantId, t.date)]);

export const faqEntries = pgTable('faq_entries', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  keywords: jsonb('keywords').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: now(),
}, (t) => [index('faq_restaurant_idx').on(t.restaurantId)]);

/* ───────────────────────── menu ───────────────────────── */

export const menuCategories = pgTable('menu_categories', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('cat_restaurant_idx').on(t.restaurantId)]);

export const menuItems = pgTable('menu_items', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => menuCategories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceCents: integer('price_cents').notNull(),
  prepMinutes: integer('prep_minutes').notNull().default(0),   // 0 = use restaurant default
  isVegetarian: boolean('is_vegetarian').notNull().default(false),
  isVegan: boolean('is_vegan').notNull().default(false),
  /** Verified allergen data only. null = NOT VERIFIED -> AI must refuse to answer. */
  allergens: jsonb('allergens').$type<string[] | null>(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Configured substitutes offered when this item is unavailable. */
  substituteItemIds: jsonb('substitute_item_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: now(), updatedAt: upd(),
}, (t) => [
  index('item_restaurant_idx').on(t.restaurantId),
  index('item_category_idx').on(t.categoryId),
]);

export const modifierGroups = pgTable('modifier_groups', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  menuItemId: text('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                  // "Size", "Crust", "Add-ons"
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  /** true => AI MUST ask before the order can leave CLARIFICATION_REQUIRED */
  isRequired: boolean('is_required').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('mg_item_idx').on(t.menuItemId)]);

export const modifiers = pgTable('modifiers', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  modifierGroupId: text('modifier_group_id').notNull().references(() => modifierGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceDeltaCents: integer('price_delta_cents').notNull().default(0),
  aliases: jsonb('aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('mod_group_idx').on(t.modifierGroupId)]);

/** Per-location availability override. Absent row => AVAILABLE. */
export const inventoryStatus = pgTable('inventory_status', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  menuItemId: text('menu_item_id').references(() => menuItems.id, { onDelete: 'cascade' }),
  modifierId: text('modifier_id').references(() => modifiers.id, { onDelete: 'cascade' }),
  status: availabilityEnum('status').notNull().default('AVAILABLE'),
  reason: text('reason').notNull().default(''),
  updatedAt: upd(),
}, (t) => [
  uniqueIndex('inv_loc_item_uq').on(t.locationId, t.menuItemId),
  uniqueIndex('inv_loc_mod_uq').on(t.locationId, t.modifierId),
]);

/* ───────────────────────── CRM ───────────────────────── */

export const customers = pgTable('customers', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  phoneE164: text('phone_e164').notNull(),
  name: text('name'),
  /** BCP-47-ish tag detected from their messages; replies try to match it. */
  language: text('language').notNull().default('en'),
  preferredLocationId: text('preferred_location_id').references(() => locations.id, { onDelete: 'set null' }),
  firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
  lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
  lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
  totalOrders: integer('total_orders').notNull().default(0),
  lifetimeSpendCents: integer('lifetime_spend_cents').notNull().default(0),
  cancelledOrders: integer('cancelled_orders').notNull().default(0),
  notes: text('notes').notNull().default(''),
  createdAt: now(), updatedAt: upd(),
}, (t) => [uniqueIndex('customer_restaurant_phone_uq').on(t.restaurantId, t.phoneE164)]);

export const customerConsent = pgTable('customer_consent', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  marketingStatus: consentStatusEnum('marketing_status').notNull().default('UNKNOWN'),
  source: text('source').notNull().default(''),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('consent_customer_idx').on(t.customerId)]);

export const customerTags = pgTable('customer_tags', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
  source: text('source').notNull().default('manual'),   // manual | segment:<id>
  createdAt: now(),
}, (t) => [uniqueIndex('tag_customer_tag_uq').on(t.customerId, t.tag)]);

export const segments = pgTable('segments', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Declarative rule tree — evaluated server-side, never by the LLM. */
  rule: jsonb('rule').$type<unknown>().notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }),
  lastCount: integer('last_count').notNull().default(0),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('segment_restaurant_idx').on(t.restaurantId)]);

export const segmentMembers = pgTable('segment_members', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  segmentId: text('segment_id').notNull().references(() => segments.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('segment_member_uq').on(t.segmentId, t.customerId)]);

/* ───────────────────── promotions ───────────────────── */

export const promotions = pgTable('promotions', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  code: text('code'),                                  // null => automatic
  name: text('name').notNull(),
  type: promoTypeEnum('type').notNull(),
  /** PERCENT_OFF => basis points (2000 = 20%). FIXED_OFF => cents. */
  value: integer('value').notNull().default(0),
  minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
  appliesToItemIds: jsonb('applies_to_item_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  freeItemId: text('free_item_id'),
  daysOfWeek: jsonb('days_of_week').$type<number[]>().notNull().default(sql`'[]'::jsonb`),  // [] = any day
  startMinute: integer('start_minute'),
  endMinute: integer('end_minute'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  firstOrderOnly: boolean('first_order_only').notNull().default(false),
  /** When set, only customers in this segment are eligible. */
  segmentId: text('segment_id').references(() => segments.id, { onDelete: 'set null' }),
  maxRedemptions: integer('max_redemptions'),
  redemptions: integer('redemptions').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('promo_restaurant_idx').on(t.restaurantId)]);

/* ───────────────────────── orders ───────────────────────── */

export const orders = pgTable('orders', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').notNull().references(() => locations.id, { onDelete: 'restrict' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  conversationId: text('conversation_id'),
  orderNumber: integer('order_number').notNull(),
  status: orderStatusEnum('status').notNull().default('DRAFT'),
  channel: orderChannelEnum('channel').notNull().default('WHATSAPP_TEXT'),
  paymentStatus: paymentStatusEnum('payment_status').notNull().default('PAY_AT_PICKUP'),
  subtotalCents: integer('subtotal_cents').notNull().default(0),
  discountCents: integer('discount_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  appliedPromotionId: text('applied_promotion_id').references(() => promotions.id, { onDelete: 'set null' }),
  specialInstructions: text('special_instructions').notNull().default(''),
  prepMinutes: integer('prep_minutes').notNull().default(0),
  promisedReadyAt: timestamp('promised_ready_at', { withTimezone: true }),
  /** Start of the pickup slot this order occupies. Capacity is counted on this column. */
  pickupSlotStart: timestamp('pickup_slot_start', { withTimezone: true }),
  /** Set when staff pushes the ETA back; the customer is always told. */
  originalReadyAt: timestamp('original_ready_at', { withTimezone: true }),
  delayNotifiedAt: timestamp('delay_notified_at', { withTimezone: true }),
  /** true when the customer asked for a specific time rather than "as soon as possible". */
  customerRequestedTime: boolean('customer_requested_time').notNull().default(false),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledReason: text('cancelled_reason').notNull().default(''),
  /** Lowest AI extraction confidence across items; drives the console warning badge. */
  aiConfidence: real('ai_confidence'),
  needsHuman: boolean('needs_human').notNull().default(false),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(), updatedAt: upd(),
}, (t) => [
  uniqueIndex('order_number_uq').on(t.restaurantId, t.orderNumber),
  index('order_restaurant_status_idx').on(t.restaurantId, t.status),
  index('order_customer_idx').on(t.customerId),
  index('order_slot_idx').on(t.locationId, t.pickupSlotStart),
]);

export const orderItems = pgTable('order_items', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: text('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'restrict' }),
  nameSnapshot: text('name_snapshot').notNull(),
  quantity: integer('quantity').notNull(),
  /** Re-read from menu_items at pricing time. NEVER taken from the LLM. */
  unitPriceCents: integer('unit_price_cents').notNull(),
  modifiersTotalCents: integer('modifiers_total_cents').notNull().default(0),
  lineTotalCents: integer('line_total_cents').notNull(),
  notes: text('notes').notNull().default(''),
  aiConfidence: real('ai_confidence'),
}, (t) => [index('oi_order_idx').on(t.orderId)]);

export const orderItemModifiers = pgTable('order_item_modifiers', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  orderItemId: text('order_item_id').notNull().references(() => orderItems.id, { onDelete: 'cascade' }),
  modifierId: text('modifier_id').notNull().references(() => modifiers.id, { onDelete: 'restrict' }),
  nameSnapshot: text('name_snapshot').notNull(),
  priceDeltaCents: integer('price_delta_cents').notNull(),
}, (t) => [index('oim_item_idx').on(t.orderItemId)]);

export const orderStatusHistory = pgTable('order_status_history', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  fromStatus: orderStatusEnum('from_status'),
  toStatus: orderStatusEnum('to_status').notNull(),
  actorType: text('actor_type').notNull(),          // AI | STAFF | SYSTEM | CUSTOMER
  actorId: text('actor_id'),
  reason: text('reason').notNull().default(''),
  createdAt: now(),
}, (t) => [index('osh_order_idx').on(t.orderId)]);

/* ───────────────── conversations & AI ───────────────── */

export const conversations = pgTable('conversations', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').references(() => locations.id, { onDelete: 'set null' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  handledBy: handledByEnum('handled_by').notNull().default('AI'),
  handedOverToUserId: text('handed_over_to_user_id').references(() => users.id, { onDelete: 'set null' }),
  activeDraftOrderId: text('active_draft_order_id'),
  /** Short rolling turn window. Long-term prefs live on the customer, not here. */
  state: jsonb('state').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('conv_restaurant_customer_idx').on(t.restaurantId, t.customerId)]);

export const conversationMessages = pgTable('conversation_messages', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  direction: msgDirectionEnum('direction').notNull(),
  kind: msgKindEnum('kind').notNull().default('TEXT'),
  category: msgCategoryEnum('category').notNull().default('TRANSACTIONAL'),
  body: text('body').notNull().default(''),
  providerMessageId: text('provider_message_id'),
  mediaUrl: text('media_url'),
  authorType: text('author_type').notNull().default('CUSTOMER'),  // CUSTOMER | AI | STAFF | SYSTEM
  authorId: text('author_id'),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(),
}, (t) => [
  uniqueIndex('msg_provider_id_uq').on(t.providerMessageId),
  index('msg_conversation_idx').on(t.conversationId),
]);

export const voiceMessages = pgTable('voice_messages', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  conversationMessageId: text('conversation_message_id').notNull().references(() => conversationMessages.id, { onDelete: 'cascade' }),
  providerMediaId: text('provider_media_id').notNull(),
  durationSeconds: real('duration_seconds'),
  transcript: text('transcript'),
  detectedLanguage: text('detected_language'),
  confidence: real('confidence'),
  status: text('status').notNull().default('PENDING'),   // PENDING | DONE | FAILED
  error: text('error').notNull().default(''),
  createdAt: now(),
});

export const aiInteractions = pgTable('ai_interactions', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' }),
  purpose: text('purpose').notNull(),                 // order_agent | copilot | campaign_builder | classify
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costMicroUsd: integer('cost_micro_usd').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  toolCalls: jsonb('tool_calls').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  confidence: real('confidence'),
  escalated: boolean('escalated').notNull().default(false),
  correctedByCustomer: boolean('corrected_by_customer').notNull().default(false),
  error: text('error').notNull().default(''),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(),
}, (t) => [index('ai_restaurant_idx').on(t.restaurantId, t.createdAt)]);

/* ───────────────────── marketing ───────────────────── */

export const campaigns = pgTable('campaigns', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: campaignStatusEnum('status').notNull().default('DRAFT'),
  segmentId: text('segment_id').references(() => segments.id, { onDelete: 'set null' }),
  promotionId: text('promotion_id').references(() => promotions.id, { onDelete: 'set null' }),
  templateName: text('template_name').notNull().default(''),   // WhatsApp approved template
  bodyPreview: text('body_preview').notNull().default(''),
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  approvedByUserId: text('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  audienceSize: integer('audience_size').notNull().default(0),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('campaign_restaurant_idx').on(t.restaurantId)]);

export const campaignMessages = pgTable('campaign_messages', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('QUEUED'),  // QUEUED|SENT|DELIVERED|READ|FAILED|SKIPPED_NO_CONSENT
  providerMessageId: text('provider_message_id'),
  error: text('error').notNull().default(''),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  /** Order credited to this campaign within the attribution window. */
  attributedOrderId: text('attributed_order_id').references(() => orders.id, { onDelete: 'set null' }),
  createdAt: now(),
}, (t) => [uniqueIndex('cm_campaign_customer_uq').on(t.campaignId, t.customerId)]);

/* ───────────────────── printing ───────────────────── */

export const printers = pgTable('printers', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  locationId: text('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: printerKindEnum('kind').notNull().default('KITCHEN'),
  transport: printerTransportEnum('transport').notNull().default('AGENT'),
  paperWidthChars: integer('paper_width_chars').notNull().default(32),
  copies: integer('copies').notNull().default(1),
  networkHost: text('network_host'),
  networkPort: integer('network_port'),
  agentTokenHash: text('agent_token_hash'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('printer_restaurant_idx').on(t.restaurantId)]);

export const printJobs = pgTable('print_jobs', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  printerId: text('printer_id').notNull().references(() => printers.id, { onDelete: 'cascade' }),
  orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' }),
  status: printJobStatusEnum('status').notNull().default('QUEUED'),
  payload: text('payload').notNull(),               // plain-text receipt, agent converts to ESC/POS
  attempts: integer('attempts').notNull().default(0),
  error: text('error').notNull().default(''),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  printedAt: timestamp('printed_at', { withTimezone: true }),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(),
}, (t) => [index('pj_printer_status_idx').on(t.printerId, t.status)]);

/* ───────────────── integrations / platform ───────────────── */

export const integrations = pgTable('integrations', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),                     // whatsapp | stripe | pos
  status: text('status').notNull().default('DISCONNECTED'),
  /** Secrets are encrypted at rest (AES-256-GCM) via src/lib/crypto.ts. */
  configEncrypted: text('config_encrypted'),
  publicConfig: jsonb('public_config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error').notNull().default(''),
  createdAt: now(), updatedAt: upd(),
}, (t) => [uniqueIndex('integration_restaurant_kind_uq').on(t.restaurantId, t.kind)]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  restaurantId: text('restaurant_id'),
  actorType: text('actor_type').notNull(),          // USER | AI | SYSTEM
  actorId: text('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before').$type<unknown>(),
  after: jsonb('after').$type<unknown>(),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(),
}, (t) => [index('audit_restaurant_idx').on(t.restaurantId, t.createdAt)]);

export const subscriptions = pgTable('subscriptions', {
  id: id(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  plan: planEnum('plan').notNull().default('STARTER'),
  status: text('status').notNull().default('TRIALING'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: now(), updatedAt: upd(),
});

export const usageRecords = pgTable('usage_records', {
  id: id(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  restaurantId: text('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),                 // YYYY-MM
  metric: text('metric').notNull(),                 // orders | wa_messages | ai_tokens | campaigns
  value: integer('value').notNull().default(0),
}, (t) => [uniqueIndex('usage_uq').on(t.organizationId, t.restaurantId, t.period, t.metric)]);

export const notifications = pgTable('notifications', {
  id: id(),
  restaurantId: text('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  orderId: text('order_id').references(() => orders.id, { onDelete: 'cascade' }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: now(),
}, (t) => [index('notif_restaurant_idx').on(t.restaurantId, t.createdAt)]);

/** Durable job store. The memory driver and the BullMQ driver both persist here. */
export const jobs = pgTable('jobs', {
  id: id(),
  name: text('name').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: jobStatusEnum('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error').notNull().default(''),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(), updatedAt: upd(),
}, (t) => [index('jobs_status_runat_idx').on(t.status, t.runAt)]);

/** Append-only domain event log — the seam every future integration hangs off. */
export const domainEvents = pgTable('domain_events', {
  id: id(),
  restaurantId: text('restaurant_id'),
  name: text('name').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  correlationId: text('correlation_id').notNull().default(''),
  createdAt: now(),
}, (t) => [index('events_name_idx').on(t.name, t.createdAt)]);
