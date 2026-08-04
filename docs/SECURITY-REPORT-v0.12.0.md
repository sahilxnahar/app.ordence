# Security Report — v0.12.0-alpha

**Phase 12 — Entitlements & Feature Gating**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build | **Clean — 30 routes** |
| Security tests (real PostgreSQL 16) | **171 / 171** |
| UI & logic tests | **236 / 236** (was 207) |
| `db:verify` | **10 / 10** |
| Tables under RLS | **30 — unchanged** |
| New dependencies | **Zero** |
| Shared JS baseline | **102 kB — unchanged** |

No new tables, no new columns, no change to the tenant isolation model.
This phase reads what Phase 11 created and decides what a workspace may do
with it.

---

## The threat model for an entitlement gate

An entitlement gate is a **commercial** control, not a confidentiality one.
It is worth stating that plainly, because it changes what the risks are.

Bypassing it does not expose another tenant's data — RLS does that job and
is unaffected here. Bypassing it means someone uses a feature they have not
paid for. That is a revenue loss, not a breach.

So the failure modes that matter are:

1. **A feature given away by accident** — a typo'd key that reads as
   "allowed", a matrix inconsistency, a client-side check trusted as a
   server-side one.
2. **A feature wrongly withheld** — which is worse commercially than the
   first, because it hits a customer who *has* paid.
3. **The wrong message** — telling someone they lack permission when they
   lack a plan.

---

## ⭐ Fails closed on every unrecognised key

`evaluateFeature` denies anything not in the catalogue, at every tier,
matching `evaluatePermission` from Phase 5. Tested against seven adversarial
inputs across all five tiers.

### 🔴 A real bug: `in` walks the prototype chain

The first implementation of `isFeatureKey` used the `in` operator:

```ts
return typeof value === "string" && value in FEATURE_CATALOG;  // WRONG
```

`"toString" in FEATURE_CATALOG` is **true**. So were `constructor`,
`hasOwnProperty` and `__proto__` — every method on `Object.prototype` read
as a known feature.

**It happened to fail closed**, but only through a chain of coincidences:
`FEATURE_CATALOG["toString"]` is a function, so `.minTier` was `undefined`,
so `TIER_RANK[undefined]` was `undefined`, so the `>=` comparison was false.
Three accidents deep. It also reported `requires_upgrade` rather than
`unknown_feature`, so nothing would have surfaced it.

A gate that is safe by luck stops being safe when something unrelated
changes — a default added to the catalogue type, a lookup rewritten. Now
`Object.hasOwn`, with a test asserting each prototype key is rejected.

---

## ⭐ The matrix cannot drift

Tiers are a **ladder**, stored as a single `minTier` per feature rather than
a list of tiers. That makes "Advanced has something Enterprise does not"
unrepresentable rather than merely unlikely.

A test asserts the superset property across **every adjacent tier pair**. It
would fail the build on any future edit that broke it — which matters,
because the symptom otherwise is an enterprise customer asking where their
contacts went.

The pricing page and comparison table are generated from
`featuresForTier()`, the same function the gate uses. A hand-maintained
pricing table that disagrees with the gate is a promise you do not keep, and
it gets discovered by a customer rather than by a test.

---

## The client copy is a rendering hint, never a boundary

`getEntitlementSummary()` sends a serialisable snapshot to client
components so a locked panel renders locked on first paint instead of
flashing and disappearing.

**Every write path calls `requireFeature()` on the server regardless.**
Re-enabling a button in devtools does nothing; the server action refuses.
This is stated explicitly in the module's doc comment because it is exactly
the kind of thing a future contributor could reasonably mistake for
enforcement.

A source-scan test asserts **no server action compares `planTier` directly**
— scattered `if (tenant.planTier === "advanced")` is what this phase exists
to remove, and it fails predictably: you add a tier and find the
seventeenth comparison eight months later, when a customer cannot reach
something they paid for.

---

## The authority is the subscription, not the cached column

`tenants.plan_tier` is a denormalised cache maintained by `reconcile.ts`.
It is correct almost always, and "almost always" is not good enough for the
column that decides what someone can reach.

Two ways it goes stale, both real: a delayed webhook leaves a customer who
just upgraded on the old tier; a lost webhook leaves a cancelled customer
with access. So the gate reads the subscription row and prefers it, falling
back to the column only when no subscription exists (a workspace
mid-signup).

Cost: one indexed query per request, deduplicated within the request by
React `cache()`. **Deliberately not a TTL cache** — a time-based cache means
a customer who has just paid still sees a paywall for however long the TTL
is, which is the most expensive moment in the product to look broken.

---

## Graceful degradation, as a security property

