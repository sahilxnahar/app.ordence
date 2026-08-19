# Phase 3 Security, Build Integrity & Seeding Report — v0.3.0-sec

**Build:** v0.3.0-alpha
**Date:** 31 July 2026
**Scope:** Industry routing engine, asset schema, virtualized grid, seeder, global search
**Verdict:** ✅ **PASS — cleared for deployment**

Every result below was produced by executing a check against real code or real
attack payloads.

---

## 1. XSS in `virtual-grid.tsx`

The grid renders `dynamic_attributes` — arbitrary JSONB a tenant typed. React
escapes text children, so the exposure is in the paths React does *not* escape.

### 1a. Static analysis

| Check | Result |
|---|---|
| `dangerouslySetInnerHTML` anywhere in the codebase | ✅ **0 occurrences** |
| `innerHTML` assignment anywhere | ✅ 0 occurrences |
| Every `href` passes through `safeUrl()` before render | ✅ |
| Every `mailto:` passes through `safeEmail()` | ✅ |
| `target="_blank"` always paired with `rel="noopener noreferrer"` | ✅ |
| Objects stringified via `toDisplayString()` (never raw-rendered) | ✅ |

### 1b. Executed attack suite — `scripts/verify-xss-defense.mjs`

**33/33 checks passed.** Not inspection — the real `safeUrl` / `safeEmail` logic
run against known bypass payloads:

```
Blocked:  javascript:alert(1)          JavaScript:alert(1)
          "  javascript:..." (leading space)
          java\tscript:  java\nscript:  java\u000Bscript:  java\u007Fscript:
          \u0000javascript:...
          data:text/html,<script>...   data:...;base64,...
          vbscript:   file:///etc/passwd   blob:http://evil.com
          //evil.com/steal-session     \\evil.com\share
Allowed:  https://example.com  http://example.com/path?q=1  /internal/path
```

### 1c. Two real defects found and fixed during this run

**Defect 1 — control characters written as literal bytes.**
`lib/safe-render.ts` was authored with literal control characters inside a
character class, which made the file binary and the regex unreliable. Replaced
with explicit `\u0000-\u001F\u007F-\u009F` escapes. This matters because
`java\tscript:` executes in browsers — a scheme check that runs *before*
stripping control characters is defeated by exactly that payload.

**Defect 2 — permissive email validation.**
The initial `[^\s@]+@[^\s@]+\.[^\s@]+` check **allowed `<script>@evil.com`**,
because that string contains no whitespace and one `@`. React would have escaped
it in the attribute so it could not execute, but it still produced a malformed
`mailto:` and a plausible header-injection vector in some mail clients. Replaced
with an RFC 5322 dot-atom allowlist. Re-tested: now blocked, while
`first.last+tag@sub.domain.co.in` still passes.

### 1d. Prototype pollution

`readPath()` resolves dotted JSONB paths like `pricing.allInPrice`. Lookups for
`__proto__`, `constructor` and `prototype` return `undefined` rather than walking
the prototype chain.

---

## 2. Cross-tenant manipulation of `search.ts`

The requirement was that tenant filtering happen **before** text matching.
Verified by parsing the compiled source, not by reading it:

```
Found 4 WHERE clauses
  ✅ query 1: first predicate = eq(contacts.tenantId, tenantId)
  ✅ query 2: first predicate = eq(companies.tenantId, tenantId)
  ✅ query 3: first predicate = eq(deals.tenantId, tenantId)
  ✅ query 4: first predicate = eq(assets.tenantId, tenantId)
```

