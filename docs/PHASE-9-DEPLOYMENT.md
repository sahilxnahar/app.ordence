# Phase 9 Deployment — v0.9.0-alpha

**External Client Portal & Secure Approvals**
**Date:** 31 July 2026

---

## What changed in plain terms

Your clients can now **open and sign contracts without an account**.

You generate a link, send it to them, and they click it. They see the
document, its attachments, and a button to approve and sign. No password, no
sign-up, no licence cost for them.

Three things are worth understanding before you use it.

**1. The link IS the password.** Anyone holding that URL can open the
document. That is what makes it convenient and what makes it worth treating
carefully. Links expire (14 days by default), can be revoked instantly, and a
signing link works exactly once.

**2. You will see each link only once.** We store a one-way scramble of the
link, not the link itself — so if our database were ever stolen, the thief
gets nothing usable. The trade-off is that we genuinely cannot show it to you
again. Copy it when it appears; if you lose it, generate a new one (which
switches the old one off).

**3. Signing is a separate permission.** Sharing a document to read and
letting someone legally sign it are different things, so they need different
permissions. If "View and sign" is missing from the dropdown, your role does
not include contract approval.

---

## Before you start

About **15 minutes**. Nothing here touches your existing data.

> **If a command fails,** stop and read the error before running the next one.
> Send me the message rather than re-running.

---

## Step 1 — Open a terminal in your project

Press `Cmd + Space`, type `Terminal`, press Enter. Then:

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

Phase 9 adds no new packages, but this keeps everything in step:

```bash
npm install
```

---

## Step 3 — Create the two new database tables

Phase 9 adds `portal_links` (the client links) and `contract_signatures`
(the signature record).

```bash
npm run db:push
```

Answer `y` if it asks for confirmation. You should see
`CREATE TABLE "portal_links"` and `CREATE TABLE "contract_signatures"` in the
output.

If you would rather review the SQL before it runs, generate it first:

```bash
npm run db:generate
```

That writes a migration file under `drizzle/` which you can read, then apply
with `npm run db:push`.

---

## Step 4 — Apply the security rules

**This step is not optional.** The tables exist after Step 3, but nothing
protects them until this runs.

In the Neon console (or whichever Postgres console you use), open a SQL editor
and run the whole of:

```
SQL-FILES/ALL-IN-ONE-SETUP.sql
```

The file is **idempotent** — running it again is safe and expected. It now
includes Sections 14–17, which cover the portal tables.

If you would rather apply only the new part, run
`SQL-FILES/0007_phase9_portals.sql` instead. The all-in-one file is the safer
choice if you are unsure whether every earlier phase was applied.

### Check it worked

At the bottom of the output is the verification block. **Check 1 must now list
25 tables, every one showing `true`** — 23 from before, plus `portal_links`
and `contract_signatures`.

If it shows 23, the tables did not exist when you ran the file. Go back to
Step 3.

---

## Step 5 — Check the code compiles

```bash
npm run typecheck
```

**Expected output: nothing at all.** TypeScript prints errors and stays silent
on success.

---

## Step 6 — Run the tests

```bash
npm run test:ui
```

Expected: `Tests  102 passed (102)`.

These include the two checks this phase had to prove: that link generation
uses a cryptographically secure randomiser rather than `Math.random()`, and
that a malformed or hostile token is rejected before it ever reaches the
database.

---

## Step 7 — Build it the way Vercel will

```bash
npm run build
```

One to two minutes. You should end with a route table and
`✓ Compiled successfully`.

Count the routes: there should be **28**. Phase 8 had 26. The two new ones are
`/portal/[token]` and `/portal/[token]/documents/[documentId]`.

If this fails, **do not push**. Vercel runs this exact command.

---

## Step 8 — Confirm your app URL is set on Vercel

This one catches people out. Portal links are built from
`NEXT_PUBLIC_APP_URL`. If it is wrong or missing, your clients receive links
pointing at `localhost:3000`.

1. Go to **vercel.com** → your project → **Settings** → **Environment
   Variables**.
2. Find `NEXT_PUBLIC_APP_URL`.
3. It must be your real, public, **https** address — e.g.
   `https://ameya-heights-os.vercel.app` or your custom domain.
4. No trailing slash.

If you change it, you must **redeploy** — environment variables are read at
build time.

---

## Step 9 — Commit and push

```bash
git add .
git commit -m "Phase 9: external client portal and secure approvals (v0.9.0-alpha)"
git push
```

If `git push` asks for a password, use a **personal access token**, not your
GitHub password.

