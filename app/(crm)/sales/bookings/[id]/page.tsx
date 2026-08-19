/**
 * Ordence — ⭐⭐⭐ THE BOOKING, AND EVERYTHING OWED AGAINST IT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY ROW OF THE BOOKINGS LIST LINKED HERE AND THIS PAGE DID NOT
 *    EXIST
 * ══════════════════════════════════════════════════════════════════════
 * `check:links` has carried `/sales/bookings/:id` in its dead-link budget
 * since the list was written. Clicking a booking gave a 404. The budget
 * kept the number from growing and nothing made it shrink.
 *
 * Behind that 404 sat two whole modules with no way in:
 *
 *   sales-bookings   getBooking, advanceBooking, cancelBooking,
 *                    generatePaymentPlan, recordMilestonePayment,
 *                    listPlanTemplates
 *   receivables      the demand lifecycle, receipts, the statement of
 *                    account, and the dunning history
 *
 * Twenty-one exported server actions, all guarded, all tested, all
 * reachable from nowhere. They are URLs the browser can POST to that no
 * screen in the product uses.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE READS HAPPEN HERE AND THE WRITES HAPPEN IN CLIENT COMPONENTS
 * ══════════════════════════════════════════════════════════════════════
 * `BookingRow` and `PaymentMilestone` carry `bigint` money columns, which
 * do not cross into a client component as themselves. Every figure is
 * therefore formatted or stringified in this file, and the client panels
 * receive strings. That is the same shape the bookings list uses, and it
 * is why `formatPaise` lives on this side of the boundary.
 *
 * ⚠️ EACH READ IS CHECKED SEPARATELY. A workspace whose receivables
 * feature is not on its plan still has a booking, a payment plan and a
 * stage; refusing the whole page because one of four reads was refused
 * would hide four working things behind one that is not bought.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, User as UserIcon } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  getBooking,
  advanceBooking,
  cancelBooking,
  generatePaymentPlan,
  listPlanTemplates,
  recordMilestonePayment,
} from "@/server/actions/sales-bookings";
import {
  createDemand,
  getBookingReceivables,
  getDunningHistory,
  getStatementOfAccount,
  markReceiptBounced,
  previewDemandNotice,
  reapplyReceipt,
  recordPayment,
  replaceDemand,
  serveDemand,
  withdrawDemand,
} from "@/server/actions/receivables";
import { Badge } from "@/components/ui/badge";
import { BookingStageControl } from "./booking-stage-control";
import { PaymentPlanBuilder } from "./payment-plan-builder";
import { MilestonePayments } from "./milestone-payments";
import { BookingCancellation } from "./booking-cancellation";
import { ReceivablesPanel } from "./receivables-panel";
import { StatementOfAccount } from "./statement-of-account";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  tentative: "Tentative",
  confirmed: "Confirmed",
  agreement: "Agreement",
  registered: "Registered",
  cancelled: "Cancelled",
};

/**
 * ⚠️ INDIAN DIGIT GROUPING, NOT `en-US`. Rs 12,34,567 and 1,234,567 are
 * the same number and only one of them is read correctly at a glance by
 * the person this screen is for.
 */
