# Phase 11 Deployment — v0.11.0-alpha

**Billing Foundation**
**Date:** 31 July 2026

---

## What this phase actually gives you

The machinery to charge people. Six new database tables, two payment
providers wired in, and — most importantly — the guarantees that stop the
two ways billing goes wrong:

- **A retried payment webhook cannot charge someone twice.** Both Razorpay
  and Stripe retry, and both occasionally send the same event again hours
  later. The database now refuses the duplicate outright.
- **An invoice you have sent cannot be quietly edited.** Once issued, the
  amounts are fixed. A correction means a credit note, which is also what
  GST rules require.

**What it does not yet do:** generate invoices automatically, take a payment
end to end, or show anyone a billing screen. Those are Phases 14 and 16.
This is the foundation the rest of Wave 1 is built on, and it is the part
where being wrong is expensive.

---

## ⚠️ Before you start — two things that will not work yet

**1. Nobody can actually pay you yet.** Every plan needs a matching plan
created inside Razorpay, and that link does not exist until you make it.
Until then, clicking "Subscribe" gives a clear message rather than an error.
Step 8 walks through it. You will need a Razorpay account with KYC
completed, which takes a few days on their side — start that now if you have
not.

**2. Vercel Hobby forbids commercial use.** This is the phase that makes
taking money possible, so it is now the phase where that matters. **Upgrade
to Pro (₹1,700/month) before your first paying customer.** Not before you
deploy — before you charge.

---

## Before you start

About **35 minutes**, plus whatever Razorpay's verification takes.

---

## Step 1 — Open a terminal in your project

```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
```

Confirm you are in the right place:

```bash
pwd
```

It should end in `ameya-heights-os`.

---

## Step 2 — Install dependencies

```bash
npm install
```

**Nothing new is installed.** That is deliberate and worth a sentence: the
official Razorpay and Stripe packages were not added. Both are thin wrappers
around a few web requests and a signature, and your app already has
everything needed to do those directly. Fewer packages in the code that
handles money is a smaller target and a faster cold start.

Confirm the count has not moved:

```bash
npm ls --depth=0 | wc -l
```

---

## Step 3 — Add the new environment variables

Open `.env.local` and add these. **Leave them blank for now** if you do not
have a Razorpay account yet — the app builds and runs perfectly without
them, and simply reports that online payment is not configured.

```bash
# ---- Razorpay (primary rail for Indian customers) ----
RAZORPAY_KEY_ID=""
RAZORPAY_KEY_SECRET=""
RAZORPAY_WEBHOOK_SECRET=""

# ---- Stripe (international cards — optional, add later) ----
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""

# ---- Your tax identity (appears on every invoice you issue) ----
PLATFORM_GST_STATE_CODE="29"
PLATFORM_GSTIN=""
PLATFORM_INVOICE_PREFIX="AH"
```

**About `PLATFORM_GST_STATE_CODE`:** this is the state where *your business*
is GST-registered, as a two-digit code. `29` is Karnataka. It decides whether
each invoice charges CGST+SGST (customer in the same state) or IGST
(customer elsewhere). Getting it wrong misclassifies every invoice you
issue, so check it against your own GST certificate rather than trusting the
default.

Add the same variables in **Vercel → your project → Settings → Environment
Variables** before Step 12.

---

## Step 4 — Update the database schema

```bash
npm run db:push
```

Answer `y` if asked. This creates six new tables.

**When it finishes it prints a warning.** That warning is real — `db:push`
deletes your tenant security rules. Do not skip the next step.

---

## Step 5 — Apply the security rules

**This step is mandatory.** It restores what Step 4 deleted and adds the new
billing protections.

In the Neon console, open a SQL editor and run the whole of:

```
SQL-FILES/ALL-IN-ONE-SETUP.sql
```

The file is safe to run repeatedly.

### Check the output

Scroll to the bottom and look for these four lines:

