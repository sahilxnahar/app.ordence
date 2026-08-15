/**
 * Ordence — ⭐⭐ PAYROLL SETUP
 * Version: v1.23.0-alpha · Batch 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RATES ARE ROWS IN YOUR WORKSPACE, NOT NUMBERS IN OUR CODE
 * ══════════════════════════════════════════════════════════════════════
 * Seeding writes Ordence's opening figures into your own
 * `statutory_rates` table with an effective date. From then on they are
 * yours: correct one and the correction is what future runs use, while
 * an old payslip reissued later still reproduces the number that was
 * actually paid.
 *
 * ⚠️ AND SEEDING NEVER OVERWRITES. A tenant who corrected a rate must
 * not have it silently replaced with the number they corrected away
 * from, so any kind that already exists is skipped.
 */

import Link from "next/link";
import { listPayComponents, payrollAccountsNeeded, seedPayrollSetup } from "@/server/actions/payroll";
import { SetupPanel } from "@/components/payroll/setup-panel";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payroll setup · Ordence" };

export default async function PayrollSetupPage() {
  const [components, accounts, manage] = await Promise.all([
    listPayComponents(),
    payrollAccountsNeeded(),
    checkPermission("payroll.manage"),
  ]);

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          Payroll
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Payroll setup</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Three things have to exist before the first run: the components people are paid in, the
          statutory rates in force, and nine ledger accounts for the journal to land in.
        </p>
      </div>

      <SetupPanel
        components={
          components.ok
            ? components.data.rows.map((c) => ({
                id: String(c.id),
                code: String(c.code),
                label: String(c.label),
                kind: String(c.kind),
                pfApplicable: Boolean(c.pfApplicable),
                esiApplicable: Boolean(c.esiApplicable),
                taxable: Boolean(c.taxable),
                proRates: Boolean(c.proRates),
              }))
            : []
        }
        accounts={accounts.ok ? [...accounts.data.roles] : []}
        canManage={manage.allowed}
        onSeed={seedPayrollSetup}
      />
    </main>
  );
}
