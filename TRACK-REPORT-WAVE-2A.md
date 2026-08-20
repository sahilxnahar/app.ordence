# TRACK REPORT — Wave 2A, the migration wizard · v1.89.0-alpha

**The defect:** eighteen entities, a load order, a dry run, a provenance
sidecar, a reversal engine and seven source profiles were all built, and a
customer could reach two entities, no order, no Tally view but one, and no
reconciliation at all. `beginImportRun` had required a file fingerprint
since Phase 2 and nothing had ever sent one, so every chunked migration
was refused at the first call.

Everything below is a command that was run and the output it produced.

---

## ① The tree, confirmed before anything was touched

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

Matches the census in the brief exactly. This is the right tree.

---

## ② What was delivered

| Path | |
|---|---|
| `components/import/figures.tsx` | new — Indian grouping, `tabular-nums`, minor units by currency exponent |
| `components/import/load-order.tsx` | new — **screen ①**, the waves |
| `components/import/mapping-review.tsx` | new — **screen ②**, the mapping table |
| `components/import/reconciliation.tsx` | new — **screen ③**, two numbers and the distance |
| `components/import/fingerprint.ts` | new — SHA-256 over the bytes, in the browser |
| `components/settings/import-wizard.tsx` | rewritten |
| `app/(crm)/settings/import/page.tsx` | edited — links to the two new screens |
| `app/(crm)/settings/import/plan/page.tsx` | new — screen ① standalone |
| `app/(crm)/settings/import/cutover/page.tsx` | new — screen ③ |
| `tests/ui/import-wave2a.test.tsx` | new — 22 assertions, every one induced to fail |

No SQL. No new npm dependency (`package.json` untouched). No file outside
`components/import/`, `components/settings/import-wizard.tsx`,
`app/(crm)/settings/import/**` and the one new test file was edited.

---

## ③ Screen ① — the order, and the proof that it is DERIVED

`resolveImportOrder(ALL_IMPORT_ENTITIES)` returns **waves**, and the
screen draws waves: one heading per group, with the sentence *"These do
not depend on each other. Load them in whatever order your files are ready
in."* under it. Every hard edge carries the entity's own `because`,
verbatim. Soft edges come from `softAdvice()` and are drawn in a separate,
dashed, uncoloured box headed **"Better if you have it — not required"** —
advice that looks like a rule is a rule nobody can start without.

🔴 **`ok: false` renders NO order.** A cycle or a dangling key produces the
problem and the entity list, and nothing else.

**"It renders" is not the claim.** A screen with the order typed into it
passes any assertion about what is on it. So the property was induced:

```
$ # LoadOrder made to ignore its `entities` prop (one-line mutation)
$ npx vitest run --project=ui tests/ui/import-wave2a.test.tsx
 × the load order screen > grows a group when an entity is added, because it is derived
   → expected [ Array(2) ] to have a length of 3 but got 2
 × the load order screen > refuses, and draws nothing, when the graph has a cycle
   → expected [ [], [] ] to have a length of +0 but got 2
      Tests  2 failed | 20 passed (22)
```

The first test hands the component a nineteenth entity depending on
`receipts` and asserts a **third group appears carrying it**. A transcribed
list cannot move. The second hands it a two-entity cycle and asserts **no
group is rendered at all** — not that a warning is present.

Restored, and the same suite is green:

```
$ npx vitest run --project=ui tests/ui/import-wave2a.test.tsx
      Tests  22 passed (22)
```

⚠️ **The picker IS this screen.** Step 1 of the wizard no longer offers a
flat list of two radio buttons; it offers all eighteen, in their waves,
with "Import this" on each. The four opening-balance entities are listed
(they are part of the order and of the job) and link to
`/settings/opening-balances` instead, which is the screen that runs them.

---

## ④ Screen ② — the mapping step

Their column on the left with **three of their own values under it**, the
Ordence field in the middle, how sure and why on the right.

