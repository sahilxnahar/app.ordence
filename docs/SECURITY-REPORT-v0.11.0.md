# Security Report — v0.11.0-alpha

**Phase 11 — Billing Foundation**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build (`next build`) | **Clean — 30 routes** |
| Security tests (real PostgreSQL 16) | **171 / 171 passing** (was 126) |
| UI & logic tests | **207 / 207 passing** (was 102) |
| Tables under RLS | **30** (was 25) |
| `db:verify` checks | **10 / 10** (was 7) |
| New production dependencies | **Zero** |
| Server secrets in client bundle | **None** |
| Shared JS baseline | **102 kB — unchanged** |

**This is the first phase where a bug costs real money in a direction that
cannot be undone by a support ticket.** Charging a customer twice is a
refund, an apology and a chargeback risk. Failing to charge them is revenue
you never learn you lost. Everything below is written against that standard.

---

## ⭐ The mandatory verification: webhook signature verification and idempotent reconciliation

### The webhook endpoints are public. The HMAC is the entire authentication.

`/api/webhooks/razorpay` and `/api/webhooks/stripe` must be public routes —
Clerk would 401 a server-to-server call carrying no session cookie, the
provider would read that as a failure, and it would retry forever. (This is
the exact mistake made with the Blob `onUploadCompleted` callback in Phase
8, which was removed rather than shipped broken.)

So anyone who can forge a signature can grant themselves an enterprise plan
or cancel another tenant's subscription. **20 tests construct real
signatures with the real algorithm** and assert that valid ones pass and
every category of invalid one fails.

| Attack | Result |
|---|---|
| Correct signature | **Accepted** |
| Wrong secret | **Rejected** — `signature_mismatch` |
| Tampered body, once-valid signature | **Rejected** |
| Missing header | **Rejected** |
| Malformed signature (wrong length, non-hex) | **Rejected, does not throw** |
| **Stripe: replayed request >5 min old** | **Rejected** — `timestamp_out_of_tolerance` |
| **Stripe: timestamp from the future** | **Rejected** |
| Stripe: multiple `v1` during secret rotation | **Accepted** |
| **Provider keys absent from the environment** | **Rejected** — `missing_secret` |
| **`manual` provider, any input at all** | **Always rejected** |

Three of those deserve expansion.

**The malformed-signature case is not cosmetic.** `timingSafeEqual` *throws*
on buffers of differing length. Without a shape check first, a short
signature produces a 500 — which makes the provider retry forever and looks
like an outage.

**`missing_secret` must never mean "pass".** An adapter that returned `ok`
when it had no secret to check against would make the endpoint completely
open the moment someone forgot an environment variable. Tested explicitly
for both providers.

**The `manual` adapter always refuses.** If it ever returned `ok`, anyone
able to reach a webhook route with `provider=manual` could mark any invoice
paid. It is tested against three payload shapes and two header sets.

### Constant-time comparison, asserted at the source level

Both adapters use `timingSafeEqual`, never `===`. A string comparison
short-circuits at the first differing byte, so the time it takes leaks how
many leading characters were correct — enough, over enough requests, to
reconstruct a valid signature one character at a time. The window is small
over a network but it is not zero, and the fix costs nothing.

A test reads both source files and fails if `===` ever appears against the
expected digest.

### Verify before parse — also asserted at the source level

`request.json()` would parse before verifying, and the re-serialised object
does not produce the same HMAC: different key order, different whitespace,
different unicode escaping. **Every legitimate webhook would fail.**

A test reads both route files and asserts that `request.text()` is used,
that `request.json()` never appears, and that the index of `verifyWebhook`
precedes the index of `JSON.parse`. A separate test proves the sensitivity
directly: the same payload re-serialised with two-space indentation fails
verification.

---

## ⭐ Idempotency: four failure modes, four defences

Webhook delivery is not exactly-once and is not ordered. Both providers
retry on any non-2xx and both occasionally redeliver a success.

### 1. Duplicate delivery → a UNIQUE index

`payment_events(provider, provider_event_id)`. The event row is inserted
**first, in the same transaction as the effect**. A duplicate raises
SQLSTATE 23505 before any state is touched, the whole transaction rolls
back, and the handler returns 200.

This is enforced by the **database**, so two concurrent Vercel invocations
racing on the same retry cannot both succeed. An application-level check
would race; there is no shared lock between serverless instances.

Proven against real PostgreSQL:

