"use client";

/**
 * Ordence — ⭐⭐⭐ BUILDING A PERIOD'S ITC, AND ASKING WHETHER IT MAY BE
 *              CLAIMED AT ALL
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO ACTIONS THAT DECIDE REAL MONEY AND HAD NO BUTTON
 * ══════════════════════════════════════════════════════════════════════
 *   buildItcForPeriod   turns a tax period's recorded purchase invoices
 *                       into register movements. Until it runs, the ITC
 *                       register for that month is empty and the GSTR-3B
 *                       claim has nothing behind it.
 *   determineItc        answers "may this be claimed at all?" against
 *                       Section 17(5), with the statutory reference, the
 *                       Rule 42 attribution and , when the answer is no ,
 *                       whether there is a remedy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CHECKER IS A QUESTION, NOT A RECORD
 * ══════════════════════════════════════════════════════════════════════
 * `determineItc` writes nothing. It is here so somebody can find out
 * BEFORE recording an invoice whether the tax on it is recoverable ,
 * which is the moment the answer changes what they do, and is months
 * before the CA finds out that it was not.
 *
 * ⚠️ THE FLAGS DEFAULT TO UNSET RATHER THAN TO FALSE. "Do we hold a valid
 * tax invoice?" answered by an unticked box that nobody read is the
 * shape of mistake that loses a claim under Section 16(2)(a). Each one is
 * only sent when it has been touched.
 */

