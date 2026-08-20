# TRACK-REPORT.md — Wave 2D, the design system

**Build:** `v1.89.0-alpha` · **Owns:** `app/globals.css`, `components/ui/**`
**Delivers:** five primitives, one formatter that is not a sixth
implementation, a token layer, and a test suite whose §9 is red on purpose.

---

## 1. The tree, confirmed once

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  29/29 passed

$ npm run check:import-contract
✅ check:import-contract
   18 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: chart-of-accounts, companies, cost-centres, customers, gst-parties,
             leads, opening-stock, stock-items, tax-codes, vendors, warehouses
     wave 1: batches, contacts, opening-customer-invoices, opening-trial-balance,
             opening-vendor-bills, purchase-bills, receipts
```

Matches the brief exactly. Right tree.

---

## 2. 🔴 The brief's known-red list names the wrong files

The brief says:

> `npx vitest run --project=ui` has **12 pre-existing failures** in three files
> (`assemble-wave`, `csv-import`, `opening-balances`).

**The count is right and three of the four file names are wrong.** On the
untouched tree, before anything in this wave existed:

```
$ npx vitest run --project=ui
 Test Files  4 failed | 208 passed (212)
      Tests  12 failed | 6802 passed | 8 skipped (6822)

$ grep -E "^ *× \|ui\|" baseline.log | sed -E 's#.*(tests/ui/[a-z-]+\.test\.ts).*#\1#' | sort | uniq -c
      1 tests/ui/assemble-wave.test.ts
      7 tests/ui/import-discovery.test.ts
      2 tests/ui/import-profiles.test.ts
      2 tests/ui/import-sales-entities.test.ts
```

`tests/ui/csv-import.test.ts` and `tests/ui/opening-balances.test.ts` both
**exist and both pass**. Three files that are red — `import-discovery`,
`import-profiles`, `import-sales-entities` — are not on the brief's list at
all.

⚠️ **Why this matters more than a typo.** The brief's instruction is "do not
fix them and do not count them as yours." Anyone following it literally will
protect two green files and treat seven genuinely-red assertions in
`import-discovery` as new damage from whichever wave lands next. The
description in the brief also does not fit what is actually failing: these
are not "source-text assertions about `server/actions/import.ts`."

⚠️ **`assemble-wave` is a 49.7-second timeout, not an assertion failure.**
`REFUSES a delivery that turns the gates red, and NAMES the gate` runs the
gate suite inside a test with a 30s budget. That is plausibly environmental —
it may pass on a faster machine — so it is the one baseline failure that
should be re-measured rather than assumed.

**None of the twelve is touched by this wave, and the count does not move.**

---

## 3. 🔴 The formatter this wave was asked to write already exists four times

The brief: *"Ship the formatter as a primitive. If each screen does its own
`toLocaleString`, one of them will use the wrong locale and nobody will
notice until a customer does."*

That has already happened. On this tree, today:

| where | what | groups Indian? |
|---|---|---|
| `lib/receivables/numbers.ts` | `groupIndian` — string surgery on a bigint's digits | ✅ |
| `lib/registers/format.ts` | a **second** `groupIndian`, different code, same output | ✅ |
| `components/returns/gstr3b-board.tsx:35` | `export function rupees` — `toLocaleString("en-IN")` | ✅ *(see §4)* |
| `components/sales/inventory-grid.tsx:76` | `new Intl.NumberFormat("en-IN")` | ✅ *(see §5)* |
| `lib/fx/currency.ts:152` | `formatMinorPlain` — used by the trial balance | 🔴 **no grouping at all** |

⭐ **So `components/ui/figure.tsx` ships no formatter. It ships an import of
one.** A fifth implementation with a nicer name is the defect, not the fix,
and the next disagreement would be one refactor away. `formatRupees` in the
design system **is** `formatRupees` in `lib/receivables/numbers.ts`, so no
test can find them apart because there is only one of them.

`lib/receivables/numbers.ts` and not either of the other two, because it
never constructs a `Number` (exact at every magnitude) and never touches
ICU (§4).

**The agreement the brief asked for, on seven digits and on a negative** —
`tests/ui/wave-2d-design-system.test.tsx` §1, importing the real screen's
`rupees` rather than a copy of it:

```
209375000              → ₹20,93,750.00   both
-209375000             → -₹20,93,750.00  both
1234567890             → ₹1,23,45,678.90 both
-1234567890            → -₹1,23,45,678.90 both
-1                     → -₹0.01          both
0                      → ₹0.00           both
100000000000000000000  → ₹10,00,00,00,00,00,00,00,000.00  both
```

Asserted as literals, not as `expect(x).toBe(format(x))` — a tautology passes
whatever the grouping is.

---

## 4. ⭐ Induced: `Intl.NumberFormat("en-IN")` is a latent defect, not a style choice

`Intl` does locale **negotiation**. Ask a Node built with `small-icu` — or
any runtime with trimmed CLDR — for `en-IN` and it does not throw and does
not warn. It falls back to `en`, and `en` groups in threes.

§2 of the test substitutes exactly that negotiation and changes nothing else:

```
 ✓ the screen's Intl-based formatter DRIFTS to Western grouping, silently
     expect(screenUnderSmallIcu("209375000")).toBe("₹2,093,750.00")
 ✓ the primitive does not move, because it never asks ICU anything
     expect(formatRupees(209375000n)).toBe("₹20,93,750.00")
