# Ordence · house rules for anyone building on this codebase

**Repo: `app.ordence`** · Next.js 15.5 App Router · TypeScript strict · Drizzle ORM · Neon PostgreSQL · Clerk · deployed to Railway from GitHub

Read this before writing a line. It is not style preference. Every rule below exists because breaking it already cost something in this product, and most of them are enforced by a gate that will refuse your work.

There is a second repo for the marketing website. **This document is about `app.ordence` only.** Website work does not touch this repo and this repo does not touch the website.

---

## 1. The fifteen gates are the contract

```
npm run -s check:boundaries        npm run -s check:tax-decisions
npm run -s check:guards            npm run -s check:links
npm run -s check:migrations        npm run -s check:tenant-isolation
npm run -s check:sql               npx tsc --noEmit
npm run -s check:sql-executes      npm run -s test:ui
npm run -s check:rls-writes        npm run -s check:posting
npm run -s check:reachability
```

**Nothing is merged that turns any of them red.** They are ordinary Node scripts in `scripts/check-*.mjs` and they are readable. If a gate is wrong, fix the gate and say why in its own comments. Do not work around it.

⚠️ **The two that catch a security regression are `check:guards` and `check:sql`.** If either goes red, stop.

⚠️ **`check:links` carries a `KNOWN_DEAD_MAX` budget that MAY ONLY DECREASE.** Raising it to make a build pass is how every link checker anybody has ever deleted got deleted.

---

## 2. RLS is the only tenant isolation there is

There is no `WHERE tenant_id = ?` safety net in the application layer. PostgreSQL row level security is the boundary, and it is the whole boundary.

```ts
await withTenant(tenantId, async (tx) => { /* every read and write */ });
await withPlatformScope("why you are reading across tenants", async (db) => { /* … */ });
```

Both set the GUC with `set_config(..., true)` **inside a real transaction**, so it cannot leak onto the next request on a pooled connection. Code that reaches for `db` directly bypasses the boundary. `check:rls-writes` exists to catch exactly that.

🔴 **THREE WAYS RLS IS SILENTLY BYPASSED, and we have hit all three:**

1. A role with `rolbypassrls` ignores every policy. `neondb_owner` has it; `ordence_app` does not.
2. A superuser ignores policies regardless of `FORCE`.
3. **A table's OWNER is exempt from its own policies unless the table has `FORCE ROW LEVEL SECURITY`**, with no `rolbypassrls` anywhere in sight. This one has no tell. Every new table gets `ENABLE` **and** `FORCE`.

Every new tenant-scoped table needs RLS enabled, forced, and a policy. `check:sql` refuses the migration otherwise.

---

## 3. Money and quantities

**Money is `bigint` in minor units (paise). It never becomes a `Number`, ever, on any path.**

```ts
Math.round(Number("1.005") * 100)   // 100, not 101. This is not a rounding preference.
0.1 + 0.2 !== 0.3                   // which is why quantities are integer thousandths
```

Display formatting is string surgery on the bigint. Arithmetic never leaves bigint. A float anywhere in a money path is a defect regardless of how it tests, because the failure is data-dependent and shows up in somebody's invoice, not in CI.

Quantities are integer thousandths: 12.5 tonnes of cement is a real quantity and a float would round it.

⚠️ **`BigInt(30.5)` is a `RangeError`, not a rounding.** There is a live instance of this at `lib/payroll/payslip.ts:216` and it is the first thing on the fix list.

---

## 4. `"use server"` publishes every export to the internet

A file with `"use server"` at the top turns **every export** into a browser-reachable RPC endpoint. Not just the ones a page imports. Anyone with curl can call them.

Every export needs a tier-2 guard , `requirePermission(...)` or a composed guard from the TIER2 family listed in `scripts/check-action-guards.mjs` , **reachable in ONE hop from the export.** `check:guards` walks one hop and one hop only.

If your guard is a legitimate composed gate that lives two hops down, **add it to the TIER2 list** rather than bolting a duplicate guard onto the endpoint. A gate that teaches people to write code for the gate is worse than no gate. That call has been made once already, deliberately, for `guardImport`.

🔴 **A screen that hides a button is a mistake guard, not a boundary.** Curl goes straight through it. Every refusal that matters must refuse the write, on the server, inside the transaction.

---

## 5. Migrations

Numbered SQL files in `SQL-FILES/`, run by a human. **There is no migrations ledger table and no `drizzle-kit push`** , push drops RLS policies on 260 tables and is blocked in the npm script.

Next free number is **0086**. `check:migrations` enforces contiguity and refuses a retired number (0062, 0072 and 0076 are retired; three separate attempts have tried to bring one back).

Every migration ships **three** files:

| File | What it is |
|---|---|
| `00NN_name.sql` | the migration. One transaction, every statement guarded so re-running does nothing. |
| `VERIFY-00NN-neon-safe.sql` | read-only. SELECTs only. Safe on production. |
| `DRILL-DO-NOT-RUN-IN-NEON-00NN.sql` | destructive proof that the guarantees hold. **Throwaway Postgres only.** |

🔴 **THE DRILL NAME IS THE WARNING AND IT IS NOT DECORATION.** A drill must never touch Neon. The same rule covers `scripts/harness/*.sql` and `HARNESS_DATABASE_URL`.

**Every migration header states whether it runs BEFORE or AFTER the code push, and why.** Both directions are correct in different cases, and the reasoning is the deliverable:

