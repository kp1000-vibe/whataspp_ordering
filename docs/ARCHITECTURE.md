# Architecture — WhatsApp AI Restaurant Ordering + CRM

## 0. Decisions log (simplest production-grade option chosen)

| # | Decision | Chosen | Why / alternative rejected |
|---|---|---|---|
| D1 | Framework | Next.js 15 App Router + TS strict | One deployable unit for console + API + webhooks. Rejected split Nest backend: premature. |
| D2 | ORM | Drizzle | SQL-first, works with PGlite (WASM Postgres) AND Neon/Supabase from the same schema file. Prisma cannot run against PGlite without a proxy. |
| D3 | Dev database | PGlite (`@electric-sql/pglite`) | No Docker/Postgres on this machine (verified fact). PGlite IS Postgres 16 compiled to WASM — same SQL, same migrations. Prod uses `postgres-js` against managed PG. Single `db` interface, driver chosen by `DATABASE_URL`. |
| D4 | Auth | Session cookie + `node:crypto` scrypt | Zero native deps, fully testable, RBAC enforced server-side. Rejected NextAuth: adds config surface for no MVP gain. |
| D5 | AI | `AIProvider` interface (`chat`/`structuredOutput`/`transcribe`/`embed`) | Providers: `anthropic`, `openai`, `deterministic` (offline test driver). No provider SDK leaks into business logic. |
| D6 | WhatsApp | `MessagingProvider` interface | Impls: `meta-cloud` (official Graph API + HMAC-SHA256 webhook verification), `mock` (in-memory, used by tests/demo). No unofficial automation, ever. |
| D7 | Queue | `JobQueue` interface | `memory` driver (dev/test, runs inline w/ retry) + `bullmq` driver (prod, needs REDIS_URL). |
| D8 | Money | integer minor units (cents) everywhere | Float money is a bug. `price_cents INTEGER NOT NULL`. |
| D9 | Tenancy | `restaurant_id` on every tenant row + mandatory `TenantScope` passed to every repo call | Enforced in the data layer, not the UI. Tests assert cross-tenant reads return empty. |
| D10 | Pricing authority | Server-only `pricing.ts` | The LLM never supplies a price. It supplies item ids + quantities; backend re-prices from DB. |

## 1. Layers (no tight coupling)

```
 Customer Layer      WhatsApp (Meta Cloud API)  ── webhook ──┐
                                                             v
 Integration Layer   MessagingProvider | STTProvider | PrinterTransport | AIProvider
                                                             v
 AI Layer            OrderAgent  ── tool calls only ──>  Commerce tools (allowlisted)
                                                             v
 Commerce Layer      menu · availability · pricing · promotions · prep-time · orders (state machine)
                                                             v
 Event Bus           domain events (order.confirmed, printer.job.created, ...)
                     ├──> Restaurant Layer  (console, kitchen display, notifications)
                     ├──> CRM Layer         (customer profile, segments, consent)
                     └──> Marketing Layer   (campaigns, journeys, attribution)
```

Rule: **AI Layer may only reach Commerce through the tool registry.** Direct DB access from agent code is a lint-level violation.

## 2. Request flow (text order)

```
POST /api/webhooks/whatsapp
  -> verify X-Hub-Signature-256 (HMAC SHA256, timing-safe)
  -> dedupe by provider message id (unique index)
  -> persist inbound ConversationMessage
  -> enqueue job: handle_inbound_message  (returns 200 in <100ms)

worker: handle_inbound_message
  -> load Conversation + Customer + Restaurant config (cached)
  -> if conversation.handled_by = STAFF -> notify staff, stop
  -> OrderAgent.run(context, tools)
       tools: get_menu, search_menu, check_item_availability, calculate_order,
              get_customer_history, get_previous_order, get_current_promotions,
              estimate_pickup_time, create_draft_order, update_draft_order,
              confirm_order, cancel_order, get_order_status, get_restaurant_info,
              get_item_details, check_modifier_availability, escalate_to_human
  -> backend re-prices, re-validates availability, applies promos server-side
  -> reply via MessagingProvider
  -> record AIInteraction (tokens, cost, latency, correlation id)
```

## 3. Order state machine

```
DRAFT ─> CLARIFICATION_REQUIRED ─> READY_FOR_CONFIRMATION ─> CONFIRMED
      ─> RECEIVED ─> ACCEPTED ─> PREPARING ─> READY ─> PICKED_UP ─> COMPLETED
alt: CANCELLED · REJECTED · CUSTOMER_NO_SHOW · REFUND_PENDING · REFUNDED
```
Transitions are a whitelist table in `src/server/orders/state-machine.ts`. Every transition writes `OrderStatusHistory` (actor, actor_type, reason). Illegal transitions throw, they do not silently pass.

## 4. Correlation ids
`correlation_id` (uuid) is minted at webhook ingress and threaded through:
inbound message -> AI interaction -> order -> printer job -> outbound notification.
One grep answers "what happened to this customer".

## 5. External services required
| Service | Required for | Mockable locally |
|---|---|---|
| Meta WhatsApp Cloud API | real customer messaging | YES (`mock` provider + simulator UI) |
| LLM provider (Anthropic/OpenAI) | natural conversation | YES (`deterministic` provider — rule-based NLU, used by all tests) |
| STT (Whisper/Deepgram) | voice orders | YES (`mock-stt` returns fixture transcript) |
| Postgres (Neon/Supabase) | prod data | YES (PGlite) |
| Redis | prod queue | YES (memory queue) |
| Stripe | future payments | YES (interface only, no live calls in MVP) |

## 6. Phase 1 MVP acceptance tests (must pass before anything else ships)
A1 signup -> org + restaurant + owner staff row created, password never stored plaintext.
A2 menu CRUD + CSV import validates before publishing.
A3 webhook rejects bad signature (401) and accepts good one (200) idempotently.
A4 "2 chicken burgers and fries" -> draft order with correct item ids + quantities.
A5 LLM-supplied price of $5 on a $17 item -> order total uses $17.
A6 sold-out item -> AI offers only configured, available substitutes.
A7 order total = sum(item*qty + modifiers) - promo + tax, integer cents, no float drift.
A8 confirm -> CONFIRMED -> RECEIVED; illegal jump DRAFT->READY throws.
A9 restaurant B cannot read restaurant A's orders/customers (repo-level, not UI).
A10 full 26-step definition-of-done runs green in one script.
