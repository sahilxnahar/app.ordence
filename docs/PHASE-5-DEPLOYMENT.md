# Phase 5 Setup & Deployment — v0.5.0-alpha

**Legend:** 💻 = Terminal · 🌐 = browser. Budget 25–35 minutes.

> ### 📁 Where the SQL lives now
> All SQL files are in their own folder: **`SQL-FILES/`** inside the project.
> You only ever need to run one of them: **`ALL-IN-ONE-SETUP.sql`**.
> It contains every migration from Phase 1 through Phase 5.

---

# PART A — Install and create tables

## Step 1: Install new packages

💻
```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
npm install
```

Phase 5 adds `recharts` for the dashboard charts.

## Step 2: Create the new tables

💻
```bash
npx drizzle-kit generate
```

💻
```bash
npx drizzle-kit push
```

Confirm **Yes**. This creates `financial_periods` and `permission_denials`, and
adds `metadata` + `severity` columns to `audit_logs`.

---

# PART B — 🔒 Run the one SQL file

## Step 3: Copy it

💻 (copies straight to your clipboard, nothing appears on screen)
```bash
pbcopy < SQL-FILES/ALL-IN-ONE-SETUP.sql
```

If you'd rather see it first:
```bash
cat SQL-FILES/ALL-IN-ONE-SETUP.sql
```

## Step 4: Run it in Neon

1. 🌐 Neon dashboard → **SQL Editor**
2. Paste → **Run**

Safe to run repeatedly — every statement is `CREATE OR REPLACE` or
`DROP IF EXISTS`. It never touches your data.

## Step 5: Read the 12 verification checks

| Check | You must see |
|---|---|
| **1** — Tables protected | **22 rows**, all `true` |
| **2** — Balance trigger | 1 row, `is_deferrable` = `true` |
| **3** — Append-only | **8 rows** |
| **5** — Ledger reconciliation | **0 rows** |
| **6** — Trial balance | `difference` = `0.00` |
| **7** — Phase 5 tables protected | **2 rows**, both `true` |
| **8** — Period-lock triggers | **2 rows** |
| **9** — Overlap constraint | **1 row** |

Anything short of that means the script didn't finish — run it again.

---

# PART C — Populate the dashboard

## Step 6: Run the Phase 5 seeder

> Run the Phase 3 seeder first if you haven't: `npm run seed`. Phase 5 builds on
> the workspace it creates.

💻
```bash
npm run seed:phase5
```

Takes 30–60 seconds. You should see:

```
╔══════════════════════════════════════════════════════════════╗
║  PHASE 5 SEED COMPLETE                                        ║
╚══════════════════════════════════════════════════════════════╝

  Users               9 across 8 roles
  Ledgers             8
  Periods             4  (Q1 + Q2 FY2026 CLOSED)
  Transactions        50
  Journal entries     100
  Audit logs          100
  Permission denials  18

  ── TRIAL BALANCE ──────────────────────────────
  Difference          ₹0.00
  Status              ✅ BALANCED
```

**If the trial balance is not ₹0.00 the script exits with an error.** That is
deliberate — a seeder that produces unbalanced books is worse than no seeder.

---

# PART D — See it working

## Step 7: Start the app

💻
```bash
npm run dev
```

🌐 **http://localhost:3000/dashboard**

You should see:
- 8 stat tiles — units, cost-to-completion, **contractor retainage**, inventory value
- A **cost-to-completion** progress meter
- A **unit status** donut chart
- A **budgeted vs committed vs spent** bar chart, read from the project's nested JSONB
- **Ledger balances**, with trust and escrow accounts highlighted
- A live **audit trail** with colour-coded severity

## Step 8: Watch the dashboard change industry

🌐 Neon SQL Editor:
```sql
UPDATE tenants
SET settings = jsonb_set(settings, '{industry}', '"legal_advocate"')
WHERE slug = 'ameya-developers';
```

Reload the dashboard. It now shows **retainer balances**, **contract lifecycle
stages**, and matter counts. Same page, same code — different aggregation.

Change it back:
```sql
UPDATE tenants
SET settings = jsonb_set(settings, '{industry}', '"real_estate_developer"')
WHERE slug = 'ameya-developers';
```

## Step 9: 🔒 Prove the period lock works

This is the one worth doing yourself.

🌐 Get the IDs you need:
```sql
SELECT id, name, start_date, end_date, status FROM financial_periods ORDER BY start_date;
SELECT id, code, name FROM ledgers LIMIT 2;
SELECT id FROM tenants WHERE slug = 'ameya-developers';
```

Now try to post an entry dated inside **closed** Q1 2026:

```sql
BEGIN;
  INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
  VALUES ('33333333-3333-4333-8333-333333333333', '<tenant-id>',
          'Back-dated test — should fail', '2026-02-15', 'INR');

  INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
  VALUES ('<tenant-id>', '33333333-3333-4333-8333-333333333333',
          '<ledger-1-id>', 'debit', 5000.00);
COMMIT;
```

**Expected:**
```
ERROR: Cannot insert this entry: 2026-02-15 falls inside closed accounting
       period "Q1 FY2026 (Jan–Mar)" (2026-01-01 to 2026-03-31).
HINT:  Post the entry to an open period, or reopen this period first.
```

Two things to notice:

1. **The error appears on the INSERT itself**, not at COMMIT. The period lock is
   a `BEFORE` trigger — it stops the write before it happens.
2. **This is different from the balance trigger** from Phase 4, which is deferred
   and fires at COMMIT. Different jobs, different timing, both correct.

Now change the date to `2026-08-15` (inside open Q3) and add a matching credit
leg. It commits cleanly.

```sql
ROLLBACK;
```

## Step 10: Check the audit trail is untouchable

```sql
UPDATE audit_logs SET reason = 'tampered' WHERE id = (SELECT id FROM audit_logs LIMIT 1);
```

**Expected:** `ERROR: audit_logs is append-only; UPDATE is not permitted`

```sql
DELETE FROM permission_denials WHERE id = (SELECT id FROM permission_denials LIMIT 1);
```

**Expected:** `ERROR: permission_denials is append-only; DELETE is not permitted`

---

# PART E — Ship it

## Step 11: Commit and push

💻
```bash
git add .
git commit -m "feat: v0.5.0-alpha — period close, granular RBAC, audit enforcement, executive dashboard"
git push
```

Vercel redeploys automatically (~2 minutes).

## Step 12: Run the SQL on production

If Vercel points at a different Neon database, repeat **Part B** there. Same
file, same 12 checks.

> Do **not** run `npm run seed:phase5` against production — it is demo data.

---

## Verification checklist

- [ ] `npx drizzle-kit push` created `financial_periods` and `permission_denials`
- [ ] `ALL-IN-ONE-SETUP.sql` ran; Check 1 shows **22 tables at `true`**
- [ ] Check 3 shows **8** append-only triggers
- [ ] Checks 7, 8 and 9 all pass
- [ ] `npm run seed:phase5` finished with **₹0.00 difference**
- [ ] `/dashboard` renders charts, ledgers and the audit feed
- [ ] Switching `settings.industry` changes the whole dashboard
- [ ] The back-dated entry **failed** with a period-lock error
- [ ] `UPDATE audit_logs` **failed** with an append-only error
- [ ] Pushed to GitHub and Vercel redeployed

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `relation "financial_periods" does not exist` | Tables not pushed | Re-run `npx drizzle-kit push` |
| `extension "btree_gist" is not available` | Rare on some Postgres hosts | Neon supports it; if blocked, comment out the EXCLUDE constraint — the trigger still works |
| Seeder: `Tenant not found` | Phase 3 seeder not run | `npm run seed` first |
| Seeder exits with unbalanced trial balance | A partial earlier run | Re-run — it clears its own data first |
| Dashboard shows zeros | Seeder not run, or wrong workspace | Check the org switcher matches the seeded tenant |
| `falls inside closed accounting period` | **Working correctly** | Use an open period, or reopen with `periods:reopen` |
| `is append-only` | **Working correctly** | History cannot be edited by design |
| `conflicting key value violates exclusion constraint` | Overlapping periods | Periods must not overlap — adjust the dates |

---

## What Phase 5 gives you

**Books that cannot be quietly rewritten.** Close a period and the database
refuses any entry dated inside it — regardless of what the application does.

**Roles that mean something.** An Accountant can post entries but cannot declare
them final. Legal Counsel can sign contracts but cannot see the ledger. A
contractor sees assets and nothing else. Those boundaries are enforced in code
and verified by an executed test suite, not just described in a table.

**An audit trail that holds up.** Four tables — audit logs, contract versions,
journal entries and permission denials — are append-only at the database level.
Blocked attempts at privileged actions are recorded, not just refused.

**A dashboard that knows what business you're in.** Real estate sees
cost-to-completion and retainage; legal sees retainer balances and matter stages.
One page, one codebase.

---

## The most valuable thing to build next

There is still no **automated cross-tenant isolation test suite** (SEC-004). Five
phases of isolation controls now exist, and each was verified when it was built.
What does not exist is a suite that runs on every commit and would catch a
regression six months from now, when someone adds a table and forgets the RLS
policy. That is the gap I would close next.
