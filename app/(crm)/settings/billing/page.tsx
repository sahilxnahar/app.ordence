/**
 * Ordence — Billing Portal
 * Version: v0.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS PAGE MUST WORK WHEN NOTHING ELSE DOES
 * ══════════════════════════════════════════════════════════════════════
 * Every other screen can be behind a paywall. This one cannot — it is
 * where the paywall is removed. A customer whose subscription has lapsed
 * arrives here specifically to fix it, and if this page is itself
 * restricted the only route out is a support ticket.
 *
 * So:
 *   • `billing:` operations are on the always-permitted write list in
 *     `lib/billing/access-state.ts`.
 *   • Nothing here is wrapped in a `FeatureGate`.
 *   • Every panel degrades independently — a failure loading invoices
 *     must not take down the payment-method form beside it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EACH PANEL HAS ITS OWN SUSPENSE BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * Four independent queries: the subscription, seats, usage, invoices. A
 * single boundary would hold the whole page until the slowest returned,
 * and the slowest is the invoice list. The customer would stare at a
 * skeleton while the one number they came for — "how do I pay?" — was
 * already available.
 */

import { Suspense } from "react";
import { CreditCard, FileText, Users, Gauge } from "lucide-react";

import { getCurrentSubscription, listInvoices } from "@/server/actions/billing";
import { ReconciliationNotice } from "@/components/reconciliation/reconciliation-notice";
import { getSeatUsage } from "@/server/actions/team";
import { checkAccess } from "@/server/billing/access";
import { getEntitlementSummary } from "@/server/entitlements";
import { TIER_LABELS } from "@/lib/entitlements/features";
import {
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUS_HELP,
  INVOICE_STATUS_LABELS,
} from "@/lib/validators/billing";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* PAGE                                                                */
/* ------------------------------------------------------------------ */

export default async function BillingPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your plan, what you are using, and every invoice we have issued.
        </p>
      </header>

      {/* The standing banner comes first — if the account is in trouble,
          that is the thing the reader needs before anything else. */}
      <Suspense fallback={null}>
        <StandingPanel />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<PanelSkeleton title="Your plan" />}>
          <PlanPanel />
        </Suspense>

        <Suspense fallback={<PanelSkeleton title="Users" />}>
          <SeatsPanel />
        </Suspense>
      </div>

      <Suspense fallback={<PanelSkeleton title="Invoices" />}>
        <InvoicesPanel />
      </Suspense>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* STANDING                                                            */
/* ------------------------------------------------------------------ */

