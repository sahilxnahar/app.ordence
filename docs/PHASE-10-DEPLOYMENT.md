# Phase 10 Deployment — v0.10.0-alpha

**Executive Dashboards & Financial Analytics**
**Date:** 31 July 2026

---

## ⚠️ Read this before you run anything

I found something during this phase that affects **every** deployment you
have done so far, and it is the most important thing in this document.

**`npm run db:push` deletes all your tenant security rules.**

Measured on a real database:

```
before  npm run db:push  ->  25 tables protected,  25 policies
after   npm run db:push  ->   0 tables protected,   0 policies
```

The tool compares your database against the code's schema and removes
anything it does not recognise. Your security rules live in a SQL file, not
in that schema, so it treats them as junk and deletes them.

**Your app keeps working perfectly afterwards.** Every page loads. Nothing
errors. The only difference is that your customers could read each other's
data, and nothing tells you.

**You have not been harmed by this**, because every deployment guide has told
you to run `ALL-IN-ONE-SETUP.sql` *after* `db:push` — which puts everything
back. The danger is doing a "quick schema change" on its own some day and
skipping that step.

So from now on the rule is:

> **`db:push` → run the SQL file → `npm run db:verify`. Always all three.**

There is a new command for that last step. It checks your live database and
tells you plainly whether you are protected.

---

## What changed in plain terms

Your dashboard is rebuilt. It now shows:

- **Four headline figures** — assets, contracts, contract value, and how many
  contracts expire in the next 30 days
- **A 30-day ledger chart** — debits against credits, day by day
- **A portfolio donut** — your assets broken down by status
- **A contract pipeline** — how many are at each stage
- **Recent activity** — who did what in the last 24 hours
- **Quick actions** — one click to the things you do most

The page loads in pieces rather than all at once, so you see something
immediately instead of a blank screen while the financial totals are
calculated.

---

## Before you start

About **20 minutes**.

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

Recharts was already installed in Phase 5, so nothing new is added — but this
keeps everything in step:

```bash
npm install
```

Confirm the charting library is present:

```bash
npm ls recharts
```

You should see `recharts@2.15.4`.

---

## Step 3 — Update the database schema

Phase 10 adds no new tables — only views. But run this so your schema is in
step:

```bash
npm run db:push
```

Answer `y` if asked.

**When it finishes it now prints a warning.** That warning is real. Do not
skip the next step.

---

## Step 4 — Apply the security rules AND the new views

**This step is mandatory.** It does two things: it puts back the security
rules that Step 3 just deleted, and it creates the three new analytics views.

In the Neon console (or whichever Postgres console you use), open a SQL
editor and run the whole of:

```
SQL-FILES/ALL-IN-ONE-SETUP.sql
```

The file is safe to run repeatedly.

### Check the output

Look for these two lines near the bottom:

```
PASS: all 3 analytics views run with security_invoker
Check 1  → 25 tables, every one `true`
```

**The `security_invoker` line matters more than it looks.** A database view
normally runs with the permissions of whoever created it — which would mean
your dashboard showing *every customer's* assets and cash added together,
presented to each of them as their own. Nothing would error. The numbers
would just be wrong in the most damaging possible way.

`security_invoker` is what makes each view respect who is asking.

---

## Step 5 — Verify you are actually protected

This is the new command, and it is the one that gives you a straight answer:

```bash
npm run db:verify
```

You want to see:

```
✅ Row-Level Security enabled AND forced
✅ Tenant isolation policies present
✅ Policies cover writes (WITH CHECK)
✅ Analytics views run with security_invoker
✅ Financial and evidence triggers installed
✅ Append-only evidence tables

  ✅ ALL CHECKS PASSED — tenant isolation is in force.
```

If anything shows ❌, **stop**. Re-run Step 4 and try again. Do not serve
traffic with a failing check.

> You may see one ⚠️ saying the connected role is a superuser. That is
> expected when you run this from an admin console — it is telling you that
> *this connection* bypasses the rules, not that your app does.

**Run this command after every future schema change.** It is the only way to
know, because the failure has no other symptom.

---

## Step 6 — Check the code compiles

```bash
npm run typecheck
```

**Expected output: nothing at all.**

---

## Step 7 — Run the tests

```bash
npm run test:ui
```

Expected: `Tests  102 passed (102)`.

---

## Step 8 — Build it the way Vercel will

```bash
npm run build
```

You should end with a route table and `✓ Compiled successfully`, with **28
routes**.

Look at the `/dashboard` line — around **233 kB**. That is the charting
library, and it loads **only on that page**. Every other route, including
your public client portal, is unchanged. That was checked deliberately:
charting libraries have a reputation for bloating an entire application, and
this one does not, because it is only pulled in where it is used.

---

## Step 9 — Commit and push

```bash
git add .
git commit -m "Phase 10: executive dashboards and financial analytics (v0.10.0-alpha)"
git push
```

---

## Step 10 — Watch the deployment

1. Open **vercel.com** and go to your project.
2. Wait for the new deployment to say **Ready**.
3. Click **Visit** and go to `/dashboard`.

---

## Step 11 — Look at it properly

Open the dashboard and check these, in order.

**The page should fill in progressively.** Headline numbers first, then the
charts. If you see grey placeholder shapes for a moment, that is correct —
they hold the space so the page does not jump as data arrives.

**The financial chart should show 30 bars**, including flat ones for days
with no transactions. Those gaps are deliberate — a chart that only drew
active days would make three transactions in a fortnight look like three
consecutive days of trading.

**Click "View as table"** on both charts. The same numbers appear as text.
This is not a nice-to-have: three of the chart colours do not have enough
contrast against a white background for a low-vision reader, so the table is
the accessible path to the same information. Please do not remove it.

**Hover a bar.** The tooltip shows exact amounts. The bars themselves are
drawn with rounded numbers because pixels are approximate; every figure you
*read* is exact.

**Check the totals against `/accounting`.** The dashboard's 30-day debits
should reconcile exactly with your ledger. If they ever disagree, that is a
bug worth reporting immediately — they are computed from the same rows.

---

## What is still outstanding

| Item | Why it matters | Effort |
|---|---|---|
| **Run `ALL-IN-ONE-SETUP.sql`** | Nothing is protected until this runs | 5 min |
| **Run `npm run db:verify` after every schema change** | The only way to detect dropped policies | 10 sec |
| Prefer `db:generate` over `db:push` in production | `push` deletes policies; `generate` gives you a file to review | — |
| Enable branch protection on `main` | Without it, CI can go red and the merge still happens | 2 min |
| Rate limiting on the portal (SEC-020) | Unauthenticated endpoint costs invocations when abused | Small |
| Upgrade to Vercel Pro | **Required before your first paying customer** | $20/mo |

---

## If something goes wrong

**Dashboard shows zeros everywhere** — most likely the analytics views were
not created. Re-run Step 4 and look for the `PASS: all 3 analytics views`
line.

**Dashboard shows numbers that look too big** — stop and run
`npm run db:verify` immediately. If the `security_invoker` check fails, you
are seeing other tenants' data aggregated into yours. Re-run Step 4.

**"Recent activity" says you lack permission** — that is correct behaviour,
not a fault. The audit log needs the `audit:read` permission, which most
roles do not have. Check Settings → Team.

**Charts are blank but the table view works** — a rendering problem rather
than a data problem. Try a hard refresh (`Cmd + Shift + R`); if it persists,
send me a screenshot and the browser console output.

**`npm run db:verify` says "0 tables protected"** — you ran `db:push` without
Step 4. Run the SQL file now.
