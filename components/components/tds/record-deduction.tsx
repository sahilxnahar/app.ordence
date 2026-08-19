"use client";

/**
 * Ordence — ⭐⭐⭐ RECORD A TDS DEDUCTION
 * Version: v1.69.0-alpha (Wave one)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THIS IS THE ONLY WAY INTO `tds_deductions`, AND UNTIL NOW THERE
 *        WAS NONE
 * ══════════════════════════════════════════════════════════════════════
 * `recordDeduction` in `server/actions/tds.ts` holds the only INSERT into
 * that table anywhere in the product, and no screen, route or job called
 * it. The register, the interest exposure, Form 26Q and Form 16A all read
 * a table nothing could write, and all four rendered correctly and empty.
 * An empty TDS register reads as "nothing owed", which is the most
 * expensive way for this particular module to be broken.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ ASSESS FIRST, THEN RECORD, AND THEY ARE TWO CALLS ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * `assessDeduction` answers "what comes off this payment" without writing
 * anything, and it needs only `tds:read`. That matters because the answer
 * is often a surprise: once the annual threshold under 194C(5) is crossed,
 * the tax on a ₹25,000 payment is ₹1,000 and not ₹250, because the whole
 * year's aggregate comes into charge at once. The contractor receives
 * ₹24,000. That is a conversation, and it is a much shorter one had
 * before the money moves.
 *
 * ⚠️ THE ASSESSED FIGURES ARE NEVER SENT BACK. `recordDeduction` re-runs
 * the assessment server-side and ignores anything this component thinks
 * it knows. Between the preview and the save another payment to the same
 * deductee may have crossed the threshold, and a form that posted its own
 * numbers would write the stale one. This component holds the assessment
 * to SHOW it, and for no other purpose.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ RULE 26 — THE FOREIGN-CURRENCY HALF, WHICH HAD NO CALLER AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `foreignPayment` has been accepted by the action and validated by
 * `lib/validators/tds.ts` since 0106 and nothing anywhere passed one. The
 * toggle below is that argument's first caller.
 *
 * 🔴 AND THE RUPEE BOX IS NOT MERELY HIDDEN WHEN IT IS ON. It is cleared,
 * because `exactlyOneBase` in the validator REFUSES a request carrying
 * both — a typed rupee figure and a Rule 26 figure are two different
 * numbers, and accepting both would mean silently choosing one. A hidden
 * input that still holds "25000" from before the toggle would be refused
 * by the server with a message about supplying two bases, which reads as
 * a bug in the form rather than as the rule it is.
 */

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DeducteeOption {
  id: string;
  code: string;
  legalName: string;
  panNumber: string | null;
  panStatus: string;
  deducteeType: string;
  isNonResident: boolean;
  isSpecifiedPerson206ab: boolean;
}

export interface SectionOption {
  code: string;
  label: string;
  statutoryRef: string;
  rateResolvable: boolean;
  note: string;
}

export interface Assessment {
  section: string;
  outcome: string;
  chargeable: boolean;
  trigger: string;
  aggregateBeforeMinor: string;
  aggregateAfterMinor: string;
  paymentBaseMinor: string;
  catchUpBaseMinor: string;
  chargeableBaseMinor: string;
  rateBps: number;
  rateBasis: string;
  statutoryRef: string;
  tdsMinor: string;
  netPayableMinor: string;
  explanation: string;
  warnings: string[];
  problem: string | null;
}

