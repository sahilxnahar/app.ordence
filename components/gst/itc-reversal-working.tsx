"use client";

/**
 * Ordence — ⭐⭐⭐ THE RULE 42 REVERSAL, WITH ITS WORKING
 * Version: v1.46.0-alpha · Batch 39
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FIGURE THIS REPLACES WAS TYPED BY A HUMAN INTO A FORM
 * ══════════════════════════════════════════════════════════════════════
 * `lib/purchases/itc.ts` has decided Section 17(5) for every purchase
 * line since Phase 33. `lib/purchases/apportionment.ts` has implemented
 * Rule 42 to the paisa, with the partition asserted rather than assumed.
 * Both were tested. Neither was reachable from the return, and the box
 * marked "ITC reversed" on the GSTR-3B was an empty text field with a
 * note next to it saying reversals are entered, not calculated.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHY THIS PANEL IS MOSTLY WORKING AND ONLY A LITTLE ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * A computed figure the operator cannot check is WORSE than a typed one,
 * not better. A typed figure is known to be somebody's judgement and gets
 * re-derived in a spreadsheet before it is filed. A computed figure that
 * arrives with no working is trusted on the first return, glanced at on
 * the third, and never looked at again — and the month the exempt ratio
 * moves because a completed tower was sold, nobody notices that the
 * reversal moved with it or failed to.
 *
 * So the number is the smallest thing on this panel. Above it sit:
 *
 *   1. WHICH INVOICES WERE BLOCKED AND UNDER WHICH CLAUSE. Not "₹4.2 lakh
 *      blocked" — "17(5)(d), 6 lines, ₹4.2 lakh, and here they are with
 *      the vendor's own invoice number on each". That is the list an
 *      officer asks for, and it is the list the accountant can walk over
 *      and check against the file.
 *
 *   2. THE RATIO. E and F in rupees, and E/F in basis points. A reversal
 *      of ₹80,000 means nothing; "34.21% of the period's turnover was
 *      exempt, so 34.21% of the common credit reverses" is checkable
 *      against a sales figure the person already knows.
 *
 *   3. THE LETTERS OF RULE 42 IN THE RULE'S OWN NAMES — C1, T1..T4, C2,
 *      C3, D1, D2. Anybody who has read the rule can follow the
 *      arithmetic without reading any code; anybody who has not can be
 *      handed the rule and the panel side by side.
 *
 *   4. WHAT IT DOES NOT COVER. Rule 43 capital goods, lines eligible only
 *      on a proviso, and the fact that E and F were typed. A computed
 *      figure that hides its own gaps is how somebody stops checking.
 *
 * ⚠️ MONEY ARRIVES AND LEAVES AS A DECIMAL STRING OF PAISE. Never a
 * number. `Number("123456789012345")` is still exact, but the first month
 * a workspace crosses ₹90,00,00,00,000 of credit it stops being, and the
 * failure is a silently wrong return rather than an error.
 */

import { useState, useTransition } from "react";
import { getItcReversalWorking, runRule42ForPeriod } from "@/server/actions/purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

