# DEPLOY , Ordence v1.63.0-alpha

**Repo: `app.ordence`**

🔴 **SQL: TWO new migrations, `0097` → `0098`, in that order, BEFORE the code push.**
⚠️ **These come AFTER `0093`–`0096` from the last release.** Full order if you have not run those yet: `0093` → `0094` → `0095` → `0096` → `0097` → `0098`.
⚠️ **No new environment variables.**

**15 gates green. `tsc` clean. 160 test files. 5,369 tests, up from 5,270.**

---

## First: your `0093` result was fine

The JSON you sent was **tab 1 of 3** , the pre-check, which runs *before* the change. `column_already_present: false` is the correct answer there on a first run: it means "not here yet, so there is work to do". Tab 3 is the verdict. **`CONFIRM-0093-neon-safe.sql`** settles it in one statement from the catalog, so it does not matter which tab was open. I proved both of its branches against a live database.

---

## What this release contains

| | |
|---|---|
| **55 + 56** | Entitlements and metering, actually enforced |
| **Comms** | The queue that never sent |
| **RERA** | Demand notices that recorded themselves as served |
| **ESI** | The mid-period defect found last wave |

---

## 🔴 The three lies this release stops the product telling

Each one is the same shape, and it is now the **fourth, fifth and sixth** instance found in three waves: something declared, displayed, and enforced by nothing.

### 1. 34 of 71 entitlement keys were read by no code

`FEATURE_CATALOG` declares 71 keys. **37 are read at a server-side decision point. 34 are priced, shown on the plan matrix, and refused by nothing.**

Most name unbuilt modules, where a gate would be dead code. **The sharp ones are not:**
- 🔴 **`hr.payroll` is fully built and completely ungated.** Any plan runs payroll.
- `admin.sso`, `admin.white_label`, `admin.data_residency` are enterprise sell-points nothing checks.
- `lib/platform/flags-catalog.ts` ships an override flag for `sales.orders`, a key no code reads , a switch for a switch that does nothing.

⭐ **`lib/entitlements/enforcement.ts` is now a ledger with one entry per key**, and a test fails if a new catalogue key has no decision, a `gated` key loses its gate, or a `declared_only` key quietly grows one. **There is no longer a way to ship a silently unenforced entitlement.**

Two more real bugs fell out: `reconcileStorageLevel()` had existed since Phase 15 and was **called from nowhere**, and `requireSeat()` ran **outside** the transaction that took the seat , so two tabs both passed at 4 of 5.

### 2. Dunning letters queued and never sent

`server/actions/credit.ts` carried its own confession: *"🔴 IT QUEUES. IT DOES NOT SEND."* The owner saw "reminder sent". The customer received nothing. The invoice aged.

There is now a real outbox with atomic claiming (`FOR UPDATE SKIP LOCKED`), suppression, backoff and dead-lettering. 🔴 **A row cannot be marked `sent` or `bounced` without a provider message id** , that is a CHECK constraint, because a row with no provider id is not proof of delivery.

⚠️ **Suppression is a shared resource, not a per-tenant nicety.** Sending to a known-bad address damages the reputation of `ordence.com` itself, degrading delivery for every tenant including the ones doing nothing wrong. The Resend webhook is Svix-verified and **fails 503 when no secret is configured rather than trusting input** , an unauthenticated endpoint that can suppress an address is a denial of service on a customer's mail.

### 3. 🔴 RERA demand notices recorded themselves as served

**This was the worst one, and it was found by an agent surveying for the second.**

`dunning_events.sent_at` was `NOT NULL DEFAULT now()` , **populated by the INSERT.** Nothing sent anything. The schema's own comment already said so.

⚠️ **This is not a marketing nudge. A demand notice under a RERA allotment is the step before interest accrues, before an allotment can be cancelled, and before a forfeiture. The record of service IS the evidence.** A developer cancelling an allotment on the strength of that timestamp is relying on a notice the allottee never received , and in front of a RERA Authority that is the developer's case collapsing, with the allottee the one actually wronged.

**Three facts, three columns, because they are three different claims:** `raised_at` (someone decided), `dispatched_at` + a provider id (it left our system), `served_at` (it arrived or was deemed to). Graded `none · system_dispatch · human_recorded · deemed · legacy_unverified`.

⭐ **Proved against a live PostgreSQL, in both directions:**

```
INSERT with a send claim        -> ERROR: dunning_events_sent_at_is_not_a_claim
INSERT of a legitimate raise    -> INSERT 0 1
dispatch with no provider id    -> ERROR: dunning_events_dispatch_needs_proof
promoting a legacy row          -> ERROR: dunning_events_legacy_is_never_promoted
```

⚠️ **Existing rows were NOT backfilled.** Copying `sent_at` into `dispatched_at` would manufacture the very evidence the defect fabricated. They are marked `legacy_unverified` at DDL time and a constraint forbids ever promoting one.

⭐ **And the cancellation flow now warns.** `previewCancellationPosting` returns a finding naming the unserved and legacy rungs. **That warning is worth more than the rest of the batch**, because it sits where the irreversible decision is made.

---

## And the ESI defect from last wave is fixed

`server/payroll/run.ts` passed `esiCoveredAtPeriodStart: false` for every employee, every month, dropping any mid-period riser the month they crossed ₹21,000 , writing a covered person out of the register in breach of Regulation 4.

Coverage now comes from **evidence**: the employee's own payslips from approved or posted runs within the contribution period. ⚠️ **When the evidence is missing it defaults to COVERED and raises a blocking finding**, because the two errors are not symmetric: over-contributing costs the employer recoverable money, under-contributing ends a real person's medical cover mid-illness.

**Past runs are detected and reported, never rewritten** , that is a correction with its own trail, not an edit.

---

## Grace, not a cliff

⭐ The billing ladder is now: warn → block new consumption → block non-essential → **never** block reading your own data → **never** block a statutory obligation.

🔴 **`payroll:`, `tds:`, `gst:` and `compliance:` are exempt at every rung.** An Indian SMB whose payroll is due on the 7th and whose card failed on the 5th **must still be able to run payroll**. And exporting your own books is never gated , a product that holds a customer's ledger hostage over a billing dispute is one a CA will warn every client away from.

Defaults 5 / 3 / 7 days, configurable, unset means the default and never zero. Overage: storage and email **refuse**, API calls **bill** , stated on the screen, derived from the same threshold that enforces it so the prose cannot drift.

---

## Deploy

1. **SQL in order: `0097` → `0098`** (after `0093`–`0096` if outstanding).
   - ⭐ Both drilled the way you actually run them: 18 and 34 statements, each on its own fresh connection, twice for idempotence. RLS **enabled and forced** verified on both new tables. No `BEGIN`, no `COMMIT`, no bare `SET LOCAL`.
2. Unzip `ordence-v1.63.0-alpha.zip`, commit, push.

⚠️ **Still not verified: `next build`.** OOM-killed here.

---

## Roadmap

**Mega-wave 2: 22 of 24** , batch 24 needs a suspended workspace, batch 32 needs the two vault keys.
**Mega-wave 3: 9 of 19** , remaining runnable: the rest of comms and support. Razorpay (53, 54, 124) needs Razorpay keys; the caged agent (62, 63, 64, 140) needs Groq and Cloudflare Workers AI keys.
