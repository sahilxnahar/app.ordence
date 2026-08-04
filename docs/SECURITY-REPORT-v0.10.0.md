# Security Report — v0.10.0-alpha

**Phase 10 — Executive Dashboards & Financial Analytics**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build (`next build`) | **Clean — 28 routes** |
| Security tests (real PostgreSQL 16) | **126 / 126 passing** |
| UI & logic tests | **102 / 102 passing** |
| Tables under RLS | **25** |
| Analytics views with `security_invoker` | **3 / 3** |
| Recharts in the shared bundle | **No — 1 of 33 routes** |
| Server secrets in client bundle | **None** |
| Production dependency vulnerabilities | **0** |
| Analytics actions without a tenant guard | **0 of 4** |

---

## ⭐ The mandatory verification: does RLS cascade into views?

**No. It does not — and the default fails silently in the worst possible
direction.**

A PostgreSQL view executes with the privileges of its **owner**, not the
caller. A view over `journal_entries` owned by the table owner returns *every
tenant's entries* to anyone permitted to select from it. The RLS policies
underneath are never consulted.

This was measured before a single view was written. Two otherwise identical
views over `contracts`, queried by a non-superuser session pinned to **one**
tenant:

```
naive view      (no option)                ->  6 tenants visible
safe  view      (security_invoker = true)  ->  1 tenant  visible
base table      (RLS applies normally)     ->  1 tenant  visible
```

**Nothing errors. The dashboard renders. The numbers are simply the whole
platform's** — every tenant's assets and every tenant's cash — shown to one
customer as their own.

All three analytics views are therefore created `WITH (security_invoker = true)`,
and the SQL file refuses to run on PostgreSQL < 15 rather than creating views
that leak.

### Proven, not asserted

`tests/security/analytics-views.test.ts` — **13 tests, real PostgreSQL 16,
non-superuser connection.** The first one builds both kinds of view in the
same database and queries them in the same session, so the difference is
demonstrated rather than claimed.

Fixtures give Tenant B deliberately unmistakable figures:

| Assertion | Result |
|---|---|
| Tenant A asset total | **₹5,000,000** — not B's ₹9,999,999 |
| Tenant A ledger debits | **₹1,000** — not B's ₹7,777,777 |
| Tenant A contract value | **₹250,000** — not B's ₹8,888,888 |
| Tenant B sees its own figures | **Yes** — isolation is symmetric, not "empty for everyone" |
| No tenant context | **0 rows from all three views** |
| Garbage tenant context | **0 rows** |
| Ledger view vs. base tables | **Identical totals** |

Aggregates additionally run inside `withTenant()` with an explicit
`WHERE tenant_id` predicate. Two independent layers; either sufficient alone.

---

## 🔴 A far more dangerous finding: `drizzle-kit push` drops every RLS policy

While verifying that `push` would not recreate the views without
`security_invoker`, a much worse behaviour surfaced.

`drizzle-kit push` compares the live database against the Drizzle schema and
removes anything it does not recognise. Our RLS policies live in
`SQL-FILES/`, not in the Drizzle schema, so **`push` classifies all of them as
drift and drops them.** Measured on a real database:

```
before  npm run db:push  ->  25 tables with RLS,  25 policies
after   npm run db:push  ->   0 tables with RLS,   0 policies
```

Observed in the output:

```
DROP POLICY "users_tenant_isolation" ON "users" CASCADE;
DROP POLICY "companies_tenant_isolation" ON "companies" CASCADE;
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_amount_positive";
ALTER TABLE "portal_links" DROP CONSTRAINT "portal_links_expiry_sane";
```

Triggers survive. Every policy does not.

**The application keeps working.** Every page renders, every query succeeds.
The only difference is that tenants can read each other's data, and nothing
anywhere says so.

### Why this has not already caused harm

The deployment guides for Phases 8 and 9 instruct running
`ALL-IN-ONE-SETUP.sql` **after** `db:push`, which restores everything. The
correct order has been followed by accident of documentation rather than by
design — and a single standalone `db:push` ("just a quick schema tweak")
would remove every tenant boundary with no symptom at all.

### What was done about it

1. **`npm run db:verify`** — a new script (`scripts/verify-security.ts`) that
   interrogates the live database and exits non-zero if RLS, policies,
   `WITH CHECK` clauses, `security_invoker`, or the integrity triggers are
   missing. Verified to fail on the damaged database and pass after repair.
2. **`npm run db:push` now prints a warning** on completion telling the
   operator to re-apply the SQL and run the verifier.
3. **CI runs `db:verify`** immediately after applying the setup SQL, so a
   regression fails the pipeline rather than reaching production.
4. The deployment guide states the ordering requirement explicitly, with the
   measured numbers.

**Recommendation:** treat `db:push` as a development tool. For production,
`db:generate` produces a reviewable migration file, and the setup SQL should
follow every schema change without exception.

---

## The mandatory bundle check: does Recharts blow up the client bundle?

**No — it is code-split to the one route that uses it.**

