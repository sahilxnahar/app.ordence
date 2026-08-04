# Phase 6 Setup & Deployment — v0.6.0-alpha

**Legend:** 💻 = Terminal · 🌐 = browser. Budget 20–30 minutes.

---

# PART A — Install and set up testing

## Step 1: Install the test packages

💻
```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
npm install
```

Adds `vitest`, `pg` (a raw PostgreSQL client) and coverage tooling.

## Step 2: Create a SEPARATE test database

> ### ⚠️ Read this before anything else
>
> These tests **create tenants, insert rows, and delete everything they made.**
> If they ever pointed at your real database, they would destroy live customer
> data.
>
> That is not hypothetical. The usual sequence is: someone copies `.env.local`
> to `.env.test` "just to get tests running", forgets, and weeks later the
> cleanup step wipes a customer's ledger.
>
> The suite has **6 independent guards** to stop this. Step 2 is where you make
> sure they never have to fire.

### 🌐 In Neon — create a test branch (free)

1. Neon dashboard → your project → **Branches**
2. **Create branch** → name it `test`
3. Inside that branch, **create a database called `ameya_test`**
   *(the word `test` in the name is required — the guard checks for it)*
4. Copy the connection string for that branch

## Step 3: Create `.env.test`

💻
```bash
cp .env.test.example .env.test
open -e .env.test
```

Fill in:

```bash
TEST_DATABASE_URL="postgresql://user:pass@ep-xxxx.region.aws.neon.tech/ameya_test?sslmode=require"
ALLOW_DESTRUCTIVE_TESTS="true"
```

> `.env.test` is already in `.gitignore` and will never be committed.

## Step 4: 🔒 Create a NON-superuser role — this step is not optional

> ### Why this matters more than it looks
>
> **A PostgreSQL superuser bypasses Row-Level Security completely.**
>
> If the tests connect as a superuser, every isolation test **passes while
> proving nothing** — including on the day someone accidentally drops every
> policy. You would have a green dashboard and no protection.
>
> I hit exactly this while building Phase 6: the first run showed 17 failures,
> and the cause was that the test connection was a superuser. The suite now
> refuses to start if it detects one.

🌐 In Neon's SQL Editor, against your **test** branch:

```sql
CREATE ROLE ameya_app LOGIN PASSWORD 'pick-a-strong-password'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO ameya_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ameya_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ameya_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ameya_app;
```

Then update `.env.test` to use **two** connections:

```bash
# The app role — every assertion runs here. RLS actually applies.
TEST_DATABASE_URL="postgresql://ameya_app:your-password@ep-xxxx.../ameya_test?sslmode=require"

# The admin role — used ONLY to create and destroy test fixtures.
TEST_ADMIN_DATABASE_URL="postgresql://owner:pass@ep-xxxx.../ameya_test?sslmode=require"

ALLOW_DESTRUCTIVE_TESTS="true"
```

## Step 5: Build the test database schema

💻
```bash
DATABASE_URL="$(grep TEST_ADMIN_DATABASE_URL .env.test | cut -d'"' -f2)" npx drizzle-kit push --force
```

If that quoting looks awkward, just export it first:

💻
```bash
export DATABASE_URL="paste-your-TEST_ADMIN_DATABASE_URL-here"
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
npx drizzle-kit push --force
```

Then apply the security rules. 🌐 Neon SQL Editor (test branch) → paste
`SQL-FILES/ALL-IN-ONE-SETUP.sql` → **Run**.

---

# PART B — Run the tests

## Step 6: Run the security suite

💻
```bash
npm run test:security
```

You should see:

```
┌────────────────────────────────────────────────────────────────┐
│  AMEYA HEIGHTS OS — SECURITY TEST SUITE                        │
├────────────────────────────────────────────────────────────────┤
│  Guard:  ✅ all 6 production-safety checks passed              │
└────────────────────────────────────────────────────────────────┘
  Connected to: ameya_test as ameya_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful

 Test Files  3 passed (3)
      Tests  69 passed (69)
```

**69 tests. All must pass.** If any fails, a security guarantee is broken —
do not deploy.

## Step 7: Other test commands

💻
```bash
npm test              # everything
npm run test:watch    # re-runs as you edit
npm run test:coverage # with a coverage report
```

---

# PART C — Turn on the CI pipeline

## Step 8: Push the code

💻
```bash
git add .
git commit -m "feat: v0.6.0-alpha — automated security test suite and CI pipeline"
git push
```

## Step 9: Watch it run

1. 🌐 Go to your GitHub repository → **Actions** tab
2. You should see **Security CI** running
3. It takes 3–5 minutes and runs five jobs:

| Job | What it does |
|---|---|
| Type-check & Build | `tsc --noEmit`, `next build`, and greps the bundle for leaked secrets |
| Security Test Suite | Spins up a real PostgreSQL 16, applies your SQL, runs all 69 tests |
| Dependency Audit | Fails on high/critical in **production** dependencies only |
| Secret Scan | Fails if any `.env` file or live key is committed |
| Security Gate | Fails unless all four above succeeded |

## Step 10: 🔒 Make CI actually block bad merges

Without this step, CI reports failures but cannot stop anything.

1. 🌐 GitHub repo → **Settings** → **Branches**
2. **Add branch protection rule**
3. Branch name pattern: `main`
4. Tick **Require status checks to pass before merging**
5. Search for and select **Security Gate**
6. Also tick **Require branches to be up to date before merging**
7. **Create**

From now on, a commit that breaks tenant isolation **cannot merge to `main`**,
and therefore cannot reach Vercel.

---

## Verification checklist

- [ ] `.env.test` exists and points at a **test** database
- [ ] `ameya_app` role created with `NOSUPERUSER NOBYPASSRLS`
- [ ] `npm run test:security` shows **69 passed**
- [ ] The banner shows "non-superuser role — isolation tests are meaningful"
- [ ] GitHub Actions shows **Security CI** passing
- [ ] Branch protection requires **Security Gate**

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `.env.test not found` | Not created yet | `cp .env.test.example .env.test` |
| `does not look like a test database` | URL has no test marker | Name the database `ameya_test` |
| `ALLOW_DESTRUCTIVE_TESTS is not set` | Missing acknowledgement | Add it to `.env.test` |
| `connects as "postgres", which is a SUPERUSER` | **Working correctly** | Do Step 4 — create `ameya_app` |
| `relation "tenants" does not exist` | Schema not pushed to the test DB | Step 5 |
| Tests fail on RLS assertions | Security SQL not applied | Run `ALL-IN-ONE-SETUP.sql` on the test branch |
| CI fails on "Verify RLS coverage" | Fewer than 22 tables protected | The SQL did not fully apply |

---

## What the 69 tests cover

**Cross-tenant isolation (24)** — reading, updating and deleting another
tenant's records by exact ID; unfiltered `SELECT *`; aggregates; JOINs;
fail-closed with no context across all 22 tables; forging a `tenant_id`;
cross-tenant reference guards; and a coverage test that fails if any future
table with a `tenant_id` lacks a policy.

**Financial integrity (23)** — unbalanced entries; one-paisa imbalances;
single-leg transactions; that the balance check is genuinely *deferred*;
closed-period rejection including exact boundary dates; that the period lock is
*immediate*; overlapping periods; float drift across 10,000 additions; a ₹1 crore
three-way split; and ledger cache reconciliation.

**Audit immutability (22)** — UPDATE and DELETE blocked on `audit_logs`,
`contract_versions`, `journal_entries` and `permission_denials`; bulk deletes;
that appending still works; that the error code is specifically 42501; and that
every evidence table has *both* guards.
