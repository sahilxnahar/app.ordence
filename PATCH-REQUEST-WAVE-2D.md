# PATCH-REQUEST-WAVE-2D.md

**From:** Wave 2D — the design system, build `v1.89.0-alpha`
**Owns:** `app/globals.css`, `components/ui/**` — and nothing else.

Everything in this file is a change to a file Wave 2D does **not** own. None
of it is applied in the delivered zip. Each § below is a complete `diff -u`
against `ordence-DEPLOY-v1.89.0-alpha.zip` as shipped, and every one of them
was applied together in a scratch copy of that tree and measured:

```
npx tsc --noEmit               →  clean, no output
npm run gates:static           →  29/29 passed
npx vitest run --project=ui    →  13 failed | 6861 passed | 8 skipped (6882)
```

The delivered tree measures `12 failed | 6802 passed | 8 skipped (6822)`.
So the four patches together add **59 passing assertions and one failure**,
and that one failure is `§9 AccountTreeRow is RENDERED by at least one
screen` — which is red on purpose and is explained in §E.

> ⚠️ **§C IS IN WAVE 2A'S FILE.** `components/settings/import-wizard.tsx` is
> being edited by Wave 2A right now. §C is written as a request, not as a
> change — if 2A has moved that markup, take the two rules out of §C and
> throw the diff away.

---

## Why any of this is a patch request and not just code

The wave brief asks for proof that "every one of the five is used by at
least one real screen — a primitive nothing renders is this project's
most-found defect, in CSS."

That proof cannot be produced from inside `components/ui/**`. A primitive
imported only by another primitive is still unreached; that is exactly how a
component library with forty components and two screens passes its own
reachability check. So the adoptions have to touch screens, screens are not
ours, and the honest form of the deliverable is: build the primitives, ship
the reachability assertion **failing**, and put the changes that turn it
green here where they can be reviewed by the people who own the files.

`tests/ui/wave-2d-design-system.test.tsx` §9 is that assertion. It is red on
the delivered tree and names this file in its failure message.

---

## §A — `app/(crm)/accounting/page.tsx`
### 🔴 The product's own trial balance prints ungrouped figures today

**Depends on §D.** Apply §D first or this will not compile.

**What is wrong, exactly.** The trial balance renders
`<Amount value={row.totalDebit} />`, and `row.totalDebit` comes from
`formatMinorPlain` (`lib/fx/currency.ts:152`), which does **no digit
grouping at all** — it divides by the currency's scale and pads the
fraction. So the screen an accountant opens first reads:

```
Stock in hand      1300     812540.00
Sundry debtors     1200     481200.00
```

where an Indian ledger reads `8,12,540.00` and `4,81,200.00`. This is the
first rule in the design brief — *"Getting this wrong tells every customer
in one glance that the product was not built for them"* — failing on the
product's most-read accounting screen.

**A second thing, smaller and free.** Only the `<tfoot>` carried
`tabular-nums`. Every body row was proportional, so the debit column did not
line up with itself. That one is already fixed by the base rule now in
`app/globals.css` and needs no diff — it reaches this screen and the other
fourteen `<Table>` consumers without any of them being edited.

**What the diff does not do.** It does not touch the totals row's figures.
`getTrialBalance` returns `totalDebits` / `totalCredits` / `difference` as
formatted decimals with no minor-unit counterpart, and reconstructing them
in the UI by summing the rows would be a **second total computed on the
client**. A footer that can disagree with its own body is worse than an
ungrouped one. Widening those has a real decision in it — which currency's
grouping, when `currencyMixed` is true and three currencies have been added
together — and it is deliberately left open rather than guessed.

