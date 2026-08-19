/**
 * Ordence — ⭐ ENGINE 4 · THE COMPLIANCE BOARD
 * Version: v0.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE OPENS WITH WHAT IS ALREADY WRONG, NOT WITH WHAT IS COMING
 * ══════════════════════════════════════════════════════════════════════
 * A compliance screen that leads with "12 obligations tracked" is a
 * screen that gets looked at once. The order below is by what it costs to
 * ignore for one more day:
 *
 *   1. MISSED         — the money is already running. Late fees on a GST
 *                       return accrue per day and do not stop.
 *   2. NOT GENERATING — an obligation configured but producing no tasks.
 *                       See below; this is the worst state in the system.
 *   3. DUE SOON       — actionable this fortnight.
 *   4. EVERYTHING     — the register itself.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY "CONFIGURED BUT NOT GENERATING" RANKS ABOVE "DUE SOON"
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT IS THE ONLY FAILURE ON THIS PAGE THAT IS INVISIBLE BY
 * CONSTRUCTION.
 *
 * A missed deadline shouts. A deadline that was never generated is
 * silent: the obligation is in the register, somebody ticked it during
 * setup, the screen looks populated — and nothing is due, so nothing is
 * late, so nothing is reported. The register keeps its reassuring green
 * for as long as the omission lasts, and the first sign is a notice from
 * the department.
 *
 * A compliance system whose alarms cannot fire is worse than no system,
 * because somebody is relying on it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ "MINE" AND "MY CLIENTS'" ARE SPLIT, ALWAYS
 * ══════════════════════════════════════════════════════════════════════
 * A CA firm looking at one merged list of six hundred deadlines cannot
 * tell which four are its own. Those four are the ones that get missed,
 * because everybody is busy with the clients' — and a practice that files
 * four hundred returns on time and misses its own ROC filing is a
 * specific, common and entirely avoidable embarrassment.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  listComplianceBoard,
  listComplianceOptions,
} from "@/server/actions/compliance";
import { ComplianceActions } from "@/components/compliance/compliance-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Deadlines · Ordence" };

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

const AUTHORITY_LABEL: Record<string, string> = {
  gst: "GST",
  income_tax: "Income Tax",
  mca_roc: "MCA / RoC",
  epfo: "EPFO",
  esic: "ESIC",
  labour: "Labour",
  professional_tax: "Professional Tax",
  customs: "Customs",
  rbi: "RBI",
  sebi: "SEBI",
  fssai: "FSSAI",
  pollution_control: "Pollution Control",
  fire: "Fire",
  municipal: "Municipal",
  transport_rto: "RTO",
  electricity_cea: "CEA",
  health_nmc: "NMC",
  drugs_licensing: "Drugs Licensing",
  aerb: "AERB",
  state_excise: "State Excise",
  legal_metrology: "Legal Metrology",
  internal: "Internal",
  other: "Other",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  awaiting_client: "Awaiting client",
  ready_to_file: "Ready to file",
  filed: "Filed",
  late_filed: "Filed late",
  missed: "Missed",
  not_applicable: "Not applicable",
  waived: "Waived",
};

/** Statuses that need no further action. */
const SETTLED = new Set(["filed", "late_filed", "not_applicable", "waived"]);

function statusTone(status: string): string {
  if (status === "missed") return "border-red-400 text-red-700 dark:border-red-700 dark:text-red-300";
  if (status === "late_filed")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (status === "filed")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  if (status === "not_applicable" || status === "waived")
    return "text-muted-foreground";
  return "";
}

/** How the due date reads at a glance. */
function dueLabel(days: number | null, status: string): string {
  if (days === null) return "—";
  if (SETTLED.has(status)) return "";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `in ${days}d`;
}