```
Routes loading the Recharts chunk:  1 of 33   (/dashboard)
Recharts chunk:                     105 kB gzipped
Shared-by-all baseline:              98 kB gzipped   (UNCHANGED from Phase 9)
```

| Route | First Load JS | Change |
|---|---|---|
| `/dashboard` | 233 kB | +23 kB (three charts) |
| `/portal/[token]` | 120 kB | **unchanged** |
| `/contracts/[id]` | 201 kB | unchanged |
| shared by all | 102 kB | **unchanged** |

The two facts that matter: Recharts is **absent from the shared chunks**, so
no other route pays for it; and the **public portal is unaffected**, which is
the page external clients load on unknown connections.

233 kB on an internal, authenticated dashboard that a user opens once per
session is a reasonable price for three charts. If it ever needs reducing,
the lever is `next/dynamic` on the chart components — but that trades a
loading flash for bytes on a route that is already behind a login.

---

## Chart design: colour was computed, not chosen

Every hue was run through a colour-vision validator against this
application's real chart surfaces before being written down.

```
LIGHT (6 slots, surface #ffffff)
  lightness band .......... PASS
  chroma floor ............ PASS
  CVD separation .......... PASS   worst adjacent ΔE 9.1 (protan)
  normal-vision floor ..... PASS   worst adjacent ΔE 19.6
  contrast vs surface ..... WARN   aqua 2.82, yellow 2.17, magenta 2.69

DARK (6 slots, surface #1a1a1a)
  every check ............. PASS   all ≥ 3:1
```

**The light-mode warning is not dismissable.** Three hues sit below 3:1
against white, which means those marks alone cannot carry meaning for a
low-vision reader. The obligation is relief, so every chart ships:

- a legend **and** direct value labels — identity is never colour-alone
- a **"View as table"** toggle — the same numbers as text

Those affordances are a stated accessibility requirement, not decoration.

Other rules followed: categorical hues assigned in **fixed order, never
cycled**; the donut capped at **five slices** with the tail folded to a grey
"Other" (the fourth and second slots fail the all-pairs floor together —
normal-vision ΔE 13.7); **no dual-axis chart** anywhere; status colours
reserved and always paired with a word or icon.

---

## Other security properties

**Money never becomes a float on the way to the screen.** NUMERIC arrives as
a string, is summed in **BigInt paise**, and is formatted for display from
the string. The single float conversion is in the chart components, where a
pixel height is required — drawn deliberately at the point where a value
stops being money and becomes geometry. Tooltips and table views show the
exact string, so what a user *reads* is always exact even where what they
*see* is approximate.

**The audit feed does not ship raw metadata.** `audit_logs.metadata` carries
recipient addresses, portal token prefixes and previous field values. The
action derives one sentence per known event and sends only that; unknown
events get no text rather than a passthrough. The feed also requires
`audit:read`, which most roles do not hold — a refusal there renders as a
neutral message, not an error.

**Views expose `tenant_id` deliberately.** RLS already restricts it to one
value, but a view that omitted the column would make an accidental
cross-tenant aggregate impossible to spot in a query plan or a debugging
session.

**No materialized views.** A materialized view stores its rows, and RLS
cannot apply to stored aggregates the way `security_invoker` applies to a
live query — you would end up with one physical copy of every tenant's data
and a filter in front of it, which is the exact shape of the leak this phase
exists to avoid.

---

## Outstanding

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| **SEC-022** | **`db:push` drops RLS — use `db:generate` in production** | **High (new)** |
| SEC-016 | Enable branch protection requiring "Security Gate" | High |
| SEC-020 | No rate limiting on `/portal/[token]` | Medium |
| SEC-002 | Nonce-based Content-Security-Policy | Medium |
| SEC-005 | Rate limiting on search, webhook and upload tokens | Medium |
| SEC-018 | Orphaned blobs — reconciliation sweep | Low |
| SEC-019 | No virus scanning on upload | Low |
| SEC-023 | Analytics views re-aggregate on every load (no caching) | Low (new) |

### On SEC-023

The views recompute on every dashboard load. For a single tenant's row counts
— thousands of journal entries, not billions — that is a few milliseconds
against indexed columns, and it is always correct.

It will not scale indefinitely. The upgrade path is a per-tenant materialized
view or a summary table with a reconciliation job, and both are a real
project rather than a configuration change. Worth revisiting when a single
tenant passes roughly a million journal entries.

---

## Honest limitations

- **The dashboard has not been rendered in a real browser.** TypeScript,
  the build and the data layer are verified; the *visual* result — label
  collisions, chart geometry at narrow widths — has not been eyeballed. The
  dataviz procedure explicitly ends with "render it and look at it", and that
  step is outstanding on the deployed environment.
- **No test drives the charts in jsdom.** Recharts requires layout
  measurement that jsdom does not provide, so chart rendering is not
  covered by the UI suite. The data feeding them is.
- **`db:verify` cannot see how the application connects.** It reports the
  role *it* is running as. If the app connects as a superuser in production,
  every policy is decorative and this script will not tell you.
- **Vercel Hobby forbids commercial use.** Unchanged.