```diff
--- a/app/(crm)/accounting/page.tsx
+++ b/app/(crm)/accounting/page.tsx
@@ -47,6 +47,25 @@
   type StatementPeriod,
 } from "@/lib/accounting/periods";
 import { JournalEntryForm, type LedgerOption } from "./journal-form";
+/* ⭐ WAVE 2D — see PATCH-REQUEST-WAVE-2D.md §A. */
+import {
+  DenseTable,
+  DenseHeader,
+  DenseBody,
+  DenseRow,
+  DenseHead,
+  DenseCell,
+  NumericCell,
+  DenseTotalRow,
+} from "@/components/ui/dense-table";
+/* 🔴 `AccountTreeRow` IS DELIBERATELY NOT IMPORTED HERE.
+   This trial balance is FLAT — a list of ledgers with no groups, no
+   collapse and no prior-period column — and it also carries `Type` and
+   `Currency` columns the tree row has no slot for. Wiring it in anyway,
+   to make a reachability check go green, is the defect that check exists
+   to find. See TRACK-REPORT.md §5: the account tree row has no host on
+   this tree, and its host is a grouped trial balance that has not been
+   built. */
 import { CreatePeriodForm } from "@/components/accounting/create-period-form";
 import {
   ClosePeriodDialog,
@@ -306,66 +325,111 @@
         ) : (
           trialBalance && (
             <div className="overflow-x-auto rounded-md border border-border">
-              <table className="w-full text-sm">
+              {/**
+                * ⭐⭐⭐ WAVE 2D — THIS TABLE PRINTED UNGROUPED FIGURES.
+                *
+                * 🔴 `<Amount value={row.totalDebit} />` rendered whatever
+                * `formatMinorPlain` produced, and `formatMinorPlain`
+                * (lib/fx/currency.ts:152) does NO digit grouping at all.
+                * The product's own trial balance therefore read
+                * "2093750.00" where an Indian ledger reads "20,93,750.00"
+                * — the exact "tells every customer in one glance that the
+                * product was not built for them" the design brief opens
+                * with, on the one screen an accountant opens first.
+                *
+                * `NumericCell` takes `row.debitMinor`, which this action
+                * ALREADY returns (server/actions/accounting.ts:788) — so
+                * the fix does not change what the server sends and does
+                * not go near the arithmetic. The decimal strings are no
+                * longer read at all on this path.
+                *
+                * ⚠️ THE BODY ROWS ALSO HAD NO `tabular-nums`. Only the
+                * <tfoot> did. The base rule now in app/globals.css puts
+                * it on every `table` in the product, so this would have
+                * been fixed here even without the rest of the patch.
+                */}
+              <DenseTable className="w-full">
                 <caption className="sr-only">
                   Trial balance by ledger account, showing total debits and credits
                 </caption>
-                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
-                  <tr>
-                    <th scope="col" className="px-3 py-2 text-left font-medium">Code</th>
-                    <th scope="col" className="px-3 py-2 text-left font-medium">Account</th>
-                    <th scope="col" className="px-3 py-2 text-left font-medium">Type</th>
+                <DenseHeader className="bg-muted/50">
+                  <DenseRow>
+                    <DenseHead scope="col">Code</DenseHead>
+                    <DenseHead scope="col">Account</DenseHead>
+                    <DenseHead scope="col">Type</DenseHead>
                     {/* ⭐ 0101. Shown only when there is something to
                         distinguish — a column of "INR" on every row of an
                         INR-only workspace is noise that trains people to
                         stop reading the column. */}
                     {trialBalance.currencyMixed && (
-                      <th scope="col" className="px-3 py-2 text-left font-medium">Currency</th>
+                      <DenseHead scope="col">Currency</DenseHead>
                     )}
-                    <th scope="col" className="px-3 py-2 text-right font-medium">Debit</th>
-                    <th scope="col" className="px-3 py-2 text-right font-medium">Credit</th>
-                    <th scope="col" className="px-3 py-2 text-right font-medium">Balance</th>
-                  </tr>
-                </thead>
-                <tbody className="divide-y divide-border">
+                    <DenseHead scope="col" numeric>Debit</DenseHead>
+                    <DenseHead scope="col" numeric>Credit</DenseHead>
+                    <DenseHead scope="col" numeric>Balance</DenseHead>
+                  </DenseRow>
+                </DenseHeader>
+                <DenseBody className="divide-y divide-border">
                   {trialBalance.rows.map((row) => (
-                    <tr key={row.ledgerId}>
-                      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
-                      <td className="px-3 py-2">{row.name}</td>
-                      <td className="px-3 py-2 text-xs text-muted-foreground">
+                    <DenseRow key={row.ledgerId}>
+                      <DenseCell className="ord-num font-mono text-xs">{row.code}</DenseCell>
+                      <DenseCell>{row.name}</DenseCell>
+                      <DenseCell className="text-xs text-muted-foreground">
                         {row.accountType}
-                      </td>
+                      </DenseCell>
                       {trialBalance.currencyMixed && (
-                        <td className="px-3 py-2 font-mono text-xs">{row.currency}</td>
+                        <DenseCell className="font-mono text-xs">{row.currency}</DenseCell>
                       )}
-                      <td className="px-3 py-2 text-right"><Amount value={row.totalDebit} /></td>
-                      <td className="px-3 py-2 text-right"><Amount value={row.totalCredit} /></td>
-                      <td className="px-3 py-2 text-right"><Amount value={row.balance} /></td>
-                    </tr>
+                      {/* 🔴 MINOR UNITS, NOT THE DECIMAL STRING. And no
+                          `tone` on any of the three — a credit balance is
+                          ordinary and the column carries the sign. */}
+                      <NumericCell minor={row.debitMinorText} />
+                      <NumericCell minor={row.creditMinorText} />
+                      <NumericCell
+                        minor={(BigInt(row.debitMinorText) - BigInt(row.creditMinorText)).toString()}
+                      />
+                    </DenseRow>
                   ))}
-                </tbody>
-                <tfoot className="border-t-2 border-border bg-muted/30 font-medium">
-                  <tr>
-                    <td className="px-3 py-2" colSpan={trialBalance.currencyMixed ? 4 : 3}>
+                </DenseBody>
+                <tfoot>
+                  {/* 🔴 THE PLAINEST ROW ON THE SCREEN, DELIBERATELY. A
+                      trial balance that does not foot is not a report
+                      with a warning on it — the out-of-balance notice is
+                      above the table and the export refuses. Colouring
+                      this row would spend --ord-blocks on a row that is
+                      correct 364 days a year. */}
+                  <DenseTotalRow>
+                    <DenseCell colSpan={trialBalance.currencyMixed ? 4 : 3}>
                       Totals
                       {trialBalance.currencyMixed && (
                         <span className="ml-2 text-xs font-normal text-destructive">
                           ({trialBalance.currencies.join(" + ")} added together)
                         </span>
                       )}
-                    </td>
-                    <td className="px-3 py-2 text-right tabular-nums">
+                    </DenseCell>
+                    {/* ⚠️ STILL THE DECIMAL STRINGS. `getTrialBalance`
+                        returns `totalDebits` / `totalCredits` / `difference`
+                        as formatted decimals and does NOT return their
+                        minor units (server/actions/accounting.ts:975).
+                        Reconstructing them here by summing the rows would
+                        be a SECOND total computed on the client, and a
+                        footer that can disagree with its own body is
+                        worse than an ungrouped one. Grouping these needs
+                        the action to return the minor units — raised as
+                        PATCH-REQUEST-WAVE-2D §D, and NOT worked around
+                        here. */}
+                    <DenseCell className="ord-num text-right">
                       {trialBalance.totalDebits}
-                    </td>
-                    <td className="px-3 py-2 text-right tabular-nums">
+                    </DenseCell>
+                    <DenseCell className="ord-num text-right">
                       {trialBalance.totalCredits}
-                    </td>
-                    <td className="px-3 py-2 text-right tabular-nums">
+                    </DenseCell>
+                    <DenseCell className="ord-num text-right">
                       {trialBalance.isBalanced ? "0.00" : trialBalance.difference}
-                    </td>
-                  </tr>
+                    </DenseCell>
+                  </DenseTotalRow>
                 </tfoot>
-              </table>
+              </DenseTable>
             </div>
           )
         )}
```

