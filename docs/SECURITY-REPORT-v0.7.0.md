# Security Report — v0.7.0-alpha

**Phase 7 — The CRUD Surface & Application UI**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build (`next build`) | **Clean — 22 routes** |
| UI behaviour tests | **19 / 19 passing** |
| Security tests (Phases 1–6) | **69 / 69 passing** |
| Server secrets in client bundle | **None** |
| Production dependency vulnerabilities | **0** |
| Exported server actions without a tenant guard | **0 of 16** |
| `tenantId` sourced from request payload | **Never** |
| Non-async exports in `"use server"` files | **0** |

---

## The two mandatory Phase 7 verifications

### 1. The dynamic JSONB form renders 3+ input types

**Required:** at least 3. **Delivered:** 6, verified by rendering.

`tests/ui/dynamic-form.test.tsx` mounts the real `DynamicFieldSet` with real
field definitions and inspects the resulting DOM:

| Definition `fieldType` | Rendered element | Asserted |
|---|---|---|
| `text` | `<input type="text">` | ✅ |
| `number` | `<input type="number">` | ✅ |
| `date` | `<input type="date">` | ✅ |
| `select` | `<select>` with the defined options | ✅ |
| `boolean` | `<input type="checkbox">` | ✅ |
| `textarea` | `<textarea>` | ✅ |

Also verified: each of the three built-in industry field sets renders ≥3
distinct input types; every definition produces an actual control; two
industries produce genuinely different forms from the same component; the
same definitions build the server-side validation schema; and keys not
described by any definition are **stripped** rather than written to JSONB.

That last one matters. `dynamic_attributes` is a JSONB column, so the
database will accept any shape at all. The test feeds it
`<img src=x onerror=alert(1)>` as a key and confirms it does not survive.

### 2. The double-entry form physically prevents unbalanced submission

`tests/ui/journal-balance.test.tsx` drives the real form with real keyboard
input, then inspects the submit button. 9 tests:

| Scenario | Submit |
|---|---|
| Empty form | **Blocked** |
| Debits 1000.00 vs credits 900.00 | **Blocked** |
| Debits 1000.01 vs credits 1000.00 (one paisa) | **Blocked** |
| Zero-value entry (0 = 0, technically balanced) | **Blocked** |
| Balanced amounts, no ledger chosen | **Blocked** |
| Balanced entry dated inside a closed period | **Blocked** |
| Debits 1000.00 = credits 1000.00 | **Allowed** |
| Balanced, then edited out of balance | **Re-blocked** |

**Stated honestly: a disabled button is the weakest of three gates.** Anyone
with dev-tools can re-enable it. It stops honest mistakes and nothing else.
The gates that actually protect the ledger are unchanged from Phase 4/5 and
still covered by the security suite:

2. `postTransactionSchema.superRefine` re-checks the balance server-side in
   exact BigInt arithmetic.
3. A `DEFERRABLE INITIALLY DEFERRED` constraint trigger refuses the `COMMIT`.

---

## Defects found and fixed during this phase

### 🔴 The accounting form was completely unusable

`watch("legs")` does not reliably re-render on changes to a field array
managed by `useFieldArray`. The running balance therefore read **₹0.00 no
matter what was typed**, `isBalanced` never became true, and the submit
button could never enable.

This is worth dwelling on. Every static check passed. TypeScript was clean,
the build was clean, and reading the code the logic looks correct — the
`disabled` expression is right, the BigInt arithmetic is right. The form
simply did not work, and would have shipped looking finished while silently
refusing to post anything.

It was caught because the test typed `1000.00` into two inputs and asked
whether the button had enabled. Fixed with `useWatch`.

### 🟠 `required` never reached any form control

All five field components passed `required` to the label, producing a visual
asterisk, but never to the `<input>`/`<select>`/`<textarea>`. Consequences:
screen readers did not announce required fields, and native browser
validation never fired. Fixed across `TextField`, `TextareaField`,
`SelectField`, `CheckboxField` and `MultiSelectField`, with both `required`
and `aria-required` now set.

### 🟠 Six Zod schemas exported from `"use server"` files

`server/actions/accounting.ts`, `periods.ts` and `documents.ts` each exported
schema constants. Next.js compiles **every non-async export in a
`"use server"` file into a publicly reachable RPC endpoint**, and fails the
build once a page imports such a file.

The build was passing before this phase only because no page imported those
actions yet — the new accounting page would have broken it.

Rather than assume the failure mode, it was reproduced with a throwaway probe
route, which produced:

```
Error: A "use server" file can only export async functions, found object.
```

All six moved to `lib/validators/`. A seventh instance
(`ASSIGNABLE_ROLES` in `team.ts`) was introduced during this phase and caught
by the build.

**`tsc --noEmit` does not catch this.** A repository-wide scan for non-async
exports in `"use server"` files is now part of the release checks and returns
zero.

---

## New attack surface reviewed

Sixteen new server actions across four files. Every one:

- derives `tenantId` from `requireTenantContext()`, never from the payload
- writes an explicit tenant predicate in its `WHERE`, in addition to RLS
- validates input with Zod before touching the database

Verified mechanically — all 16 checked, 0 without a guard.

### Role assignment (`server/actions/team.ts`)

The highest-risk addition in this phase, since it can grant privilege. Three
rules, all enforced server-side after re-deriving the actor from the session:

1. **No upward grants.** Nobody may assign a role more senior than their own,
   nor modify anyone already more senior. Without this, a `tenant_admin`
   could mint a `platform_super_admin` and leave the tenant entirely.
2. **No self-modification.** Not even an owner. Role changes always involve
   two people.
3. **The last owner cannot be demoted or suspended.** A tenant with zero
   owners has nobody who can restore one.

`platform_super_admin` is absent from `ASSIGNABLE_ROLES` entirely.

Every role change is written to the audit log at `critical` severity with the
**previous and new value** — "changed to manager" alone does not tell an
auditor what was lost.

### Audit-log noise

UI permission gating uses the pure `can()`, not `checkPermission()`.
`checkPermission()` records a denial every time it returns false, which is
correct at the top of a server action and wrong for deciding whether to render
a button — every page load by every unprivileged user would write an audit
row, burying the denial log under noise within a week.

---

## Outstanding

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| SEC-016 | Enable branch protection requiring "Security Gate" | High |
| SEC-002 | Nonce-based Content-Security-Policy | Medium |
| SEC-005 | Rate limiting on search and webhook | Medium |
| SEC-013 | Bank reconciliation UI | Medium |
| SEC-011 | Binary PDF output (currently print-ready HTML) | Low |
| SEC-015 | Permission override admin UI | Low |

**Closed this phase:** SEC-014 (period-close UI).

---

## Honest limitations

- The UI tests run in **jsdom, not a real browser**. They verify DOM state and
  React behaviour; they do not catch CSS making a control invisible or a real
  browser's layout quirks.
- No end-to-end test yet drives a real browser against a real database. The
  layers are each tested; their composition is not.
- **Vercel Hobby forbids commercial use.** This is a licensing fact, not a
  technical one, and no amount of code changes it. Pro is required before the
  first paying customer.