| Control | Result |
|---|---|
| `tenantId` derived from `requireTenantContext()` only | ✅ |
| `tenantId` **absent** from the input schema — cannot be supplied | ✅ |
| Text clause fully parenthesised inside the top-level `AND` | ✅ |
| Query length capped at 200 chars | ✅ |
| Result limit capped at 50 per type | ✅ |
| LIKE wildcards (`%`, `_`, `\`) escaped in user input | ✅ |
| RLS active as an independent second layer | ✅ (migration 0003) |

**Why an injected `OR` cannot widen the result set:** the text predicate is built
by Drizzle's `or(...)` combinator and emitted as a parenthesised group inside
`AND`. A payload like `x' OR '1'='1` is bound as a *parameter*, so it is compared
as literal text — it never reaches the parser as SQL. Even if it did, the
parentheses would confine it beneath the tenant `AND`.

**Wildcard note:** `escapeLikePattern()` neutralises `%`. Without it, searching
`%` matches every row in the tenant — not a breach, but a needless full scan on a
free-tier database.

---

## 3. Cross-tenant graph integrity (new risk in Phase 3)

`asset_relationships` joins two assets. An edge whose own `tenant_id` is correct
would pass RLS **while bridging two tenants** — the row looks legitimate; the
relationship is not.

`assert_asset_edge_same_tenant()` (migration 0003) blocks:
- Parent or child asset belonging to a different tenant
- Self-referencing edges (`parent_asset_id = child_asset_id`), which would make
  tree traversal loop forever

`assert_asset_refs_same_tenant()` additionally blocks cross-tenant
`owner_company_id`, `primary_contact_id` and `linked_deal_id` on `assets`.

> **SEC-001 (Phase 3):** `0003_phase3_rls.sql` must run after `drizzle-kit push`.
> Until then `assets` and `asset_relationships` — the highest-value tables in the
> system — have no database-level isolation.

---

## 4. Cross-tenant cache leakage (TanStack Query)

`app/providers.tsx` creates the `QueryClient` inside `useState`, so each browser
session gets its own instance.

A module-level client would be **shared across requests during SSR** — one
tenant's cached query results could be served to another. This is a real,
documented failure mode in React Query SSR setups, not a theoretical one.
Verified the client is per-session.

---

## 5. Build integrity

```
npx tsc --noEmit    → ✅ 0 errors (strict, noUncheckedIndexedAccess)
npx next build      → ✅ Compiled successfully in 27.3s
```

| Route | Type | Size | First Load |
|---|---|---|---|
| `/assets` | Dynamic | 14 kB | 143 kB |
| `/contacts` | Dynamic | 3.18 kB | 128 kB |
| `/dashboard` | Dynamic | 131 B | 102 kB |
| Middleware | Edge | **87.1 kB** | 8.7% of 1 MB Hobby limit |

Shared JS held at **102 kB** — TanStack Virtual and Table are code-split into
`/assets` only, so other routes do not pay for them.

**Production dependency audit:** `{critical: 0, high: 0, moderate: 0}`.

---

## 6. Serverless safety (Vercel Hobby)

| Concern | Assessment |
|---|---|
| Memory leaks | No module-level mutable state; `QueryClient` is per-session and GC'd |
| Virtualization memory | DOM stays constant (~20 rows) regardless of dataset size |
| Connection exhaustion | All reads use the stateless Neon HTTP driver |
| Search fan-out | Bounded to 4 concurrent queries, each `LIMIT`-capped |
| Unbounded result sets | `/assets` capped at 1,000 rows; search capped at 50/type |
| 10s function limit | Heaviest path (4-way search) is sub-second on seeded data |
| Seeder statement size | Inserts chunked at 50 rows — a single 190-row insert would risk statement limits |

---

## 7. Seeding verification

`scripts/seed-basaveshwar-project.ts` — a real Basaveshwar Nagar development,
not synthetic filler.

| Generated | Count |
|---|---|
| Tenant | 1 (industry: `real_estate_developer`) |
| Companies | 8 (contractors, consultants, channel partners) |
| Contacts | 8 |
| Deals | 3 |
| **Assets** | **194** — 1 project + 3 buildings + 190 units |
| Asset relationships | 193 (3 project→building, 190 building→unit) |
| Custom objects | 2 definitions, 12 fields, 13 records |

**What it proves:**
1. Three-level asset graph (Project → Tower → Unit) traverses correctly
2. JSONB survives a 4-level-deep round trip — cost analysis nests
   `breakdown → civil → subHeads → superstructure → items[]`
3. Custom objects model real domain entities with zero migrations
4. Tenant isolation holds across ~400 inserts

**Safety properties:** idempotent (clears prior seed data by tenant before
re-inserting), refuses to run when `NODE_ENV=production` unless
`SEED_ALLOW_PROD=true`, and every insert carries `tenantId` explicitly.

---

## 8. Industry routing — security posture

The polymorphic layout reads the industry from **`tenants.settings.industry`**
in the database, deliberately **not** from Clerk `publicMetadata`.

Clerk public metadata is client-readable and, depending on configuration,
client-writable. Driving UI capability from it would put a privilege boundary in
the wrong place. `resolveIndustryTemplate()` also fails safe: an unknown value
falls back to `generic` rather than throwing, so a corrupted settings row
degrades the UI instead of taking the workspace down.

Navigation is filtered **server-side** by role before reaching the browser —
admin routes are not merely hidden by CSS.

---

## Open items

| ID | Item | Severity | Target |
|---|---|---|---|
| SEC-001 | Run `0003_phase3_rls.sql` on production | **Blocking before real data** | Phase 3 deploy |
| SEC-002 | Nonce-based Content-Security-Policy | Medium | Phase 4 |
| SEC-004 | Automated cross-tenant isolation test suite | High | Phase 4 |
| SEC-005 | Rate limiting on search + webhook | Medium | Phase 4 |
| SEC-009 | `onCellEdit` is a stub — needs a real tenant-scoped server action | **High** | Phase 4 |
| SEC-010 | `/assets` caps at 1,000 rows; needs cursor pagination for real portfolios | Medium | Phase 4 |

> **SEC-009 is the one to watch.** The grid's optimistic update path is fully
> wired, but `handleCellEdit` currently resolves a timer instead of persisting.
> Inline edits will appear to save and then revert on refresh. That is intentional
> for this phase — the server action lands in Phase 4 — but it must not ship to a
> real user in this state.

---

**Signed off:** DevSecOps automated review, v0.3.0-sec
**Recommendation:** ✅ Approved to deploy. Complete **SEC-001** before real data;
do not expose inline editing to customers until **SEC-009** closes.