async function ComplianceBody() {
  const result = await listComplianceBoard();
  /**
   * ⚠️ THE FORM OPTIONS ARE READ SEPARATELY AND ARE ALLOWED TO FAIL.
   *
   * The register is the thing this page exists to show. If the obligation
   * and client lists cannot be read, the write panel goes away and the
   * board still renders — a compliance screen that refuses to display
   * because a dropdown could not be populated is a screen that hides the
   * missed deadlines it was opened to show.
   */
  const options = await listComplianceOptions();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Compliance register unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    tasks,
    missed,
    dueSoon,
    ownCount,
    clientCount,
    lateFeeExposureMinor,
    obligationsWithoutTasks,
    activeObligations,
  } = result.data;

  const open = tasks.filter((t) => !SETTLED.has(t.status));
  const ownMissed = missed.filter((t) => t.subjectCompanyId === null);

  return (
    <div className="space-y-6">
      {options.ok && (
        <ComplianceActions
          obligations={options.data.obligations}
          companies={options.data.companies}
          /**
           * ⭐ Every task, not just the open ones. Evidence gets attached to
           * filings that are already done — that is when the acknowledgement
           * PDF actually arrives — and the component filters to open tasks
           * itself for the actions that need it.
           */
          tasks={tasks}
        />
      )}

      {/* ── 1 · MISSED. The money is already running. ─────────────── */}
      {missed.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {missed.length} deadline{missed.length === 1 ? "" : "s"} missed
              {ownMissed.length > 0 && clientCount > 0 && (
                <span className="ml-2 text-sm font-normal">
                  — {ownMissed.length} of them your own
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {missed.slice(0, 12).map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{t.obligationName}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.periodLabel}
                  </span>
                  <span className="tabular-nums text-red-600 dark:text-red-400">
                    {t.daysLate}d late
                  </span>
                  {BigInt(t.lateFeeMinor || "0") > 0n && (
                    <span className="tabular-nums text-red-600 dark:text-red-400">
                      {inr(t.lateFeeMinor)}
                    </span>
                  )}
                  {t.subjectCompanyId === null && (
                    <Badge variant="outline" className="text-[10px]">
                      your own
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {missed.length > 12 && (
              <p className="text-xs text-muted-foreground">
                …and {missed.length - 12} more in the register below.
              </p>
            )}
            <p className="text-muted-foreground">
              A missed deadline stays missed. It is not moved back to pending
              when it is eventually filed — it becomes{" "}
              <span className="font-medium">filed late</span>, because a
              register you can tidy is a register no inspector will accept.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · CONFIGURED BUT NOT GENERATING. See the file header. ── */}
      {obligationsWithoutTasks.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {obligationsWithoutTasks.length} obligation
              {obligationsWithoutTasks.length === 1 ? " is" : "s are"} configured
              but producing no deadlines
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="flex flex-wrap gap-2">
              {obligationsWithoutTasks.slice(0, 15).map((o) => (
                <li key={o.id}>
                  <Badge variant="outline" className="text-[11px]">
                    {o.name}
                    <span className="ml-1.5 text-muted-foreground">
                      {o.frequency.replace("_", " ")}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              ⚠️ This is the one failure on this page you cannot see by looking
              at it. The obligation is in the register and the screen looks
              populated, but nothing has ever been generated from it — so
              nothing is due, nothing is late, and nothing will be reported.
              The register stays green for exactly as long as the omission
              lasts.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={open.length > 0 ? "" : "opacity-80"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open deadlines
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{open.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {tasks.length} in the register.
            </p>
          </CardContent>
        </Card>

        <Card className={dueSoon.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Due within 14 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{dueSoon.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {dueSoon[0]?.dueDate
                ? `Next: ${dueSoon[0].obligationName} on ${dueSoon[0].dueDate}.`
                : "Nothing in the next fortnight."}
            </p>
          </CardContent>
        </Card>

        <Card
          className={
            BigInt(lateFeeExposureMinor || "0") > 0n
              ? "border-red-300 dark:border-red-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Late fees accrued
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(lateFeeExposureMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Derived from the days late, per the rate on each obligation.
            </p>
          </CardContent>
        </Card>

        {/* ⭐ The split that keeps a practice from missing its own filings. */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Yours vs clients&apos;
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {ownCount}
              <span className="text-base font-normal text-muted-foreground">
                {" / "}
                {clientCount}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {activeObligations} active obligation
              {activeObligations === 1 ? "" : "s"} configured.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 4 · The register. ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The register</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No deadlines yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                A deadline is generated from an obligation — &ldquo;GSTR-3B,
                monthly, due the 20th&rdquo; — and its due date is worked out by
                the database from the period, never typed. That matters at the
                end of a 31-day month: an obligation due on the 31st falls on
                the 30th in a 30-day month and the 28th in February, and a
                hand-typed date gets that wrong once a year, quietly.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Obligation</th>
                    <th className="px-4 py-2 font-medium">Authority</th>
                    <th className="px-4 py-2 font-medium">Period</th>
                    <th className="px-4 py-2 font-medium">For</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Late fee</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      className={
                        t.status === "missed"
                          ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30"
                          : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2 font-medium">
                        {t.obligationName}
                        <div className="text-xs font-normal text-muted-foreground">
                          {t.frequency.replace("_", " ")}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {AUTHORITY_LABEL[t.authority] ?? t.authority}
                      </td>
                      <td className="px-4 py-2 text-xs">{t.periodLabel}</td>
                      {/* ⭐ Whose obligation this is — never merged away. */}
                      <td className="px-4 py-2 text-xs">
                        {t.subjectCompanyId === null ? (
                          <span className="font-medium">You</span>
                        ) : (
                          <span className="text-muted-foreground">A client</span>
                        )}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {t.dueDate ?? "—"}
                        <div
                          className={
                            (t.daysUntilDue ?? 0) < 0 && !SETTLED.has(t.status)
                              ? "text-xs text-red-600 dark:text-red-400"
                              : "text-xs text-muted-foreground"
                          }
                        >
                          {dueLabel(t.daysUntilDue, t.status)}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={statusTone(t.status)}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {BigInt(t.lateFeeMinor || "0") > 0n
                          ? inr(t.lateFeeMinor)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Due dates are derived by the database from the period and the
        obligation&apos;s own rule, never typed — including the day-31 clamp, so
        an obligation due on the 31st lands correctly in February. Late fees
        accrue from the days late at the rate stated on the obligation, capped
        where the statute caps them. Filed and missed are both terminal:
        completing a missed deadline records it as filed late rather than
        returning it to pending.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function CompliancePage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Deadlines</h1>
          <p className="text-sm text-muted-foreground">
            What must be done, for whom, by when — and what lateness costs.
          </p>
        </div>
        <Link
          href="/compliance/licences"
          className="text-sm text-muted-foreground hover:underline"
        >
          Licences &amp; renewals
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <ComplianceBody />
      </Suspense>
    </div>
  );
}
