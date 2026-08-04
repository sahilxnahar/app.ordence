# Going Live — The Complete Checklist

**Version:** v0.31.0-alpha · Phase 31 (deploy hardening)
**Audience:** anyone. No programming knowledge is assumed.
**Time:** about two hours, spread over two sittings.

---

## What this document is

`DEPLOYMENT-GUIDE.md` gets the software **running**. This one gets it ready to
hold **other people's money and other people's customers**. They are not the
same job, and the gap between them is where most small SaaS businesses get hurt.

Everything below is a thing that must be true before the first real customer
signs in. Each step says what to do, exactly what to type, and — the part that
matters — **how you know it worked**.

**Legend:** 💻 = type in Terminal · 🌐 = do in a web browser · 🧑‍💻 = needs someone
who can run a database command

---

## Before you start

Collect these. If any is missing, stop and get it — starting without it means
finishing halfway, which is the worst state to leave a deployment in.

| # | What | Where it comes from |
|---|---|---|
| 1 | The production **database connection string** | Neon → your project → Connection Details |
| 2 | **Clerk dashboard** access, with permission to change settings | clerk.com |
| 3 | **Vercel** access to the project's Settings | vercel.com |
| 4 | **GitHub** admin on the repository | github.com |
| 5 | A **Razorpay** account, activated (KYC done) | razorpay.com |
| 6 | Someone who can run a `psql` command | your engineer, or you after Part 1 |

Put the database connection string in your Terminal once, so every command
below can use it:

💻
```bash
export DATABASE_URL="postgresql://YOUR-NEON-CONNECTION-STRING-HERE"
```

> ⚠️ Use the **direct** (non-pooled) string here — the one **without** `-pooler`
> in it. Schema changes through a connection pooler can be applied to a
> connection that is then handed to somebody else mid-way. The pooled string is
> for the application; the direct one is for this document.

Check it works before going further:

💻
```bash
psql "$DATABASE_URL" -c "SELECT current_database(), current_user;"
```

You want one row back naming your database. If you get `command not found:
psql`, install it: `brew install postgresql@16` on a Mac.

---

# PART 1 — Build the database, in order

> ### 🔴 Read this before running anything
>
> The tables and the **security rules** are created by two different things.
>
> `npm run db:push` creates the **tables**. It also **DELETES every security
> policy**, because it compares the database against our table definitions and
> removes anything it does not recognise — and our policies are not in there.
> Measured on a real database during Phase 10:
>
> ```
> before db:push  →  25 tables protected, 25 policies
> after  db:push  →   0 tables protected,  0 policies
> ```
>
> **The application keeps working perfectly.** Every page loads. Every save
> succeeds. The only difference is that customers can now read each other's
> data, and nothing anywhere says so.
>
> That is why the SQL files come after, every time, without exception, and why
> Part 2 exists.

## Step 1.1 — Create the tables

💻
```bash
npm run db:push
```

If it asks for confirmation, answer **Yes**. It prints the tables it creates and
finishes with a reminder to run the SQL files.

## Step 1.2 — Create the application's database user

The application must **not** connect to the database as an administrator. A
PostgreSQL superuser ignores every security policy in the product — all of them,
completely — so an application connecting as one is an application with no
tenant isolation at all, however much SQL you run.

🧑‍💻 Run this once. **Change the password** to something long and random, and keep
it: it goes into `DATABASE_URL` in Part 6.

💻
```bash
psql "$DATABASE_URL" <<'SQL'
CREATE ROLE ordence_app LOGIN PASSWORD 'CHANGE-THIS-TO-A-LONG-RANDOM-PASSWORD'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ordence_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ordence_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ordence_app;
SQL
```

`NOSUPERUSER NOBYPASSRLS` are the two words that make everything else in this
document mean something.

> On Neon your project may already connect as an owner account called something
> like `neondb_owner`. Create `ordence_app` anyway and point the application at
> it. An owner account is exempt from far too much.

> ⚠️ **This step comes BEFORE the SQL files, and the order is not cosmetic.**
> The grant above is deliberately broad, and each SQL file then narrows it —
> taking away the ability to reprice your own plans, to alter payment records,
> and to delete the log of what your support staff did. Run it the other way
> round and the broad grant lands last and quietly undoes all of them. Part 2
> catches this exact mistake; it was found by doing it.

