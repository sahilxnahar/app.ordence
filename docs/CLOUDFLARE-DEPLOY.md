# Putting Ordence live at app.ordence.com

**A step-by-step guide. No prior deployment experience assumed.**
**Version:** v0.31.0-alpha · Cloudflare Workers

---

## What you are about to do

Six things, in order. Roughly 45 minutes if nothing surprises you.

1. Create a Cloudflare account and turn on Workers Paid (₹420 / $5 a month)
2. Create two storage buckets
3. Create a database (Neon — free to start)
4. Create login keys (Clerk — free to start)
5. Set up the security rules in the database
6. Deploy, and point app.ordence.com at it

**You will be typing commands into a Terminal window.** Every command is
given in full. Copy the whole line, paste it, press Enter.

---

## 🛑 STOP — read these three things first

**1. Workers *Paid* is required. Not the free plan.**

The free plan allows 10 milliseconds of processing per page. Rendering a
CRM page takes 10–20. **Free is not a cheaper option, it is a
non-functional one** — pages will simply fail. It is $5/month flat.

**2. Do not skip Step 5.**

Step 5 applies the security rules to your database. Without it the
application runs *perfectly* — every page loads, nothing errors — and
every customer can read every other customer's data. There is no visible
symptom. This is the single most important step in this document.

**3. Nothing here is reversible by guessing.**

If a command fails, stop and send me the exact error text. Do not try a
different command that looks similar.

---

## Before you start

Open the **Terminal** app.

- **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `PowerShell`, press Enter.

Now check you have Node.js. Type this and press Enter:

```
node --version
```

You should see something like `v22.11.0`. **The number must be 20 or
higher.** If you see "command not found", install Node.js from
<https://nodejs.org> (choose the "LTS" button), then close and reopen
Terminal.

Next, go to the project folder. If the folder is on your Desktop:

```
cd ~/Desktop/ordence
```

Then install what it needs (this takes 2–5 minutes and prints a lot):

```
npm install
```

---

## Step 1 — Cloudflare account and Workers Paid

1. Go to <https://dash.cloudflare.com/sign-up> and create an account.
2. Once signed in, click **Workers & Pages** in the left sidebar.
3. Click **Plans**, choose **Workers Paid**, and pay the $5.

> ✅ **You know it worked when:** the Workers & Pages page shows "Workers
> Paid" rather than "Workers Free".

Now connect your Terminal to that account:

```
npx wrangler login
```

A browser window opens asking you to authorise. Click **Allow**. Return
to Terminal — it will say `Successfully logged in`.

---

## Step 2 — The two storage buckets

Ordence stores two things in Cloudflare: your customers' uploaded
documents, and a page cache.

Type each of these, one at a time:

```
npx wrangler r2 bucket create ordence-documents
```

```
npx wrangler r2 bucket create ordence-cache
```

> ✅ **You know it worked when:** each prints `Created bucket ...`.

> **Why this matters beyond storage:** Cloudflare's terms permit serving
> files through their network *provided the files are hosted on a
> Cloudflare service*. R2 is one. Storing documents anywhere else and
> serving them through Cloudflare would breach that. Using R2 keeps you
> compliant without thinking about it again.

---

## Step 3 — The database

Ordence needs a PostgreSQL database. Neon is free to start and is what
the application is built against.

1. Go to <https://neon.tech> and sign up.
2. Create a project. Name it `ordence`.
3. **Choose the region closest to your customers** — for India, pick
   Singapore (`ap-southeast-1`) or Mumbai if offered.
4. When it finishes, you land on a **Connection Details** panel. Copy the
   connection string. It looks like:

```
postgresql://ordence_owner:AbC123xyz@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/ordence?sslmode=require
```

**Keep this window open.** You need this string twice — in Step 5 and
Step 6.

> ⚠️ That string is a password. Do not paste it into email, chat, or
> anywhere public.

---

## Step 4 — Login keys

Ordence uses Clerk to handle sign-in.

1. Go to <https://clerk.com> and sign up.
2. Create an application. Name it `Ordence`.
3. Turn on **Email** and **Google** as sign-in options.
4. **Turn on Organizations** — left sidebar → **Organizations** → enable.
   ⚠️ This is not optional. Ordence uses one organisation per customer
   workspace; without it, nobody can sign in properly.
5. Go to **API Keys** and copy both:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — starts `pk_test_...`
   - `CLERK_SECRET_KEY` — starts `sk_test_...`

Keep these to hand.

---

## Step 5 — 🛑 The security rules

**This is the step that must not be skipped.** Read the warning at the
top of this document again if you skipped it.

You need a tool called `psql` to talk to the database.

- **Mac:** `brew install libpq` then `brew link --force libpq`
- **Windows:** install from <https://www.postgresql.org/download/windows/>

Now set your database connection string. Replace the part in quotes with
what you copied in Step 3:

```
export DATABASE_URL="postgresql://ordence_owner:...paste yours here..."
```

*(On Windows PowerShell use `$env:DATABASE_URL="..."` instead.)*

Now create the tables:

