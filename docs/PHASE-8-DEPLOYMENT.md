# Phase 8 Deployment — v0.8.0-alpha

**Cloud Storage, Document Assembly & Transactional Email**
**Date:** 31 July 2026

---

## What changed in plain terms

Your CRM can now **hold files and send email**.

You can drag a signed agreement onto a contract and it uploads. You can email
that contract to your client with one button. When someone closes an accounting
period, your finance contacts get told.

Both of these are the first features that reach **outside** your system, so both
got extra scrutiny. Two things are worth knowing before you start:

1. **Files are stored privately.** Nobody can open a document by its URL, even
   if they somehow get hold of it. Every download goes through your app, which
   checks who is asking and which workspace they belong to.
2. **You cannot un-send an email.** The "Send to client" button therefore asks
   you to confirm, and shows you the exact address first.

---

## Before you start

You need about **25 minutes**, most of it waiting. Nothing here can damage your
existing data.

> **If a command fails,** stop and read the error before running the next one.
> Send me the message rather than running the same command again.

---

## Step 1 — Open a terminal in your project

On a Mac press `Cmd + Space`, type `Terminal`, press Enter. Then:

```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
```

Confirm you are in the right place:

```bash
pwd
```

It should end in `ameya-heights-os`.

---

## Step 2 — Install the new packages

```bash
npm install
```

This installs `@vercel/blob` (file storage) and `resend` (email), along with
everything else. Takes one to three minutes. Warnings scrolling past are normal;
what matters is that it finishes without `ERR!`.

Check they arrived:

```bash
npm ls @vercel/blob resend
```

Both should show a version number.

---

## Step 3 — Create your file storage

This is done in the Vercel website, not the terminal.

1. Go to **vercel.com** and open your project.
2. Click the **Storage** tab at the top.
3. Click **Create Database**, then choose **Blob**.
4. Name it `ameya-documents` and click **Create**.
5. Vercel will offer to connect it to your project — **say yes**.

That last step matters: connecting the store automatically adds
`BLOB_READ_WRITE_TOKEN` to your project's environment variables, which is what
your app uses to authorise uploads.

To confirm it worked, go to **Settings → Environment Variables** and check that
`BLOB_READ_WRITE_TOKEN` is listed.

> **Cost:** the Hobby plan includes 1 GB of storage and 10 GB of bandwidth per
> month at no charge. For a few hundred PDFs that is comfortably enough. You are
> not being asked for a card here.

---

## Step 4 — Create your email account

1. Go to **resend.com** and sign up (the free tier allows 3,000 emails a month
   and 100 a day — plenty to start).
2. Once signed in, click **API Keys** in the left sidebar.
3. Click **Create API Key**. Name it `ameya-production`.
4. Choose **Sending access** — not Full access. It only needs to send.
5. **Copy the key now.** It starts with `re_` and Resend will never show it to
   you again. If you lose it, delete the key and make a new one.

### About the sending address

Out of the box your emails come from `onboarding@resend.dev`. This works with no
setup at all — but **Resend only delivers from that address to the email you
signed up with.** It is meant for testing.

To email real clients you must verify your own domain:

1. In Resend, click **Domains** → **Add Domain**.
2. Enter your domain, e.g. `ameyaheights.com`.
3. Resend shows you three DNS records to add (SPF, DKIM, and a return-path).
4. Add them wherever your domain is managed — GoDaddy, Cloudflare, Route 53.
5. Click **Verify**. It usually takes 15 minutes; occasionally a few hours.

You can do this later. Until you do, only your own inbox will receive anything.

---

## Step 5 — Add the keys locally

Open `.env.local` in your project folder in any text editor and add these lines
at the bottom:

```bash
# --- File storage (Phase 8) ---
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_xxxxxxxxxxxxx"

# --- Email (Phase 8) ---
RESEND_API_KEY="re_xxxxxxxxxxxxx"
RESEND_FROM_EMAIL="Ameya Heights <notifications@yourdomain.com>"
FINANCE_ALERT_EMAILS="you@yourdomain.com"
```

Replace each `xxxxx` with your real values.

- `BLOB_READ_WRITE_TOKEN` — copy from Vercel → Settings → Environment Variables
- `RESEND_API_KEY` — the `re_...` key from Step 4
- `RESEND_FROM_EMAIL` — leave this line out until your domain is verified
- `FINANCE_ALERT_EMAILS` — who receives period-close notices; comma-separate
  several

> ⚠️ **`.env.local` must never be committed to git.** It is already listed in
> `.gitignore`, and the CI pipeline fails the build if an environment file is
> ever tracked. Do not work around that.

---

## Step 6 — Update the database

The new `documents` table needs creating, and its security policies applying.

**First**, create the table:

```bash
npm run db:push
```

Answer `y` if it asks for confirmation. You should see
`CREATE TABLE "documents"` in the output.

**Then** apply the security rules. In the Neon console (or whichever Postgres
console you use), open a SQL editor and run the whole of:

```
SQL-FILES/ALL-IN-ONE-SETUP.sql
```

This file is **idempotent** — running it again is safe and expected. It now
includes Section 13, which locks down the `documents` table.

If you would rather apply only the new part, run `SQL-FILES/0006_phase8_storage.sql`
instead. The all-in-one file is the safer choice if you are unsure whether every
earlier phase was applied.

### Check it worked

At the bottom of the output you should see the verification block. **Check 1 must
now list 23 tables, every one showing `true`** — 22 from before, plus `documents`.

If it shows 22, the `documents` table did not exist when you ran the file. Go
back and run `npm run db:push` first.

---

## Step 7 — Check the code compiles

```bash
npm run typecheck
```

