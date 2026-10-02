# AI Takeaway Counter

Turn a restaurant's WhatsApp number into an AI takeaway counter.

A customer messages the restaurant — by text or voice note, in English, Hindi or
Hinglish. The assistant understands the order, validates it against the real
menu and live availability, prices it server-side, allocates a **real pickup
slot** based on what the kitchen can actually deliver, confirms, and sends the
order straight to the kitchen screen and the thermal printer.

Nobody stops cooking to answer the phone. Nobody stands in a queue to order.

---

## What actually runs today

Verified by `npm run acceptance` (90 checks) and `npm test` (81 tests), both
against a real PostgreSQL database.

| Area | Status |
|---|---|
| WhatsApp webhook: signature verification, idempotent ingestion | Working |
| Text ordering (English) | Working |
| Voice ordering (transcript → order) | Working |
| Hindi / Hinglish / mixed-language ordering | Working |
| Menu validation, modifiers, required-choice questions | Working |
| Server-authoritative pricing, tax, promotions | Working |
| Dynamic pickup slots + kitchen capacity | Working |
| Emergency controls (pause, +15/+30, sold out, close) | Working |
| Order state machine, staff console, kitchen display | Working |
| KOT printing via local print agent | Working |
| Customer status messages + delay notifications | Working |
| Customer profiles, "same as last time" | Working |
| Analytics incl. AI containment rate | Working |
| Usage metering per restaurant | Working |
| Human takeover | Working |
| Multi-tenant isolation, RBAC, audit log | Working |

**Honest limitations — read this before demoing to anyone:**

- **The Meta WhatsApp transport has never run against live Meta servers here.**
  No credentials exist in this environment. The provider is written against the
  documented Graph API v21.0 contract; the *webhook parser and signature
  verification are tested against recorded Meta payload fixtures*, but the
  outbound `send()` path is unproven in production. Treat connecting a real
  number as a task that still needs a day of integration testing.
- **Hosted LLM providers are likewise unexecuted here.** `AI_PROVIDER=anthropic`
  and `openai` are written and typechecked but never called with a real key.
  Everything you see working runs on the `deterministic` provider (below).
- **Speech-to-text is fixture-backed by default.** The OpenAI Whisper path is
  written; `STT_PROVIDER=mock` is what the tests and simulator use.
- **PGlite is single-process.** Great for dev and CI, wrong for running a web
  tier and a worker at once. Use managed Postgres for anything real.
- **Payments are interfaces only.** V1 is pay-at-pickup, deliberately.
- **Marketing/campaigns/segments are built but not in the V1 nav.** The engines
  and tests exist; the product is a takeaway counter first.

---

## The one idea worth understanding

**The language model never decides a business fact.**

It is given exactly one job: turn a sentence into *phrases and quantities*.
Look at the type it is allowed to return ([`src/server/ai/interpretation.ts`](src/server/ai/interpretation.ts)):

```ts
type ItemPhrase = {
  phrase: string;            // what the customer called it
  quantity: number;
  modifierPhrases: string[];
};
```

No item id. No price. No availability. No pickup time. It *cannot express* a
price, so it cannot invent one. The backend then:

1. resolves each phrase against the live menu and scores the match,
2. rejects or asks when the score is low or two items are too close,
3. re-reads every price from the database,
4. applies tax and promotions server-side,
5. allocates a pickup slot from real kitchen capacity.

The acceptance suite proves it: a caller that injects `unitPriceCents: 500` on a
₹240 item gets charged ₹240.

---

## Architecture

```
 WhatsApp (Meta Cloud API)
      │  webhook: verify HMAC-SHA256 over the raw body, persist, enqueue, 200 in <100ms
      ▼
 Integration layer   MessagingProvider │ STTProvider │ AIProvider │ PrinterTransport
      ▼
 AI layer            OrderAgent ──── tool registry only ────┐
      ▼                                                      │
 Commerce layer      menu · availability · PRICING · promotions · SLOTS · orders
      ▼
 Event bus           order.confirmed, printer.job.created, customer.segment.changed …
      ├──▶ Restaurant  console, kitchen display, notifications
      ├──▶ CRM         profiles, consent, rollups
      └──▶ Marketing   campaigns (built, Phase 2)
```

Full decision log with rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Why these choices

| Decision | Why |
|---|---|
| **Drizzle + PGlite for dev** | This machine has no Docker and no Postgres. PGlite *is* Postgres 16 compiled to WASM — same SQL, same migrations, same schema file as production. Prisma cannot do this without a proxy. |
| **Integer cents everywhere** | Float money is a bug waiting for a customer to find it. Tax is basis points so rates are exact integers too. |
| **Postgres-backed job queue** | `SELECT … FOR UPDATE SKIP LOCKED`. Zero extra infrastructure, survives restarts, identical on PGlite and RDS. Swap in BullMQ behind the same `enqueue`/`register` API when throughput demands it. |
| **Scrypt sessions, not NextAuth** | Zero native deps, fully testable, RBAC enforced in the data layer. |
| **Promotions do not stack** | Best single promotion wins. Every real POS defaults to this; stacking is an edge-case swamp. |
| **Slot *end* is the promise** | Under-promise, over-deliver. A missed ETA is worse than a longer honest one. |