import { useState, useTransition } from "react";
import { Calculator, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const PURPOSES = [
  { value: "taxable_supply", label: "A taxable outward supply" },
  { value: "sold_before_completion", label: "A flat sold before completion" },
  { value: "own_account_construction", label: "Construction on our own account" },
  { value: "further_supply_works_contract", label: "Further supply of works contract" },
  { value: "plant_and_machinery", label: "Plant and machinery" },
  { value: "exempt_supply", label: "An exempt supply" },
  { value: "common", label: "Common to taxable and exempt" },
  { value: "non_business", label: "Not for business" },
] as const;

const NATURES = [
  "goods",
  "input_service",
  "capital_goods",
  "motor_vehicle",
  "vessel_or_aircraft",
  "motor_vehicle_related_service",
  "food_and_beverage",
  "outdoor_catering",
  "beauty_or_health_service",
  "club_or_fitness_membership",
  "employee_travel_benefit",
  "life_or_health_insurance",
  "works_contract_service",
  "construction_material",
  "rent_a_cab",
] as const;

type Verdict = {
  eligibility: string;
  blockReason: string | null;
  statutoryRef: string;
  rule42Attribution: string;
  explanation: string;
  remedy: string | null;
};

export function ItcPeriodPanel(props: {
  registrations: readonly { id: string; label: string }[];
  build: (
    input: unknown,
  ) => Promise<Result<{ claimed: number; skipped: number; totalMinor: string }>>;
  determine: (input: unknown) => Promise<Result<Verdict>>;
}) {
  const [pending, startTransition] = useTransition();

  /* ---- build ------------------------------------------------------ */
  const [taxPeriod, setTaxPeriod] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildNotice, setBuildNotice] = useState<string | null>(null);

  /* ---- determine -------------------------------------------------- */
  const [purpose, setPurpose] = useState<string>("taxable_supply");
  const [nature, setNature] = useState<string>("goods");
  const [hasInvoice, setHasInvoice] = useState<boolean | null>(null);
  const [composition, setComposition] = useState<boolean | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  function build() {
    setBuildError(null);
    setBuildNotice(null);
    startTransition(async () => {
      const result = await props.build({
        taxPeriod,
        registrationId: registrationId === "" ? null : registrationId,
      });
      if (!result.ok) {
        setBuildError(result.error);
        return;
      }
      const { claimed, skipped, totalMinor } = result.data;
      setBuildNotice(
        `${claimed} invoice${claimed === 1 ? "" : "s"} claimed for ${taxPeriod}` +
          (skipped > 0 ? `, ${skipped} skipped` : "") +
          `. Total tax ₹${(Number(totalMinor) / 100).toLocaleString("en-IN")}.`,
      );
    });
  }

  function check() {
    setCheckError(null);
    setVerdict(null);
    startTransition(async () => {
      const result = await props.determine({
        itcPurpose: purpose,
        expenditureNature: nature,
        ...(hasInvoice === null ? {} : { hasValidTaxInvoice: hasInvoice }),
        ...(composition === null ? {} : { supplierIsComposition: composition }),
      });
      if (!result.ok) {
        setCheckError(result.error);
        return;
      }
      setVerdict(result.data);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Input tax credit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── BUILD ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Build a period&rsquo;s register
          </h3>
          <p className="text-sm text-muted-foreground">
            Turns the purchase invoices recorded for a tax period into register movements.
            Until this runs, the register for that month is empty and the 3B claim has nothing
            behind it.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Tax period</span>
              <input
                value={taxPeriod}
                onChange={(e) => setTaxPeriod(e.target.value)}
                placeholder="2026-07"
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Registration</span>
              <select
                value={registrationId}
                onChange={(e) => setRegistrationId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Every registration</option>
                {props.registrations.map((registration) => (
                  <option key={registration.id} value={registration.id}>
                    {registration.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={build}
                disabled={pending || taxPeriod.trim() === ""}
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Building…" : "Build it"}
              </button>
            </div>
          </div>

          {buildError && (
            <p role="alert" className="text-sm text-destructive">
              {buildError}
            </p>
          )}
          {buildNotice && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">{buildNotice}</p>
          )}
        </section>

        {/* ── DETERMINE ─────────────────────────────────────────── */}
        <section className="space-y-3 border-t pt-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Calculator className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            May this be claimed at all?
          </h3>
          <p className="text-sm text-muted-foreground">
            Section 17(5) blocks credit on a long list of expenditure regardless of how well
            documented it is. Ask before recording the invoice, not after the return is filed.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">What is it for</span>
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {PURPOSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="font-medium">What was bought</span>
              <select
                value={nature}
                onChange={(e) => setNature(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {NATURES.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/*
            ⚠️ THREE STATES, NOT TWO. "Not asked" is different from "no",
            and a tri-state select is the honest control: an unticked
            checkbox nobody read is how a claim is lost under Section
            16(2)(a).
          */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Do we hold a valid tax invoice?</span>
              <select
                value={hasInvoice === null ? "" : hasInvoice ? "yes" : "no"}
                onChange={(e) =>
                  setHasInvoice(e.target.value === "" ? null : e.target.value === "yes")
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Not asked</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="font-medium">Is the supplier under composition?</span>
              <select
                value={composition === null ? "" : composition ? "yes" : "no"}
                onChange={(e) =>
                  setComposition(e.target.value === "" ? null : e.target.value === "yes")
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Not asked</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            onClick={check}
            disabled={pending}
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Checking…" : "Check it"}
          </button>

          {checkError && (
            <p role="alert" className="text-sm text-destructive">
              {checkError}
            </p>
          )}

          {verdict && (
            <div
              className={
                verdict.eligibility === "eligible"
                  ? "space-y-1 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"
                  : "space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
              }
            >
              <p className="font-medium">
                {verdict.eligibility.replace(/_/g, " ")}
                {verdict.blockReason ? ` , ${verdict.blockReason.replace(/_/g, " ")}` : ""}
              </p>
              <p>{verdict.explanation}</p>
              <p className="text-xs text-muted-foreground">
                {verdict.statutoryRef} · attribution: {verdict.rule42Attribution}
              </p>
              {/*
                ⭐ THE REMEDY IS THE MOST USEFUL FIELD AND IS EASY TO
                MISS. "Blocked" with a way out is a different fact from
                "blocked" without one.
              */}
              {verdict.remedy && (
                <p className="font-medium">What can be done: {verdict.remedy}</p>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