---

## §D — `server/actions/accounting.ts`
### The minor units reach the client, as digit strings

**Required by §A.**

`toRows` strips `debitMinor` / `creditMinor` before the data crosses to the
client, and its comment is right to: a `bigint` is not serialisable across
the React Server Component boundary. The consequence was that the UI had
nothing but the already-formatted decimal string, and re-parsing a formatted
decimal in order to re-format it is how a rounding difference gets
introduced between a screen and the server that computed it.

⭐ **The fix keeps the bigints out and keeps their digits.**
`BigInt.prototype.toString()` is lossless in both directions, a digit string
crosses the boundary safely and exactly at every magnitude, and it is
precisely what `components/ui/figure.tsx` accepts — it calls `BigInt()` on
the other side and refuses anything that is not `/^-?\d+$/`.

⚠️ **Nothing is recomputed and no query changes.** No new value is derived,
no rounding happens, and the existing `totalDebit` / `totalCredit` /
`balance` strings are untouched, so every other consumer of
`TrialBalanceRow` is unaffected.

⚠️ The `Omit<>` on `LedgerBalance` is load-bearing. Without it the
intersection would require every internal producer to carry
`debitMinorText` too — that is, to stringify the bigints *before* the one
function whose job is to do exactly that.

```diff
--- a/server/actions/accounting.ts
+++ b/server/actions/accounting.ts
@@ -625,11 +625,53 @@
   totalCredit: string;
   /** Debit-positive. Inverted for presentation exactly once, in the UI. */
   balance: string;
+
+  /**
+   * ⭐⭐⭐ WAVE 2D — MINOR UNITS, AS DECIMAL DIGIT STRINGS.
+   *
+   * 🔴 WHY THE UI NEEDED THESE. `totalDebit` and `totalCredit` above are
+   * produced by `formatMinorPlain` (lib/fx/currency.ts:152), and that
+   * function does NO DIGIT GROUPING — it returns "2093750.00". The trial
+   * balance page rendered exactly that string, so the product's own
+   * ledger printed an ungrouped figure where an Indian ledger reads
+   * "20,93,750.00". The UI could not fix it locally because the only
+   * thing it had was the already-formatted string, and re-parsing a
+   * formatted decimal to re-format it is how a rounding difference gets
+   * introduced between a screen and the server that computed it.
+   *
+   * ⚠️ `string`, NOT `bigint`, AND THIS IS THE WHOLE POINT OF THE SHAPE.
+   * `toRows` strips the bigint working columns deliberately: a `bigint`
+   * cannot cross the React Server Component serialisation boundary, and
+   * the note on `toRows` has said so since it was written. A decimal
+   * digit string crosses safely, is exact at every magnitude, and is
+   * precisely what `components/ui/figure.tsx` takes — it calls `BigInt()`
+   * on it on the other side and refuses anything that is not digits.
+   *
+   * ⚠️ THE ENVELOPE TOTALS (`totalDebits`, `totalCredits`, `difference`)
+   * ARE DELIBERATELY NOT GIVEN THE SAME TREATMENT HERE. Widening those
+   * has a decision in it — which currency's grouping, when
+   * `currencyMixed` is true and three currencies have been added
+   * together — and the UI must NOT work around it by summing the rows
+   * itself. A footer that can disagree with its own body is worse than
+   * an ungrouped one.
+   */
+  debitMinorText: string;
+  creditMinorText: string;
 };
 
 export type { StatementPeriodInput, StatementPeriod };
 
-type LedgerBalance = TrialBalanceRow & {
+/**
+ * The server-side working shape: exact bigints, and NOT yet the two
+ * digit-string fields that `toRows` derives from them.
+ *
+ * ⚠️ THE `Omit` IS load-BEARING (Wave 2D). Without it this intersection
+ * would require every internal producer to carry `debitMinorText` too —
+ * i.e. to stringify the bigints before the one function whose job is to
+ * do exactly that. The wire type is a projection of this one, not a
+ * supertype of it.
+ */
+type LedgerBalance = Omit<TrialBalanceRow, "debitMinorText" | "creditMinorText"> & {
   debitMinor: bigint;
   creditMinor: bigint;
 };
@@ -795,9 +837,22 @@
   });
 }
 
-/** Strip the bigint working columns before the data crosses to the client. */
+/**
+ * Strip the bigint working columns before the data crosses to the client.
+ *
+ * ⭐ WAVE 2D — AND KEEP THEIR DIGITS. The bigints still do not cross (a
+ * `bigint` is not serialisable across the RSC boundary, which is the
+ * reason this function exists); their base-10 digit strings do, exactly,
+ * and that is what the UI needs to group them the Indian way. Nothing is
+ * recomputed and nothing is rounded — `BigInt.prototype.toString()` is
+ * lossless in both directions.
+ */
 function toRows(list: readonly LedgerBalance[]): TrialBalanceRow[] {
-  return list.map(({ debitMinor: _d, creditMinor: _c, ...row }) => row);
+  return list.map(({ debitMinor, creditMinor, ...row }) => ({
+    ...row,
+    debitMinorText: debitMinor.toString(),
+    creditMinorText: creditMinor.toString(),
+  }));
 }
 
 const PL_TYPES = new Set(["revenue", "expense"]);
```