async function StandingPanel() {
  const decision = await checkAccess();
  if (!decision.headline) return null;

  const tone =
    decision.level === "restricted" || decision.level === "locked"
      ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
      : decision.level === "warning"
        ? "border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20"
        : "border-border bg-muted/40";

  return (
    <section role="status" className={cn("rounded-lg border p-4", tone)}>
      <p className="text-sm font-medium">{decision.headline}</p>
      {decision.detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{decision.detail}</p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* PLAN                                                                */
/* ------------------------------------------------------------------ */

async function PlanPanel() {
  const [result, entitlements] = await Promise.all([
    getCurrentSubscription(),
    getEntitlementSummary().catch(() => null),
  ]);

  if (!result.ok) {
    return <PanelError title="Your plan" message={result.error} />;
  }

  const subscription = result.data;

  if (!subscription) {
    return (
      <Panel title="Your plan" icon={<CreditCard className="h-4 w-4" />}>
        <p className="text-sm text-muted-foreground">
          This workspace is not on a paid plan yet.
        </p>
        {entitlements ? (
          <p className="mt-2 text-sm">
            Currently running as{" "}
            <strong>{TIER_LABELS[entitlements.effectiveTier]}</strong>.
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel title="Your plan" icon={<CreditCard className="h-4 w-4" />}>
      <dl className="space-y-3 text-sm">
        <Row label="Plan">
          <strong>{subscription.planName}</strong>{" "}
          <span className="text-muted-foreground">
            · {subscription.unitAmountDisplay} / {subscription.interval}
          </span>
        </Row>

        <Row label="Status">
          <span>{SUBSCRIPTION_STATUS_LABELS[subscription.status] ?? subscription.status}</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {/* Says what happens NEXT, not just what the state is called.
                "Payment failed" tells someone nothing about whether they
                still have access. */}
            {SUBSCRIPTION_STATUS_HELP[subscription.status] ?? ""}
          </p>
        </Row>

        <Row label="Current period">
          {formatDate(subscription.currentPeriodStart)} —{" "}
          {formatDate(subscription.currentPeriodEnd)}
        </Row>

        {subscription.cancelAtPeriodEnd ? (
          <Row label="Ends">
            {formatDate(subscription.currentPeriodEnd)} — you keep full access until then.
          </Row>
        ) : null}
      </dl>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* SEATS                                                               */
/* ------------------------------------------------------------------ */

async function SeatsPanel() {
  const result = await getSeatUsage();

  if (!result.ok) {
    return <PanelError title="Users" message={result.error} />;
  }

  const seats = result.data;

  return (
    <Panel title="Users" icon={<Users className="h-4 w-4" />}>
      <p className="text-2xl font-semibold tabular-nums">
        {seats.used}
        <span className="text-base font-normal text-muted-foreground">
          {" "}
          of {seats.purchased}
        </span>
      </p>

      <Meter used={seats.used} total={seats.purchased} />

      {/* Overage first — it is the more urgent of the two, and only one
          can apply at a time. */}
      {seats.overageMessage ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          {seats.overageMessage}
        </p>
      ) : seats.warningMessage ? (
        <p className="mt-3 text-sm text-muted-foreground">{seats.warningMessage}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {seats.available} seat{seats.available === 1 ? "" : "s"} available.
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        {/* The remedy most admins do not know exists. Stating it here
            saves a support conversation. */}
        Suspending someone who has left frees their seat and keeps their history.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* INVOICES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SETTLEMENT CHECK IS SURFACED HERE TOO, EVEN THOUGH THIS PANEL
 * PRINTS NO "RECEIVED" COLUMN. It prints the invoice STATUS, and "Paid"
 * is a settlement claim in one word — the shortest and most trusted form
 * of the very figure the gate is checking. A screen that shows the claim
 * without the check is the screen the claim gets read off.
 */
async function InvoicesPanel() {
  const result = await listInvoices(24);

  if (!result.ok) {
    return <PanelError title="Invoices" message={result.error} />;
  }

  const { invoices: invoiceRows, reconciliation, breachCauses } = result.data;

  if (reconciliation.state === "breached") {
    return (
      <Panel title="Invoices" icon={<FileText className="h-4 w-4" />}>
        <ReconciliationNotice
          reconciliation={reconciliation}
          breachCauses={breachCauses}
        />
      </Panel>
    );
  }

  if (invoiceRows.length === 0) {
    return (
      <Panel title="Invoices" icon={<FileText className="h-4 w-4" />}>
        <p className="text-sm text-muted-foreground">
          No invoices yet. One is issued at the start of each billing period.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Invoices" icon={<FileText className="h-4 w-4" />}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Number</th>
              <th className="py-2 pr-4 font-medium">Issued</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              {/* Right-aligned and tabular — digits must line up down the
                  column or they are misread. */}
              <th className="py-2 pr-4 text-right font-medium">Amount</th>
              <th className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoiceRows.map((invoice) => (
              <tr key={invoice.id} className="border-b last:border-0">
                <td className="py-2 pr-4 font-medium">{invoice.invoiceNumber}</td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {formatDate(invoice.issuedAt)}
                </td>
                <td className="py-2 pr-4">
                  {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {invoice.totalDisplay}
                </td>
                <td className="py-2">
                  <a
                    href={`/settings/billing/invoices/${invoice.id}`}
                    className="text-sm font-medium underline underline-offset-2"
                  >
                    View
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * A failed panel says what failed and leaves the rest of the page alone.
 *
 * Deliberately NOT a thrown error: on a billing page, one slow query
 * must never blank the screen a lapsed customer came to fix.
 */
function PanelError({ title, message }: { title: string; message: string }) {
  return (
    <Panel title={title}>
      <p className="text-sm text-muted-foreground">{message}</p>
    </Panel>
  );
}

function PanelSkeleton({ title }: { title: string }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {/* Holds the space so the page does not jump as panels arrive. */}
      <div className="space-y-2" aria-hidden="true">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <span className="sr-only">Loading {title}…</span>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Meter({ used, total }: { used: number; total: number }) {
  // Guarded: a zero total would make this NaN and render an invisible bar.
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 100;
  const over = used > total;

  return (
    <div
      className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${used} of ${total} seats in use`}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          over ? "bg-amber-500" : pct >= 80 ? "bg-amber-400" : "bg-primary",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
