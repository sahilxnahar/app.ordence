/**
 * Ordence — ⭐⭐⭐ RECORD A TDS DEDUCTION
 * Version: v1.69.0-alpha (Wave one)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS PAGE IS THE THIRTEENTH INSTANCE BEING CLOSED, AND THE LARGEST
 * ══════════════════════════════════════════════════════════════════════
 * `recordDeduction` holds the only INSERT into `tds_deductions` in the
 * product and nothing called it. `/tds` imports three reads. So the
 * register could never receive a row, the interest exposure could only
 * report zero, Form 26Q could only be empty and Form 16A could only be
 * empty — and every one of those screens rendered correctly.
 *
 * ⚠️ THE NAV ENTRIES AND THE LINK FROM `/tds` GO IN WITH THIS FILE, in
 * the same change. `0100` shipped a complete depreciation engine that no
 * navigation reached for four batches, and `/banking` existed from
 * v1.18.0 in no nav section at all. Adding the page and leaving the route
 * to a follow-up is how both of those happened.
 */

import Link from "next/link";
import {
  assessDeduction,
  getDeductionFormOptions,
  recordDeduction,
} from "@/server/actions/tds";
import { RecordDeduction } from "@/components/tds/record-deduction";

export const dynamic = "force-dynamic";

export const metadata = { title: "Record a TDS deduction · Ordence" };

export default async function RecordTdsDeductionPage() {
  const options = await getDeductionFormOptions();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Record a TDS deduction</h1>
        <p className="text-sm text-muted-foreground">
          Ask what comes off a payment before it is made, then record what was
          withheld ·{" "}
          <Link href="/tds" className="underline">
            the TDS register
          </Link>
        </p>
      </div>

      {options.ok ? (
        <RecordDeduction
          deductees={options.data.deductees}
          sections={options.data.sections}
          assessAction={assessDeduction}
          recordAction={recordDeduction}
        />
      ) : (
        <p className="text-sm text-destructive">{options.error}</p>
      )}
    </main>
  );
}