---

## §B — `components/returns/gstr3b-board.tsx`
### One number with no working shown becomes two and the distance between them

This file's own header says it best, four hundred lines above the code this
diff changes:

> *"A screen that shows only 'cash payable ₹2,40,000' is asking the
> accountant to trust it. They will not, and they are right not to — they
> will re-derive it in a spreadsheet, and then there are two answers."*

And then the summary block does exactly that: a single 2xl figure, "Payable
in cash", with the heads listed underneath in muted 12px. The set-off
working is on the screen, but it is below the fold of the card, and the
number at the top is unaccompanied.

⭐ **`MetricCard` makes the working the headline** — output tax, credit
available, and the cash gap on its own row under a rule. This is the third
dashboard card in `ORDENCE-ERP-UI.html`, which is the one the design brief
flags as having no precedent in the Mobbin library at all: an Indian GST
position with a statutory due date on the difference line.

🔴 **The card does not compute the difference and is not asked to.** Cash
payable is the output of the set-off engine *and its order*; it is not
`output − credit`, and the two differ whenever any credit is carried
forward. `MetricCard` has no subtraction in it precisely so that this
cannot be quietly gotten wrong.

**Also in this diff, and it is the smaller half:**

- The three `<Badge>`s become `StatusPill`s with meanings. `filed` is
  `ties` — the figure Ordence computed and the figure the portal holds now
  agree, which is the same claim a reconciled bank line makes. `finalised`
  is `statutory`, not `check`: nothing about it needs a person to *look*, it
  needs a person to *pay*. `variant="destructive"` for "problem" becomes
  `blocks`, because a return that cannot be filed blocks the cutover and a
  failed form field does not.