/** Paise to rupees for display. Integer arithmetic on strings, always. */
export function paiseToRupees(minor: string): string {
  const value = BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toLocaleString("en-IN");
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${whole}.${paise}`;
}

/** Basis points to a percentage, for the working only. */
function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

type WorkingLine = {
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string;
  lineNumber: number;
  description: string;
  statutoryRef: string | null;
  blockReason: string | null;
  eligibility: string;
  taxMinor: string;
  engineEligibility: string;
  engineStatutoryRef: string;
  engineExplanation: string;
  divergence: string | null;
};

type Working = {
  taxPeriod: string;
  lineCount: number;
  blockedTotalMinor: string;
  byClause: Array<{
    statutoryRef: string;
    blockReason: string | null;
    lineCount: number;
    blockedTaxMinor: string;
  }>;
  blockedLines: WorkingLine[];
  provisoLines: WorkingLine[];
  linesNotListed: number;
  exemptTurnoverMinor: string;
  totalTurnoverMinor: string;
  exemptRatioBps: number;
  deemedNonBusinessRateBps: number;
  c1Minor: string;
  t1Minor: string;
  t2Minor: string;
  t3Minor: string;
  c2Minor: string;
  t4Minor: string;
  c3Minor: string;
  d1Minor: string;
  d2Minor: string;
  eligibleCommonMinor: string;
  reversalIgstMinor: string;
  reversalCgstMinor: string;
  reversalSgstMinor: string;
  reversalCessMinor: string;
  reversalTotalMinor: string;
  capitalCommonMinor: string;
  rule43MonthlySliceMinor: string;
  rule43ThisPeriodMinor: string;
  caveats: string[];
};

export type ComputedReversal = {
  igstMinor: string;
  cgstMinor: string;
  sgstMinor: string;
  cessMinor: string;
  /** One line naming where the figure came from. Stored with the return. */
  basis: string;
};

/**
 * ⭐ The panel. `taxPeriod` is owned by the prepare form above it, so the
 * working can never be computed for a different month than the return is
 * being prepared for — which is the one mistake that would produce a
 * perfectly-formed reversal for the wrong period.
 */
export function ItcReversalWorking({
  taxPeriod,
  onUse,
}: {
  taxPeriod: string;
  onUse: (computed: ComputedReversal) => void;
}) {
  const [pending, start] = useTransition();
  const [exempt, setExempt] = useState("");
  const [total, setTotal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  /**
   * ⚠️ EDITING E OR F DISCARDS THE WORKING.
   *
   * The panel shows one number and offers two buttons that act on it —
   * put it in the return, post it to the register. If a turnover figure
   * could be changed while a stale working stayed on screen, both buttons
   * would send figures derived from the NEW E and F while the operator
   * read the old ones. The two numbers would differ by an amount nobody
   * could see, in the direction the person editing was moving.
   */
  function setTurnover(next: { exempt?: string; total?: string }): void {
    if (next.exempt !== undefined) setExempt(next.exempt);
    if (next.total !== undefined) setTotal(next.total);
    setWorking(null);
    setPosted(null);
  }

  /**
   * ⚠️ COMMAS OUT, NOTHING ELSE TOUCHED. "33,00,000" is how the figure
   * appears on every Indian statement the operator is copying from, and
   * the money validator refuses it. Stripping the separator here is the
   * whole of the leniency — anything else typed is still refused, with
   * the validator's own sentence, rather than being silently reshaped
   * into a number nobody meant.
   */
  const rupeeInput = (raw: string): string => {
    const cleaned = raw.replace(/,/g, "").trim();
    return cleaned === "" ? "0" : cleaned;
  };

  function compute() {
    setError(null);
    setPosted(null);
    start(async () => {
      const res = await getItcReversalWorking({
        taxPeriod,
        exemptTurnover: rupeeInput(exempt),
        totalTurnover: rupeeInput(total),
      });
      if (!res.ok) {
        setWorking(null);
        setError(res.error);
        return;
      }
      setWorking(res.data as Working);
    });
  }

  /**
   * ⚠️ POSTING IS A SEPARATE, SECOND ACT AND A DIFFERENT PERMISSION.
   * `runRule42ForPeriod` writes the reversal into the ITC register, which
   * is the internal record of what was reversed and why. Computing it is
   * `purchases:read`; posting it is `purchases:reverse_itc`, because an
   * over-reversal is money quietly given away and that is not the same
   * grant as being allowed to look at the working.
   */
  function postToRegister() {
    if (!working) return;
    setError(null);
    start(async () => {
      const res = await runRule42ForPeriod({
        taxPeriod,
        exemptTurnover: rupeeInput(exempt),
        totalTurnover: rupeeInput(total),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPosted(
        `Recorded in the ITC register for ${taxPeriod}: ${paiseToRupees(
          res.data.totalReversalMinor,
        )} reversed under Rule 42(1).`,
      );
    });
  }

  return (
    <div className="space-y-3 rounded border p-3 text-xs" data-testid="itc-reversal-working">
      <div>
        <div className="font-medium">Rule 42 reversal for {taxPeriod || "—"}</div>
        <p className="mt-1 text-muted-foreground">
          Computed from the period&apos;s purchase lines by the Section 17(5) and Rule 42
          engines. The working is below it, because a figure you cannot check is worse than
          one you typed yourself — you stop checking.
        </p>
      </div>

      {/*
        ⚠️ E AND F ARE ASKED FOR AND NOT DERIVED. The Explanation to Rule
        42 pulls the value of land sold and of buildings sold AFTER the
        completion certificate into exempt turnover. Neither raises a tax
        invoice — a sale after the certificate is outside GST entirely
        (Schedule III para 5) — so deriving E from the invoice table would
        silently omit the largest exempt figure a developer has,
        understate the reversal and overstate the credit.
      */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="rule42-exempt">Exempt turnover E (₹)</Label>
          <Input
            id="rule42-exempt"
            value={exempt}
            onChange={(e) => setTurnover({ exempt: e.target.value })}
            placeholder="0.00"
          />
          <p className="text-muted-foreground">
            Include land and completed-building sales. They raise no invoice and cannot be
            derived.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule42-total">Total turnover F (₹)</Label>
          <Input
            id="rule42-total"
            value={total}
            onChange={(e) => setTurnover({ total: e.target.value })}
            placeholder="0.00"
          />
          <p className="text-muted-foreground">E is a subset of F, not a separate figure.</p>
        </div>
        <div className="flex items-start">
          <Button type="button" size="sm" disabled={pending || !taxPeriod} onClick={compute}>
            Compute the reversal
          </Button>
        </div>
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}
      {posted ? <p className="text-muted-foreground">{posted}</p> : null}

      {working ? (
        <div className="space-y-4 border-t pt-3">
          {/* ---- ⭐ THE ANSWER, and immediately under it the working -- */}
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Reversal — GSTR-3B Table 4(B)(1)</div>
            <div className="text-lg font-semibold" data-testid="computed-reversal-total">
              {paiseToRupees(working.reversalTotalMinor)}
            </div>
            <div className="mt-1 text-muted-foreground">
              IGST {paiseToRupees(working.reversalIgstMinor)} · CGST{" "}
              {paiseToRupees(working.reversalCgstMinor)} · SGST{" "}
              {paiseToRupees(working.reversalSgstMinor)} · cess{" "}
              {paiseToRupees(working.reversalCessMinor)}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  onUse({
                    igstMinor: working.reversalIgstMinor,
                    cgstMinor: working.reversalCgstMinor,
                    sgstMinor: working.reversalSgstMinor,
                    cessMinor: working.reversalCessMinor,
                    basis:
                      `Rule 42 for ${working.taxPeriod} over ${working.lineCount} purchase ` +
                      `lines: C3 ${paiseToRupees(working.c3Minor)}, E/F ` +
                      `${bpsToPct(working.exemptRatioBps)}, D1 ` +
                      `${paiseToRupees(working.d1Minor)} + D2 ` +
                      `${paiseToRupees(working.d2Minor)}.`,
                  })
                }
              >
                Use this figure in the return
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={postToRegister}
              >
                Record it in the ITC register
              </Button>
            </div>
          </div>

          {/* ---- ① SECTION 17(5): WHICH BILLS, WHICH CLAUSE --------- */}
          <div>
            <div className="font-medium">
              Blocked under Section 17(5): {paiseToRupees(working.blockedTotalMinor)}
            </div>
            {working.byClause.length === 0 ? (
              <p className="mt-1 text-muted-foreground">
                No line in this period was blocked. Every rupee of input tax entered the pool
                that Rule 42 apportions.
              </p>
            ) : (
              <table className="mt-2 w-full">
                <tbody>
                  {working.byClause.map((c) => (
                    <tr key={c.statutoryRef} className="border-b last:border-0">
                      <td className="py-1">
                        <code className="font-mono">{c.statutoryRef}</code>
                        {c.blockReason ? (
                          <span className="text-muted-foreground"> · {c.blockReason}</span>
                        ) : null}
                      </td>
                      <td className="py-1 text-right text-muted-foreground">
                        {c.lineCount} line{c.lineCount === 1 ? "" : "s"}
                      </td>
                      <td className="py-1 text-right">{paiseToRupees(c.blockedTaxMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {working.blockedLines.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground">
                  The blocked bills, one by one
                </summary>
                <table className="mt-2 w-full">
                  <tbody>
                    {working.blockedLines.map((l) => (
                      <tr
                        key={`${l.invoiceNumber}-${l.lineNumber}`}
                        className="border-b align-top last:border-0"
                      >
                        <td className="py-1">
                          <div>
                            <code className="font-mono">{l.invoiceNumber}</code>{" "}
                            <span className="text-muted-foreground">
                              {l.invoiceDate} · {l.vendorName}
                            </span>
                          </div>
                          <div className="text-muted-foreground">
                            line {l.lineNumber}: {l.description}
                          </div>
                          <div>
                            <code className="font-mono">{l.statutoryRef ?? "—"}</code>{" "}
                            <span className="text-muted-foreground">
                              {l.blockReason ?? ""}
                            </span>
                          </div>
                          {l.divergence ? (
                            <div className="mt-1 text-amber-700 dark:text-amber-400">
                              {l.divergence}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-1 text-right">{paiseToRupees(l.taxMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}

            {/*
              ⭐ THE LINES THAT SURVIVED ONLY ON A PROVISO. A canteen
              mandatory under Section 46 of the Factories Act is genuinely
              creditable; the same canteen without the obligation is
              blocked by 17(5)(b). The row cannot tell them apart, so the
              panel names them and says the evidence has to exist.
            */}
            {working.provisoLines.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-amber-700 dark:text-amber-400">
                  {working.provisoLines.length} line
                  {working.provisoLines.length === 1 ? "" : "s"} eligible only on a
                  Section 17(5) proviso
                </summary>
                <table className="mt-2 w-full">
                  <tbody>
                    {working.provisoLines.map((l) => (
                      <tr
                        key={`proviso-${l.invoiceNumber}-${l.lineNumber}`}
                        className="border-b align-top last:border-0"
                      >
                        <td className="py-1">
                          <div>
                            <code className="font-mono">{l.invoiceNumber}</code>{" "}
                            <span className="text-muted-foreground">
                              {l.invoiceDate} · {l.vendorName}
                            </span>
                          </div>
                          <div className="text-muted-foreground">{l.divergence}</div>
                        </td>
                        <td className="py-1 text-right">{paiseToRupees(l.taxMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}

            {working.linesNotListed > 0 ? (
              <p className="mt-1 text-muted-foreground">
                {working.linesNotListed} further line
                {working.linesNotListed === 1 ? " is" : "s are"} not listed above. The totals
                include every one of them.
              </p>
            ) : null}
          </div>

          {/* ---- ② THE RATIO --------------------------------------- */}
          <div>
            <div className="font-medium">The ratio Rule 42 applied</div>
            <p className="mt-1">
              Exempt turnover E {paiseToRupees(working.exemptTurnoverMinor)} ÷ total turnover
              F {paiseToRupees(working.totalTurnoverMinor)} ={" "}
              <strong data-testid="exempt-ratio">{bpsToPct(working.exemptRatioBps)}</strong>{" "}
              ({working.exemptRatioBps} bps).
            </p>
            <p className="mt-1 text-muted-foreground">
              D1 reverses that share of the common credit. D2 reverses a further{" "}
              {bpsToPct(working.deemedNonBusinessRateBps)} of it as deemed non-business use,
              which Rule 42(1)(l) fixes whether or not any exists.
            </p>
          </div>

          {/* ---- ③ THE LETTERS ------------------------------------- */}
          <div>
            <div className="font-medium">The formula, in the rule&apos;s own letters</div>
            <table className="mt-2 w-full">
              <tbody>
                {(
                  [
                    ["C1", "input tax on the period's inputs and input services", working.c1Minor],
                    ["T1", "exclusively non-business", working.t1Minor],
                    ["T2", "exclusively exempt", working.t2Minor],
                    ["T3", "blocked by Section 17(5)", working.t3Minor],
                    ["C2", "C1 − (T1+T2+T3) — what enters the credit ledger", working.c2Minor],
                    ["T4", "exclusively taxable, including zero-rated", working.t4Minor],
                    ["C3", "C2 − T4 — the common credit", working.c3Minor],
                    ["D1", "C3 × E ÷ F — reversed as attributable to exempt supplies", working.d1Minor],
                    ["D2", "5% of C3 — reversed as deemed non-business", working.d2Minor],
                    ["C3 − D1 − D2", "common credit that survives, by subtraction", working.eligibleCommonMinor],
                  ] as const
                ).map(([letter, meaning, amount]) => (
                  <tr key={letter} className="border-b last:border-0">
                    <td className="py-1 font-mono">{letter}</td>
                    <td className="py-1 text-muted-foreground">{meaning}</td>
                    <td className="py-1 text-right">{paiseToRupees(amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-muted-foreground">
              Built from {working.lineCount} purchase line
              {working.lineCount === 1 ? "" : "s"} for {working.taxPeriod}. Cancelled bills are
              excluded — their credit may already have reached a return.
            </p>
          </div>

          {/* ---- ④ WHAT IT DOES NOT COVER -------------------------- */}
          <div>
            <div className="font-medium">What this figure does not cover</div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {working.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {BigInt(working.capitalCommonMinor || "0") > 0n ? (
              <p className="mt-1">
                <Badge variant="outline">Rule 43</Badge> Tc{" "}
                {paiseToRupees(working.capitalCommonMinor)} · Tm{" "}
                {paiseToRupees(working.rule43MonthlySliceMinor)} per month · Te{" "}
                {paiseToRupees(working.rule43ThisPeriodMinor)} for this month, on capital
                goods bought in this period only. Not included above.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