| Assertion | Result |
|---|---|
| Same provider event id inserted twice | **23505 on the second** |
| Same id from a *different* provider | **Allowed** — index is scoped by provider |
| **Two tenants both claiming one event id** | **23505** — the index is global, not per-tenant |

That last row matters. A per-tenant index would leave a hole: tenant B could
replay tenant A's webhook against their own subscription and get a free
period. Tenant B cannot *see* tenant A's row — RLS hides it — but the unique
index still catches the insert.

### 2. Out-of-order delivery → a monotonic high-water mark

`subscriptions.last_provider_event_at`, compared against the **provider's**
timestamp, not our receipt time. Our receipt time is exactly the thing that
is out of order.

The scenario: a `payment_failed` generated at 10:00 fails to reach us and is
retried at 10:05 — by which point a `payment_succeeded` from 10:02 has been
applied. Applying the late failure would push a customer who has just paid
into dunning and eventually lock them out of a product they are paid up on.

### 3. Unresolvable tenant → recorded, not dropped, not retried

Test-mode traffic, an object created by hand in a provider dashboard, a
customer migrated from another system. Recorded with `tenant_id IS NULL` and
status `ignored_unknown_tenant`, then acknowledged. **An event you cannot
explain is exactly the one you will want to read six months from now during
a dispute.**

### 4. Partial application → one transaction

Event insert and state change share a single transaction. Without that, a
process dying between them would leave the unique index blocking the retry,
so the update would be lost *forever*, silently.

---

## The tenant-resolution decision, and the hole it closes

A webhook arrives with no session. Resolving the tenant **is** the work, so
it cannot happen inside `withTenant()`. It runs under `withPlatformScope()`
— but that section resolves an id and nothing else. Every subsequent read
and write happens inside `withTenant(resolvedTenantId, …)`, so RLS covers
all of it.

Resolution is attempted in a deliberate order:

1. **Provider subscription id** (authoritative — bound to a row by a unique index we control)
2. **Provider customer id**
3. **Our own `tenant_id` metadata hint** (weakest)

**The hint is checked last on purpose.** It is a string field that anyone
with access to the payment provider's dashboard can edit. If it won
unconditionally, a hostile or careless actor could set `notes.tenant_id` on
their own subscription to another tenant's uuid and have their payment
events applied to that tenant's subscription. Preferring the provider id
closes that. The hint is still validated against a real, non-deleted tenant
row before use, and is only reached when neither provider id matches — which
is the normal case for the very first event of a new subscription.

---

## Database-enforced integrity

Three guarantees live in PostgreSQL rather than in application code, because
the application will be rewritten several times and these must survive it.

### `payment_events` is append-only

UPDATE and DELETE refused by trigger with SQLSTATE 42501, exactly as for
`audit_logs` (Phase 1) and `contract_signatures` (Phase 9). Corrections are
made by inserting a correcting event.

The concrete risk is narrow and realistic: an engineer with database access
"fixing" a bad reconciliation with an UPDATE rather than an insert. The
history then describes a past that did not happen, and the bug that caused
it becomes invisible.

**Two independent layers, and they are tested separately.** The application
role holds SELECT and INSERT only, so an UPDATE never reaches the trigger —
it is refused by the privilege system first. Both raise 42501, which is the
exact trap that cost time in Phase 9: *a test whose role simply lacked a
privilege passed while proving nothing about the trigger it claimed to
test.* So there are two tests, each asserting the message that identifies
which layer fired. If the GRANT is loosened, the first fails; if the trigger
is dropped, the second does. **Neither can mask the other.**

The superuser test is the one that matters: `postgres` has every privilege,
so when it is refused with `append-only`, only the trigger can have done it.

### Issued invoices are immutable

Once issued, the customer holds a copy. Changing our side produces two
documents with one number and two totals — indistinguishable, after the
fact, from fraud. Under GST rules a revision is a credit note or a fresh
invoice, never an edit.

| Change to an ISSUED invoice | Result |
|---|---|
| Any amount column | **Refused** |
| Invoice number | **Refused** |
| Tenant | **Refused** |
| Tax identity (GSTIN, place of supply) | **Refused** |
| Rewriting, adding or deleting a **line item** | **Refused** |
| Recording a payment (status, amount paid, paid_at) | **Permitted** |
| Everything, on a **draft** | **Permitted** |

The line-item trigger is not redundant. Without it the header trigger is
trivially bypassed: leave the totals alone and rewrite what was bought. The
customer's copy and ours would then agree on the total and disagree on the
goods.

