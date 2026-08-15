/**
 * Ordence — ⭐⭐⭐ BROKERAGE
 * Version: v1.25.0-alpha · Batch 17
 *
 * ⚠️ The guards are on the actions, not on this route.
 *
 * 🔴 THIS ROUTE IS THE POINT OF THE BATCH. `computeCommission()` and
 * `computeTds()` have existed since Phase 22 with nothing able to record
 * what they produced — the ninth complete engine in this project that
 * nothing reached.
 */

import Link from "next/link";
import {
  listBrokerage,
  brokerageAccountsNeeded,
  previewBrokerage,
  raiseBrokerage,
  approveBrokerage,
  postBrokerageBill,
  payBrokerage,
  cancelBrokerageBill,
} from "@/server/actions/sales-brokerage";
import { listChannelPartners } from "@/server/actions/sales-partners";
import {
  BrokerageBoard,
  type BrokerageBillView,
  type PartnerOption,
} from "@/components/sales/brokerage-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brokerage · Ordence" };

export default async function BrokeragePage() {
  const [bills, partners, accounts, manage, post] = await Promise.all([
    listBrokerage(),
    listChannelPartners(),
    brokerageAccountsNeeded(),
    checkPermission("partners:manage"),
    checkPermission("transactions:post"),
  ]);

  if (!bills.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Brokerage</h1>
        <p className="text-sm text-destructive">{bills.error}</p>
      </main>
    );
  }

  const rows: BrokerageBillView[] = bills.data.rows.map((r) => ({
    id: String(r.id),
    reference: String(r.reference),
    status: String(r.status),
    partnerFirmName: String(r.partnerFirmName),
    partnerHasPan: Boolean(r.partnerHasPan),
    bookingReference: r.bookingReference ? String(r.bookingReference) : null,
    creditedOn: String(r.creditedOn),
    workings: String(r.workings ?? ""),
    grossMinor: String(r.grossMinor ?? "0"),
    cgstMinor: String(r.cgstMinor ?? "0"),
    sgstMinor: String(r.sgstMinor ?? "0"),
    igstMinor: String(r.igstMinor ?? "0"),
    itcEligible: Boolean(r.itcEligible),
    tdsMinor: String(r.tdsMinor ?? "0"),
    tdsRateBps: Number(r.tdsRateBps ?? 0),
    tdsExplanation: r.tdsExplanation ? String(r.tdsExplanation) : null,
    netPayableMinor: String(r.netPayableMinor ?? "0"),
  }));

  /**
   * ⚠️ TERMINATED PARTNERS ARE LEFT OUT OF THE PICKER, not merely
   * refused by the action. Offering a name that can only produce an
   * error is a worse experience than not offering it, and the refusal
   * stays in place for the case where somebody has the id already.
   */
  const partnerOptions: PartnerOption[] = partners.ok
    ? partners.data.rows
        .filter((p) => p.status !== "terminated")
        .map((p) => ({
          id: String(p.id),
          firmName: String(p.firmName),
          kycStatus: String(p.kycStatus),
        }))
    : [];

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Brokerage</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          What channel partners have earned, what was withheld under section 194H, and what is
          still owed to them. The brokerage calculation has been in Ordence since Phase 22 and
          had nowhere to be recorded — so the largest single selling cost in a developer&apos;s
          business never reached the accounts.
        </p>
        <p className="mt-2 text-xs">
          <Link href="/sales/partners" className="underline">
            Channel partners
          </Link>
        </p>
      </div>

      <BrokerageBoard
        rows={rows}
        partners={partnerOptions}
        outstandingMinor={bills.data.outstandingMinor}
        missingAccounts={accounts.ok ? accounts.data.missing : []}
        missingItcAccounts={accounts.ok ? accounts.data.missingForItc : []}
        canManage={manage.allowed}
        canPost={post.allowed}
        onPreview={previewBrokerage}
        onRaise={raiseBrokerage}
        onApprove={approveBrokerage}
        onPost={postBrokerageBill}
        onPay={payBrokerage}
        onCancel={cancelBrokerageBill}
      />
    </main>
  );
}