```

The GSTR-3B screen would print a customer's tax liability in Western grouping
on such a runtime, in production, with nothing in any log.

**And the induction that proves the guard is real** — make `figure.tsx` stop
delegating and use `Intl` instead:

```
$ npx vitest run --project=ui tests/ui/wave-2d-design-system.test.tsx
 × §2 › the primitive does not move, because it never asks ICU anything
      Tests  6 failed | 54 passed (60)
```

---

## 5. Two more findings in existing screens, neither of them ours to fix

**`components/sales/inventory-grid.tsx:76` puts the minus inside the rupee
sign, and swallows paise.**

```
minor = -100  →  inventory-grid: "₹-1"      others: "-₹1.00"
minor = -1    →  inventory-grid: "₹0"       others: "-₹0.01"
minor = -99   →  inventory-grid: "₹0"       others: "-₹0.99"
```

`BigInt(minor) / 100n` truncates toward zero, so any debit under one rupee
renders as `₹0` — a figure that states there is nothing there.

**`lib/fx/currency.ts:152` `formatMinorPlain` does no grouping**, and it is
what the trial balance renders. The product's own trial balance prints
`2093750.00`. That is `PATCH-REQUEST-WAVE-2D.md` §A and §D.

---

## 6. What was built

### `app/globals.css`

Six meanings as HSL tokens, in the same triplet form as every other token in
the file, declared on **three** grounds:

| | why |
|---|---|
| `:root` | the light values, converted from `ORDENCE-ERP-UI.html`'s `:root`. The hex each came from is in a comment, so the conversion is checkable. |
| `.dark` | re-cut, not dimmed. `#0f7a46` on `#121212` is a smudge and `#b8322a` is unreadable. The 3B with a deadline is exactly the screen somebody opens at 11pm. |
| `.document-surface` | 🔴 **the light values again.** An invoice, a payslip and a 3B summary are PAPER. Without this block, adding dark values would silently have turned every printed document's red into pale pink on white. |

⚠️ **Not in `tailwind.config.ts`, deliberately.** That file belongs to nobody
this wave and editing it would collide. Consumers write
`text-[hsl(var(--ord-ties))]`, which needs no config entry. Adding
`text-ord-ties` later is additive and breaks no call site written now.

**And the one CSS line the brief is about:**

```css
table { font-variant-numeric: tabular-nums lining-nums; … }
.ord-num { … }
```

⭐ **A base rule on `table`, not a class each screen remembers.** There are
218 routes; the one that forgets is the one an accountant opens. This makes
every existing ledger in the product line up **without a single screen being
edited** — which is what lets this wave ship without touching Wave 2A's
files. `lining-nums` is not redundant: some faces default to old-style
figures, where 3, 4, 5, 7 and 9 drop below the baseline, which defeats the
alignment `tnum` just bought.

### `components/ui/` — five, and only five

| file | the rule it makes structural |
|---|---|
| `figure.tsx` | delegates; `minor` is `bigint \| string`; unparseable → `—`, **never `0n`** |
| `metric-card.tsx` | `difference` is **required**; the card does not compute it |
| `account-tree-row.tsx` | `debitMinor` **and** `creditMinor`, never one signed amount |
| `status-pill.tsx` | five meanings over a `Record<>`; a sixth is a compile error |
| `dense-table.tsx` | `NumericCell` instead of `align="right"`; total row is the plainest |
| `mapping-row.tsx` | `warning` renders **on the row**, and cannot be hoisted |

*(Six files for five primitives: `figure.tsx` is the atom the other five
render their numbers through, and is the formatter the brief asked to be
shipped as a primitive.)*

---

## 7. 🔴 Proven by induction, because a gate proven only by passing is not proven

Every one of these was run on a scratch copy of the delivered tree.

**A sixth status meaning:**
```
$ # add "saved" to StatusMeaning
$ npx tsc --noEmit
components/ui/status-pill.tsx(79,7): error TS2741: Property 'saved' is missing
  in type '{ ties: …; check: …; blocks: …; statutory: …; neutral: … }'
  but required in type 'Record<StatusMeaning, string>'.
```