**This surfaced a real ordering constraint during testing.** An invoice must
be *built as a draft*, have its lines attached, and only then be issued —
creating it as `open` and attaching lines afterwards fails with 42501. The
test fixture did exactly that and was caught. Phase 16's invoice generator
must follow the same sequence, and it is now documented in the fixture.

### One live subscription per tenant

A partial unique index over `(tenant_id)` where status is live and
`deleted_at IS NULL`.

The scenario it prevents: an upgrade creates a new subscription, the old
one's cancellation fails or its webhook never arrives, and next month **both
renew**. The customer is charged twice, notices, and the honest answer is
"our code has a race". With the index the second INSERT fails and the
upgrade is rejected — an annoyance, versus a refund and a lost customer.

The index is partial so a tenant may accumulate any number of cancelled rows
as history. Tested both ways.

Also enforced: **a subscription cannot be moved to another tenant.** Doing so
would drag its whole billing history with it and leave the original tenant's
records pointing at something no longer theirs.

---

## 🔴 A finding: additive GRANTs are not a restriction

While building a fresh test database for this phase, the earlier phases'
tests failed with `permission denied` until a baseline
`GRANT ALL ON ALL TABLES IN SCHEMA public TO ameya_app` was applied.

**That is the exact situation that would have silently defeated this phase's
grants.** The original Section 6 only *added* privileges. If anyone had ever
run a blanket `GRANT ALL` — which is the first thing most people do when a
query fails with "permission denied", and which several hosting providers'
setup guides recommend outright — then the application role already held
UPDATE on `plans` and DELETE on `payment_events`, and every GRANT in the
file would have been a no-op changing nothing.

A tenant repricing their own plan to zero is the most obvious attack on a
billing system, and the defence was decorative.

**Fixed** by revoking to nothing first, then granting exactly what is needed:

```sql
REVOKE ALL ON plans          FROM ameya_app;
REVOKE ALL ON payment_events FROM ameya_app;
REVOKE ALL ON subscriptions  FROM ameya_app;
REVOKE ALL ON invoices       FROM ameya_app;
```

Verified: after a deliberate `GRANT ALL ON ALL TABLES`, re-running the file
still leaves `plans.UPDATE = false` and `payment_events.DELETE = false`.

`subscriptions` and `invoices` also lost DELETE. Both are financial history
and are soft-deleted, so the privilege has no legitimate use — while a hard
delete of a subscription would orphan every invoice referencing it, and a
hard delete of an invoice would remove a document a customer is holding.

`npm run db:verify` now asserts all four privileges directly.

---

## Money never becomes a float

Every monetary column is `bigint` in the smallest currency unit — paise for
INR, cents for USD. There is **no `number` in any signature that represents
money**.

`0.1 + 0.2 !== 0.3` in IEEE-754. A paisa lost per transaction is an invoice
that does not reconcile, and the failure is entirely silent: it does not
throw, it passes every type check, it renders correctly, and it surfaces
when someone reads a bank statement three months later.

**45 tests** cover the arithmetic with the inputs that break naive
implementations:

| Property | Why it is tested |
|---|---|
| Rates are **basis points**, integers — 1800, not 0.18 | A float rate reintroduces the problem one multiplication later |
| `applyRateBps` rounds **half-up** | Matches the statutory GST method an auditor will recompute by hand |
| Rounding is **symmetric across zero** | Otherwise an upgrade then an immediate downgrade leaves a stray paisa nothing clears |
| `splitEvenly` **never loses a minor unit** | ₹100 split three ways naively loses a paisa |
| **Odd GST amounts** split correctly | Halving twice and rounding each half exceeds the tax charged, and the invoice CHECK constraint rejects the row |
| `addInterval` **clamps 31 Jan → 28 Feb** | Naive `Date` rolls to 3 March and *permanently* moves the customer's billing anchor |
| Leap year, year boundary, DST | All computed in UTC |
| Proration by **seconds, not days** | No boundary argument about the switching day; sidesteps 28/29/30/31 and DST entirely |
| Proration **clamped** into the period | Clock skew on a webhook would otherwise credit more than was ever charged |
| **Property test over every hour of a month** | The credit is never greater than the amount charged |
| `toBigIntAmount` **throws on a float** | Silently truncating would turn a corrupt row into a free subscription |
| `toBigIntAmount` **throws on a malformed string** | Returning 0 would do the same |
| INR uses **lakh/crore grouping** | ₹12,34,567 — the most visible "not built for us" signal in India |

