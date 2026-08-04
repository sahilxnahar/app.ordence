# Phase 4 Setup & Deployment — v0.4.0-alpha

You asked for all the SQL in one go. **There is now exactly one SQL file to run:**
`db/migrations/ALL-IN-ONE-SETUP.sql`. It contains every migration from Phase 1
through Phase 4.

Budget 30–40 minutes. **Legend:** 💻 = Terminal · 🌐 = browser

---

# PART A — Install and build the tables

## Step 1: Install the new packages

💻
```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
npm install
```

Phase 4 adds `bullmq` (job queue), `ioredis` (Redis client), and
`@upstash/qstash` (webhook signature verification).

## Step 2: Create the new tables

💻
```bash
npx drizzle-kit generate
```

💻
```bash
npx drizzle-kit push
```

Confirm **Yes**. This creates six tables: `contracts`, `contract_versions`,
`clause_library`, `ledgers`, `transactions`, `journal_entries`.

---

# PART B — 🔒 Run the one SQL file

> **This is the important step.** Creating tables gives you storage. This file
> gives you *protection* — tenant isolation, an unalterable audit trail, and the
> rule that stops unbalanced financial entries from ever being saved.

## Step 3: Print the file

💻
```bash
cat db/migrations/ALL-IN-ONE-SETUP.sql
```

Select and copy **everything** it prints. It is long — that is expected.

> Easier on a Mac: `pbcopy < db/migrations/ALL-IN-ONE-SETUP.sql` copies it
> straight to your clipboard with nothing shown on screen.

## Step 4: Run it in Neon

1. 🌐 Neon dashboard → **SQL Editor**
2. Paste the whole file
3. Click **Run**

It takes a few seconds. You will see several result tables at the end — those are
the verification checks.

> **Safe to run more than once.** Every statement uses `CREATE OR REPLACE` or
> `DROP IF EXISTS`. Re-running reapplies the same rules and never touches data.

## Step 5: Read the verification output

The file ends with six checks. Confirm each:

| Check | What you must see |
|---|---|
| **1 — Tables protected** | **20 rows**, every `rowsecurity` = `true` |
| **2 — Balance trigger** | 1 row, `is_deferrable` = `true`, `starts_deferred` = `true` |
| **3 — Append-only** | **6 rows** (2 each for audit_logs, contract_versions, journal_entries) |
| **5 — Ledger reconciliation** | **0 rows** (0 rows = every balance agrees) |
| **6 — Trial balance** | `difference` = `0.00` |

If Check 1 shows fewer than 20 rows or any `false`, the script did not finish —
run it again.

---

# PART C — Set up background jobs (Upstash)

Optional but recommended. **The app works without this** — document rendering
just happens inline instead of in the background.

## Step 6: Create a free Upstash Redis database

1. 🌐 Go to **upstash.com** → sign up (free)
2. **Create Database**
3. Name: `ameya-queue`
4. Region: closest to your Vercel region (Singapore for India)
5. Type: **Regional** (free tier)
6. Click **Create**

## Step 7: Copy the credentials

On the database page you need **two different things**:

1. Scroll to **REST API** → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
2. Scroll to **Connect to your database** → select the **Redis** (not REST) tab →
   copy the `rediss://…` connection string

> **Why two?** Caching uses the REST endpoint (works everywhere including Edge).
> BullMQ speaks the raw Redis protocol and needs the `rediss://` TCP URL. They are
> the same database, reached two ways.

## Step 8: Add them to your environment

💻
```bash
open -e .env.local
```

Add these lines, save, close:

```bash
# --- Upstash Redis: caching (REST) ---
UPSTASH_REDIS_REST_URL="https://your-db.upstash.io"
UPSTASH_REDIS_REST_TOKEN="AX...your-token"

# --- Upstash Redis: BullMQ queue (TCP) ---
REDIS_URL="rediss://default:your-password@your-db.upstash.io:6379"

# --- Worker endpoint authentication (REQUIRED if you enable the queue) ---
# Generate with:  openssl rand -hex 32
WORKER_API_SECRET="paste-the-generated-value-here"

# --- QStash (optional, for scheduled job draining) ---
QSTASH_TOKEN=""
QSTASH_CURRENT_SIGNING_KEY=""
QSTASH_NEXT_SIGNING_KEY=""
```

Generate the worker secret:

💻
```bash
openssl rand -hex 32
```

Copy the 64-character output into `WORKER_API_SECRET`.

> 🔒 **This secret protects an endpoint that executes background work.** If it
> leaks, someone can drain your job queues and run up your Vercel usage. Treat it
> exactly like a password. Without it (and without QStash keys) the endpoint
> refuses all requests and returns 503 — deliberately fail-closed.

---

# PART D — Test it

## Step 9: Start the app

💻
```bash
npm run dev
```

## Step 10: Confirm the worker endpoint is locked down

**Test 1 — unauthenticated request must be rejected:**

💻
```bash
curl -i -X POST http://localhost:3000/api/workers -d '{}'
```

Expected: **`HTTP/1.1 401 Unauthorized`**

**Test 2 — wrong secret must be rejected:**

💻
```bash
curl -i -X POST http://localhost:3000/api/workers \
  -H "Authorization: Bearer wrong-secret-value" -d '{}'
```

Expected: **`HTTP/1.1 401 Unauthorized`**

**Test 3 — correct secret must work.** Replace `YOUR_SECRET` with the value from
`.env.local`:

💻
```bash
curl -i -X POST http://localhost:3000/api/workers \
  -H "Authorization: Bearer YOUR_SECRET" -d '{}'
```