---

## Quick start

```bash
npm install
npm run db:push     # creates 41 tables in a local PGlite database
npm run db:seed     # SpiceBox Biryani: 11 items, 8 customers, 36 past orders
npm run dev
```

Open http://localhost:3000 and sign in:

```
owner@spicebox.demo / spicebox2026
```

No API keys. No Docker. No Postgres install. It works offline.

### See it work in 60 seconds

Go to **Test order** and send:

```
2 chicken biryani, one spicy, and 2 coke
```

You get back:

```
Here's your order:
• 1 x Chicken Biryani (Regular) — ₹240.00
• 1 x Chicken Biryani (Spicy) — ₹240.00
• 2 x Coke — ₹120.00

Subtotal: ₹600.00
Discount: -₹60.00
Tax: ₹27.00
Total: ₹567.00

the earliest pickup for this order is 1:00 PM.
Shall I confirm?
```

Reply `yes`, then watch **Orders** and **Kitchen**. Try the Hinglish button too.

---

## How it works without any API keys

`AI_PROVIDER=deterministic` is a real, rule-based NLU implementing the same
`AIProvider` interface as the hosted models. It handles quantities (digits, words,
and Hindi numerals), multi-item utterances, modifier splitting, removals,
confirmations, allergen questions and the common question intents.

It exists for three reasons:

1. **Every test runs the full pipeline** with no network and no spend.
2. **It is the production fallback.** If the hosted model errors or times out,
   `withFallback` drops to it rather than telling a paying customer "sorry, try
   later". A biryani shop in Hyderabad does not stop selling because an API is slow.
3. **It keeps the guardrail honest.** If the product works with a dumb
   interpreter, the intelligence genuinely lives in the backend.

Switch providers with one env var; no business logic changes.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm test` | 81 unit/integration tests |
| `npm run acceptance` | The full 29-step acceptance scenario, 90 checks |
| `npm run db:push` | Apply migrations |
| `npm run db:seed` | Seed the demo restaurant |
| `npm run db:reset` | Wipe and reseed (refuses on non-PGlite) |
| `npm run worker` | Background worker (production) |
| `npm run print-agent` | Local print agent |
| `npm run connect:whatsapp` | Connect / disconnect / check a WhatsApp number |

---

## Connecting WhatsApp

Uses the **official WhatsApp Business Platform** only. No scraping, no unofficial
automation, ever.

### Testing without a new number

You do not need to buy or register a number to test with real WhatsApp. When you
add the WhatsApp product to a Meta app, Meta issues a **free test sender number**.
Your own personal WhatsApp plays the customer.

1. At developers.facebook.com create an app and add the **WhatsApp** product.
2. In **WhatsApp → API Setup**, note the test number's *Phone number ID* and copy
   the *temporary access token* (valid 24 hours). Under **To**, add your own mobile
   number and confirm the code Meta sends you. Up to 5 recipients are allowed.
3. In **App Settings → Basic**, copy the *App Secret*.
4. Pick any string as your verify token and put it in `.env.local`:
   ```
   WHATSAPP_VERIFY_TOKEN=pick-anything
   ```
5. Connect the demo restaurant to the test number. The script looks the display
   number up from Meta, which also confirms your credentials work:
   ```bash
   npm run connect:whatsapp -- --phone-number-id <ID> --token <TOKEN> --app-secret <SECRET>
   ```
6. Start the app and give it a public URL (no account needed for a quick tunnel):
   ```bash
   npm run dev
   npx cloudflared tunnel --url http://localhost:3000
   ```
7. In **WhatsApp → Configuration**, set the callback URL to
   `https://<tunnel-host>/api/webhooks/whatsapp`, enter the same verify token,
   and subscribe to the `messages` field.
8. From your phone, WhatsApp the test number: `2 chicken biryani, one spicy, and 2 coke`.

Test-number limits: it can only message the numbers you added in step 2, the
temporary token expires after 24 hours (re-run step 5 with a fresh one), and it
cannot be used for real customers.

To go back to the simulator: `npm run connect:whatsapp -- --disconnect`.
To check the current state: `npm run connect:whatsapp -- --status`.

### Going live with a real number

Same steps, with a permanent System User token and your own verified business
number in place of the test sender. Set `ENCRYPTION_KEY` **before** connecting —
the script encrypts the token with it, and without it the insecure dev fallback
key is used.

### What is verified

The webhook route has been exercised over HTTP with a connected integration:
Meta's GET handshake (right token 200, wrong token 403), unsigned / wrongly-signed
/ tampered bodies all rejected with 401, a correctly signed message accepted, and
Meta's at-least-once retry of the same message id deduplicated.

**Not yet verified:** a round trip through Meta's real servers. Everything above
used a locally computed signature. The first real message you send in step 8 is
the first time the outbound `send()` call reaches Meta.