A source-level test also asserts the module contains no `parseFloat` and at
most three `Number(` calls — the two in `formatMoney` where a value becomes
pixels, plus its safety guard.

### One test was itself the bug it tested for

The control-character check originally embedded **literal control
characters** in its own regex — the same defect that appeared three times
across Phases 3 and 8. It passed. It has been rewritten with explicit `\u`
escapes and now scans five billing source files.

---

## GST compliance

| Concern | Handling |
|---|---|
| Intra-state supply | CGST + SGST, split with `splitEvenly` so the pair sums *exactly* to the tax |
| Inter-state supply | IGST at the full rate |
| Unknown place of supply | **Defaults to IGST** — a single line at the full rate under-collects nothing and is straightforward to correct |
| All three populated | **Rejected by CHECK constraint** — would double-charge on a return |
| GSTIN validation | Shape **and** state code **and** mod-36 checksum, in code and as a CHECK constraint |
| GSTIN state vs. place of supply | Cross-validated — a mismatch produces an invoice the customer cannot claim credit against |
| Invoice numbering | A **database sequence**, not `MAX(n)+1` |
| Financial year | **April–March**. 2 April 2026 → FY 2026-27; 30 March 2026 → FY 2025-26 |
| SAC code | 998314, on every line by default |

**Why a sequence.** Two concurrent invoice creations reading `MAX` get the
same answer, and on a serverless platform where a hundred instances can
exist at once this is not theoretical — nor is it solvable with an
application lock, because the instances share nothing. Tested for uniqueness
across 50 sequential and 25 concurrent calls.

Sequences produce gaps on rollback, and that is accepted deliberately: **a
gap you can explain is far better than a duplicate number**, which is a
compliance failure.

---

## Zero new dependencies

Neither the `razorpay` nor the `stripe` npm package was added. Both SDKs are
thin wrappers over a handful of REST calls plus an HMAC, and taking them
would have cost:

- a transitive HTTP stack in a serverless bundle where cold-start size is
  what you actually pay for;
- two packages that must be kept current in the code path that handles
  money — supply-chain surface on the highest-value target in the
  application;
- an abstraction over `fetch`, which is already global.

`node:crypto` and `fetch` are platform primitives. The signature algorithms
are documented, stable and fifteen lines each.

**Bundle impact: both webhook routes are 154 B. The shared baseline is
unchanged at 102 kB.**

Both HTTP clients enforce a **15-second timeout** — `fetch` has none by
default, and a hung provider connection would occupy a Vercel function until
the platform kills it. Both classify errors as retryable (5xx, 429, network)
or not (4xx), because retrying a 400 forever is how a misconfigured plan id
turns into a rate-limit ban. Stripe's API version is **pinned** so a
provider-side version roll cannot silently change payload shapes.

---

## Other security properties

**Payload redaction runs even though it should find nothing.** Neither
provider sends a full card number. The pass runs anyway because
`payment_events.payload` is stored *forever* and is *append-only* — if a
provider ever changes what it sends, the first we would know is a PCI
finding against data we can no longer delete. It is Luhn-checked to avoid
eating provider reference ids, depth-limited to survive a cyclic object
without blowing the stack inside a webhook handler, and it never mutates its
input.

**No payment instruments are stored.** `payment_methods` holds a provider
token plus enough to render "Visa ending 4242" and nothing else. No PAN, no
CVV. Storing those would drag this application into PCI-DSS scope, which is
a compliance programme, not a schema decision.

**Refunds and disputes do not revoke access.** A refund can be partial,
goodwill, or a duplicate charge being returned; a dispute is a claim, not a
verdict. Both are recorded as high-signal events for a human. Silently
revoking access on either would punish someone who may still be paying.

**An unrecognised provider status changes nothing.** `mapProviderStatus`
returns `null` rather than defaulting, so a provider adding a status string
in a minor release cannot move a paying customer into an arbitrary state. A
default of `cancelled` would be the worst available and is what a naive
`?? "cancelled"` produces.

**Dunning does not lock anyone out.** `past_due` grants full access; only
`unpaid` — after four failed attempts and a seven-day grace window — is what
Phase 14 may gate on. The most common cause of a failed renewal is an
expired card, and cutting someone off on that day converts a recoverable
renewal into churn.