Expected: **`HTTP/1.1 200 OK`** with a JSON body showing `"processed": 0`.

> If Test 1 or Test 2 returns 200, **stop and tell me.** That would mean the
> endpoint is open.

## Step 11: Prove the double-entry rule works

This is the one worth seeing with your own eyes.

🌐 In Neon's SQL Editor, first get some real IDs:

```sql
SELECT id, name FROM tenants LIMIT 1;
SELECT id, code, name FROM ledgers LIMIT 2;
```

If no ledgers exist yet, create two:

```sql
INSERT INTO ledgers (tenant_id, name, code, type, account_type)
VALUES
  ('<your-tenant-id>', 'Bank — Operating', '1000', 'operating', 'asset'),
  ('<your-tenant-id>', 'Client Advances',  '2000', 'trust',     'liability');
```

Now try to save an **unbalanced** transaction — ₹100 in, ₹60 out:

```sql
BEGIN;
  INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
  VALUES ('11111111-1111-4111-8111-111111111111', '<your-tenant-id>',
          'Deliberately unbalanced test', CURRENT_DATE, 'INR');

  INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
  VALUES ('<your-tenant-id>', '11111111-1111-4111-8111-111111111111',
          '<ledger-1-id>', 'debit', 100.00);

  INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
  VALUES ('<your-tenant-id>', '11111111-1111-4111-8111-111111111111',
          '<ledger-2-id>', 'credit', 60.00);
COMMIT;
```

**Expected:**
```
ERROR: Transaction 11111111-... does not balance.
       Debits = 100.00, Credits = 60.00, difference = 40.00
HINT:  Debits must exactly equal credits.
```

Two things to notice:

1. **The individual INSERTs succeeded.** The error appeared at `COMMIT`. That is
   the deferred trigger working as designed — it waits until all the legs are in
   before judging.
2. **Nothing was saved.** The whole transaction rolled back.

Now run it again with `100.00` on both sides. It commits cleanly.

Clean up if you like:
```sql
ROLLBACK;
```

---

# PART E — Ship it

## Step 12: Commit and push

💻
```bash
git add .
git commit -m "feat: v0.4.0-alpha — CLM, double-entry accounting, BullMQ workers, grid persistence"
git push
```

## Step 13: Add the environment variables to Vercel

🌐 Vercel → your project → **Settings → Environment Variables**. Add:

| Name | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | from Upstash REST section |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash REST section |
| `REDIS_URL` | the `rediss://…` TCP string |
| `WORKER_API_SECRET` | **generate a NEW one** — do not reuse the local value |

💻 Generate the production secret:
```bash
openssl rand -hex 32
```

Then 🌐 **Deployments** → newest → `…` → **Redeploy**.

> Skipping the redeploy is the most common mistake. Vercel only picks up new
> environment variables on a fresh deployment.

## Step 14: Run the SQL on production

If Vercel points at a different Neon database than local, repeat **Part B** there.
Same file, same six checks.

---

## Verification checklist

- [ ] `npx drizzle-kit push` created the 6 new tables
- [ ] `ALL-IN-ONE-SETUP.sql` ran; Check 1 shows **20 tables at `true`**
- [ ] Check 2 shows the balance trigger is deferred
- [ ] Check 3 shows 6 append-only triggers
- [ ] Checks 5 and 6 came back clean
- [ ] Unauthenticated `/api/workers` returns **401**
- [ ] Authenticated `/api/workers` returns **200**
- [ ] The unbalanced transaction test **failed** with a balance error
- [ ] A balanced version of the same transaction **succeeded**
- [ ] Inline grid edits on `/assets` now **persist across a refresh**
- [ ] Vercel has all four new environment variables, and was redeployed

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `relation "contracts" does not exist` | Tables not pushed | Re-run `npx drizzle-kit push` |
| SQL file errors on `ALTER TABLE ... contracts` | Ran the SQL before creating tables | Do Step 2 first, then Part B |
| `/api/workers` returns 503 | No auth method configured | Set `WORKER_API_SECRET` and restart |
| `/api/workers` returns 200 without auth | **Serious — tell me** | Do not deploy |
| Transaction rejected as unbalanced | **Working correctly** | Check your debit and credit totals |
| `journal_entries is append-only` | **Working correctly** | Post a reversing entry instead of editing |
| Inline edit still reverts | Dev server not restarted | `Ctrl + C`, then `npm run dev` |
| Jobs enqueue but never run | Nothing is draining the queue | Call `/api/workers` with your secret, or set up QStash |
| `ECONNREFUSED` on enqueue | `REDIS_URL` wrong or missing | Use the `rediss://` TCP URL, not the REST URL |

---

## What Phase 4 gives you

**Inline edits persist (SEC-009 closed).** Edit a cell on `/assets`, refresh — the
value stays. The optimistic path still rolls back visibly if the save fails.

**Contracts with a tamper-evident history.** Every version is immutable and hash-
chained. `verifyContractIntegrity()` walks the chain and reports any break.

**A trust ledger that cannot go out of balance.** Enforced in the database, so it
holds regardless of what the application does.

**Background jobs on a free tier.** Enqueue from Vercel, drain through an
authenticated endpoint. When you outgrow it, the same job definitions run
unchanged on a real worker host.

---

## One thing to be aware of before real bookkeeping

There is currently no **period close** — nothing stops a back-dated entry being
posted into a month you have already reported on. That is an accounting control,
not a security hole, but it matters once you file real numbers. It is tracked as
**SEC-012** for Phase 5.