- `totalOf` adds the three heads with exact `bigint` arithmetic and returns
  `null` if any head is unreadable. ⚠️ Summing with `BigInt(x || "0")` —
  which is the idiom already in this file — would report a total that
  silently omits a head the server failed to send, and a GST output total
  short by one head is the most expensive wrong number this screen could
  print.

⚠️ **`rupees()` in this file is left exactly as it is.** It is still used by
the by-head line and by the set-off working, `tests/ui/wave-2d-design-
system.test.tsx` §1 imports it and asserts it agrees with the primitive on
seven digits and on negatives, and replacing it is a bigger change than this
wave should be making in a file it does not own. See TRACK-REPORT.md §3 for
the standing risk.

```diff
--- a/components/returns/gstr3b-board.tsx
+++ b/components/returns/gstr3b-board.tsx
@@ -25,6 +25,9 @@
 import { Badge } from "@/components/ui/badge";
 import { Button } from "@/components/ui/button";
 import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
+/* ⭐ WAVE 2D — see PATCH-REQUEST-WAVE-2D.md §B. */
+import { MetricCard } from "@/components/ui/metric-card";
+import { StatusPill, type StatusMeaning } from "@/components/ui/status-pill";
 import { Input } from "@/components/ui/input";
 import { Label } from "@/components/ui/label";
 import { Textarea } from "@/components/ui/textarea";
@@ -42,6 +45,42 @@
   return `${negative ? "-" : ""}₹${whole}.${paise}`;
 }
 
+/**
+ * ⭐ WAVE 2D — THE RETURN'S STATUS, IN THE SIX MEANINGS.
+ *
+ * 🔴 `filed` IS `ties` AND NOT "success". A filed 3B means the figure
+ * Ordence computed and the figure the portal holds now agree — which is
+ * the same claim a reconciled bank line makes, and is why they share a
+ * colour. A draft that merely SAVED does not get it.
+ *
+ * ⚠️ `finalised` IS `statutory`, NOT `check`. It is a duty owed to the
+ * State with a date on it and nothing about it needs a person to look —
+ * it needs a person to pay.
+ */
+/**
+ * ⚠️ EXACT bigint ADDITION, AND `null` IF ANY HEAD IS UNREADABLE.
+ * Summing three heads with `BigInt(x || "0")` would report a total that
+ * silently omits a head the server failed to send — and a GST output
+ * total that is short by one head is the single most expensive wrong
+ * number this screen could print.
+ */
+function totalOf(...heads: string[]): string | null {
+  let sum = 0n;
+  for (const h of heads) {
+    if (!/^-?\d+$/.test(String(h ?? "").trim())) return null;
+    sum += BigInt(h);
+  }
+  return sum.toString();
+}
+
+function statusMeaning(status: string, hasProblems: boolean): StatusMeaning {
+  if (hasProblems) return "blocks";
+  if (status === "filed") return "ties";
+  if (status === "finalised") return "statutory";
+  if (status === "superseded") return "neutral";
+  return "check";
+}
+
 export type ReturnView = {
   id: string;
   gstin: string;
@@ -391,8 +430,13 @@
           <CardContent className="space-y-4 pt-4">
             <div className="flex flex-wrap items-center gap-2">
               <span className="font-medium">{r.taxPeriod}</span>
-              <Badge variant={r.status === "filed" ? "secondary" : "outline"}>{r.status}</Badge>
-              {r.problems.length > 0 ? <Badge variant="destructive">problem</Badge> : null}
+              <StatusPill
+                meaning={statusMeaning(r.status, false)}
+                label={r.status}
+              />
+              {r.problems.length > 0 ? (
+                <StatusPill meaning="blocks" label="Blocks filing" />
+              ) : null}
               {r.hasJournal ? <Badge variant="secondary">posted</Badge> : null}
               {r.arn ? <code className="font-mono text-xs">{r.arn}</code> : null}
               <span className="ml-auto text-xs text-muted-foreground">
@@ -401,15 +445,49 @@
             </div>
 
             {/* ---- 🔴 The number somebody has to find money for ------ */}
-            <div className="rounded border p-3">
-              <div className="text-xs text-muted-foreground">Payable in cash</div>
-              <div className="text-2xl font-semibold">{rupees(r.totalCashMinor)}</div>
-              <div className="mt-1 text-xs text-muted-foreground">
-                IGST {rupees(r.cashIgstMinor)} · CGST {rupees(r.cashCgstMinor)} · SGST{" "}
-                {rupees(r.cashSgstMinor)}
-                {BigInt(r.interestMinor || "0") > 0n ? ` · interest ${rupees(r.interestMinor)}` : ""}
-                {BigInt(r.lateFeeMinor || "0") > 0n ? ` · late fee ${rupees(r.lateFeeMinor)}` : ""}
-              </div>
+            {/**
+              * ⭐ WAVE 2D — THIS WAS ONE NUMBER ON ITS OWN AND IS NOW THREE.
+              *
+              * "Payable in cash ₹42,440" is a demand with no working
+              * shown. An accountant reading it re-derives it in a
+              * spreadsheet, and then there are two answers — which is the
+              * failure this file's own header is written about, one
+              * heading further down. The metric card makes the working
+              * the headline: output tax, credit claimed, and the cash gap
+              * between them on its own row.
+              *
+              * ⚠️ THE DIFFERENCE IS NOT COMPUTED BY THE CARD. `MetricCard`
+              * deliberately refuses to subtract — the cash payable here
+              * is the result of the set-off engine and its ORDER, not of
+              * `output - credit`, and the two are different numbers
+              * whenever any credit is carried forward.
+              */}
+            <MetricCard
+              title={`GST position, ${r.taxPeriod}`}
+              primary={{
+                minor: totalOf(r.outputIgstMinor, r.outputCgstMinor, r.outputSgstMinor),
+                qualifier: "Output tax",
+              }}
+              secondary={{
+                minor: totalOf(r.itcIgstMinor, r.itcCgstMinor, r.itcSgstMinor),
+                qualifier: "Credit available",
+              }}
+              difference={{
+                label: r.dueOn ? `Payable in cash, due ${r.dueOn}` : "Payable in cash",
+                minor: r.totalCashMinor,
+                // 🔴 `statutory`, not `blocks`. Cash being payable is the
+                // ordinary outcome of a return; it blocks nothing. It
+                // becomes `blocks` when the deadline has passed, and that
+                // is the screen's judgement to make, not the card's.
+                tone: "statutory",
+              }}
+              emphasis={r.problems.length > 0 ? "blocks" : undefined}
+            />
+            <div className="text-xs text-muted-foreground">
+              Cash by head — IGST {rupees(r.cashIgstMinor)} · CGST {rupees(r.cashCgstMinor)} · SGST{" "}
+              {rupees(r.cashSgstMinor)}
+              {BigInt(r.interestMinor || "0") > 0n ? ` · interest ${rupees(r.interestMinor)}` : ""}
+              {BigInt(r.lateFeeMinor || "0") > 0n ? ` · late fee ${rupees(r.lateFeeMinor)}` : ""}
             </div>
 
             <div className="grid gap-3 text-xs sm:grid-cols-2">
```

