/**
 * Ordence — ⭐⭐ THE INPUT CREDIT ON BANK CHARGES
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS PAGE EXISTS BECAUSE A REGISTER NOBODY CAN REACH IS A TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `0100` shipped a complete depreciation engine and no navigation
 * reached it for four batches. Built-and-unreachable is the same defect
 * as declared-and-unenforced wearing a different hat, and it has now
 * happened twelve times in this product.
 *
 * ⚠️ SO THE LINK IN `lib/industry-templates.ts` WENT IN WITH THIS FILE,
 * in the same change, not in a follow-up.
 */

import Link from "next/link";
import {
  getBankChargeItcRegister,
  markBankChargeNotClaimable,
  postBankChargeInputCredit,
  recordBankChargeTaxInvoice,
} from "@/server/actions/banking";
import { InputCreditRegister } from "@/components/banking/input-credit-register";

export const dynamic = "force-dynamic";

export const metadata = { title: "Input credit on bank charges · Ordence" };

export default async function BankChargeInputCreditPage() {
  const result = await getBankChargeItcRegister();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Input credit on bank charges</h1>
        <p className="text-sm text-muted-foreground">
          Charges written up from a bank statement are posted gross, because
          that is what left the account and the bank&apos;s tax invoice arrives
          separately. This is the record of the credit that is therefore not
          claimed yet, and of whether it has since been moved into the books ·{" "}
          <Link href="/banking" className="underline">
            bank reconciliation
          </Link>
        </p>
      </div>

      {result.ok ? (
        <InputCreditRegister
          periods={result.data.periods}
          charges={result.data.charges}
          recordInvoiceAction={recordBankChargeTaxInvoice}
          markNotClaimableAction={markBankChargeNotClaimable}
          postCreditAction={postBankChargeInputCredit}
        />
      ) : (
        <p className="text-sm text-destructive">{result.error}</p>
      )}
    </main>
  );
}
