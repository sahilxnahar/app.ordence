# Phase 12 Deployment — v0.12.0-alpha

**Entitlements & Feature Gating**
**Date:** 31 July 2026

---

## What this phase does

Phase 11 gave you the ability to charge for plans. This one makes the plans
mean something: the product now knows which features each plan includes and
enforces it.

**Twenty-six features**, each tagged with the cheapest plan that includes it.
One gate the whole application consults. No new database tables, no new
packages, and nothing extra downloaded by your users' browsers.

---

## The one decision worth understanding

**Losing a feature never hides your customer's data.**

When someone downgrades, or their card expires, their contracts and ledger
entries and documents are all still there. The obvious way to build a
paywall is to hide the screen — and it is the wrong way. The customer
concludes their records have been deleted, at exactly the moment you are
asking them to pay you. It reads as punitive and it reads as unreliable.

So: **they can look, they cannot write.**

- Viewing the trial balance — always allowed
- Posting a journal entry — requires the Advanced plan
- Reading existing contracts — always allowed
- Sending one for signature — requires Advanced

The locked area still shows the real numbers, dimmed, with a clear
explanation above it. That is a deliberate commercial choice as much as a
technical one.

There is a matching decision about the words used. Someone who never bought
a feature sees *"Trust accounting is on the Advanced plan."* Someone whose
payment lapsed sees *"Trust accounting is paused — everything you have
entered is safe and unchanged."* Their first question is whether their data
is gone, and nothing else can be heard until that is answered.

---

## What each plan includes

| | Basic | Advanced | AI | Enterprise |
|---|:---:|:---:|:---:|:---:|
| Contacts, companies, deals | ✅ | ✅ | ✅ | ✅ |
| Asset catalogue | ✅ | ✅ | ✅ | ✅ |
| Client portal | ✅ | ✅ | ✅ | ✅ |
| Document vault | ✅ | ✅ | ✅ | ✅ |
| Email notifications | ✅ | ✅ | ✅ | ✅ |
| Trust accounting | — | ✅ | ✅ | ✅ |
| Contracts & e-signature | — | ✅ | ✅ | ✅ |
| Custom record types | — | ✅ | ✅ | ✅ |
| Executive dashboard | — | ✅ | ✅ | ✅ |
| Audit log, data export, API | — | ✅ | ✅ | ✅ |
| AI copilot, ask-your-data | — | — | ✅ | ✅ |
| White labelling, SSO, residency | — | — | — | ✅ |

**A trial gets everything in Advanced.** A trial that only unlocks the
cheapest tier is a bad trial — the prospect evaluates the least impressive
version of your product and concludes it does not do what they need.

**A lapsed workspace drops to Basic**, not to nothing. They keep a usable,
limited product and a clear prompt.

To change any of this, edit `lib/entitlements/features.ts`. It is a plain
list; there is no migration and no deploy ordering to worry about.

---

## Before you start

About **10 minutes**. There is no database change in this phase.

---

## Step 1 — Open a terminal in your project

```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
pwd
```

It should end in `ameya-heights-os`.

---

## Step 2 — Install dependencies

```bash
npm install
```

Nothing new is added.

---

## Step 3 — No database changes

**There are none.** This phase adds no tables and no columns — it reads the
subscription and plan rows Phase 11 already created.

You do **not** need to run `db:push` or the SQL file for this phase. If you
have not yet run `ALL-IN-ONE-SETUP.sql` from Phase 11, do that now — but
that is Phase 11's step, not this one's.

Confirm you are still protected:

```bash
npm run db:verify
```

All **ten** checks should be green.

---

## Step 4 — Check the code compiles

```bash
npm run typecheck
```

**Expected output: nothing at all.**

---

## Step 5 — Run the tests

```bash
npm run test:ui
```

Expected: `Tests  236 passed (236)` — up from 207.

```bash
npm run test:security
```

Expected: `Tests  171 passed (171)` — unchanged, since nothing about tenant
isolation moved.

---

## Step 6 — Build

```bash
npm run build
```

You should end with `✓ Compiled successfully` and **30 routes**.

Check the bottom line: **`First Load JS shared by all — 102 kB`**, still
unchanged. The whole entitlement system runs on the server; nothing about it
is downloaded by your users.

---

## Step 7 — Commit and deploy

```bash
git add .
git commit -m "Phase 12: entitlements and feature gating (v0.12.0-alpha)"
git push
```