---

## §C — `components/settings/import-wizard.tsx`
### ⚠️ WAVE 2A OWNS THIS FILE. This is a request, and two rules.

**Rule 1 — sample values under every column. The wizard has none.**

The mapping table shows *Ordence field · Your column · Why*. It does not
show a single value from the customer's file. "Amount → total_minor" looks
correct and proves nothing; the question that decides whether the import is
right is whether that column holds `1,24,600`, `124600` or `1,24,600 Dr`,
and those are three different imports — the middle one is paise and the
other two are rupees, off by a factor of a hundred.

⭐ **The values are already in the component.** `records` is in state, and
`column.sourceIndex` says which column each proposal points at. No server
change and no new state is needed — three rows of `records` under each
column is the whole fix. This is the Customer.io pattern the design brief
names, and it is the cheapest correctness win in the wizard.

**Rule 2 — the warning goes on the row. `proposal.cautions` does not.**

`column.conflict` is already rendered on its row, which is right and is kept.
`proposal.cautions`, however, is rendered as a stack of amber paragraphs
*below the table*. That is the summary-at-the-bottom the brief forbids: a
person reading "3 columns need attention" has to hold three names in their
head, scroll back up, find each one and decide — and they will do that for
the first mapping and not for the fourth.

🔴 **This diff does not fix cautions, because it cannot.** `cautions` is
`readonly string[]` on `MappingProposal` — free sentences with no column
attached — so there is nothing to attach them to. Fixing it properly means
`lib/import/proposal.ts` giving each caution the `field` it is about, which
is 2A's decision and 2A's file. `MappingRow` is ready for it: `warning`
takes a string and renders it under that row's destination, and the
component has **no** `onWarning`, no `warnings` array and no id to correlate
with a panel elsewhere, so a screen cannot hoist them back into a summary
even by accident.