```
PASS: webhook replay protection is in place
PASS: a tenant cannot hold two live subscriptions
PASS: all 5 tenant-scoped billing tables are ENABLE + FORCE
PASS: billing privileges are correctly restricted
```

**The first line is the most important in this entire phase.** It confirms a
database index that makes it impossible to record the same payment event
twice. Without it, a retried webhook charges a customer twice — with no
error, no warning, and nothing in any log to tell you. You would find out
from the customer.

The fourth line confirms something equally quiet: your application cannot
change its own prices, and cannot alter payment records after the fact. That
one was **broken and fixed during this phase** — see "What went wrong"
below.

---

## Step 6 — Verify you are actually protected

```bash
npm run db:verify
```

You want **ten** green ticks now (there were seven):

```
✅ Row-Level Security enabled AND forced
     all 30 tables protected
✅ Tenant isolation policies present
✅ Policies cover writes (WITH CHECK)
✅ Analytics views run with security_invoker
✅ Financial and evidence triggers installed
✅ Append-only evidence tables
✅ Webhook replay protection (payment_events unique index)
✅ One live subscription per tenant
✅ Billing privileges are restricted
✅ Connected role does not bypass RLS
```

If anything shows ❌, **stop**. Re-run Step 5.

---

## Step 7 — Load the plan catalogue

```bash
npm run seed:plans
```

You should see five plans created:

```
    created  trial                    ₹       0 / monthly
    created  basic_monthly_inr        ₹    1999 / monthly
    created  advanced_monthly_inr     ₹    4999 / monthly
    created  advanced_annual_inr      ₹   49990 / annual
    created  enterprise_annual_inr    ₹  249990 / annual
```

Then a warning that these plans cannot be purchased online. **That is
expected** — Step 8 fixes it.

**These prices are placeholders.** They are internally consistent and the
annual plans are priced at ten months for twelve, which is the usual
convention. They are not market research. Edit them in
`lib/validators/billing.ts` and re-run this command; it updates in place
rather than duplicating.

> One thing this script deliberately will **not** do: change what an existing
> customer pays. A subscription copies its price at the moment of purchase,
> so editing the catalogue affects only new sign-ups. That is why you can
> re-run this safely.

---

## Step 8 — Create the plans inside Razorpay

This is the step that turns "we have billing code" into "someone can pay us".

1. Log in at **dashboard.razorpay.com**.
2. Go to **Subscriptions → Plans → + New Plan**.
3. Create one plan per row in the table below.

| Your plan code | Billing cycle | Amount to enter |
|---|---|---|
| `basic_monthly_inr` | Monthly | ₹1,999 |
| `advanced_monthly_inr` | Monthly | ₹4,999 |
| `advanced_annual_inr` | Yearly | ₹49,990 |

4. After creating each one, Razorpay shows a **Plan ID** like
   `plan_NxxxxxxxxxxxxX`. Copy it.
5. In the Neon SQL editor, run one line per plan:

```sql
UPDATE plans SET razorpay_plan_id = 'plan_PASTE_YOURS_HERE'
 WHERE code = 'basic_monthly_inr';

UPDATE plans SET razorpay_plan_id = 'plan_PASTE_YOURS_HERE'
 WHERE code = 'advanced_monthly_inr';

UPDATE plans SET razorpay_plan_id = 'plan_PASTE_YOURS_HERE'
 WHERE code = 'advanced_annual_inr';
```

6. Confirm none are missing:

```bash
npm run seed:plans
```

The warning list should now be empty.

> **Do not create a Razorpay plan for `trial` or `enterprise_annual_inr`.**
> The trial charges nothing, and enterprise is sold by conversation with a
> manually-issued invoice — that is what the `manual` payment path exists
> for.

---

## Step 9 — Get your Razorpay keys