🔴 **The GSTIN/PAN case.** A column headed `GSTIN` holding PANs beside `F7`
holding the real GSTINs is scored `CONTRADICTED_HEADER` (0.60, below the
0.90 auto-commit threshold) by `proposeMapping`. This screen renders that
as **"Needs your eye"** with the scorer's own sentence in an amber band
**inside the row**, and the three sample values under the picker are
`AABCR5055K, AAACS1429B, AAGCS4576P` — which is the check, and it takes a
second. Asserted with `within(row)`:

```
✓ the mapping step > puts the disagreement on the row, not in a list at the bottom
✓ the mapping step > shows three sample values under the chosen column, and follows an override
✓ the mapping step > blocks a required column nothing matched, and says what to do
```

⚠️ **The samples follow the OVERRIDE, not the proposal.** Changing the
picker to `F7` changes the three values to `27AABCR5055K1Z7,
27AAACS1429B1ZP, 24AAGCS4576P1ZI`. Showing the proposed column's values
next to a chosen column would make the check a check of the old answer,
which is worse than showing none. Asserted.

⚠️ **Nothing is repeated at the bottom.** The test asserts there is no
element after the table. Only file-level cautions — "6 columns in your file
were not used" — are rendered above it, and any caution that is also a
row's `conflict` is dropped from that list.

⚠️ **A caution that always fires gets clicked past**, so no band is emitted
for a clean row, and none for a merely low-but-uncontested score (a
profile spelling scores 0.85 and is fine). One defect was found and fixed
while writing the test: the row printed the contradiction sentence twice,
once as `why` and once in the band. It now prints once.

`resolveCivilDateFormat`'s discipline is untouched: a column of
`01/01/2026, 02/02/2026` says nothing because both readings give the same
days. Those sentences arrive through `SourceTable.notes`, which the wizard
already renders, and no new always-on caution was added anywhere.

---

## ⑤ Screen ③ — reconciliation and cutover

Xero's grammar, held to: **two numbers and the distance between them.** The
difference is a sentence — `difference 1,400.00 short` — never a signed
number, because "-1,400" asks the reader to work out which side is short.

🔴 **"Not checked yet" and "zero" are different SHAPES, not a nullable
number.** `ReconciliationMeasure` is a discriminated union: a `not-checked`
line has no `declared` to read, so no renderer can format it as `0`. And
`cutoverVerdict` cannot return `ties` while one exists. Induced:

```
$ # the `unknown` clause deleted from cutoverVerdict
 × cannot say everything ties while one line was never measured
   → expected { verdict: 'ties', checked: 2, …(2) } to deeply equal { Object }
 × renders a measured zero and an unmeasured line differently
   → Unable to find an element with the text: /1 of 2 checks ran/
      Tests  2 failed | 20 passed (22)
```

The first test's second half is the important half: the SAME lines with the
unmeasured one replaced by a measured `0n → 0n` **do** go green, so the
clause is the cause and not a coincidence. The rendered difference is
asserted too — a measured zero shows `0.00` and "they tie"; the unmeasured
line shows no figure at all and says "Not checked yet".

**What the page measures today:** the row census per run — `expectedRows`,
declared by the browser before the first chunk, against `rowsWritten +
rowsSkipped + rowsFailed` accounted for by the server. Two numbers from two
places. A run still in flight is `not-checked` ("still running"), not a
shortfall, because red on this page means *this blocks the cutover*.

**What it honestly does not:** the four control totals. Footing the
imported sub-ledgers back against the customer's opening trial balance
needs a server function over the provenance sidecar that does not exist —
Track M8. It is rendered as one `not-checked` line naming exactly that,
which keeps the page off green. See `PATCH-REQUEST-WAVE-2A.md` §1 for the
signature and the five-line wiring. **A green page here would have been
green by omission, which is the cheapest lie a screen can tell.**

---

## ⑥ The fingerprint — the one thing that is not a screen

```ts
const bytes = new Uint8Array(await file.arrayBuffer());
const digest = await crypto.subtle.digest("SHA-256", copy);
```