**On confidence.** `column.confidence` is a number and the diff does not
show it. "72%" invites a reader to work out where the threshold is and there
is no threshold they can act on; `confidenceOf` turns `basis` into a word
instead. ⚠️ `basis === "model"` is **always** `guess` whatever the score —
a model that is 96% sure is still a model, and this file's own header says a
mapping somebody clicked past is not a mapping somebody decided.

```diff
--- a/components/settings/import-wizard.tsx
+++ b/components/settings/import-wizard.tsx
@@ -73,6 +73,9 @@
 import type { ActionResult } from "@/lib/validators/crm";
 import type { CsvRecord } from "@/lib/import/csv";
 import type { MappingProposal } from "@/lib/import/proposal";
+import type { ColumnProposal, ProposalBasis } from "@/lib/import/proposal";
+/* ⭐ WAVE 2D — see PATCH-REQUEST-WAVE-2D.md §C. */
+import { MappingRow, type MappingConfidence } from "@/components/ui/mapping-row";
 import { EVIDENCE_SAMPLE_ROWS } from "@/lib/import/shapes";
 /**
  * ⭐ THE READERS RUN HERE, IN THE BROWSER. That is only possible because
@@ -190,6 +193,39 @@
   },
 ];
 
+
+/**
+ * ⭐⭐⭐ WAVE 2D — HOW SURE THE MAPPER WAS, AS A WORD.
+ *
+ * 🔴 THE PERCENTAGE IS NOT SHOWN AND THAT IS DELIBERATE. `column.confidence`
+ * is a number and "72%" invites a reader to work out where the threshold
+ * is — and there is no threshold they can act on. The honest content is
+ * what the mapper KNEW, which is `basis`:
+ *
+ *   exact-header / profile-header / alias  → nothing to decide
+ *   value-shape / token-*                  → inferred; likely
+ *   model                                  → an AI proposed it; CONFIRM
+ *   none                                   → no proposal, which is normal
+ *
+ * ⚠️ `model` IS ALWAYS `guess`, WHATEVER THE SCORE. A model that is 96%
+ * sure is still a model, and the wizard's own header says a mapping
+ * somebody clicked past is not a mapping somebody decided.
+ *
+ * ⚠️ A CONFLICT OUTRANKS EVERYTHING. `conflict` is set when a model and
+ * the values disagree — the one case a human must look at — so it cannot
+ * be allowed to render as "Exact match" because the header happened to
+ * match too.
+ */
+function confidenceOf(column: ColumnProposal): MappingConfidence {
+  if (column.conflict) return "guess";
+  if (!column.sourceHeader) return "none";
+  const basis: ProposalBasis = column.basis;
+  if (basis === "exact-header" || basis === "profile-header" || basis === "alias") return "exact";
+  if (basis === "model") return "guess";
+  if (basis === "none") return "none";
+  return "likely";
+}
+
 export function ImportWizard({
   preview,
   commit,
@@ -840,28 +876,47 @@
 
           {proposal ? (
             <div className="space-y-3">
-              <div className="overflow-x-auto rounded-lg border bg-card">
-                <table className="w-full text-sm">
-                  <thead>
-                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
-                      <th scope="col" className="p-3 font-medium">Ordence field</th>
-                      <th scope="col" className="p-3 font-medium">Your column</th>
-                      <th scope="col" className="p-3 font-medium">Why</th>
-                    </tr>
-                  </thead>
-                  <tbody>
-                    {proposal.columns.map((column) => {
-                      const chosen = overrides[column.field] ?? column.sourceHeader ?? "";
-                      return (
-                        <tr key={column.field} className="border-b align-top last:border-0">
-                          <td className="p-3">
-                            <span className="font-medium">{column.header}</span>
-                            {column.required ? (
-                              <span className="ml-2 text-xs text-muted-foreground">required</span>
-                            ) : null}
-                          </td>
-                          <td className="p-3">
-                            <select
+              {/**
+                * ⭐⭐⭐ WAVE 2D — THIS WAS A TABLE AND IS NOW A LIST OF
+                * DECISIONS, FOR TWO REASONS THAT ARE BOTH RULES.
+                *
+                * 🔴 1. SAMPLE VALUES UNDER EVERY COLUMN. The table had
+                * none. "Amount → total_minor" looks correct and proves
+                * nothing; the question that decides the import is whether
+                * that column holds "1,24,600", "124600" or "1,24,600 Dr",
+                * and those are three different imports. Three of the
+                * customer's own values answer it in a glance and no
+                * confidence score does. They are already in `records` —
+                * no server change was needed to show them.
+                *
+                * 🔴 2. THE CONFLICT SITS ON THE ROW. It already did here,
+                * which is right; `proposal.cautions` below still does not,
+                * and that is raised separately in the patch request.
+                */}
+              <div className="overflow-hidden rounded-lg border bg-card">
+                {proposal.columns.map((column) => {
+                  const chosen = overrides[column.field] ?? column.sourceHeader ?? "";
+                  const index =
+                    chosen === "" ? -1 : proposal.sourceHeaders.indexOf(chosen);
+                  const samples =
+                    index < 0
+                      ? []
+                      : (records ?? [])
+                          .slice(1, 4)
+                          .map((r) => r.cells[index] ?? "");
+                  return (
+                    <MappingRow
+                      key={column.field}
+                      sourceColumn={
+                        column.required ? `${column.header} · required` : column.header
+                      }
+                      samples={samples}
+                      confidence={confidenceOf(column)}
+                      /* 🔴 ON THE ROW. The conflict and the reason both. */
+                      warning={column.conflict ?? null}
+                      destinationControl={
+                        <>
+                          <select
                               aria-label={`Which of your columns is ${column.header}`}
                               className="h-9 w-full min-w-40 rounded-md border border-input bg-background px-2 text-sm"
                               value={chosen}
@@ -879,25 +934,28 @@
                                   {header}
                                 </option>
                               ))}
-                            </select>
-                          </td>
-                          <td className="p-3 text-xs text-muted-foreground">
-                            {/*
-                              ⚠️ THE REASON, NOT A PERCENTAGE ON ITS OWN.
-                              "72%" is not something a person can check.
-                              "matched on its contents — 92% of its values
-                              look like a GSTIN" is.
-                            */}
+                          </select>
+                          {/*
+                            ⚠️ THE REASON, NOT A PERCENTAGE ON ITS OWN.
+                            "72%" is not something a person can check.
+                            "matched on its contents — 92% of its values
+                            look like a GSTIN" is.
+
+                            ⚠️ IT STAYS HERE AND IS NOT FOLDED INTO
+                            `warning`. `why` is always present and is
+                            explanatory; `warning` is exceptional and is
+                            the thing that must be read. Putting the
+                            ordinary sentence in the exceptional slot is
+                            how a person learns to skip the slot.
+                          */}
+                          <p className="mt-1.5 text-[11.5px] leading-[1.45] text-muted-foreground">
                             {column.why}
-                            {column.conflict ? (
-                              <span className="mt-1 block text-amber-700">{column.conflict}</span>
-                            ) : null}
-                          </td>
-                        </tr>
-                      );
-                    })}
-                  </tbody>
-                </table>
+                          </p>
+                        </>
+                      }
+                    />
+                  );
+                })}
               </div>
 
               {proposal.cautions.map((caution) => (
```