1. **Settings → API Keys → Generate Key.**
2. You get a **Key ID** (`rzp_live_…` or `rzp_test_…`) and a **Key Secret**.
3. **The secret is shown once.** Copy it now.
4. Put them in `.env.local` and in Vercel:

```bash
RAZORPAY_KEY_ID="rzp_test_xxxxxxxxxxxx"
RAZORPAY_KEY_SECRET="xxxxxxxxxxxxxxxxxxxx"
```

> Use the **test** keys first. Razorpay gives you test cards that behave
> like real ones without moving money. Switch to live keys only after Step
> 13 works end to end.

---

## Step 10 — Set up the webhook

This is how Razorpay tells your app that a payment happened. Without it, a
customer pays and your app never finds out.

1. **Settings → Webhooks → + Add New Webhook.**
2. **Webhook URL:**
   ```
   https://YOUR-DOMAIN.vercel.app/api/webhooks/razorpay
   ```
3. **Secret:** invent a long random string. Generate one with:
   ```bash
   openssl rand -hex 32
   ```
4. **Active Events** — tick exactly these:
   - `payment.captured`
   - `payment.failed`
   - `subscription.activated`
   - `subscription.charged`
   - `subscription.cancelled`
   - `subscription.halted`
   - `invoice.paid`
5. Save.
6. Put the same secret in `.env.local` and Vercel:

```bash
RAZORPAY_WEBHOOK_SECRET="the-string-you-generated"
```

**Why the secret matters.** This URL is public — it has to be, because
Razorpay's servers call it and they have no login. Anyone on the internet
can send it a request. The only thing separating a real payment
notification from a forged one is that Razorpay signs each message with this
shared secret and your app checks the signature before believing a word of
it.

So: **treat it exactly like a password.** If it leaks, someone can tell your
app that any subscription was paid for. Rotate it in the Razorpay dashboard
and in Vercel if you ever suspect it has.

If the secret is missing or wrong, your app rejects every webhook — which is
the correct failure. It never guesses.

---

## Step 11 — Check the code compiles and the tests pass

```bash
npm run typecheck
```

**Expected output: nothing at all.**

```bash
npm run test:ui
```

Expected: `Tests  207 passed (207)` — up from 102.

```bash
npm run test:security
```

Expected: `Tests  171 passed (171)` — up from 126.

> The security tests need a throwaway database (`.env.test`). If you have not
> set one up, they will refuse to run rather than risk touching production —
> that refusal is the guard working, not a fault.

---

## Step 12 — Build it the way Vercel will

```bash
npm run build
```

You should end with `✓ Compiled successfully` and **30 routes** — two more
than before, the two webhook endpoints.

Look at the bottom line: **`First Load JS shared by all — 102 kB`**. That is
unchanged. Adding two payment providers cost your users nothing, because no
payment code reaches the browser.

---

## Step 13 — Commit, push and deploy

```bash
git add .
git commit -m "Phase 11: billing foundation (v0.11.0-alpha)"
git push
```

Then open **vercel.com**, wait for the deployment to say **Ready**.

---

## Step 14 — Test a real payment, with fake money

1. In Razorpay, make sure you are in **Test Mode** (toggle, top right).
2. Trigger a checkout from your app.
3. Use Razorpay's test card: **4111 1111 1111 1111**, any future expiry, any
   CVV, OTP `1234`.
4. Complete the payment.

### Then check three things, in order

**a) Razorpay received it.** Dashboard → Transactions. You should see the
payment.

**b) Razorpay delivered the webhook.** Settings → Webhooks → click yours →
**Recent Deliveries**. You want **HTTP 200**.

- A **401** means the secret in Vercel does not match the one in Razorpay.
  Re-check both.
- A **503** means the secret is missing from Vercel entirely.
- A **500** means something broke on our side — check the Vercel function
  logs and send me what you see.

**c) Your database recorded it.** In the Neon SQL editor:

```sql
SELECT provider, provider_event_name, event_type, status,
       amount_minor, received_at
  FROM payment_events
 ORDER BY received_at DESC
 LIMIT 10;
```

You should see your event with status `processed`.

### Now test the thing that actually matters

In Razorpay's webhook page, click **Resend** on that same delivery.

Then re-run the query above. **The row count must not increase.** Razorpay
will report a 200, because the event was already handled — but nothing is
recorded twice and nothing is charged twice.

That is the single most important behaviour in this phase, and it is worth
seeing with your own eyes once.

---

## What went wrong during this phase, and what I did about it

Four things, all found and fixed before this reached you.

**1. The plan-price protection was decorative.** The rules said "the app can
read prices but not change them" — but they only *added* permissions, never
removed any. If anyone had ever run a blanket "grant everything" command
(which is the first thing most people do when a query fails with "permission
denied", and which several hosting guides actually recommend), the
protection would have quietly done nothing. Your application could have
repriced its own plans to zero.

Found because a fresh test database needed exactly that blanket command to
work at all. Fixed by explicitly *removing* the permissions first, then
granting back only what is needed — and `db:verify` now checks it directly.

**2. A test contained the exact bug it was testing for.** There is a check
for invisible control characters hidden in source code — a defect that has
appeared three times in this project. That check was written with literal
control characters inside it. It passed. Rewritten properly.

**3. Two test assumptions were wrong, and the database was right.** A test
tried to attach line items to an already-issued invoice, and another tried
to change a draft invoice's subtotal without adjusting its tax. Both were
refused. Both refusals were correct — an invoice must be built as a draft
and then issued, and the totals must always add up. The tests were fixed,
not the rules. That ordering is now written down, because Phase 16's invoice
generator has to follow it.

**4. A verification query crashed on PostgreSQL.** A type mismatch in one of
the checks in the new SQL file. Found by running it against a real
PostgreSQL 16 rather than assuming it was fine.

> On that last point: for this phase I set up a real PostgreSQL 16 and ran
> every SQL file and all 171 security tests against it before writing this
> guide. The four issues above are the ones that found. Nothing here is
> "should work".

---

## What is still outstanding

| Item | Why it matters | Effort |
|---|---|---|
| **Create the Razorpay plans (Step 8)** | **Nothing can be purchased until this is done** | 15 min |
| **Run `ALL-IN-ONE-SETUP.sql`** | Nothing is protected until this runs | 5 min |
| **Upgrade to Vercel Pro** | **Required before your first paying customer** — Hobby forbids commercial use | ₹1,700/mo |
| Rate limiting on the webhook endpoints | Public endpoints cost invocations when abused | Phase 20 |
| Prefer `db:generate` over `db:push` in production | `push` deletes policies | — |
| Enable branch protection on `main` | Without it, CI can go red and the merge still happens | 2 min |
| Stripe setup | Only needed when you have a customer paying by international card | Later |

---

## If something goes wrong

**Webhook returns 401** — the secret in Vercel does not match Razorpay.
They must be character-for-character identical. Re-copy both.

**Webhook returns 503** — `RAZORPAY_WEBHOOK_SECRET` is not set in Vercel at
all. Add it and redeploy (environment variables do not apply to an existing
deployment).

**"That plan cannot be purchased online yet"** — Step 8 is not done for that
plan. Run `npm run seed:plans` to see which ones are missing.

**"Online payments are not configured for this workspace"** — the Razorpay
keys are missing from Vercel. Step 9.

**`db:verify` says "0 tables protected"** — you ran `db:push` without Step
5. Run the SQL file now.

**A payment succeeded but the app does not know** — check the webhook's
Recent Deliveries in Razorpay first. If there is no delivery attempt at all,
the webhook URL is wrong. If there is one with a red status, the response
code tells you which of the above it is.

**`npm run seed:plans` fails with "DATABASE_URL is not set"** — it reads
`.env.local`. Make sure you are running it from the project folder.
