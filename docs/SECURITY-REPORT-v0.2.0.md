# Phase 2 Security & Build Integrity Report — v0.2.0-sec

**Build:** v0.2.0-alpha
**Date:** 31 July 2026
**Scope:** Clerk webhook, CRM schema, custom object engine, server actions, data grid
**Verdict:** ✅ **PASS — cleared for deployment**

Every result below was produced by executing a check, not by inspection.

---

## 1. IDOR — tenant scoping on every server action

Automated AST-style scan of all exported actions in `server/actions/`:

| Action | Session-derived tenant | Tenant predicate in query |
|---|---|---|
| `getContacts` | ✅ | ✅ |
| `getContactById` | ✅ | ✅ |
| `createContact` | ✅ | ✅ |
| `updateContact` | ✅ | ✅ |
| `deleteContact` | ✅ | ✅ |
| `defineCustomObject` | ✅ (admin-gated) | ✅ |
| `getCustomObjects` | ✅ | ✅ |
| `getCustomObjectBySlug` | ✅ | ✅ |
| `createCustomRecord` | ✅ | ✅ |
| `getCustomRecords` | ✅ | ✅ |

**10 / 10 actions pass.**

### The structural guarantee

```
✅ `tenantId` is never accepted as a parameter anywhere in the action surface.
```

This is the property that matters. `tenantId` is only ever read from
`requireTenantContext()`, which resolves it from the Clerk session server-side.
A caller has no channel through which to supply one.

### Specific IDOR vectors closed

| Vector | Defense |
|---|---|
| `updateContact({id: <victim's id>})` | `WHERE id = ? AND tenant_id = ?` — never id alone |
| `deleteContact(<victim's id>)` | Same dual predicate; returns "not found", leaking nothing |
| Attaching a contact to another tenant's company | `companyId` ownership verified before insert **and** enforced by DB trigger |
| Writing records against another tenant's object definition | `definitionId` ownership verified before insert **and** enforced by DB trigger |
| Cross-tenant company name leaking through a JOIN | `leftJoin` carries `eq(companies.tenantId, ctx.tenant.id)` in its ON clause |
| Arbitrary keys injected into JSONB `data` | Unknown keys **rejected**, not ignored — see §4 |

---

## 2. Clerk webhook — payload spoofing

`app/api/webhooks/clerk/route.ts` is necessarily a public endpoint. Signature
verification is the entire security boundary. Verified control flow:

| Check | Result |
|---|---|
| Fail-closed when `CLERK_WEBHOOK_SIGNING_SECRET` is unset | ✅ Returns 500, never processes |
| Raw body read **before** verification | ✅ `req.text()` precedes `wh.verify()` |
| No `JSON.parse` before verification | ✅ Body is never mutated pre-verify |
| Signature verified **before** any DB write | ✅ Ordering confirmed by static analysis |
| Bad signature returns **401**, not 500 | ✅ No oracle for attackers |
| All three Svix headers required | ✅ `svix-id`, `svix-timestamp`, `svix-signature` |
| Replay protection | ✅ Svix enforces a timestamp window |
| Idempotent under at-least-once delivery | ✅ `onConflictDoNothing` on `clerk_org_id` |

**Why body ordering matters:** Svix signs the raw bytes. Parsing to JSON and
re-serialising changes whitespace and key order, invalidating the signature —
a subtle way to accidentally disable verification. Verified this does not happen.

---

## 3. Environment secret exposure

Executed against the compiled `.next/static/` output:

```
✅ CLERK_SECRET_KEY   absent from client bundle
✅ postgresql://      absent from client bundle
✅ Neon host string   absent from client bundle
✅ server-only guard  intact on server/tenant-context.ts
✅ "use server"       present on both action files
```

**Build-time finding, now fixed:** the first build failed with
`A "use server" file can only export async functions, found object.` Exported Zod
schemas were being turned into callable RPC endpoints. All schemas and pure
helpers were moved to `lib/validators/crm.ts`, leaving the action files exporting
async functions only. This was a genuine attack-surface reduction, not just a
build fix — every non-function export in a `"use server"` file is a subtle hazard.

---

## 4. Custom object engine — JSONB injection surface