Over the **bytes**, in the browser; the server receives 64 hex characters
and never the file. Proven three ways:

```
✓ is the SHA-256 of the bytes, in the shape the server demands
✓ does not change when the file is renamed, and does when a cell is fixed
✓ hashes the view it was given, not the buffer behind it
```

The third is a trap this codebase would otherwise have hit: a `Uint8Array`
can be a view onto a larger `ArrayBuffer` — which several readers in
`lib/import/sources/` produce — and `subtle.digest(bytes.buffer)` would
fingerprint bytes the customer's file does not contain. The function copies
into an exact-length buffer first.

**And the wizard sends it.** Driven end to end (upload a 1,001-row file,
choose a duplicate mode, dry run, import all) with stubbed actions, then
the argument `beginImportRun` received is compared against a SHA-256
computed independently in the test with `node:crypto`:

```
✓ the migration path > fingerprints the file in the browser and sends it to beginImportRun
```

Induced, by sending `file:${fileName}` instead — the shape a
name-based "fingerprint" would have, which is idempotency that is present
and inert:

```
 × fingerprints the file in the browser and sends it to beginImportRun
   → expected 'file:customers.csv' to match /^sha256:[0-9a-f]{64}$/
      Tests  1 failed | 21 passed (22)
```

⚠️ **Changing the sheet, changing the Tally view and applying a column
mapping do NOT change the fingerprint** — they re-read or rewrite the
records, never the bytes. The same upload must resume the same run rather
than start a rival one. A rival run is unrecoverable in `update` mode: the
second captures the first's values as the "prior".

**`resumed` and `note` are rendered**, and the test asserts the ABSENCE of
the other sentence, because rendering both would be the defect with a
sentence added rather than repaired:

```
✓ says it is resuming, and does not also say it is starting
✓ says it is starting when the run is new
```

🔴 A migration with records but no bytes is **refused with a sentence**,
not silently returned from.

---

## ⑦ Four smaller defects repaired on the way

1. **The Tally view picker.** `TALLY_VIEW_LABELS` has been documented "one
   line each, for a picker" since v1.74.0-alpha with no picker, and Phase 9
   added three more views to the same silence. Five views, one file, one
   reachable. There is now a picker, shown only for `tally-xml`, re-reading
   the same bytes.
2. **`duplicateModes` is honoured.** The wizard offered all three modes to
   every entity while `server/actions/import.ts` refuses any mode outside
   `entity.duplicateModes` — so an opening journal entry offered
   "overwrite", a control whose only possible outcome is an error message.
3. **The recommendation comes from the contract.** `recommended` was a
   hard-coded flag on `skip`; it is now `contract.duplicateDecision.recommended`
   with `.because` under it. Still nothing pre-ticked.
4. **`abandoned` was dead code** — `...(stopped ? { abandoned: false } : {})`
   is `false` on both branches, so the `"abandoned"` run status has never
   been reachable. Removed rather than faked; see PATCH-REQUEST §3.

---

## ⑧ The three typographic rules

`components/import/figures.tsx` is the only way a figure reaches these
screens. `tabular-nums` is on the component and not on the table, so a
figure inside a sentence keeps it.

🔴 **The grouping is RE-EXPORTED from `lib/receivables/numbers.ts`, not
reimplemented.** This tree already carries five money formatters that
disagree at the edges — one of them, `formatMinorPlain`, does no grouping
at all, which is why the trial balance prints `2093750.00`. A sixth would
have been the sixth. `groupIndian` is exact at any magnitude because it
takes and returns a string, and it uses no `Intl`: `Intl.NumberFormat("en-IN")`
falls back to grouping in threes on a small-ICU runtime, **silently**. The
test asserts identity — `expect(groupIndian).toBe(canonicalGroupIndian)` —
rather than agreement, because a test comparing two implementations is a
test somebody updates when one of them changes.