```
npx drizzle-kit push
```

Then apply the security rules — **run these in exactly this order**:

```
psql "$DATABASE_URL" -f SQL-FILES/ALL-IN-ONE-SETUP.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0017_change_log.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0018_phase23_workflows.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0019_phase24_dynamic_objects.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0020_phase25_views.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0021_phase32_gst.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0022_phase29_admin_console.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0023_phase33_purchases.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0024_phase34_gstr2b.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0025_phase36_tds.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0026_phase37_tally.sql
```
```
psql "$DATABASE_URL" -f SQL-FILES/0027_phase38_receivables.sql
```

Each one prints a lot of output ending in lines saying **PASS**.

> 🛑 **If you see the word FAIL anywhere, stop.** Do not continue to
> Step 6. Send me the output.

Now prove it worked:

```
npm run db:verify
```

> ✅ **You know it worked when** the last line reads:
> `✅ ALL CHECKS PASSED — tenant isolation is in force.`
>
> 🛑 **If it says any check failed, do not deploy.** The most common
> cause is running the files out of order. Re-run them from the top.

---

## Step 6 — Deploy

First, tell Cloudflare your secrets. Run each command; it will prompt you
to paste the value, then press Enter. **Nothing appears as you paste —
that is normal.**

```
npx wrangler secret put DATABASE_URL
```
*(paste the Neon string from Step 3)*

```
npx wrangler secret put DATABASE_URL_UNPOOLED
```
*(paste the same Neon string)*

```
npx wrangler secret put CLERK_SECRET_KEY
```
*(paste the `sk_test_...` key from Step 4)*

```
npx wrangler secret put NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```
*(paste the `pk_test_...` key from Step 4)*

```
npx wrangler secret put PLATFORM_ADMIN_EMAILS
```
*(type your own email address — this makes you the platform administrator)*

Now deploy:

```
npm run cf:deploy
```

This takes 3–6 minutes. It builds the application and uploads it.

> ✅ **You know it worked when** it prints a URL ending in
> `.workers.dev` — something like
> `https://ordence.your-account.workers.dev`
>
> **Open that URL in a browser. You should see Ordence.**

---

## Step 7 — Your own domain

1. In the Cloudflare dashboard, click **Add a site**, enter `ordence.com`,
   and follow the instructions to point your domain's nameservers at
   Cloudflare. *(This is done at whoever you bought ordence.com from.)*
   It can take a few hours to take effect.

2. Once ordence.com shows as **Active**, go to
   **Workers & Pages → ordence → Settings → Domains & Routes → Add**.

3. Choose **Custom domain** and enter:

```
app.ordence.com
```

Cloudflare creates the DNS record for you.

4. Finally, tell the application its own address:

```
npx wrangler secret put NEXT_PUBLIC_APP_URL
```
*(type `https://app.ordence.com`)*

```
npx wrangler secret put NEXT_PUBLIC_ROOT_DOMAIN
```
*(type `app.ordence.com`)*

Then redeploy so it picks them up:

```
npm run cf:deploy
```

> ✅ **You know it worked when** <https://app.ordence.com> loads Ordence
> with a padlock in the address bar.

---

## What works, and what does not, on this deployment

Being straight with you, because a guide that overstates is worse than
one that admits gaps.

### Working

Everything you have seen built: the sales pipeline, inventory and
bookings, the workflow builder, custom record types, saved views, the
admin console, GST, purchases and input tax credit, GSTR-2B
reconciliation, TDS, Tally export, and demand notices.

### Degraded, deliberately

**Background jobs run inside the request rather than in the background.**

Document processing and notification sending used to run on a separate
queue. Cloudflare Workers cannot hold the kind of long-lived connection
that needed, so for now those jobs run immediately, as part of whichever
click triggered them.

What that means in practice: uploading a large document may take a few
seconds longer. Nothing is dropped — the code refuses to report success
for work that did not happen. When volume justifies it, this moves to
Cloudflare Queues, which is a small change.

### Not yet built

- Email sending is not configured (Resend key not set)
- Payments are not configured (Razorpay plans not created — nothing is
  purchasable yet)
- The customer-facing support-consent page

---

## If something goes wrong

**"command not found: npx"** — Node.js is not installed. Go back to
*Before you start*.

**"You need to login first"** — run `npx wrangler login` again.

**A page loads but says "Something went wrong"** — a secret is missing or
wrong. See exactly what the server saw:

```
npx wrangler tail
```

Leave that running, reload the page in your browser, and read what
appears. Send it to me.

**"ALL CHECKS PASSED" never appeared in Step 5** — do not deploy. Send me
the output of `npm run db:verify`.

---

## What this costs

| | Monthly |
|---|---|
| Cloudflare Workers Paid | $5 |
| R2 storage (first 10 GB) | Free |
| R2 bandwidth | **$0 — no egress fees** |
| Neon database (free tier) | $0 until you outgrow it |
| Clerk (first 10,000 users) | $0 |
| **Total to start** | **$5/month** |

For comparison, the Vercel path this replaces was $20 per user per month
plus bandwidth charges.