## Step 1.3 — Apply the SQL files, in this exact order

**Seven files. This order. Do not skip one because "it looked like it was
already there".** Each depends on things the previous ones create.

💻
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/ALL-IN-ONE-SETUP.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0017_change_log.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0018_phase23_workflows.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0019_phase24_dynamic_objects.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0020_phase25_views.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0021_phase32_gst.sql
```
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/0022_phase29_admin_console.sql
```

Or, if you would rather run one command and have it stop at the first problem:

💻
```bash
for f in SQL-FILES/ALL-IN-ONE-SETUP.sql \
         SQL-FILES/0017_change_log.sql \
         SQL-FILES/0018_phase23_workflows.sql \
         SQL-FILES/0019_phase24_dynamic_objects.sql \
         SQL-FILES/0020_phase25_views.sql \
         SQL-FILES/0021_phase32_gst.sql \
         SQL-FILES/0022_phase29_admin_console.sql; do
  echo "── $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || { echo "STOPPED AT $f"; break; }
done
```

### What each file is for

| File | What it switches on |
|---|---|
| `ALL-IN-ONE-SETUP.sql` | The Phase 1–22 baseline: tenant isolation on every table, the append-only audit trail, double-entry balance enforcement, period locking, the client portal guards, billing and payment-evidence immutability, usage metering, the platform/impersonation tables, invoicing, and the sales guarantees including **one live booking per flat** |
| `0017_change_log.sql` | The change log — records what changed and where it came from, including deletions |
| `0018_phase23_workflows.sql` | The automation engine, and the guard that stops a workflow triggering itself forever |
| `0019_phase24_dynamic_objects.sql` | Customer-defined record types, and the rule that makes an unprotected table impossible to create |
| `0020_phase25_views.sql` | Saved views, and the guards around sharing one |
| `0021_phase32_gst.sql` | GST: registrations, rates, and the rule that a corrected tax rate cannot silently restate invoices already sent |
| `0022_phase29_admin_console.sql` | The super admin console, and the re-assertion of the two privileges your own staff must never hold |

### Reading the output

Each file prints tables of results at the end. **Every line should say `PASS`.**
Some checks pass by printing *no rows at all* — they list problems, so an empty
result is the good outcome.

If any line contains `*** FAIL ***`, **stop here**. Do not continue and do not
"try it and see". Each of those lines is a protection that is not in place.

**It is safe to run any of these files twice.** They change nothing the second
time and they never delete data. If you are unsure whether one ran, run it
again.

---

# PART 2 — Prove it actually worked

This is the most important command in this document.

💻
```bash
npm run db:verify
```

## What a PASS looks like

```
✅ Row-Level Security enabled AND forced
     all 61 tables protected
✅ Tenant isolation policies present
✅ Policies cover writes (WITH CHECK)
✅ Analytics views run with security_invoker
✅ Financial and evidence triggers installed
✅ ⭐ Support impersonation cannot delete customer data
✅ Policy accessor functions present
✅ Append-only evidence tables
✅ Webhook replay protection (payment_events unique index)
✅ One live subscription per tenant
✅ ⭐ One live booking per unit
✅ Cross-tenant reference integrity
✅ No unit is promised to two buyers
✅ Every held unit can release itself
✅ Billing privileges are restricted

  ✅ ALL CHECKS PASSED — tenant isolation is in force.
```

## ⚠️ What a FAILURE means, in plain words

**It does not mean "a test is failing".** Nothing in this list has any other
symptom. The application will look completely healthy with every one of them
broken. Here is what each failure actually is:

| The line that failed | What is true if you ignore it |
|---|---|
| **Row-Level Security enabled AND forced** | Any customer can read every other customer's records. This is the whole product's central promise, and it is off. |
| **Tenant isolation policies present** | Same, for the tables named. |
| **Policies cover writes (WITH CHECK)** | A customer can write rows **into another customer's workspace**. They cannot see them afterwards; the victim can. |
| **Analytics views run with security_invoker** | Every dashboard shows every customer's totals to every other customer. No error, no clue, just wrong numbers that look right. |
| **Financial and evidence triggers installed** | The audit trail can be edited. Books can be unbalanced. Closed accounting periods can be rewritten. Signed contracts can be altered. |
| **⭐ Support impersonation cannot delete customer data** | Your own staff can delete a customer's records during a support session, and the customer has no way to see that it happened. |
| **Policy accessor functions present** | The database restore you did came from before Phase 17. Half the rules above are reading a function that no longer exists. |
| **Append-only evidence tables** | The record of what happened can be rewritten by whoever is being asked about it. |
| **Webhook replay protection** | A retried payment notification **will** be processed twice and **will** charge a customer twice. |
| **One live subscription per tenant** | A customer can hold two subscriptions and be billed for both. |
| **⭐ One live booking per unit** | Two sales reps can sell the same flat to two different buyers, and both will succeed. That is a refund, a broken relationship, and possibly a RERA complaint. |
| **Cross-tenant reference integrity** | One customer's record can point at another customer's record. Deleting a row in one workspace writes into another. |
| **No unit is promised to two buyers** | It has **already happened**, in your live data, right now. Deal with that before anything else. |
| **Billing privileges are restricted** | The application can change its own prices and alter payment records. |

### How to fix it

Nine times out of ten the cause is that somebody ran `npm run db:push` and did
not re-run the SQL files afterwards. The fix is Part 1, Step 1.3 again, in
order, followed by this command again.

If a re-run does not fix it, **do not launch**. Show the output to whoever
maintains the application.

### When to run this

- After every `npm run db:push`, without exception.
- After every database restore.
- After anything that says "permission denied" and is fixed by granting
  something.
- Once a month, on a calendar reminder, for no reason at all.

---

# PART 3 — The Clerk session token

This is a settings change in Clerk that takes two minutes and is one character
away from being a security hole.

## What it is

Clerk gives every signed-in person a small signed pass. That pass can carry
extra facts. There are two places those facts can come from and **they are not
the same**:

| Where the fact lives | Who can change it |
|---|---|
| `public_metadata` | **Only you**, from the Clerk dashboard |
| `unsafe_metadata` | **The signed-in person, from their own browser** |

The application's front door reads a fact called `platformAdmin` to decide
whether to show someone the `/platform` address at all. Taken from
`unsafe_metadata`, **any customer who signs up can set it on themselves**.

They would still get nothing once inside — the console re-checks everything
against the database and would refuse them — but they should not reach the door,
and you should not have to depend on the second lock.

## What to do

1. 🌐 Clerk dashboard → choose this application
2. 🌐 Left menu: **Configure → Sessions**
3. 🌐 Find **Customize session token** → **Edit** on the **Claims** editor
4. Look for a line mentioning `metadata`.

**If the editor is empty, or there is no `metadata` line, paste exactly this:**

```json
{
  "metadata": "{{user.public_metadata}}"
}
```

**If a `metadata` line already exists:**

| What you see | What to do |
|---|---|
| `"metadata": "{{user.public_metadata}}"` | ✅ Correct. Change nothing. |
| `"metadata": "{{user.unsafe_metadata}}"` | 🔴 **Fix now.** Replace `unsafe_metadata` with `public_metadata` and save. |
| Anything else | Do not guess. Show this page to whoever maintains the application. |

5. 🌐 **Save**.

> The two words are one idea apart and worlds apart in effect. `public` means
> "anyone may READ it, only we may WRITE it". `unsafe` means "the user writes it
> from their browser". You want **`public_metadata`**. Always.

## The second half: the `fva` claim

The console asks a staff member to re-confirm who they are before anything
dangerous. For that check to be real rather than decorative, the session token
must carry a claim called **`fva`** — how many minutes ago they last proved
their identity with a second factor.

**Current Clerk includes `fva` automatically.** There is normally nothing to do.
To confirm:

1. 🌐 Still on **Configure → Sessions**, look for the list of default claims.
   `fva` should be among them.
2. 🌐 If your application uses a **hand-written JWT template** instead
   (**Configure → JWT Templates**), open it and check it has not removed the
   defaults. A hand-written template that lists only its own claims will not
   contain `fva`.

**How to tell whether it worked, later:** ask a staff member to suspend a test
workspace, then open the console's **Action register**. If `fva` is missing you
will see a `warning` entry saying, in plain words, that the identity re-check
was *a click, not a verified factor*. If it is present, no such entry appears.
The console tells you the truth about its own controls either way.

## While you are in Clerk