**The billing audit writer never swallows its error.** This is a deliberate
departure from the usual "audit failures must not break the request" rule:
if the audit insert throws, the reconciliation transaction rolls back and
the provider retries. For a money movement, an unrecorded change is not an
acceptable outcome.

**Checkout does not create a subscription row.** It creates a pending one at
the provider and returns a URL; the local row is written by the confirming
webhook. Writing it optimistically would leave an abandoned payment holding
an active-looking subscription — and the one-live-subscription index would
then block the customer from ever trying again.

**Cancellation calls the provider first, then updates our row.** The reverse
order fails by telling the customer their subscription is over while the
provider keeps charging them; they find out on a card statement. This
order's failure mode self-heals when the provider's cancellation webhook
arrives.

**Return URLs are built from our own origin.** `returnPath` is validated as
a relative path by the Zod schema. Accepting a full URL would be an
open-redirect on a payment confirmation page.

**Manual payments demand a bank reference.** "Paid" without a UTR is an
assertion, not a record. The event's idempotency key is derived from the
invoice and the reference, so recording the same UTR twice against one
invoice violates the unique index — which is exactly the double-entry
mistake a busy finance person makes. Overpayment is refused with the
outstanding balance quoted, because an over-application is almost always a
duplicate entry.

---

## Outstanding

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| **SEC-024** | **No rate limiting on the webhook endpoints (new)** | **High** |
| **SEC-025** | **Provider plan ids are not yet set — nothing can be purchased (new)** | **High** |
| SEC-022 | `db:push` drops RLS — use `db:generate` in production | High |
| SEC-016 | Enable branch protection requiring "Security Gate" | High |
| SEC-020 | No rate limiting on `/portal/[token]` | Medium |
| SEC-002 | Nonce-based Content-Security-Policy | Medium |
| SEC-005 | Rate limiting on search, webhook and upload tokens | Medium |
| SEC-018 | Orphaned blobs — reconciliation sweep | Low |
| SEC-019 | No virus scanning on upload | Low |
| SEC-023 | Analytics views re-aggregate on every load | Low |

### On SEC-024

The webhook endpoints are public and do real database work. An attacker who
cannot forge a signature can still make us compute an HMAC and open a
connection, once per request, for free — on a plan billed by invocation.

The signature check is cheap and fails before any database access, so this
is a **cost** problem rather than a correctness one. Phase 20 closes it
along with SEC-005 and SEC-020, since all three want the same Upstash
rate-limiter.

### On SEC-025

Every plan currently has `razorpay_plan_id IS NULL`, so **checkout will
refuse for all of them** with "That plan cannot be purchased online yet."
That is correct, deliberate behaviour — a clear message beats a provider 400
the customer cannot act on — but it does mean **Phase 11 does not yet take
money**. Mirroring the plans into Razorpay is a fifteen-minute task in their
dashboard, documented step by step in the deployment guide, and it needs a
real Razorpay account with KYC completed.

---

## Honest limitations

- **No screen has been rendered in a real browser.** This is now eleven
  phases without a visual check. Phase 11 ships no new UI, so nothing is
  newly at risk — but the debt has not moved.
- **No end-to-end test drives a real provider sandbox.** The adapters are
  tested against constructed payloads shaped like real ones, and the
  signature algorithms are verified against the real HMAC. What is *not*
  verified is that Razorpay's live payload matches the shape assumed here.
  The `unmapped` fallback and the never-throw normalisers mean a mismatch
  degrades to "recorded, not applied" rather than to a crash — but the first
  real webhook should be watched.
- **Proration is computed but not yet charged.** `previewPlanChange` returns
  the exact figures; applying them is Phase 14.
- **Invoices are not yet generated.** The schema, the numbering, the tax
  arithmetic and the immutability guarantees are all in place and tested.
  The code that *creates* an invoice from a subscription period is Phase 16.
- **`db:verify` cannot see how the application connects.** It reports the
  role it is running as. If the app connects as a superuser in production,
  every policy is decorative and this script will not tell you.
- **The prices in the catalogue are placeholders.** They are internally
  consistent — the tier ladder, seat counts and quotas line up, and annual
  is priced at ten months for twelve — but they are not market research.
  Change them before you charge anyone.
- **Vercel Hobby forbids commercial use.** Unchanged, and now directly
  relevant: this is the phase that makes taking money possible, and taking
  money on Hobby breaches their terms. **Upgrade to Pro before your first
  paying customer.**