⚠️ `formatMinorIndian` does NOT delegate to `formatPaise`, which hard-codes
`100n`. Minor units are not universally two decimals (rule 6), so the
exponent comes from `minorUnitExponent(currency)` and only the grouping is
shared. Induced (grouping switched to `toLocaleString("en-US")`):

```
$ # formatCount switched to toLocaleString("en-US")
 × figures > groups the Indian way
   → expected '2,093,750' to be '20,93,750'
```

Money reads its exponent from the currency: `formatMinorIndian(1234n,
"KWD")` is `1.234` and `(1234n, "JPY")` is `1,234`. Dividing by 100 would
report a Kuwaiti amount ten times too large. Asserted.

🔴 **Never red for a negative number.** `never renders a minus sign for a
shortfall` asserts the rendered output contains `1,400.00 short` and does
not contain `-1,400`. Red on these screens means *this blocks the cutover*
and nothing else.

---

## ⑨ Gates, after

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  29/29 passed

$ npm run check:links
✅ check:links
   171 internal link shapes, 243 routes.
   0 known dead (budget 0), 0 new.

$ npm run check:import-contract
   18 entities examined … 2 wave(s)   (unchanged)
```

`check:boundaries` and `check:client-hooks` pass with `ALL_IMPORT_ENTITIES`
imported into a client component: `lib/import/` is pure, which is the
property that makes this possible at all.

---

## ⑩ What is red, and why — read this before counting

The brief said 12 pre-existing UI failures in `assemble-wave`,
`csv-import` and `opening-balances`. **That is not what this tree does.**
Measured on an untouched extraction of `ordence-DEPLOY-v1.89.0-alpha.zip`
(`/tmp/w2a/base`, same `node_modules`):

```
$ npx vitest run --project=ui tests/ui/import-profiles.test.ts \
    tests/ui/import-discovery.test.ts tests/ui/import-sales-entities.test.ts \
    tests/ui/csv-import.test.ts tests/ui/opening-balances.test.ts
      Tests  11 failed | 216 passed (227)

$ npx vitest run --project=ui tests/ui/assemble-wave.test.ts
 × assemble-wave > REFUSES a delivery that turns the gates red, and NAMES the gate
      Tests  1 failed | 5 passed (6)
```

So the count of 12 is right and the file list is wrong: the pre-existing
red is **import-discovery (7), import-profiles (2), import-sales-entities
(2), assemble-wave (1)**. On the pristine tree `csv-import` and
`opening-balances` are **green**. None of the twelve is Wave 2A's and none
was touched.

**After this wave: 13 failed.** The one difference is mine and it is
deliberate:

```
 × tests/ui/csv-import.test.ts > re-running an import
   > the wizard names the key and warns about the name fallback
```

That test asserts the wizard's SOURCE contains `"same GSTIN"` and
`"same domain"` — the two halves of `entityKey === "companies" ? … : …`.
`lib/import/types.ts` names that exact ternary as the reason
`ImportEntityDefinition.duplicateRule` exists, and with eighteen entities
in the picker it described sixteen of them to the customer as a GST party
at the moment they decide what happens to their data. It is gone; the
screen reads `entity.duplicateRule`, which sixteen of the eighteen
entities declare.

**The two that do not are `companies` and `gst-parties`** — the two the
ternary was carrying — so those two now show no matching rule. That is a
real loss and it is in a file this wave does not own
(`lib/import/entities.ts`). It was NOT edited, and it was not papered over
with a second ternary in a file that is owned.
**`PATCH-REQUEST-WAVE-2A.md` §2 carries both halves of the fix**: the two
`duplicateRule` strings, verbatim from the deleted ternary, and the
replacement assertion — which is stronger, because it covers all eighteen
entities instead of two.

## ⑪ The full suite

```
$ npx vitest run --project=ui
 Test Files  5 failed | 208 passed (213)
      Tests  13 failed | 6823 passed | 8 skipped (6844)

$ npx vitest run --project=ui tests/ui/import-wave2a.test.tsx
      Tests  22 passed (22)
```

12 of the 13 are the pre-existing set above. The 13th is §2.
