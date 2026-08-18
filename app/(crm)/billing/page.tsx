/**
 * Ordence — BILLING · WHAT THIS WORKSPACE OWES AND WHAT IT IS USING
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS EXISTS WHEN `/settings/billing` ALREADY DOES
 * ══════════════════════════════════════════════════════════════════════
 * `/settings/billing` is the PORTAL: it changes the plan, starts a
 * checkout, cancels, records a manual settlement. It is a place you go to
 * DO something, and it is reached from a settings menu when you already
 * know what you want.
 *
 * This page does none of that. It is the STANDING VIEW — the one on the
 * main navigation, opened by somebody who has not come to buy anything
 * and needs to know whether the account is about to bite them. So it is
 * read-only by construction: every action lives one link away, at the
 * portal, and nothing here can spend money.
 *
 * ⚠️ THE MODULE REGISTRY WAS RIGHT TO REFUSE TO REPOINT `/billing` AT
 * `/settings/billing`. They are different intents and a menu entry that
 * quietly goes somewhere else is worse than one that is absent.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ORDER IS BY WHAT IT COSTS TO IGNORE FOR ONE MORE WEEK
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCOUNT STANDING — a trial ending, a failed payment, a grace
 *      window running out. These end in a read-only workspace.
 *   2. ⭐ A CARD THAT DIES BEFORE THE NEXT RENEWAL — the failure that has
 *      ALREADY HAPPENED and that nothing else on any screen shows. The
 *      expiry date is knowable today; the declined charge lands on
 *      renewal day, and by then it is a dunning email and a locked-out
 *      team. This is the single most valuable line on the page.
 *   3. UNPAID INVOICES — money owed, oldest first.
 *   4. QUOTA — what is at or near a limit, and what happens when it is
 *      hit. Not everything blocks; the ones that do say so.
 *   5. The plan, the seats, the invoice history.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY MONEY FIGURE ARRIVES AS A STRING AND IS FORMATTED HERE
 * ══════════════════════════════════════════════════════════════════════
 * Amounts are `bigint` paise in the database. `JSON.stringify` throws on
 * a bigint, so a server action returning a raw billing row crashes at the
 * RSC boundary — at runtime, only on pages that render money, which is
 * this one. The actions convert at the boundary and `inr()` below never
 * does arithmetic on a float.
 *
 * ⚠️ EACH PANEL HAS ITS OWN SUSPENSE BOUNDARY. The invoice list is the
 * slowest query on the page and the standing banner is the fastest; one
 * boundary would hold the sentence somebody came for behind a list they
 * did not.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getCurrentSubscription,
  getUsageAgainstPlan,
  listInvoices,
  listPaymentMethods,
} from "@/server/actions/billing";
import { checkAccess } from "@/server/billing/access";
import { ReconciliationNotice } from "@/components/reconciliation/reconciliation-notice";
import {
  INVOICE_STATUS_LABELS,
  SUBSCRIPTION_STATUS_HELP,
  SUBSCRIPTION_STATUS_LABELS,
} from "@/lib/validators/billing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Billing · Ordence" };

/* ------------------------------------------------------------------ */
/* FORMATTERS — string in, string out. No floats anywhere.             */
/* ------------------------------------------------------------------ */

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

/** Invoices with money still on them. Void and written-off are not owed. */
const OWING = new Set(["open", "partially_paid"]);

const METHOD_LABEL: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  netbanking: "Net banking",
  emandate: "e-Mandate",
  wallet: "Wallet",
};

function quotaTone(level: string): string {
  if (level === "exceeded")
    return "border-red-400 text-red-700 dark:border-red-800 dark:text-red-300";
  if (level === "warning")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (level === "notice")
    return "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300";
  return "";
}

/* ------------------------------------------------------------------ */
/* 1 · ACCOUNT STANDING                                                */
/* ------------------------------------------------------------------ */