**Red for a negative number:**
```
$ # <Figure minor="-100" tone="negative" />
error TS2322: Type '"negative"' is not assignable to type 'FigureTone | undefined'.
```
There is no negative to colour: `AccountTreeRow` takes two amounts, so a
credit balance is a position in a column rather than a minus sign. The rule
is enforced by the shape of the API, not remembered against it.

**A metric card with one number:**
```
$ # <MetricCard title primary secondary />  — no difference
error TS2741: Property 'difference' is missing … but required in type 'MetricCardProps'.
```

**Delete the tabular-nums base rule:**
```
× §7 › `table` itself carries it — which is what reaches the 15 screens already rendering <Table>
```

**Delete the `--ord-` tokens from `.document-surface`:**
```
× §8 › --ord-chrome is defined in light, in dark, and on a document surface   (×6)
× §8 › the document surface uses the LIGHT values, not the dark ones
```

**Make the formatter use `Intl`:** §4 above.

---

## 8. 🔴 The reachability check caught its own floor, and that is the honest part

§9 asserts each primitive is rendered by a real screen. The first draft
checked that the module path appeared in a file and the export's name
appeared somewhere in it. **It went green for `AccountTreeRow` on a screen
that imported it and never rendered it** — the identifier was matched inside
the `import` statement.

That is the fourth time a checker in this codebase has had exactly this bug.
The test now strips import statements and matches `<Name`, and it went red
immediately.

**On the delivered tree, all five are red, and that is the shipped state:**

```
$ npx vitest run --project=ui tests/ui/wave-2d-design-system.test.tsx
 × §9 › MetricCard is RENDERED by at least one screen
 × §9 › AccountTreeRow is RENDERED by at least one screen
 × §9 › StatusPill is RENDERED by at least one screen
 × §9 › DenseTable is RENDERED by at least one screen
 × §9 › MappingRow is RENDERED by at least one screen
      Tests  5 failed | 55 passed (60)
```

Wave 2D owns `components/ui/**` and `app/globals.css`. Adopting a primitive
means editing a screen, screens are not ours, and Wave 2A is in the import
wizard right now. So the adoptions are `PATCH-REQUEST-WAVE-2D.md` §A–§D, and
the test ships **failing** so that "the primitives are adopted" cannot become
true by assumption.

**With all four patches applied in a scratch copy:**

```
$ npx tsc --noEmit                                    (no output)
$ npm run gates:static                                29/29 passed
$ npx vitest run --project=ui tests/ui/wave-2d-design-system.test.tsx
      Tests  1 failed | 59 passed (60)
$ npx vitest run --project=ui
 Test Files  5 failed | 208 passed (213)
      Tests  13 failed | 6861 passed | 8 skipped (6882)
```

`6802 → 6861` is +59 passing, and `12 → 13` is the one deliberate red below.

### The one that stays red

`AccountTreeRow` has **no host on this tree.** `find app components -ipath
"*trial*"` returns nothing; the only trial balance is the flat ledger list in
`app/(crm)/accounting/page.tsx` — no groups, no collapse, no prior-period
column, and two extra columns the tree row has no slot for. Wiring it in
anyway to make the check pass is the defect the check exists to find.

Two honest options, in `PATCH-REQUEST-WAVE-2D.md` §E: build the grouped
trial balance in the wave that owns accounting screens, or delete
`account-tree-row.tsx`. **Wave 2D's recommendation is the former** — it is
the Xero pattern the brief is built on and `row.accountType` is already on
every row — but shipping the primitive "for later" with nothing rendering it
is precisely how a five-component design system becomes a forty-component
one, so the test will keep saying so.

---

## 9. Delivered

```
app/globals.css                                 modified  (tokens + the base rule)
components/ui/figure.tsx                        new
components/ui/metric-card.tsx                   new
components/ui/account-tree-row.tsx              new
components/ui/status-pill.tsx                   new
components/ui/dense-table.tsx                   new
components/ui/mapping-row.tsx                   new
tests/ui/wave-2d-design-system.test.tsx         new  ⚠️ outside the two owned globs
TRACK-REPORT.md
PATCH-REQUEST-WAVE-2D.md
```

⚠️ **`tests/ui/wave-2d-design-system.test.tsx` is outside `components/ui/**`
and `app/globals.css`.** It is a new file that collides with nothing, and
the wave brief's "Prove it" cannot be satisfied without it — the proof has to
live somewhere the suite collects. Flagged rather than assumed.

**Not done, deliberately:** no SQL, no server code, no page, no
`tailwind.config.ts`, no existing screen rewritten, no new npm dependency,
and none of the twelve pre-existing failures touched.