🌐 **Configure → Organizations → Enable organizations = ON.** Without it every
customer company shares one space. This is the switch that makes the product
multi-tenant.

🌐 Switch Clerk from **Development** to **Production** keys, and add your real
domain under **Configure → Domains**. Development keys have looser limits and
are not meant to face the public.

---

# PART 4 — Your own staff access

Full instructions are in `PHASE-29-DEPLOYMENT.md`. The short version, because it
belongs on this checklist:

Access to the admin console needs **two independent keys**, and one of them
lives outside the database on purpose — somebody who breaks into the database
still cannot let themselves in.

**Key 1 — a list of emails in the application's settings.** 🌐 Vercel → Settings
→ Environment Variables:

```
PLATFORM_ADMIN_EMAILS
```
```
priya@yourcompany.com,arjun@yourcompany.com
```

Commas, no spaces. Redeploy afterwards. Each address must be one Clerk has
**verified**.

**Key 2 — a database grant.** 🧑‍💻 Once, for the first person:

💻
```bash
psql "$DATABASE_URL" -c "INSERT INTO platform_staff (clerk_user_id, email, display_name, grade, status, expires_at, grant_reason) VALUES ('CLERK_USER_ID_HERE', 'EMAIL_HERE', 'FULL NAME HERE', 'owner', 'active', now() + interval '90 days', 'Initial platform owner grant, approved by NAME');"
```

`CLERK_USER_ID_HERE` looks like `user_2abc…` and comes from Clerk → Users →
click the person. It is **not** their email.

**Also mark them in Clerk:** 🌐 Users → the person → **Metadata** → **Public
metadata** (not *unsafe*, not *private*):

```json
{
  "platformAdmin": true
}
```

Note the **90 days** on the grant. Every grant should have an end date. That is
how a contractor from two years ago stops being able to read every customer's
billing record.

> **Granting access is hard; revoking it is easy.** That asymmetry is
> deliberate. To lock somebody out immediately, at any hour, with no deploy:
>
> ```bash
> psql "$DATABASE_URL" -c "UPDATE platform_staff SET status = 'revoked', revoked_at = now(), revoke_reason = 'REASON' WHERE email = 'THEIR_EMAIL';"
> ```

---

# PART 5 — Razorpay: create the plans

Until this is done, a customer clicking **Subscribe** gets *"That plan cannot be
purchased online yet."* Nothing is broken; the plan simply does not exist at the
payment provider.

## Step 5.1 — Put the plan catalogue in your database

💻
```bash
npm run seed:plans
```

This is safe to run repeatedly. It **never** reprices an existing customer — a
subscription copies its price onto itself at purchase — and it never blanks a
provider id you have already filled in.

## Step 5.2 — Create the matching plans in Razorpay

🌐 Razorpay Dashboard → **Subscriptions** → **Plans** → **Create Plan**.

Create these **three**. `trial` and `enterprise` are deliberately not sold
online, so they need no Razorpay plan.

| # | Plan name to type | Billing cycle | Amount to type | This is |
|---|---|---|---|---|
| 1 | `Ordence Basic (monthly)` | Monthly, every 1 month | **1999** | ₹1,999.00 / month |
| 2 | `Ordence Advanced (monthly)` | Monthly, every 1 month | **4999** | ₹4,999.00 / month |
| 3 | `Ordence Advanced (annual)` | Yearly, every 1 year | **49990** | ₹49,990.00 / year |

> ⚠️ **Razorpay's amount box is in RUPEES, and our database stores PAISE.**
> Our catalogue says `499900`; you type `4999`. If a box on Razorpay's screen is
> labelled *paise*, type `499900` instead. Getting this wrong by a factor of one
> hundred is the single most common billing mistake there is, and it is
> equally bad in both directions.

> **Currency: INR.** Do not create these in any other currency.

After saving each one, Razorpay shows a **Plan ID** that looks like
`plan_NxxxxxxxxxxxxX`. Copy all three.

## Step 5.3 — Tell our database the Razorpay ids

🧑‍💻 Replace the three `plan_…` values with the real ones:

💻
```bash
psql "$DATABASE_URL" <<'SQL'
UPDATE plans SET razorpay_plan_id = 'plan_PASTE_BASIC_MONTHLY_HERE'
  WHERE code = 'basic_monthly_inr';
UPDATE plans SET razorpay_plan_id = 'plan_PASTE_ADVANCED_MONTHLY_HERE'
  WHERE code = 'advanced_monthly_inr';
UPDATE plans SET razorpay_plan_id = 'plan_PASTE_ADVANCED_ANNUAL_HERE'
  WHERE code = 'advanced_annual_inr';
SQL
```

Check it:

💻
```bash
psql "$DATABASE_URL" -c "SELECT code, name, amount_minor, razorpay_plan_id FROM plans WHERE is_public ORDER BY sort_order;"
```

**Every public plan must show a `plan_…` id.** A blank one is a plan nobody can
buy.

## Step 5.4 — Razorpay keys and the webhook

🌐 Razorpay → **Settings → API Keys** → generate. Put both in Vercel:

```
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
```

🌐 Razorpay → **Settings → Webhooks** → **Add New Webhook**:

| Field | Value |
|---|---|
| Webhook URL | `https://YOUR-DOMAIN/api/webhooks/razorpay` |
| Secret | invent a long random string — **the same one** goes in Vercel |
| Active events | `subscription.*`, `payment.*`, `invoice.*` |

Then in Vercel:

```
RAZORPAY_WEBHOOK_SECRET
```

> **Why the webhook secret matters more than it looks.** Without it, anybody who
> guesses the URL can tell your application that an invoice was paid. The
> application verifies the signature and refuses unsigned calls — but only if
> the secret is set. And the *duplicate* protection that `npm run db:verify`
> checks is what stops Razorpay's own automatic retry from charging a customer
> twice.

Finally, set your own tax identity — this appears on every invoice you issue:

```
PLATFORM_GST_STATE_CODE   e.g. 29   (Karnataka; two digits)
PLATFORM_GSTIN            your own GSTIN
PLATFORM_INVOICE_PREFIX   e.g. AH
```

## Step 5.5 — Test it with real money, once

Subscribe a test workspace to Basic with a real card, confirm the invoice
appears in the workspace's billing page, then cancel and refund it from the
Razorpay dashboard. ₹1,999 is a cheap price for finding out that the webhook URL
had a typo.

---

# PART 6 — Vercel Pro

## Why this is not optional

> ### ⚠️ Vercel's Hobby plan forbids commercial use
>
> Vercel's own terms restrict Hobby to *"non-commercial, personal use only."*
> **A product with a paying customer, hosted on Hobby, violates those terms**,
> and Vercel can suspend the project.
>
> Suspension is not a warning email. It is your customers' product going dark,
> on a day you did not choose, over a **$20/month** bill.

Hobby is right for building and demonstrating. The day money changes hands it is
the wrong plan, and the trigger is contractual rather than technical — you will
not hit a limit that tells you.

You also get, and will want: email support, **1 day** of log retention instead
of 1 hour (an incident you hear about the next morning is otherwise
uninvestigable), password-protected preview deployments, spend caps, and 40
firewall rules instead of 3.

## What to do

1. 🌐 Vercel → your project → **Settings → General → Plan** → upgrade to **Pro**
   ($20/month).
2. 🌐 **Immediately** afterwards: **Settings → Billing → Spend Management** →
   set a hard cap.

> **Do not skip the spend cap.** Pro includes 10M edge requests and then bills
> per use. A runaway loop or a scraper can produce a genuinely alarming invoice,
> and the first you would know is the invoice. Set the cap at a number that would
> annoy you but not hurt you.

## While you are in Vercel — the environment variables

🌐 **Settings → Environment Variables**, on **Production**:

| Name | Value | Required? |
|---|---|---|
| `DATABASE_URL` | the **pooled** Neon string (has `-pooler`), as user `ordence_app` | **Yes** |
| `DATABASE_URL_UNPOOLED` | the direct string (no `-pooler`) | Recommended |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk **production** `pk_live_…` | **Yes** |
| `CLERK_SECRET_KEY` | Clerk **production** `sk_live_…` | **Yes** |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk → Webhooks → Signing Secret | **Yes** |
| `NEXT_PUBLIC_APP_URL` | `https://your-real-domain.com` | **Yes** |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `your-real-domain.com` | **Yes** |
| `PLATFORM_ADMIN_EMAILS` | your staff, comma-separated | For the console |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | Part 5 | To take payments |
| `PLATFORM_GST_STATE_CODE` / `PLATFORM_GSTIN` / `PLATFORM_INVOICE_PREFIX` | Part 5 | To issue invoices |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | resend.com | To send any email at all |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | upstash.com | For rate limiting |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob | For file uploads |

