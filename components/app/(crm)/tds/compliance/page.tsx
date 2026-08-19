/**
 * Ordence — ⭐⭐⭐ THE TDS QUARTER: CHALLAN, RETURN, CERTIFICATE
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NINE ACTIONS, THE WHOLE COMPLIANCE CYCLE, AND NO SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `/tds` could show the register and who had been deducted from. Every
 * step that follows , the part with statutory deadlines and penalties ,
 * had no caller:
 *
 *   recordChallan                the money going to the government
 *   mapDeductionsToChallan       which deductions that challan covers
 *   reconcileChallansForPeriod   whether those two agree
 *   sweepThresholdShortfalls     who crossed a threshold and was under-
 *                                deducted before they did
 *   buildQuarterlyReturn         the 24Q/26Q/27Q/27EQ
 *   fileQuarterlyReturn          recording that it was filed, and the
 *                                late fee if it was late
 *   buildCertificates            Form 16A for each deductee
 *   upsertDeductee               who they are, and their PAN status
 *   upsertLowerDeductionCertificate  a 197 certificate
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ORDER ON THIS PAGE IS THE ORDER OF THE QUARTER
 * ══════════════════════════════════════════════════════════════════════
 * Deduct → deposit → map → reconcile → file → certify. A screen that
 * offered them alphabetically would let somebody file a return before the
 * challans it references exist, which is how a return gets a defective
 * status and has to be corrected.
 *
 * ⚠️ THE RECONCILIATION IS SHOWN BEFORE THE RETURN BUILDER, and the
 * builder says out loud that a return built on a period that does not
 * reconcile will be defective.
 */

import Link from "next/link";
import { ArrowLeft, ScrollText } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  buildCertificates,
  buildQuarterlyReturn,
  fileQuarterlyReturn,
  getDeductees,
  getRegister,
  mapDeductionsToChallan,
  reconcileChallansForPeriod,
  recordChallan,
  sweepThresholdShortfalls,
  upsertDeductee,
  upsertLowerDeductionCertificate,
} from "@/server/actions/tds";
import { TDS_SECTION_CODES } from "@/lib/tds/sections";
import { TdsQuarterConsole } from "./tds-quarter-console";
import { DeducteeForms } from "./deductee-forms";

export const dynamic = "force-dynamic";

export const metadata = { title: "TDS compliance · Ordence" };

/**
 * The Indian financial year that a date falls in. 1 April to 31 March.
 *
 * ⚠️ COMPUTED IN IST. A deduction made at 23:00 on 31 March in Delhi is
 * in the year that is closing; read through UTC it is 17:30 on the 31st,
 * which is the same day , but the same arithmetic applied at 05:00 on
 * 1 April would put it in the wrong year, and the wrong year is a return
 * that has to be revised.
 */
function currentFinancialYear(): string {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60_000);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export default async function TdsCompliancePage() {
  const ctx = await requirePageContext();
  const financialYear = currentFinancialYear();

  const [deductees, register] = await Promise.all([
    getDeductees(true),
    getRegister({ financialYear }),
  ]);

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  /**
   * ⚠️ TWO DIFFERENT KEYS, AND THE SPLIT IS REAL. Recording a challan is
   * bookkeeping. Filing a return is a statutory declaration with the
   * deductor's name on it and a late fee attached to getting it wrong.
   */
  const canManage = can(subject, "tds:manage_challans");
  const canFile = can(subject, "tds:file_return");

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/tds"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to TDS
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ScrollText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          The quarter
        </h1>
        <p className="text-sm text-muted-foreground">
          Deduct, deposit, map, reconcile, file, certify. In that order , a return built
          before its challans exist is a return that has to be corrected.
        </p>
      </div>

      <TdsQuarterConsole
        financialYear={financialYear}
        undepositedMinor={register.ok ? register.data.summary.totalUndepositedMinor : "0"}
        /*
          ⚠️ ONLY THE UNDEPOSITED DEDUCTIONS ARE OFFERED FOR MAPPING. A
          deduction already carrying a `challanId` is covered; offering it
          again invites double-mapping, which makes the challan look
          over-utilised and the reconciliation fail for a reason nobody
          can find.
        */
        unmappedDeductions={
          register.ok
            ? register.data.rows
                .filter((row) => row.challanId === null && row.tdsMinor !== "0")
                .map((row) => ({
                  id: row.id,
                  label: `${row.deductionDate} · ${row.section} · ₹${(
                    Number(row.tdsMinor) / 100
                  ).toLocaleString("en-IN")}`,
                }))
            : []
        }
        sections={[...TDS_SECTION_CODES]}
        canManage={canManage}
        canFile={canFile}
        recordChallan={recordChallan}
        mapDeductions={mapDeductionsToChallan}
        reconcile={reconcileChallansForPeriod}
        sweepThresholds={sweepThresholdShortfalls}
        buildReturn={buildQuarterlyReturn}
        fileReturn={fileQuarterlyReturn}
        buildCertificates={buildCertificates}
      />

      {can(subject, "tds:manage_deductees") && (
        <DeducteeForms
          deductees={
            deductees.ok
              ? deductees.data.rows.map((row) => ({
                  id: row.id,
                  label: `${row.code} , ${row.legalName}`,
                  panStatus: row.panStatus,
                }))
              : []
          }
          financialYear={financialYear}
          sections={[...TDS_SECTION_CODES]}
          saveDeductee={upsertDeductee}
          saveCertificate={upsertLowerDeductionCertificate}
        />
      )}
    </main>
  );
}