---

## §E — the one that stays red, and why it is not in this file

`§9 AccountTreeRow is RENDERED by at least one screen` fails after every
patch above is applied. That is correct and it is not an oversight.

**There is no grouped trial balance in this tree.** `find app components
-ipath "*trial*"` returns nothing; the only trial balance is the flat ledger
list in `app/(crm)/accounting/page.tsx` — no groups, no collapse, no
prior-period column, and two extra columns (`Type`, `Currency`) that the tree
row has no slot for. `AccountTreeRow` is the Xero/Wave/Quicken pattern from
the design brief and its host is a screen nobody has built.

🔴 **The first draft of §A imported `AccountTreeRow` and did not render it,
and the reachability test went green.** The check was matching the
identifier inside the import statement. That is the fourth time a checker in
this codebase has had this exact bug, so the test now strips import
statements and matches `<Name` — and it immediately went red, which is how
this paragraph came to be written instead of a false green being shipped.

Wiring the tree row into the flat trial balance to make a check pass would
be the defect the check exists to find. The two honest options are:

1. **Build the grouped trial balance** — group by `row.accountType`, which is
   already on every row, with collapsible groups, count badges and a prior
   period. That is a screen, and this wave is explicitly forbidden to build
   one.
2. **Delete `components/ui/account-tree-row.tsx`** if nobody intends to build
   it this quarter. A primitive with no host is a maintenance surface with no
   user, and shipping it "for later" is how a five-component design system
   becomes a forty-component one.

Wave 2D's recommendation is (1), in the wave that owns the accounting
screens. Until then the test states the fact out loud, which is the only
thing that stops "the primitives are adopted" from becoming true by
assumption.