---

## Step 10 — Watch the deployment

1. Open **vercel.com** and go to your project.
2. A new deployment appears, marked **Building**.
3. Wait two to four minutes.
4. When it says **Ready**, click **Visit**.

---

## Step 11 — Test it properly

This is the part worth doing carefully, because it involves something you
cannot undo.

### Generate a view-only link first

1. Open any contract.
2. Scroll to **Client access**.
3. Click **Generate client link**.
4. Leave "What can they do?" as **View only**.
5. Set the expiry to **1 day** for this test.
6. Click **Create link**.
7. **Copy the link immediately** — the panel warns you, and it means it.

### Open it the way a client would

Paste the link into a **private/incognito window**, where you are not signed
in.

You should see the contract, cleanly branded, with no navigation into your
application — and **no sign-in prompt**. That is the whole point of this
phase.

Check the bottom: it should say the document was shared for review, with no
signing button. That is the view-only permission working.

### Now revoke it and try again

1. Back in your normal window, click **Revoke** on that link.
2. Refresh the incognito tab.

You should get **"This link is no longer available"**. Revocation takes effect
on the very next request — there is no cache to wait for.

### Test signing

Generate a second link, this time **View and sign**. Note the warning that
appears — it is there because this delegates real authority.

Open it in incognito, type a name, tick the consent box, and click
**Approve & Sign**.

Then check three things:

1. The portal shows a confirmation and the link closes.
2. **Refresh that same URL** — it must now refuse. A signing link works once.
3. Back in your app, the contract status is **Signed**, and a **Signature
   record** section shows the name, time, IP address and a content hash.

That content hash is what makes this evidence rather than a claim: it records
exactly what was shown to the signer, so a later edit to the contract becomes
detectable.

---

## Emailing links to clients

On the create form, tick **Email this link to the recipient**. The email uses
the `ContractReadyEmail` template from Phase 8, now carrying the secure portal
URL instead of an internal app link — a client clicking the old one would have
hit a sign-in page they could never pass.

The recipient address comes from the contract's linked contact. If the tick box
is disabled, fill in the recipient email field first.

> Reminder from Phase 8: until you verify your own domain in Resend, email
> only delivers to the address you signed up with.

---

## What is still outstanding

| Item | Why it matters | Effort |
|---|---|---|
| **Run `ALL-IN-ONE-SETUP.sql`** | The portal tables are unprotected until this runs | 5 min |
| Confirm `NEXT_PUBLIC_APP_URL` | Wrong value = links pointing at localhost | 2 min |
| Enable branch protection on `main` | Without it, CI can go red and the merge still happens | 2 min |
| Rate limiting on the portal (SEC-020) | An unauthenticated endpoint costs invocations when abused | Small |
| Verify your domain in Resend | Otherwise you can only email yourself | 15 min + DNS |
| Upgrade to Vercel Pro | **Required before your first paying customer** | $20/mo |

---

## Things worth knowing before a client uses this

**An emailed link can be forwarded.** If your client forwards it to a
colleague, that colleague can open — and if it is a signing link, sign — the
document. The email says so plainly, and links expire, but the honest position
is that this is as secure as the recipient's inbox.

**This is an electronic record of assent, not a digital signature in the
cryptographic sense.** There is no certificate and no private key held by the
signer. For most commercial agreements in India that is fine and normal; for a
high-value or contested matter, a provider with identity verification is
worth the cost. This distinction is written into the contract page rather than
hidden.

**A signature cannot be edited or deleted — by anyone.** The database refuses
it, including for an administrator. If something is wrong, the remedy is to
void the contract and sign a new one, so both records stay visible. That is
deliberate.

---

## If something goes wrong

**Link says "no longer available" immediately** — check the expiry you chose,
and that you copied the whole URL. The token is 64 characters; a truncated
paste fails the shape check and is refused before the database is even
queried.

**Client sees a sign-in page** — `/portal` is not being treated as public.
Confirm the deployment includes the updated `middleware.ts`.

**Links point at localhost** — `NEXT_PUBLIC_APP_URL` is wrong on Vercel. Fix
it and redeploy. Links already sent will keep pointing at localhost; generate
new ones.

**"Only contracts can be signed"** — you generated a signing link for an
asset. Assets can be shared to view, but there is nothing to execute.

**"View and sign" missing from the dropdown** — your role lacks
`contracts:approve`. Check Settings → Team.

**Signing fails with "already been signed"** — working as intended. A signing
link works exactly once, and this message also appears if two submissions
raced.