The brief says "never a hard crash", and there is a security-adjacent reason
beyond the commercial one.

A gate that threw on reads would mean a downgrade turns every page touching
that feature into a 500. Error pages leak more than success pages —
stack frames, route names, framework versions — and a customer repeatedly
hitting one is a customer generating exactly the sort of output you do not
want in a log they can screenshot.

Two shapes, deliberately: `requireFeature()` throws (writes),
`checkFeature()` returns a decision (reads). Twelve write paths are gated;
**zero read paths are.**

### 🔴 An automated wiring pass got this backwards

Inserting the gates by pattern-matching attached three of them to
`getTrialBalance` — a read — and none to `postTransaction`, `createLedger`
or `reverseTransaction`. Reads gated, writes open: the exact inversion this
design exists to prevent, and it typechecked cleanly.

Found by inspecting where each gate landed rather than trusting the script
reported success. Corrected, and a test now enumerates every gated function
and fails if any whose name begins `get`/`list`/`find`/`is`/`preview` is
feature-gated.

---

## 🔴 `inert=""` rendered nothing

The locked subtree must be genuinely inert — removed from the tab order,
from hit-testing and from the accessibility tree.

`inert=""` is discarded by React, which treats an empty string as an absent
value for boolean-ish attributes. The attribute never reached the DOM.

**There was no visible symptom.** The content still looked dimmed, because
the opacity class was unaffected. A mouse user saw exactly the intended
result. Only a keyboard or screen-reader user would have discovered it, by
tabbing into buttons that silently did nothing — a strictly worse experience
than the mouse user gets, which is the wrong way round.

Now `inert={true}`, with a test that queries the DOM for `[inert]` rather
than trusting the JSX.

`pointer-events-none` alone was considered and rejected for the same reason:
it disables the mouse and nothing else.

---

## Message hygiene

Two properties, both tested across the whole catalogue:

**No denial message contains an internal feature key.** "accounting.ledger
is available on…" is developer output leaking into a commercial
conversation. Messages use the human label.

**No denial message mentions permissions, roles or administrators.** Telling
a workspace owner they "lack permission" for something they have not bought
sends them to ask an administrator who is themselves. It is the single worst
error message a SaaS product can produce, and the only defence is checking
entitlement *before* permission — an ordering that is invisible in its
effects until a customer receives the wrong words.

`requireFeatureAndPermission()` exists so that order cannot be got wrong at
a call site.

---

## Commercial decisions encoded as constants

Each is one named constant, easy to find and easy to change:

| Constant | Value | Reasoning |
|---|---|---|
| `TRIAL_EFFECTIVE_TIER` | `advanced` | A trial unlocking only the cheapest tier means the prospect evaluates the least impressive version and concludes it does not do what they need. |
| `LAPSED_EFFECTIVE_TIER` | `basic` | An expired card should find a limited product and a clear prompt, not a locked door and data apparently gone. |

Both are asserted by tests, so changing one is a deliberate act with a
visible diff rather than a quiet edit.

---

## Outstanding

Unchanged from v0.11.0. Nothing in this phase adds or closes a security
item.

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| **SEC-025** | Provider plan ids unset — nothing purchasable | **High** |
| SEC-024 | No rate limiting on webhook endpoints | High |
| SEC-022 | `db:push` drops RLS | High |
| SEC-016 | Branch protection on `main` | High |
| SEC-020 | No rate limiting on `/portal/[token]` | Medium |
| SEC-002 | Nonce-based CSP | Medium |
| SEC-005 | Rate limiting on search, webhook, upload | Medium |
| SEC-018 | Orphaned blob sweep | Low |
| SEC-019 | No virus scanning on upload | Low |
| SEC-023 | Analytics views re-aggregate per load | Low |

---

## Honest limitations

- **Seat limits are defined but not enforced.** `seatsPurchased` and
  `includedSeats` exist and nothing reads them. A workspace can add
  unlimited users today. That is Phase 13, and until it lands the per-seat
  pricing in the catalogue is decorative.
- **Quotas are not metered.** Storage and email limits are columns on
  `plans` that nothing counts against. Phase 15.
- **The upgrade prompt links to `/settings/billing`, which does not exist
  yet.** The link is correct and will resolve when Phase 16 builds that
  page; today it 404s. Deliberate — the alternative was a placeholder route
  that would have to be found and removed later.
- **No screen has been rendered in a real browser.** Twelve phases. This
  one adds visible UI (the paywall), so the debt is now slightly more
  pointed than it was: the `FeatureGate` component is covered by jsdom
  tests, but nobody has *looked* at a dimmed accounting page.
- **Vercel Hobby forbids commercial use.** Unchanged.