function formatPaise(minor: bigint | string | null): string {
  if (minor === null) return "—";
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const paise = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${new Intl.NumberFormat("en-IN").format(whole)}.${paise}`;
}

function formatDay(value: Date | string | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date);
}

export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext();

  const [bookingResult, templatesResult, receivablesResult, statementResult] =
    await Promise.all([
      getBooking({ id }),
      listPlanTemplates(),
      getBookingReceivables({ bookingId: id }),
      getStatementOfAccount({ bookingId: id }),
    ]);

  /**
   * ⚠️ `notFound()` AND NOT AN ERROR PANEL. A booking id that does not
   * resolve inside this tenant is indistinguishable from one that never
   * existed, and it must stay that way , an error panel that says
   * "not permitted" for a real id and "not found" for a fake one is an
   * oracle for guessing which bookings exist in another workspace.
   */
  if (!bookingResult.ok) notFound();

  const { booking, milestones, summary, commission } = bookingResult.data;
  const templates = templatesResult.ok ? templatesResult.data.templates : [];
  const receivables = receivablesResult.ok ? receivablesResult.data : null;
  const statement = statementResult.ok ? statementResult.data : null;

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canUpdate = can(subject, "bookings:update");
  const canCancel = can(subject, "bookings:cancel");
  const canManagePlan = can(subject, "payment_plans:manage");
  const canRaiseDemand = can(subject, "receivables:raise_demand");
  const canIssueDemand = can(subject, "receivables:issue_demand");
  const canRecordReceipt = can(subject, "receivables:record_receipt");
  const canAllocate = can(subject, "receivables:allocate");

  const cancelled = booking.status === "cancelled";

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="space-y-3">
        <Link
          href="/sales/bookings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to bookings
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{booking.reference}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-4 w-4" aria-hidden="true" />
                {booking.unitCode ?? "no unit"}
                {booking.projectName ? ` · ${booking.projectName}` : ""}
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <UserIcon className="h-4 w-4" aria-hidden="true" />
                {booking.leadName ?? "no buyer on file"}
              </span>
            </p>
          </div>

          <Badge variant={cancelled ? "destructive" : "outline"}>
            {STATUS_LABELS[booking.status] ?? booking.status}
          </Badge>
        </div>
      </header>

      {/* ── THE MONEY, IN ONE ROW ─────────────────────────────────── */}
      <section aria-labelledby="figures-heading" className="space-y-3">
        <h2 id="figures-heading" className="text-lg font-semibold">
          Where this booking stands
        </h2>
        <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Agreement value</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatPaise(booking.agreementValueMinor)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Collected</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatPaise(summary.collectedMinor)}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {summary.collectedPct}%
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Outstanding</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatPaise(summary.outstandingMinor)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Overdue</dt>
            <dd
              className={`text-lg font-semibold tabular-nums ${
                summary.overdueMinor > 0n ? "text-destructive" : ""
              }`}
            >
              {formatPaise(summary.overdueMinor)}
            </dd>
          </div>
        </dl>

        {summary.nextDue && (
          <p className="text-sm text-muted-foreground">
            Next due: <span className="font-medium">{summary.nextDue.label}</span> ,{" "}
            {formatPaise(summary.nextDue.amountMinor)} on {formatDay(summary.nextDue.dueDate)}.
          </p>
        )}

        {/*
          ⭐ THE COMMISSION IS SHOWN WITH ITS WORKINGS, and with its
          `problem` when it has one. `computeCommission` returns zero and
          a sentence rather than throwing, precisely so a half-configured
          partner agreement is visible instead of invisible.
        */}
        {commission && (
          <p className="text-sm text-muted-foreground">
            Partner commission: {formatPaise(commission.grossMinor)} , {commission.workings}
            {commission.problem ? ` (${commission.problem})` : ""}
          </p>
        )}
      </section>

      {/* ── STAGE ─────────────────────────────────────────────────── */}
      {canUpdate && !cancelled && (
        <BookingStageControl
          bookingId={booking.id}
          status={booking.status}
          advance={advanceBooking}
        />
      )}

      {/* ── THE PAYMENT PLAN ──────────────────────────────────────── */}
      <section aria-labelledby="plan-heading" className="space-y-3">
        <h2 id="plan-heading" className="text-lg font-semibold">
          Payment plan
        </h2>

        {milestones.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No plan yet. Until there is one, nothing has a due date and nothing can fall
            overdue.
          </p>
        ) : (
          <MilestonePayments
            rows={milestones.map((m) => ({
              id: m.id,
              label: m.label,
              sequence: m.sequence,
              amount: formatPaise(m.amountMinor),
              paid: formatPaise(m.amountPaidMinor),
              /** The raw figure the form needs, in rupees, as a string. */
              outstandingRupees: (
                Number(m.amountMinor - m.amountPaidMinor) / 100
              ).toFixed(2),
              dueDate: formatDay(m.dueDate),
              status: m.status,
            }))}
            canRecord={canManagePlan && !cancelled}
            record={recordMilestonePayment}
          />
        )}

        {canManagePlan && !cancelled && (
          <PaymentPlanBuilder
            bookingId={booking.id}
            hasPlan={milestones.length > 0}
            templates={templates.map((t) => ({
              key: t.key,
              name: t.name,
              description: t.description,
              stages: t.stages.map((s) => ({ label: s.label, shareBps: s.shareBps })),
            }))}
            generate={generatePaymentPlan}
          />
        )}
      </section>

      {/* ── RECEIVABLES ───────────────────────────────────────────── */}
      {receivables ? (
        <ReceivablesPanel
          bookingId={booking.id}
          buyerLanguage={receivables.buyerLanguage}
          demands={receivables.demands}
          receipts={receivables.receipts}
          ladder={receivables.ladder}
          canRaise={canRaiseDemand && !cancelled}
          canIssue={canIssueDemand}
          canRecordReceipt={canRecordReceipt && !cancelled}
          canAllocate={canAllocate}
          raise={createDemand}
          preview={previewDemandNotice}
          serve={serveDemand}
          withdraw={withdrawDemand}
          replace={replaceDemand}
          history={getDunningHistory}
          record={recordPayment}
          bounce={markReceiptBounced}
          reapply={reapplyReceipt}
        />
      ) : (
        /*
          ⚠️ NAMED, NOT BLANK. A missing receivables section with no
          explanation reads as a bug; the refusal from the action says
          whether it is a plan, a permission or an outage, and that
          sentence is the useful thing.
        */
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {receivablesResult.ok ? "" : receivablesResult.error}
        </p>
      )}

      {/* ── THE STATEMENT ─────────────────────────────────────────── */}
      {statement && <StatementOfAccount statement={statement} />}

      {/* ── CANCELLATION, LAST ────────────────────────────────────── */}
      {canCancel && !cancelled && (
        <BookingCancellation bookingId={booking.id} cancel={cancelBooking} />
      )}
    </main>
  );
}