**Expected output: nothing at all.** TypeScript prints errors and stays silent on
success.

---

## Step 8 — Run the tests

```bash
npm run test:ui
```

Expected: `Tests  79 passed (79)`.

These include the two checks this phase was required to prove: that the upload
token issuer refuses anyone without a valid session, and that the email templates
cannot be turned into an attack by a malicious contract title.

---

## Step 9 — Build it the way Vercel will

```bash
npm run build
```

One to two minutes. You should end with a route table and
`✓ Compiled successfully`.

Count the routes: there should be **26**. Phase 7 had 22.

If this fails, **do not push**. Vercel runs this exact command, so a failure here
is a failure there — the difference is that here nobody else sees it.

---

## Step 10 — Add the keys to Vercel

Your local `.env.local` is not uploaded anywhere. Vercel needs its own copy.

1. Go to **vercel.com** → your project → **Settings** → **Environment Variables**.
2. `BLOB_READ_WRITE_TOKEN` should already be there from Step 3. If not, add it.
3. Click **Add New** and add:
   - Name: `RESEND_API_KEY`, Value: your `re_...` key
   - Name: `RESEND_FROM_EMAIL`, Value: your verified sender
   - Name: `FINANCE_ALERT_EMAILS`, Value: your finance contacts
4. For each one, tick **Production**, **Preview** and **Development**.
5. Click **Save**.

> Environment variables are only read when a deployment is built. Adding them
> now means they take effect on the deployment you are about to push — but if
> you add one later, you must **redeploy** for it to be picked up. This catches
> almost everybody once.

---

## Step 11 — Commit and push

```bash
git add .
git commit -m "Phase 8: cloud storage, document vault and transactional email (v0.8.0-alpha)"
git push
```

If `git push` asks for a password, use a **personal access token**, not your
GitHub password. Generate one at GitHub → Settings → Developer settings →
Personal access tokens.

---

## Step 12 — Watch the deployment

1. Open **vercel.com** and go to your project.
2. A new deployment appears, marked **Building**.
3. Wait two to four minutes.
4. When it says **Ready**, click **Visit**.

---

## Step 13 — Test it for real

Sign in, then:

### Upload a file

1. Go to `/contracts` and open any contract. (No contracts yet? The Phase 5
   seeder creates some: `npm run seed:phase5`.)
2. Scroll to **Attached documents**.
3. Drag a PDF onto the dashed box.
4. You should see a progress bar, then the file in the list below.

**Try a large file too** — anything over 5 MB. This is the thing worth proving:
Vercel refuses any request body over 4.5 MB, so if uploads worked the obvious
way, a 10 MB agreement would fail. It works because the file goes from your
browser straight to storage and never passes through the server.

### Try to break it

Rename a `.exe` to `.pdf` and try uploading it. It should be refused — the check
is on the file's actual type, not its name.

### Download it

Click **Download**. The file should open.

Now copy that download link and paste it into a private browsing window where
you are not signed in. **It should refuse.** That is the private-storage design
working: there is no URL anywhere that gives access without a session.

### Send an email

1. On a contract with a linked client contact, click **Send to client**.
2. The dialog shows you the exact address. Confirm it is right.
3. Add a covering note if you like, then click **Send now**.
4. The contract moves to **Counterparty review**.

If the button is greyed out, hover it — it will tell you why. Usually either no
contact is linked, or `RESEND_API_KEY` is not set on Vercel.

> Remember: until your domain is verified in Resend, delivery only works to the
> address you signed up with. A "sent" confirmation with nothing arriving in a
> client's inbox is almost always this.

---

## What is still outstanding

| Item | Why it matters | Effort |
|---|---|---|
| **Run `ALL-IN-ONE-SETUP.sql`** | **Nothing is protected until this runs.** Still the most important item. | 5 min |
| Verify your domain in Resend | Until then you can only email yourself | 15 min + DNS |
| Enable branch protection on `main` | Without it, CI can go red and the merge still happens | 2 min |
| Delete the `_to_delete/` folder | Stale files from earlier phases | 1 min |
| Upgrade to Vercel Pro | **Required before your first paying customer** — Hobby forbids commercial use | $20/mo |

---

## Costs, honestly

Everything in this phase stays inside free tiers for a long while:

| Service | Free allowance | What that means for you |
|---|---|---|
| Vercel Blob | 1 GB stored, 10 GB bandwidth/month | Roughly 500 typical PDFs |
| Resend | 3,000 emails/month, 100/day | Comfortable for a small practice |
| Neon Postgres | 0.5 GB | The `documents` table stores only metadata — a few hundred bytes per file |

The first thing you would outgrow is Blob storage, and only once you are storing
serious volumes of scanned documents. Vercel Blob then charges per GB rather than
jumping to a plan, so it grows gradually rather than as a cliff.

---

## If something goes wrong

**"File storage is not configured"** — `BLOB_READ_WRITE_TOKEN` is missing on
Vercel, or you added it after the last deployment. Add it and redeploy.

**"Email is not configured for this deployment"** — same thing for
`RESEND_API_KEY`.

**Upload reaches 100% then fails** — the file uploaded but the database record
did not save. Almost always the `documents` table has not been created; run
`npm run db:push`.

**Download returns "Not found" for a file you can see** — the row exists but the
object is missing from storage. This happens if the store was recreated. The row
can be deleted safely.

**Email says sent but nothing arrives** — check Resend's **Logs** tab, which
shows delivery status per message. If it says delivered, check spam. If you have
not verified a domain, this is expected for any address other than your own.

**"Your role does not include permission…"** — working as intended. Uploading
requires `contracts:update`. Check your role under Settings → Team.