The webhook **refuses unsigned requests in production** and logs loudly if it
accepts one in development.

## Connecting a printer

```bash
node agent/print-agent.mjs \
  --url https://your-app \
  --printer prn_xxx \
  --token pa_xxx \
  --target network --host 192.168.1.50
```

Targets: `stdout` (verify the pipeline), `file`, `raw` (`--device \\.\USB001` or
`/dev/usb/lp0`), `network` (ESC/POS over TCP 9100).

The cloud never connects *into* the restaurant network — the agent polls out.
A printer being offline never blocks an order; jobs queue and reprint.

---

## Testing

```bash
npm test          # 81 tests: money, state machine, slots, segments, crypto, tenancy, interpreter
npm run acceptance # 90 checks: the entire 29-step scenario end to end
```

The acceptance run is the honest one. It signs a restaurant up, seeds a menu,
pushes a Meta-shaped webhook through the real ingestion path, lets the agent
interpret it, prices it, allocates a slot, confirms, prints a KOT with the real
print-agent auth, walks the kitchen states, checks the customer got exactly one
message per state, rebuilds the order from history, pauses the kitchen, marks an
item sold out, proves the AI respects both immediately, hands the chat to a
human, and asserts restaurant B cannot see restaurant A's data.

### Bugs this process actually caught

Worth listing, because they are the ones a demo would have hidden:

1. **`"2 chicken biryani, one spicy, 2 coke"` created a phantom "one spicy" line.**
   The spec's own headline example. Fixed with modifier-only clause detection.
2. **Two consecutive qualifiers collapsed onto one line**, so
   `"one spicy, one regular"` lost the split. Fixed with an anchor line.
3. **An allergen question was parsed as an order** because the regex missed the
   plural in "peanuts". Safety-critical. The allergen guard is now deliberately
   greedy and sits above the ordering rules.
4. **Customers received two identical confirmation messages** — the agent and the
   event handler both replied. Lifecycle messaging now has exactly one owner.
5. **Event handlers registered twice on hot reload**, which would double every
   customer notification in production too. Registration is now keyed and idempotent.
6. **PGlite aborted when Next.js instantiated the DB module twice.** The
   connection is now pinned to `globalThis`.
7. **Gibberish scored 0.92 confidence.** Confidence is capped when there is no
   quantity and no ordering verb.
8. **`"one veg biryani"` answered "Anything else?" instead of asking which spice
   level.** Unpriceable lines are never written to `order_items`, so the question
   could not be re-derived. Pending specs now live in conversation memory.
9. **Answering that question with `"spicy"` was read as a new dish** and failed
   with "I couldn't find spicy on our menu". A reply to an open question is now
   matched against the pending item's modifier groups first.

---

## Production deployment

```
Vercel (or any Node host)
  ├── web           DATABASE_URL=postgresql://…  WORKER_MODE=external
  ├── worker        npm run worker
  └── Postgres      Neon / Supabase / RDS
```

Checklist:

- [ ] `DATABASE_URL` points at managed Postgres (**not** PGlite)
- [ ] `ENCRYPTION_KEY` set — required in production, integration secrets are
      AES-256-GCM encrypted at rest
- [ ] `WHATSAPP_APP_SECRET` set — the webhook rejects unsigned requests in production
- [ ] `WORKER_MODE=external` and the worker process running
- [ ] `AI_PROVIDER` set with a real key (falls back to deterministic if absent)
- [ ] `npm run db:push` against the production database
- [ ] Rate limiting: currently in-process. Move to Redis before running more
      than one web instance.

---

## Security

- Tenant isolation is enforced in the data layer, never in the UI. Every
  tenant-scoped function takes a `TenantScope`; `scopeForUser` throws before any
  query runs if the user has no staff row for that restaurant.
- Passwords: scrypt (N=16384). Sessions: random token, only its SHA-256 stored.
- Webhook signatures: HMAC-SHA256 over the raw body, `timingSafeEqual`.
- Printer tokens: hashed, compared timing-safely, opaque errors so a wrong token
  cannot probe which printers exist.
- Integration credentials: AES-256-GCM at rest.
- Phone numbers masked on printed receipts.
- Every staff override is written to `audit_logs`.
- `correlation_id` threads webhook → AI interaction → order → print job →
  notification, so one grep answers "what happened to this customer".

## Privacy

`eraseCustomer()` wipes identifiers and message bodies while keeping anonymised
order facts for accounting. Consent is event-sourced in `customer_consent` with
source and timestamp. `STOP` / `UNSUBSCRIBE` and natural-language opt-outs are
handled **before** the model sees the message — compliance is never delegated to
an LLM.

---

## Roadmap

- **Phase 2** — repeat-order nudges, segmentation, win-back campaigns, promotions
  in the console (engines and tests already exist)
- **Phase 3** — POS integrations (Petpooja, UrbanPiper), multi-location, UPI /
  Razorpay, demand and capacity prediction