**Redeploy after changing any of these.** Environment variables are read at
build time; an unchanged deployment keeps the old values indefinitely.

> ⚠️ `DATABASE_URL` must name **`ordence_app`**, not the Neon owner account. If
> the application connects as an owner or a superuser, every protection Part 2
> just verified is bypassed by the application itself, and `db:verify` cannot
> see that from where it runs.

---

# PART 7 — GitHub branch protection

Every guarantee in this product lives in code that a future commit could quietly
break. The test suite catches that — but only if a broken commit cannot reach
`main` in the first place, because Vercel deploys `main` automatically and
nobody reads a red build after the fact.

## What to do

1. 🌐 GitHub → your repository → **Settings → Branches**
2. 🌐 **Add branch protection rule** (or **Add classic branch protection rule**)
3. Branch name pattern: `main`
4. ✅ **Require a pull request before merging**
5. ✅ **Require status checks to pass before merging**
6. In the search box, find and select **`Security Gate`**
7. ✅ **Require branches to be up to date before merging**
8. ✅ **Do not allow bypassing the above settings** ← the one people leave off
9. **Create** / **Save changes**

## What `Security Gate` actually gates

It is one check that waits on five jobs, and it fails if any of them is skipped
or cancelled as well as failed:

| Job | What it proves |
|---|---|
| **Type-check & Build** | It compiles, it builds, and no secret reached the browser bundle |
| **Security Test Suite** | 737 tests against a real PostgreSQL, connected as a non-superuser, plus `npm run db:verify` on a database built by these exact SQL files |
| **UI Behaviour Tests** | 682 tests over the interface |
| **Dependency Audit** | No high or critical advisory in the code you actually ship |
| **Secret Scan** | No `.env` file and no live key pattern in the repository |

From then on, a commit that breaks tenant isolation **cannot merge**, and
therefore cannot reach Vercel.

> ⚠️ **Confirm the check is green at least once before turning protection on.**
> A required check that has never passed blocks every merge, and the fix people
> reach for at 6pm on a Friday is to turn the protection off. Push a trivial
> commit, watch **Actions** go green, then add the rule.

---

# PART 8 — The final walk-through

Do these in a browser, on the real production URL, in this order. Each one is
quick and each one has caught a real problem.

- [ ] `https://your-domain/api/health` returns `{"status":"ok", …}`
- [ ] You can sign up, create an organisation, and reach the dashboard
- [ ] Create a second workspace with a **different** email. Confirm it sees
      **none** of the first one's records — no contacts, no leads, no documents
- [ ] Create a contact, edit it, delete it. Check **Settings → Recycle bin**
- [ ] Subscribe to Basic with a real card. The invoice appears in the
      workspace's billing page
- [ ] Cancel and refund that subscription from Razorpay
- [ ] Sign in as a platform staff member and open `/platform`. You see the
      workspace list
- [ ] Open a workspace in the console. Confirm you **cannot** see its contacts
      or documents anywhere — that refusal is the product working
- [ ] Confirm that opening it wrote a line in **that customer's own** audit log
- [ ] A password reset email arrives (proves `RESEND_API_KEY` is right)
- [ ] Set a calendar reminder: **run `npm run db:verify` on the 1st of every month**

---

# 🛑 STOP — do not serve traffic if any of these fail

Everything above is a checklist. **This is a gate.** If a line here is not
satisfied, the correct action is to delay the launch — not to launch and fix it
next week. Every item below is something that is invisible when it is broken and
expensive when it is discovered.

### 1. `npm run db:verify` does not print ✅ ALL CHECKS PASSED
Do not launch. Not one failing line, not "only the billing one". Each failing
line is a protection that is absent, and none of them has any other symptom. Go
back to Part 1, Step 1.3, run the files in order, and run the verifier again.

### 2. The application connects to the database as a superuser or an owner
Check it:
```bash
psql "$DATABASE_URL" -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ordence_app';"
```
Both flags must be `f`. And `DATABASE_URL` in Vercel must actually name that
role. A superuser bypasses row-level security **completely** — not partially.
Every policy you just installed would be decoration.