async function StandingPanel() {
  // ⚠️ Never fails the page. Account standing is the thing a lapsed
  // customer arrives here to fix, and a panel that throws would take the
  // route out down with it.
  const decision = await checkAccess().catch(() => null);
  if (!decision?.headline) return null;

  const severe = decision.level === "restricted" || decision.level === "locked";

  return (
    <Card
      className={
        severe
          ? "border-red-400 dark:border-red-800"
          : "border-amber-400 dark:border-amber-700"
      }
    >
      <CardHeader>
        <CardTitle
          className={
            severe
              ? "text-red-700 dark:text-red-300"
              : "text-amber-700 dark:text-amber-300"
          }
        >
          {decision.headline}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {decision.detail && (
          <p className="text-muted-foreground">{decision.detail}</p>
        )}
        {decision.callToAction && (
          <Link
            href={decision.callToAction.href}
            className="inline-block font-medium underline"
          >
            {decision.callToAction.label}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 2 · THE CARD THAT DIES FIRST                                        */
/* ------------------------------------------------------------------ */

async function InstrumentsPanel() {
  const subscription = await getCurrentSubscription();
  const renewal = subscription.ok ? subscription.data?.currentPeriodEnd : null;
  const result = await listPaymentMethods(renewal ?? undefined);

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment methods</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const methods = result.data;
  const doomed = methods.filter((m) => m.isExpired || m.expiresBeforeRenewal);

  return (
    <div className="space-y-4">
      {/* ⭐ THE FAILURE THAT HAS ALREADY HAPPENED. */}
      {doomed.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {doomed.length === 1
                ? "A payment method will not survive the next renewal"
                : `${doomed.length} payment methods will not survive the next renewal`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {doomed.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">
                    {m.brand ?? METHOD_LABEL[m.methodType] ?? m.methodType}
                    {m.last4 ? ` ···· ${m.last4}` : ""}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    expires {m.expiry}
                  </span>
                  {m.isDefault && (
                    <Badge variant="outline" className="text-[10px]">
                      default
                    </Badge>
                  )}
                  <span className="text-xs text-red-700 dark:text-red-300">
                    {m.isExpired ? "already expired" : "expires before renewal"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              {renewal
                ? `Renewal is ${day(renewal)}. `
                : ""}
              A charge against an expired card is declined by the bank, not by
              us — the first anybody hears of it is a dunning email, and the
              workspace goes read-only while somebody works out whose card it
              was. Replacing it takes a minute today and a week in arrears.{" "}
              <Link href="/settings/billing" className="font-medium underline">
                Update it in the billing portal
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment methods</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {methods.length === 0 ? (
            <div className="space-y-3 px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No payment method is saved for this workspace.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                A saved instrument is what the renewal charges. Without one,
                every period has to be settled by hand before the grace window
                closes — and a workspace that misses that window becomes
                read-only for everybody in it, including whoever was going to
                pay.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {methods.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-medium">
                    {m.brand ?? METHOD_LABEL[m.methodType] ?? m.methodType}
                    {m.last4 ? ` ···· ${m.last4}` : ""}
                  </span>
                  {m.upiVpaMasked && (
                    <span className="text-xs text-muted-foreground">
                      {m.upiVpaMasked}
                    </span>
                  )}
                  {m.bankName && (
                    <span className="text-xs text-muted-foreground">
                      {m.bankName}
                    </span>
                  )}
                  {m.expiry && (
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {m.expiry}
                    </span>
                  )}
                  {m.isDefault && (
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      default
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3 · INVOICES                                                        */
/* ------------------------------------------------------------------ */

async function InvoicesPanel() {
  const result = await listInvoices(60);

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { invoices, reconciliation, breachCauses } = result.data;

  /**
   * 🔴 THE SETTLEMENT FIGURES ARE WITHHELD WHEN THE INVOICE REGISTER
   *    DISAGREES WITH THE PAYMENT LOG.
   *
   * `listInvoices` strips `amountPaidMinor` from every row on a breach,
   * so the "Received" column below has nothing to print — the numbers
   * are structurally absent rather than hidden behind a flag this
   * component is trusted to read.
   *
   * ⚠️ AND THE "STILL OWING" CARD GOES WITH THEM, WHICH IS THE POINT
   * THAT MATTERS MOST HERE. That card is nothing but total minus
   * received, it is the one thing on this page somebody ACTS on, and its
   * standing copy asserts that "anything sitting here has genuinely not
   * been collected". When the two sources disagree, that sentence is
   * exactly what nobody can say — the whole question is whether money
   * that arrived has been applied — so the card that says it must not
   * render. Chasing a customer who has paid is the specific harm.
   *
   * ⚠️ THE INVOICE TABLE ITSELF STAYS. Number, date, status and total are
   * the document, not a claim about settlement, and each row is a GST tax
   * invoice the customer's auditor is entitled to. Withholding those
   * would be the rule applied carelessly rather than precisely.
   */
  const settlementUsable = reconciliation.state !== "breached";

  // Oldest first: the one that has been outstanding longest is the one
  // about to become a collections problem.
  const owing = settlementUsable
    ? invoices
        .filter((i) => OWING.has(i.status))
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))
    : [];

  return (
    <div className="space-y-4">
      <ReconciliationNotice
        reconciliation={reconciliation}
        breachCauses={breachCauses}
      />

      {owing.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {owing.length} invoice{owing.length === 1 ? "" : "s"} still owing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {owing.slice(0, 10).map((i) => {
                const overdueBy = i.dueAt ? daysUntil(i.dueAt) : null;
                return (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-baseline gap-3"
                  >
                    <Link
                      href={`/settings/billing/invoices/${i.id}`}
                      className="font-mono text-xs underline"
                    >
                      {i.invoiceNumber}
                    </Link>
                    <span className="tabular-nums font-medium">
                      {i.totalDisplay || inr(i.totalMinor)}
                    </span>
                    {i.amountPaidMinor && i.amountPaidMinor !== "0" && (
                      <span className="text-xs text-muted-foreground">
                        {i.amountPaidDisplay || inr(i.amountPaidMinor)} received
                      </span>
                    )}
                    <span
                      className={
                        overdueBy !== null && overdueBy < 0
                          ? "tabular-nums text-xs text-red-700 dark:text-red-300"
                          : "tabular-nums text-xs text-muted-foreground"
                      }
                    >
                      {overdueBy === null
                        ? "no due date"
                        : overdueBy < 0
                          ? `${Math.abs(overdueBy)} days overdue`
                          : `due in ${overdueBy} days`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground">
              An invoice is marked paid by a verified provider webhook, never
              from a screen — so anything sitting here has genuinely not been
              collected, whatever a bank statement says. If you have paid one
              of these, the reconciliation has not reached us yet.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {invoices.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No invoice has been issued to this workspace yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                Invoices appear the first time a billing period closes — on a
                trial, that is the day the trial converts. Each one is a GST
                tax invoice with your GSTIN and place of supply on it, kept
                here permanently because it is the document your own auditor
                asks for.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Number</th>
                    <th className="px-4 py-2 font-medium">Issued</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    {/* The settlement column disappears entirely rather
                        than showing an em dash: a blank cell in a money
                        column reads as zero received. */}
                    {settlementUsable && (
                      <th className="px-4 py-2 text-right font-medium">Received</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {invoices.map((i) => (
                    <tr
                      key={i.id}
                      className={
                        OWING.has(i.status)
                          ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                          : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2 font-mono text-xs">
                        <Link
                          href={`/settings/billing/invoices/${i.id}`}
                          className="underline"
                        >
                          {i.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {day(i.issuedAt)}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {day(i.dueAt)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {INVOICE_STATUS_LABELS[i.status] ?? i.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {i.totalDisplay || inr(i.totalMinor)}
                      </td>
                      {settlementUsable && (
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {i.amountPaidDisplay || inr(i.amountPaidMinor)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4 · USAGE AGAINST THE PLAN                                          */
/* ------------------------------------------------------------------ */

async function UsagePanel() {
  const result = await getUsageAgainstPlan();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const usage = result.data;
  const pressing = usage.metrics.filter(
    (m) => m.level === "warning" || m.level === "exceeded",
  );

  return (
    <div className="space-y-4">
      {pressing.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {pressing.length === 1 && pressing[0]
                ? `${pressing[0].label} is at ${Math.round((pressing[0].usedBps ?? 0) / 100)}% of your allowance`
                : `${pressing.length} allowances are nearly spent`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-2">
              {pressing.map((m) => (
                <li key={m.metric}>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-medium">{m.label}</span>
                    <span className="tabular-nums">
                      {m.usedLabel}
                      {m.limitLabel ? ` of ${m.limitLabel}` : ""}
                    </span>
                    <Badge variant="outline" className={quotaTone(m.level)}>
                      {m.isBlocked ? "blocked" : m.level}
                    </Badge>
                  </div>
                  {/* ⭐ THE SENTENCE IS THE METRIC'S OWN, VERBATIM, AND IT
                      CARRIES THE REMEDY. "Delete something" and "upgrade"
                      are different answers, and a screen that guesses
                      between them costs the customer money. */}
                  {m.message && (
                    <p className="text-xs text-muted-foreground">{m.message}</p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Usage this period
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {day(usage.periodStart)} → {day(usage.periodEnd)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!usage.hasPlan && (
            <p className="text-xs text-muted-foreground">
              ⚠️ There is no live subscription, so usage is being MEASURED and
              not capped. Nothing here is blocking anything — but a workspace
              without a subscription passes through notice, warning and then
              read-only on its own schedule, which is what the panel at the top
              of this page tracks.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">Metric</th>
                  <th className="px-2 py-2 text-right font-medium">Used</th>
                  <th className="px-2 py-2 text-right font-medium">Allowance</th>
                  <th className="px-2 py-2 font-medium">Standing</th>
                  {/* 🔴 THE OVERAGE POLICY IS A COLUMN, NOT A FOOTNOTE.
                      A customer decides whether to care about a metric
                      based on what happens when they exceed it, and that
                      answer differs per metric here. Burying it in prose
                      under the table meant nobody read it until after the
                      refusal — or after the invoice. */}
                  <th className="px-2 py-2 font-medium">Over the limit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {usage.metrics.map((m) => (
                  <tr key={m.metric}>
                    <td className="px-2 py-2">{m.label}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {m.usedLabel}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                      {m.limitLabel ?? "unlimited"}
                    </td>
                    <td className="px-2 py-2">
                      <Badge variant="outline" className={quotaTone(m.level)}>
                        {m.level}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {/* ⭐ The sentence travels with the state from
                          `lib/metering/overage.ts`, which derives it from
                          the SAME `hardBlockBps` that enforces it. Typing
                          the policy into this page instead is how a screen
                          ends up promising something the engine refuses. */}
                      {m.overageSentence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* ⚠️ This paragraph no longer restates WHICH metric blocks —
              that is the "Over the limit" column above, generated from the
              policy itself. What is left here is the part the column
              cannot say: the two things that are never gated at all. */}
          <p className="text-xs text-muted-foreground">
            ⚠️ Deleting always works, even when you are over — a system that
            blocks the remedy is a trap. Downloading and exporting your own
            data always works too, at every level of usage and of billing
            standing. Nothing you have uploaded is hidden or removed by us.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5 · THE PLAN                                                        */
/* ------------------------------------------------------------------ */

async function PlanPanel() {
  const result = await getCurrentSubscription();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your plan</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const sub = result.data;

  if (!sub) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-6 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            This workspace has no live subscription.
          </p>
          <p className="mx-auto max-w-xl text-xs text-muted-foreground">
            Nothing is deleted and nothing is hidden while there is no plan —
            reads and exports keep working at every level of standing. What
            lapses is the ability to WRITE, on the ladder shown at the top of
            this page.
          </p>
          <Link href="/settings/billing" className="text-sm underline">
            Choose a plan
          </Link>
        </CardContent>
      </Card>
    );
  }

  const renewsIn = daysUntil(sub.currentPeriodEnd);
  const seatsLeft = sub.seatsPurchased - sub.seatsUsed;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {sub.planName}
          <Badge variant="outline" className="ml-2 text-[10px]">
            {SUBSCRIPTION_STATUS_LABELS[sub.status] ?? sub.status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {SUBSCRIPTION_STATUS_HELP[sub.status] ?? ""}
        </p>

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Rate
            </dt>
            <dd className="tabular-nums">
              {sub.unitAmountDisplay || inr(sub.unitAmountMinor)} per{" "}
              {sub.interval}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Current period
            </dt>
            <dd className="tabular-nums">
              {day(sub.currentPeriodStart)} → {day(sub.currentPeriodEnd)}
              {renewsIn !== null && renewsIn >= 0 && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {sub.cancelAtPeriodEnd
                    ? `ends in ${renewsIn} days`
                    : `renews in ${renewsIn} days`}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Seats
            </dt>
            {/* ⚠️ Counted live from `users`, not cached on the
                subscription. A stale count is the difference between "two
                spare" and a failed invite in front of a new joiner. */}
            <dd className="tabular-nums">
              {sub.seatsUsed} of {sub.seatsPurchased} used
              {seatsLeft <= 0 && (
                <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                  no seat free — the next invite will be refused
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Failed payments
            </dt>
            <dd className="tabular-nums">
              {sub.failedPaymentCount}
              {sub.graceEndsAt && (
                <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                  grace ends {day(sub.graceEndsAt)}
                </span>
              )}
            </dd>
          </div>
        </dl>

        {sub.cancelAtPeriodEnd && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            This subscription is set to end on {day(sub.currentPeriodEnd)}. Full
            access continues until then — it has been paid for.
          </p>
        )}

        <Link href="/settings/billing" className="inline-block text-sm underline">
          Change plan, seats or payment method
        </Link>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* PAGE                                                                */
/* ------------------------------------------------------------------ */

function PanelSkeleton() {
  return <div className="h-40 animate-pulse rounded-lg border bg-muted/40" />;
}

export default function BillingOverviewPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            What this workspace owes, what it is using, and what is about to
            stop working.
          </p>
        </div>
        <Link
          href="/settings/billing"
          className="text-sm text-muted-foreground hover:underline"
        >
          Billing portal
        </Link>
      </header>

      <Suspense fallback={null}>
        <StandingPanel />
      </Suspense>

      <Suspense fallback={<PanelSkeleton />}>
        <InstrumentsPanel />
      </Suspense>

      <Suspense fallback={<PanelSkeleton />}>
        <UsagePanel />
      </Suspense>

      <Suspense fallback={<PanelSkeleton />}>
        <PlanPanel />
      </Suspense>

      <Suspense fallback={<PanelSkeleton />}>
        <InvoicesPanel />
      </Suspense>

      <p className="text-xs text-muted-foreground">
        Nothing on this page can spend money or change a plan — every write
        lives in the billing portal, one link away. An invoice is marked paid
        only by a verified provider webhook, never from a screen: a "mark as
        paid" button reachable from the UI would be the single most valuable
        endpoint in this product to an attacker.
      </p>
    </div>
  );
}
