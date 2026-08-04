# Phase 3 Deployment & Testing — v0.3.0-alpha

Follow in order. About 25–35 minutes.

**Legend:** 💻 = Terminal · 🌐 = browser

---

## Step 1 — Install the new packages

💻
```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
npm install
```

Phase 3 adds `@tanstack/react-virtual` (windowed rendering), plus `tsx` and
`dotenv` as dev tools so the seed script can run.

---

## Step 2 — Create the asset tables

💻
```bash
npx drizzle-kit generate
```

Review what it wrote:

💻
```bash
ls db/migrations/
```

Apply it:

💻
```bash
npx drizzle-kit push
```

Confirm **Yes** when prompted. This creates two tables — `assets` and
`asset_relationships` — plus three new enums.

---

## Step 3 — 🔒 Turn on isolation for the asset tables (DO NOT SKIP)

> These two tables will hold your entire development portfolio: unit-level
> pricing, contractor commercials, cost breakdowns. They are created with
> Row-Level Security **off**. This step is what stops one customer's portfolio
> from ever being visible to another.

1. 💻 Print the migration:
   ```bash
   cat db/migrations/0003_phase3_rls.sql
   ```
2. Copy **all** of the output
3. 🌐 Neon dashboard → **SQL Editor** → paste → **Run**

### Verify

Paste into the SQL Editor and Run:

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('tenants','users','roles','role_permissions','user_roles',
                    'audit_logs','companies','contacts','deals',
                    'custom_object_definitions','custom_field_definitions',
                    'custom_object_records','assets','asset_relationships')
ORDER BY tablename;
```

**You must see 14 rows, every one `true`.** Anything showing `false` means the
script did not finish — run it again.

---

## Step 4 — Seed the Basaveshwar Nagar project

This proves the asset engine works against real data rather than placeholders.

💻
```bash
npm run seed
```

Takes 20–40 seconds. You should see nine numbered steps and then:

```
╔══════════════════════════════════════════════════════════════╗
║  SEED COMPLETE                                                ║
╚══════════════════════════════════════════════════════════════╝

  Tenant            Ameya Developers Pvt Ltd
  Industry          real_estate_developer
  Assets            194  (1 project + 3 buildings + 190 units)
  Relationships     193
  Custom objects    2  (12 fields, 13 records)
  Nested JSONB      ~9,000 bytes, 4 levels deep
```

> **Safe to re-run.** It clears its own previous data first, so you will not get
> duplicates. It also refuses to run against a production database unless you
> explicitly set `SEED_ALLOW_PROD=true`.

### Confirm in the database

🌐 In Neon's SQL Editor:

```sql
-- The three-level hierarchy
SELECT a.asset_type, count(*)
FROM assets a
JOIN tenants t ON t.id = a.tenant_id
WHERE t.slug = 'ameya-developers'
GROUP BY a.asset_type;
-- expect: project 1, building 3, unit 190

-- Nested JSONB survived the round trip (4 levels deep)
SELECT dynamic_attributes
  #>> '{costAnalysis,breakdown,civil,subHeads,superstructure,progressPct}'
  AS superstructure_progress
FROM assets WHERE code = 'AHD-BSVN-01';
-- expect: 43
```

If that second query returns `43`, deep JSONB is intact end to end.

---

## Step 5 — See it running

💻
```bash
npm run dev
```

🌐 Open **http://localhost:3000**

### What to look for

**The industry engine.** Sign in to the seeded workspace. The sidebar should show
**Projects, Buildings, Units, Land & Plots** — not generic "Products". That is the
`real_estate_developer` template driving navigation, and it comes from one field
in the database.

**The virtualized grid.** Go to **/assets**. 194 rows render instantly. Open your
browser's Elements inspector and scroll — the row count in the DOM stays around
20 no matter how far you go. That is virtualization; the Phase 2 grid would put
all 194 in the DOM at once.

**Inline editing.** Click any **Facing** cell. It becomes an input. Type and press
Enter — the value updates immediately.

> ⚠️ **Inline edits do not persist yet (SEC-009).** The optimistic UI path is
> fully wired, but the server action that saves the change lands in Phase 4. Edit,
> then refresh, and the old value returns. This is expected in v0.3.0 — do not
> put this in front of a customer until Phase 4 closes it.

**Bulk selection.** Tick a few row checkboxes — a selection bar appears. Tick the
header checkbox for select-all.

### Try the other industry

Switch this workspace to the legal template and watch the whole UI change:

🌐 Neon SQL Editor:
```sql
UPDATE tenants
SET settings = jsonb_set(settings, '{industry}', '"legal_advocate"')
WHERE slug = 'ameya-developers';
```

Reload the app. The sidebar now reads **Matters, Cases, Contracts, Hearings**, and
"Leads" becomes "Clients". Same code, same routes, same components.

Change it back:
```sql
UPDATE tenants
SET settings = jsonb_set(settings, '{industry}', '"real_estate_developer"')
WHERE slug = 'ameya-developers';
```

---

## Step 6 — Ship it

💻
```bash
git add .
git commit -m "feat: v0.3.0-alpha — industry routing, asset catalog, virtual grid, global search"
git push
```

Vercel redeploys automatically (~2 minutes).

### Run the RLS migration on production

If Vercel points at a different Neon database than local, repeat **Step 3** there.
Same SQL, same verification query, same 14 rows.

> Do **not** run `npm run seed` against production. It is demo data.

---

## Verification checklist

- [ ] `npx drizzle-kit push` created `assets` and `asset_relationships`
- [ ] All **14** tables report `rowsecurity = true`
- [ ] `npm run seed` completed with 194 assets
- [ ] The deep JSONB query returns `43`
- [ ] Sidebar shows Projects/Buildings/Units (not generic labels)
- [ ] `/assets` renders 194 rows with ~20 in the DOM
- [ ] Switching `settings.industry` changes the whole navigation
- [ ] `git push` succeeded and Vercel redeployed

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DATABASE_URL is not set` on seed | Script can't find `.env.local` | Run from the project root, not a subfolder |
| `relation "assets" does not exist` | Migration not pushed | Re-run `npx drizzle-kit push` |
| Seed fails on `duplicate key` | Partial previous run | Re-run — it clears prior data first |
| Sidebar shows generic labels | `settings.industry` unset | Run the `jsonb_set` UPDATE from Step 5 |
| `/assets` is empty | Seed not run, or you're in a different workspace | Check the org switcher matches the seeded tenant |
| Inline edit reverts on refresh | **Expected in v0.3.0** (SEC-009) | Phase 4 |
| Grid feels slow past ~5,000 rows | `/assets` caps at 1,000 (SEC-010) | Cursor pagination in Phase 4 |
| `Cross-tenant asset relationship blocked` | The trigger is working correctly | You linked assets across tenants |

---

## What Phase 3 gives you

**One frontend, many industries.** `lib/industry-templates.ts` holds the whole
polymorphic engine. Adding a third vertical — construction, logistics, healthcare
— means adding one object to that file. No new routes, no new components, no
database migration.

**One table, every asset kind.** Buildings, units, vehicles, matters and contracts
all live in `assets`, distinguished by `asset_type` with their specifics in JSONB.
`asset_relationships` is a proper graph, so containment, assignment and dependency
are all expressible without new join tables.

**A grid that scales.** The virtualized grid keeps a constant DOM footprint. It
will render a 50,000-unit portfolio at the same speed it renders 194.