Open **vercel.com** and wait for **Ready**.

---

## Step 8 — See it working

The clearest way to check this is to move a workspace between tiers and
watch what changes. In the Neon SQL editor:

**a) Look at where a workspace sits now:**

```sql
SELECT t.name, t.plan_tier, s.status, p.name AS plan
  FROM tenants t
  LEFT JOIN subscriptions s
    ON s.tenant_id = t.id AND s.deleted_at IS NULL
  LEFT JOIN plans p ON p.id = s.plan_id
 WHERE t.deleted_at IS NULL;
```

**b) Drop your test workspace to Basic:**

```sql
UPDATE tenants SET plan_tier = 'basic'
 WHERE slug = 'your-test-workspace-slug';
```

**c) Reload the app and check three things:**

1. Open `/accounting`. **The numbers are still there.** That is the point of
   the whole phase — the data is visible, dimmed, with an upgrade note above
   it.
2. Try to post a journal entry. It should refuse with *"Trust accounting is
   available on the Advanced plan"* — **not** "you do not have permission",
   and **not** "something went wrong".
3. Contacts and companies still work normally.

**d) Put it back:**

```sql
UPDATE tenants SET plan_tier = 'advanced'
 WHERE slug = 'your-test-workspace-slug';
```

Reload. Everything returns immediately — no setup, no re-entry.

> ⚠️ Editing `plan_tier` by hand like this is a **testing shortcut only**.
> In normal operation that column is kept in step automatically by the
> payment webhooks. Never use it to grant a real customer access, because
> the next webhook will overwrite it and they will lose the feature again
> with no explanation.

---

## What went wrong during this phase

Three things, all caught by the tests written alongside the code.

**1. A key check let through every built-in JavaScript method.** The
function deciding whether a feature name is real used a JavaScript operator
that also matches inherited properties — so `toString`, `constructor` and
`__proto__` all came back as valid feature names. It happened not to grant
access, but only through a chain of coincidences, and it reported the wrong
reason. A gate that is safe by accident stops being safe when something
unrelated changes. Fixed.

**2. The "locked" area was not actually locked for keyboard users.** The
dimmed section is supposed to be completely inert — not focusable, not
announced by a screen reader. The attribute that does that was written in a
form React silently discards, so the section stayed fully keyboard
reachable. **There was no visible symptom** — it still looked dimmed. Only
someone navigating by keyboard or with a screen reader would ever have found
it, tabbing into buttons that did nothing.

**3. An automated pass put the gates on the wrong functions.** When wiring
gates into the accounting module, my first attempt attached three of them to
*reading* the trial balance and none to *posting* an entry — exactly
backwards, and exactly the failure this phase's design is meant to prevent.
Corrected, and there is now a test that fails if any function whose name
starts with `get`, `list` or `find` is ever feature-gated again.

---

## What is still outstanding

| Item | Why it matters | When |
|---|---|---|
| **Create the Razorpay plans** | Still nothing can be purchased | Phase 11, Step 8 |
| **Run `ALL-IN-ONE-SETUP.sql`** | Nothing is protected until this runs | Phase 11, Step 5 |
| Seat limits are defined but not enforced | A workspace can add unlimited users | **Phase 13** |
| The paywall has no in-app upgrade button | It links to a billing page that does not exist yet | **Phase 14** |
| Storage and email quotas are not counted | Plan limits exist but nothing measures usage | **Phase 15** |
| **Upgrade to Vercel Pro** | Required before your first paying customer | Before charging |

---

## If something goes wrong

**A feature you paid for shows as locked** — the subscription row is the
authority, not the `plan_tier` column. Check it:

```sql
SELECT s.status, p.tier, p.name
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
 WHERE s.tenant_id = 'your-tenant-uuid' AND s.deleted_at IS NULL;
```

If the status is `cancelled` or `expired`, that is why. If it looks right
but the app disagrees, the page may be cached — hard refresh with
`Cmd + Shift + R`.

**Everything shows as locked** — most likely the workspace has no
subscription row and its `plan_tier` is something unexpected. The query in
Step 8a shows both.

**A locked area shows nothing at all instead of dimmed data** — that is a
bug, not a setting. Send me the screen it happened on.

**"Something went wrong" instead of an upgrade message** — also a bug. It
means a locked feature was raised somewhere that does not yet translate it
into plain language. Tell me which action you were performing.