### 3. Clerk's session token reads `unsafe_metadata`
Part 3. A customer who signs up can promote themselves to the front door of your
admin console.

### 4. Any SQL file printed `*** FAIL ***` and was not re-run to a clean pass
A half-applied security file is worse than an unapplied one, because the parts
that did apply make it look done.

### 5. `git ls-files | grep -c "env"` is not `0` for real environment files
```bash
git ls-files | grep -E '^\.env($|\.local$|\.production$|\.test$)' || echo "clean"
```
If anything is listed, your production keys are in the repository's history.
Remove the file **and rotate every key it contained** — deleting it in a new
commit does not remove it from history.

### 6. You are on Vercel Hobby with a paying customer
A terms violation whose penalty is suspension. $20 stands between you and your
customers' product going dark on a day you did not choose.

### 7. `GET /api/webhooks/razorpay` is reachable without a webhook secret set
Then anybody who guesses the URL can tell your application an invoice was paid.

### 8. Branch protection on `main` is off, or can be bypassed
Vercel deploys `main` automatically. Without the gate, a commit that drops
tenant isolation reaches production the moment it is pushed, and the red build
arrives afterwards.

### 9. You have no tested restore
Not "you have backups" — **you have restored one and it worked.** Neon's free
tier keeps no point-in-time history; the Launch plan (~$19/month) keeps 7 days.
See `DISASTER-RECOVERY.md` and run `npm run drill:restore`. A backup nobody has
restored is a belief, not a backup.

### 10. Nobody knows who to call
Write down, on paper, before launch: who has the database password, who has the
Clerk admin account, who has the Vercel account, and who to call at 3am. This
costs nothing and is the item most often skipped.

---

## What is deliberately NOT done yet

Written down rather than quietly omitted, because a control everybody believes
exists is worse than one everybody knows is missing.

| Gap | What it means for you | Severity |
|---|---|---|
| **No customer-facing "grant support access" page** | A customer who wants your staff to look at their workspace cannot switch it on themselves. Their permission has to be recorded by hand on their written instruction — see Step 9 of `PHASE-29-DEPLOYMENT.md`. Nothing is unsafe; a convenience is missing. | Low |
| **The impersonation tidy-up job is not scheduled** | Finished support sessions are not marked "finished" in the history. ⚠️ **They still END** — a session's clock is the authority, and it runs out whether or not anything writes it down. The history is untidy; nothing is less safe. | Cosmetic |
| **`/settings/gst` does not exist** | Some GST actions try to refresh a page that was never built. Refreshing a page that does not exist is silently ignored, so nothing breaks. | Cosmetic |
| **No `/sales/partners/<id>` detail page** | Clicking a broker's name on the partner list leads to a "page not found". | Low — visible |
| **Background workers are not on Vercel** | Vercel functions stop when the request ends, so queued jobs need a small always-on process elsewhere (Railway, Fly, Render — all have free tiers) hitting `/api/workers`. Without it, queued work waits. | Medium if you rely on queues |
| **No workflow builder screen** | The automation engine is complete and tested; the visual editor to configure one is not built. | Feature, not a risk |

---

## The one-page version

Print this bit.

```
1.  npm run db:push
2.  create the ordence_app role  (NOSUPERUSER NOBYPASSRLS)   ← before the SQL
3.  ALL-IN-ONE-SETUP.sql, then 0017, 0018, 0019, 0020, 0021, 0022 — in order
4.  npm run db:verify            → must say ALL CHECKS PASSED
5.  Clerk: metadata = {{user.public_metadata}}, organizations ON, prod keys
6.  PLATFORM_ADMIN_EMAILS + one platform_staff row with an expiry date
7.  npm run seed:plans, create 3 Razorpay plans, paste the plan_… ids back
8.  Vercel Pro + spend cap + every environment variable + redeploy
9.  GitHub: protect main, require "Security Gate", no bypass
10. Walk through Part 8, then read the 🛑 STOP list one more time
```

---

*Related: `DEPLOYMENT-GUIDE.md` (first-time setup) · `PHASE-29-DEPLOYMENT.md`
(the admin console in detail) · `DISASTER-RECOVERY.md` (backups and restores) ·
`COST-AND-UPGRADE-PATH.md` (what to upgrade and when).*