- *Before* is usual: new code SELECTs a table that is not there yet and the screen 500s.
- *After* is right when the migration adds CHECK constraints that refuse rows the **old** code produces. 0080 is that case.
- *Before* is urgent when the failure would be **silent**. 0083 reads credit hold tables on every order confirmation; if the code went first, the gate would degrade to "no hold row found, therefore no hold". One ordering fails loudly and harmlessly, the other fails silently and costs money.

---

## 6. India is not a locale setting

- **The financial year runs 1 April to 31 March.** Use `fyStartFor(date)`.
- **Dates default via `Asia/Kolkata`, never `toISOString()`.** UTC is yesterday's date for the first five and a half hours of an Indian day, and a pre-filled wrong date starts the MSME acceptance clock early.
- **GST place of supply comes from the engine, never from comparing two state codes.** `check:tax-decisions` enforces this. The relevant sections are s.12(3) for immovable property, s.7(5)(b) for SEZ, s.10(1)(a) for goods movement, s.12(2) for services. CGST+SGST, CGST+UTGST and IGST are three different answers.
- **CGST credit may never be set off against SGST, or the other way round.** They are different governments. A set-off that treats the pools as interchangeable produces a smaller, entirely plausible cash figure and the department disagrees months later with interest attached.
- **Contract labour and employees are different tables on purpose.** `site_workers` are brought by a vendor and paid through that vendor's RA bill. Giving them payslips misstates the employment relationship in a way a labour inspector cares about.

---

## 7. How to decide, when the code has to decide

These are the patterns this codebase reaches for. They are worth copying.

**Compute it twice by routes that share no source. When they disagree, render NO figure at all.** Not amber, not asterisked, and not the "true" one either, because a correct number printed under a heading that just failed its own check reads to the person holding it as verification. See `lib/reconciliation/gate.ts` and `lib/accounting/cash-flow.ts`.

**Refuse rather than guess.** A register with a column it cannot source shows the column blank and named, or refuses to generate. A balance that cannot be derived is not defaulted to zero. `matchThreeWay([])` returns `unmatched`, not `matched`, because a bill with no lines has not been checked , and it is the control that authorises paying a vendor.

**A balance is derived from entries and never stored.** A stored balance is a cache of a sum, and a cache that disagrees with its ledger is unarguable with the employee who has kept their own count.

**Ask the question that scopes the answer, not the question RLS will satisfy.** `myPayslips()` takes no arguments at all , not an employee id, not a filter. The query asks *which employee rows point at me*, because every colleague's payslip is in the same tenant and the policy is satisfied by the leaking query exactly as by the correct one.

**The database is the authority; the screen is a mirror.** Legal state transitions are enforced by triggers. The screen mirrors them only so it does not offer what will be refused. If the mirror drifts, somebody has a confusing afternoon. If the database drifted, an order changes in a way nobody meant. Only one of those is recoverable.

---

## 8. Comments are the deliverable, not decoration

This codebase explains **why** in block comments above the decision, marked:

- 🔴 a defect, or a rule that costs real money
- ⚠️ a trap, something that looks right and is not
- ⭐ a decision worth keeping, and the reasoning behind it

Write them for somebody meeting the code in two years with no context. "What this does" is readable from the code. **"What goes wrong without this, concretely"** is not, and that is the sentence worth writing.

---

## 9. Tests

`tests/ui/*.test.ts`, run by `npm run -s test:ui`. Currently 122 files and 4,347 tests.

🔴 **When a test asserts the ABSENCE of code, strip comments and strings first** with a `codeOnly()` helper. This repo has been fooled five times by a comment that quoted the very code the test was checking had been removed , once masking a genuinely uncalled engine.

⚠️ **Never pin an exact number that can only improve.** A test that pins the dead-link budget at 10 fails the day somebody fixes two more, which trains people to edit the test rather than read it. Assert a ceiling.

**Prove it, do not assert it.** Where a fix changes a query, run the old and the new predicate through the real function and show both answers. That is how the three-way match defect was demonstrated rather than argued about.

---

## 10. Two shapes that recur here, so expect them

**"A complete engine that nothing reaches."** Roughly thirty-five instances found so far: `recordGoodsReceipt` writing no stock movement, eleven of twelve order actions with no caller, `grantPlatformStaff` never called by anything, `valuationMethod` read by nothing. Before building a feature, **search for it first.** It is often already written and simply unreachable, and wiring it is a fraction of the work , and safer, because the engine has usually had more thought put into it than a rewrite would get.

**The finding is rarely the thing the plan named.** "Wire up GRN" turned out to be "the GRN moves no stock". "Replace a string compare" turned out to be "the table cannot hold the answer". "Add a bank account form" turned out to be "no code path can write that table at all". Budget for the real finding.

---

## 11. Practical mechanics

- `npm install` then `npm run -s test:ui` should pass on a clean clone.
- The one-line safety habit: **delete `tsconfig.tsbuildinfo` before trusting a `tsc --noEmit` run.** A stale one makes tsc print nothing and exit 0 without doing any work, which reads exactly like success.
- `db:push` is deliberately blocked. Use the numbered SQL files.
- Do not add a dependency without saying why in the PR. The CSV parser here is ~120 lines and handles BOM, CRLF, quoted commas and quoted newlines, because a dependency for that was not worth the supply chain.
- Deploys go GitHub → Railway automatically. There is no deploy command.

---

## 12. What is actually left

**29 of 128 batches are done. Mega-wave 1 is complete.** The remaining 99 are listed by mega-wave, with batch numbers, in `docs/current/122-WHERE-EVERYTHING-STANDS.md`. That document also carries the five known defects that are found but not fixed, each with a file and line.

Start there. The batch numbering is the shared vocabulary for this project and keeping it makes every conversation shorter.