function inr(minor: string): string {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? "−" : ""}₹${(abs / 100n).toString()}.${(abs % 100n)
    .toString()
    .padStart(2, "0")}`;
}

const BLANK = {
  deducteeId: "",
  section: "",
  paymentBaseMinor: "",
  deductionDate: "",
  referenceNumber: "",
  description: "",
  manualRateBps: "",
  manualRateReason: "",
};

const BLANK_FOREIGN = {
  currency: "",
  amountMinor: "",
  creditDate: "",
  paymentDate: "",
};

export function RecordDeduction({
  deductees,
  sections,
  assessAction,
  recordAction,
}: {
  deductees: readonly DeducteeOption[];
  sections: readonly SectionOption[];
  assessAction: (i: unknown) => Promise<Result<Assessment>>;
  recordAction: (
    i: unknown,
  ) => Promise<Result<{ id: string; tdsMinor: string; explanation: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ ...BLANK });
  const [foreignOn, setForeignOn] = useState(false);
  const [foreign, setForeign] = useState({ ...BLANK_FOREIGN });
  const [assessment, setAssessment] = useState<Assessment | null>(null);

  const chosenSection = useMemo(
    () => sections.find((s) => s.code === form.section) ?? null,
    [sections, form.section],
  );
  const chosenDeductee = useMemo(
    () => deductees.find((d) => d.id === form.deducteeId) ?? null,
    [deductees, form.deducteeId],
  );

  /**
   * ⭐ ONE PAYLOAD BUILDER FOR BOTH CALLS. Assessing against one shape and
   * recording against another is how a preview comes to describe a
   * different payment from the one that gets written.
   */
  function basePayload() {
    return {
      deducteeId: form.deducteeId,
      section: form.section,
      deductionDate: form.deductionDate,
      referenceNumber: form.referenceNumber || null,
      description: form.description || null,
      /**
       * 🔴 EXACTLY ONE OF THESE IS EVER PRESENT. `exactlyOneBase` in
       * `lib/validators/tds.ts` refuses a request carrying both, and
       * `null` rather than `""` because the validator tests presence.
       */
      paymentBaseMinor: foreignOn ? null : form.paymentBaseMinor || null,
      foreignPayment: foreignOn
        ? {
            currency: foreign.currency.trim().toUpperCase(),
            amountMinor: foreign.amountMinor,
            creditDate: foreign.creditDate || null,
            paymentDate: foreign.paymentDate || null,
          }
        : null,
    };
  }

  function runAssess() {
    startTransition(async () => {
      const res = await assessAction(basePayload());
      if (!res.ok) {
        setAssessment(null);
        toast.error(res.error);
        return;
      }
      setAssessment(res.data);
    });
  }

  function runRecord() {
    startTransition(async () => {
      const res = await recordAction({
        ...basePayload(),
        /**
         * ⚠️ ONLY FOR 192 AND 195, AND THE REASON IS REQUIRED WITH IT.
         * The row records `rate_basis = 'manually_determined'`, so the
         * register can tell a rate a person determined from one the
         * engine resolved. Sending an empty string would post a rate of
         * zero on the two sections with the largest penalty attached.
         */
        manualRateBps: form.manualRateBps ? Number(form.manualRateBps) : null,
        manualRateReason: form.manualRateReason || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Recorded. ${inr(res.data.tdsMinor)} withheld. ${res.data.explanation}`,
      );
      setForm({ ...BLANK });
      setForeign({ ...BLANK_FOREIGN });
      setForeignOn(false);
      setAssessment(null);
    });
  }

  const canAssess =
    form.deducteeId !== "" &&
    form.section !== "" &&
    form.deductionDate !== "" &&
    (foreignOn
      ? foreign.currency !== "" && foreign.amountMinor !== ""
      : form.paymentBaseMinor !== "");

  /**
   * 🔴 THE MANUAL RATE IS REQUIRED, NOT OPTIONAL, ON AN UNRESOLVABLE
   * SECTION. The engine refuses to invent one for 192 or 195, so a
   * submission without it fails server-side; saying so here means the
   * person supplies the working rather than meeting a refusal.
   */
  const needsManualRate = chosenSection !== null && !chosenSection.rateResolvable;
  const manualRateReady =
    !needsManualRate ||
    (form.manualRateBps !== "" && form.manualRateReason.trim().length > 0);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">The payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {deductees.length === 0 && (
            <p className="text-destructive">
              There are no active deductees. A deduction is recorded against a
              person with a PAN, because the PAN is what decides the rate:
              without one, section 206AA applies at twenty per cent. Add a
              deductee before recording anything.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="deductee">Deductee</Label>
              <select
                id="deductee"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.deducteeId}
                onChange={(e) =>
                  setForm({ ...form, deducteeId: e.target.value })
                }
              >
                <option value="">Choose…</option>
                {deductees.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} · {d.legalName}
                    {d.panNumber ? ` · ${d.panNumber}` : " · NO PAN"}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="section">Section</Label>
              <select
                id="section"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.section}
                onChange={(e) => {
                  setForm({ ...form, section: e.target.value });
                  setAssessment(null);
                }}
              >
                <option value="">Choose…</option>
                {sections.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/**
           * ⚠️ THE TWO FLAGS THAT CHANGE THE RATE ARE SHOWN AT THE MOMENT
           * A DEDUCTEE IS CHOSEN, not discovered in the assessment. A
           * missing PAN means 206AA at 20%, and a specified person under
           * 206AB means a higher rate again. Both are facts about who is
           * being paid, and the person filling this in is usually the
           * person who can go and get the PAN.
           */}
          {chosenDeductee && (
            <div className="flex flex-wrap gap-2">
              {chosenDeductee.panNumber === null && (
                <Badge variant="destructive">
                  No PAN — section 206AA applies at 20%
                </Badge>
              )}
              {chosenDeductee.isSpecifiedPerson206ab && (
                <Badge variant="destructive">
                  Specified person under 206AB — higher rate
                </Badge>
              )}
              {chosenDeductee.isNonResident && (
                <Badge variant="secondary">
                  Non-resident — section 195, rate needs the treaty position
                </Badge>
              )}
            </div>
          )}

          {chosenSection && (
            <p className="text-muted-foreground">
              {chosenSection.statutoryRef} · {chosenSection.note}
            </p>
          )}

          {/**
           * ⭐⭐⭐ RULE 26. THE TOGGLE THAT GIVES `foreignPayment` ITS
           * FIRST CALLER.
           */}
          <div className="rounded-md border p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={foreignOn}
                onChange={(e) => {
                  setForeignOn(e.target.checked);
                  /**
                   * 🔴 CLEARED, NOT HIDDEN. See the header: a stale rupee
                   * figure travelling with a foreign payment is refused by
                   * `exactlyOneBase`, and the refusal would read as a bug
                   * in this form rather than as the rule it is.
                   */
                  setForm((f) => ({ ...f, paymentBaseMinor: "" }));
                  setForeign({ ...BLANK_FOREIGN });
                  setAssessment(null);
                }}
              />
              <span>
                <span className="font-medium">
                  The payment was made in a foreign currency
                </span>
                <span className="block text-xs text-muted-foreground">
                  The rupee base is then not typed. Rule 26 of the Income-tax
                  Rules 1962 requires it to be the amount converted at the
                  telegraphic transfer buying rate on the date the tax is
                  required to be deducted — and that date is the earlier of
                  credit and payment, which is often not the date the money
                  left. Ordence refuses rather than falling back to another
                  rate if no TT buying rate is on file for that day.
                </span>
              </span>
            </label>
          </div>

          {foreignOn ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fx-ccy">Currency</Label>
                <Input
                  id="fx-ccy"
                  placeholder="USD"
                  maxLength={3}
                  value={foreign.currency}
                  onChange={(e) =>
                    setForeign({ ...foreign, currency: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-amt">
                  Amount, in that currency&apos;s minor units
                </Label>
                <Input
                  id="fx-amt"
                  inputMode="numeric"
                  placeholder="500000"
                  value={foreign.amountMinor}
                  onChange={(e) =>
                    setForeign({ ...foreign, amountMinor: e.target.value })
                  }
                />
                {/**
                 * ⚠️ "MINOR UNITS" AND NOT "PAISE", AND NOT TWO DECIMALS.
                 * A currency's exponent is its own: JPY has none, and
                 * KWD, BHD, OMR, JOD, TND, LYD and IQD have three. A form
                 * that said "cents" would be wrong for seven currencies
                 * and silently wrong by a factor of ten for six of them.
                 */}
                <p className="text-xs text-muted-foreground">
                  US$5,000.00 is 500000. ⚠️ Not every currency has two
                  decimals — the yen has none, the dinar has three.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-credit">Date credited</Label>
                <Input
                  id="fx-credit"
                  type="date"
                  value={foreign.creditDate}
                  onChange={(e) =>
                    setForeign({ ...foreign, creditDate: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-paid">Date paid</Label>
                <Input
                  id="fx-paid"
                  type="date"
                  value={foreign.paymentDate}
                  onChange={(e) =>
                    setForeign({ ...foreign, paymentDate: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Give both where both are known. The tax falls due on the
                  earlier, and the server refuses the row if the deduction date
                  below disagrees with the one the rule produces rather than
                  quietly preferring its own.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="base">Payment base, in paise, excluding GST</Label>
              <Input
                id="base"
                inputMode="numeric"
                placeholder="2500000"
                value={form.paymentBaseMinor}
                onChange={(e) =>
                  setForm({ ...form, paymentBaseMinor: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                ₹25,000.00 is 2500000. ⚠️ EXCLUDING GST where the tax is shown
                separately on the invoice — CBDT Circular 23/2017. Including it
                over-deducts on every bill.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ddate">Deduction date</Label>
              <Input
                id="ddate"
                type="date"
                value={form.deductionDate}
                onChange={(e) =>
                  setForm({ ...form, deductionDate: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                The earlier of credit and payment.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ref">Reference</Label>
              <Input
                id="ref"
                value={form.referenceNumber}
                onChange={(e) =>
                  setForm({ ...form, referenceNumber: e.target.value })
                }
              />
            </div>
          </div>

          {needsManualRate && (
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <p className="text-muted-foreground">
                🔴 The rate under {chosenSection?.code} cannot be resolved from
                the section, and Ordence will not invent one.{" "}
                {chosenSection?.code === "192"
                  ? "Salary is the employee's projected annual liability under the regime they have chosen, spread over the remaining months."
                  : "A non-resident's rate is whichever of the Act and the applicable double taxation avoidance agreement is more beneficial, which needs the treaty article, a tax residency certificate and a Form 10F."}{" "}
                Supply the rate and the working. The row records that a person
                determined it.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="mrate">Rate, in basis points</Label>
                  <Input
                    id="mrate"
                    inputMode="numeric"
                    placeholder="1000"
                    value={form.manualRateBps}
                    onChange={(e) =>
                      setForm({ ...form, manualRateBps: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    10% is 1000.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mreason">How it was arrived at</Label>
                  <Input
                    id="mreason"
                    value={form.manualRateReason}
                    onChange={(e) =>
                      setForm({ ...form, manualRateReason: e.target.value })
                    }
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={pending || !canAssess}
              onClick={runAssess}
            >
              What comes off this payment?
            </Button>
          </div>
        </CardContent>
      </Card>

      {/**
       * ⭐⭐⭐ THE ASSESSMENT, AND THE CATCH-UP LINE IS THE POINT OF IT.
       *
       * 🔴 `catchUpBaseMinor` IS THE FIGURE NOBODY EXPECTS. Under
       * 194C(5)'s second limb the whole year's aggregate comes into
       * charge the moment the annual threshold is crossed, so the tax on
       * the payment that crosses it includes tax on every earlier payment
       * that was correctly not deducted at the time. Showing only the
       * total would make the number look like an error.
       */}
      {assessment && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">
                {assessment.chargeable
                  ? `${inr(assessment.tdsMinor)} to withhold`
                  : "Nothing to withhold"}
              </CardTitle>
              <Badge variant={assessment.chargeable ? "default" : "secondary"}>
                {assessment.outcome}
              </Badge>
              <Badge variant="secondary">
                {assessment.statutoryRef} · {assessment.rateBps / 100}%
              </Badge>
              <Badge variant="secondary">{assessment.rateBasis}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  This payment
                </p>
                <p className="font-semibold tabular-nums">
                  {inr(assessment.paymentBaseMinor)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Earlier payments brought into charge
                </p>
                <p className="font-semibold tabular-nums">
                  {inr(assessment.catchUpBaseMinor)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {BigInt(assessment.catchUpBaseMinor) > 0n
                    ? "The threshold was crossed by this payment, so the whole year's aggregate comes into charge at once."
                    : "Nothing earlier is caught by this payment."}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Chargeable base
                </p>
                <p className="font-semibold tabular-nums">
                  {inr(assessment.chargeableBaseMinor)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Payee receives
                </p>
                <p className="font-semibold tabular-nums">
                  {inr(assessment.netPayableMinor)}
                </p>
              </div>
            </div>

            <p className="text-muted-foreground">{assessment.explanation}</p>

            {assessment.warnings.map((w) => (
              <p key={w} className="text-amber-600 dark:text-amber-500">
                ⚠️ {w}
              </p>
            ))}

            {/**
             * 🔴 A PROBLEM DISABLES THE SAVE. The engine reports a state
             * it cannot resolve — an unresolvable rate, a lapsed
             * certificate — and writing anyway would put a figure in the
             * register that the engine itself said it could not stand
             * behind.
             */}
            {assessment.problem !== null && (
              <p className="text-destructive">{assessment.problem}</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  pending || assessment.problem !== null || !manualRateReady
                }
                onClick={runRecord}
              >
                Record this deduction
              </Button>
              {!manualRateReady && (
                <span className="text-xs text-destructive">
                  Supply the rate and how it was arrived at first.
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              ⚠️ The figures above are re-computed on save and are not sent
              back. If another payment to this deductee crosses the threshold
              between now and then, what is recorded is the correct larger
              figure and not the one shown here.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