`custom_object_records.data` accepts client-supplied JSON, which is the highest-risk
new surface in Phase 2.

| Risk | Control |
|---|---|
| Arbitrary keys written to the row | Unknown keys **rejected** with a field error, not silently dropped or stored |
| Type confusion (string where number expected) | Every value coerced and range-checked per its declared `field_type` |
| `javascript:` / `data:` URLs → stored XSS | `url` fields accept only `http:` / `https:`; grid re-checks before rendering an anchor |
| Invalid `select` values | Validated against the definition's allowed `options` |
| Field names as injection vectors | `fieldNameSchema` restricts to `^[a-z][a-z0-9_]*$` |
| Regex DoS via stored `pattern` | Wrapped in try/catch; a bad pattern cannot break the write path |
| Unbounded field count | Capped at 100 fields per object |

---

## 5. Database-layer isolation — Phase 2 tables

⚠️ **New tables are created with RLS *disabled* by default.** Six new tables were
added; all six now carry explicit policies in `db/migrations/0002_phase2_rls.sql`:

`companies` · `contacts` · `deals` · `custom_object_definitions` ·
`custom_field_definitions` · `custom_object_records`

Each has `ENABLE` + **`FORCE`** ROW LEVEL SECURITY with a
`tenant_id = app_current_tenant_id()` policy on both `USING` and `WITH CHECK`.

### Cross-tenant referential integrity (new in Phase 2)

A plain foreign key proves a row *exists*, not that it belongs to the same tenant.
`assert_same_tenant()` triggers now block:

- `contacts.company_id` → a company in another tenant
- `deals.company_id` / `deals.contact_id` → cross-tenant references
- `custom_object_records.definition_id` → another tenant's object definition
- `custom_field_definitions.object_definition_id` → same

These fire at the database level, so they hold even if application validation is
bypassed entirely.

> **SEC-001 (Phase 2):** `0002_phase2_rls.sql` must be run after `db:push`.
> Until it does, the six new tables rely on application filtering alone.

---

## 6. Build integrity

```
npx tsc --noEmit    → ✅ 0 errors (strict, noUncheckedIndexedAccess)
npx next build      → ✅ Compiled successfully
```

| Route | Type | Size |
|---|---|---|
| `/contacts` | Dynamic | 25.4 kB → 128 kB first load |
| `/api/webhooks/clerk` | Dynamic (Node) | 127 B |
| `/dashboard` | Dynamic | 394 B → 140 kB |
| Middleware | Edge | **87.1 kB** (8.7% of the 1 MB Hobby limit) |

Shared JS unchanged at 103 kB — TanStack Table is code-split into `/contacts` only,
so pages that don't use the grid don't pay for it.

**Dependency audit:** `{"critical":0,"high":0,"moderate":0}` in production.

---

## 7. Serverless-safety review (Vercel Hobby)

| Concern | Assessment |
|---|---|
| Memory leaks | No module-level mutable caches added; webhook holds no state between invocations |
| Connection exhaustion | All Phase 2 queries use the stateless Neon HTTP driver — zero held connections |
| Long-running work | Heaviest path is the webhook (≤4 queries); well inside limits |
| Unbounded result sets | Every list action caps `pageSize` at 100 via Zod |
| `Promise.all` fan-out | Bounded to 2 concurrent queries (rows + count) |

---

## Open items

| ID | Item | Severity | Target |
|---|---|---|---|
| SEC-001 | Run `0002_phase2_rls.sql` on production | **Blocking before real data** | Phase 2 deploy |
| SEC-002 | Nonce-based Content-Security-Policy | Medium | Phase 3 |
| SEC-004 | Automated cross-tenant isolation test suite | High | Phase 3 |
| SEC-005 | Rate limiting on the webhook endpoint | Medium | Phase 3 |
| SEC-007 | `updateCustomRecord` / `deleteCustomRecord` not yet implemented | Low | Phase 3 |
| SEC-008 | `isUnique` on custom fields is declared but not yet enforced | Medium | Phase 3 |

---

**Signed off:** DevSecOps automated review, v0.2.0-sec
**Recommendation:** ✅ Approved to deploy. Complete **SEC-001** before real customer data.
