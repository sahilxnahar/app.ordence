/**
 * Ordence — ⭐ ENGINE 4 · LICENCES AND RENEWALS
 * Version: v0.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A LICENCE IS NOT A DEADLINE, AND CONFLATING THE TWO IS EXPENSIVE
 * ══════════════════════════════════════════════════════════════════════
 * Missing a filing costs a late fee. The fee is usually knowable in
 * advance, it accrues in a straight line, and filing late fixes it.
 *
 * An expired licence STOPS THE BUSINESS. A factory licence, a fire NOC, a
 * drug licence, an FSSAI registration — when one of those lapses, the
 * premises cannot lawfully operate. There is no late fee to pay and get
 * on with it; there is a closure, and a renewal process that takes weeks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE PAGE IS ORGANISED BY LEAD TIME, NOT BY EXPIRY DATE
 * ══════════════════════════════════════════════════════════════════════
 * "Expires in 40 days" tells you nothing on its own. A shops-and-
 * establishment renewal takes a week; a pollution-control consent can
 * take three months. The question is never "when does it expire" — it is
 * "is it already too late to start".
 *
 * That is why `renewal_lead_days` lives on each licence rather than being
 * one global setting, and why the renewal window opens off it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE WINDOW IS COMPUTED, NOT READ FROM `status`
 * ══════════════════════════════════════════════════════════════════════
 * `status` is whatever somebody last selected from a dropdown. The
 * renewal window is a fact about today and the expiry date, and it opens
 * whether or not anyone remembered to update anything. Trusting the
 * status column would mean a licence quietly stops warning the moment
 * somebody clicks the wrong option — which is exactly the kind of thing
 * nobody notices until the inspection.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  listComplianceLicences,
  listComplianceOptions,
} from "@/server/actions/compliance";
import { LicenceActions } from "@/components/compliance/licence-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Licences · Ordence" };

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
  active: "Active",
  renewal_due: "Renewal due",
  under_renewal: "Under renewal",
  expired: "Expired",
  suspended: "Suspended",
  cancelled: "Cancelled",
  not_required: "Not required",
};

function statusTone(status: string): string {
  if (status === "expired" || status === "suspended")
    return "border-red-400 text-red-700 dark:border-red-700 dark:text-red-300";
  if (status === "renewal_due")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (status === "active")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  return "text-muted-foreground";
}

async function LicencesBody() {
  const result = await listComplianceLicences();
  /**
   * ⚠️ Read separately, and allowed to fail without taking the page with
   * it. The client list only populates one dropdown; the expired-licence
   * panel below is the reason somebody opened this screen.
   */
  const options = await listComplianceOptions();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Licence register unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { licences, expired, renewalDue, renewalFeeDueMinor } = result.data;

  const live = licences.filter(
    (l) => l.status !== "cancelled" && l.status !== "not_required",
  );
  const noExpiry = live.filter((l) => l.validUntil === null);

  return (
    <div className="space-y-6">
      <LicenceActions
        companies={options.ok ? options.data.companies : []}
        licences={licences.map((l) => ({
          id: l.id,
          name: l.name,
          status: l.status,
          validUntil: l.validUntil,
        }))}
      />

      {/* ── EXPIRED. The business may be operating unlawfully today. ── */}
      {expired.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {expired.length} licence{expired.length === 1 ? " has" : "s have"}{" "}
              expired
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {expired.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{l.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {AUTHORITY_LABEL[l.authority] ?? l.authority}
                  </span>
                  {l.licenceNumber && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {l.licenceNumber}
                    </span>
                  )}
                  <span className="tabular-nums text-red-600 dark:text-red-400">
                    expired {Math.abs(l.daysUntilExpiry ?? 0)}d ago
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              An expired licence is not a late fee. Depending on which one this
              is, the premises may not lawfully be operating right now — and
              renewal after expiry is usually a fresh application rather than a
              renewal, which takes considerably longer.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── RENEWAL WINDOW OPEN. Computed, not read from status. ────── */}
      {renewalDue.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {renewalDue.length} licence{renewalDue.length === 1 ? "" : "s"}{" "}
              inside the renewal window with nothing started
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {renewalDue.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{l.name}</span>
                  <span className="tabular-nums">
                    expires in {l.daysUntilExpiry}d
                  </span>
                  {/* ⭐ The number that actually decides urgency. */}
                  <span className="text-xs text-muted-foreground">
                    needs {l.renewalLeadDays}d to renew
                  </span>
                  {(l.daysUntilExpiry ?? 0) < l.renewalLeadDays / 2 && (
                    <Badge
                      variant="outline"
                      className="border-red-400 text-[10px] text-red-700 dark:border-red-700 dark:text-red-300"
                    >
                      already tight
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The window opens from each licence&apos;s own lead time, not from a
              shared setting — a shops-and-establishment renewal takes a week
              and a pollution-control consent can take three months, so a single
              &ldquo;warn me 30 days before&rdquo; rule is wrong for both.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Live licences
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{live.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {licences.length} on record.
            </p>
          </CardContent>
        </Card>

        <Card className={expired.length > 0 ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expired
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{expired.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Operating without one is not a fee, it is a closure.
            </p>
          </CardContent>
        </Card>

        <Card
          className={renewalDue.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Renewal window open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {renewalDue.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Judged on each licence&apos;s own lead time.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Renewal fees due
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(renewalFeeDueMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across expired and renewal-due licences.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ⚠️ A licence with no expiry recorded warns about nothing. */}
      {noExpiry.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {noExpiry.length} licence{noExpiry.length === 1 ? "" : "s"} with no
              expiry date recorded
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="flex flex-wrap gap-2">
              {noExpiry.slice(0, 15).map((l) => (
                <li key={l.id}>
                  <Badge variant="outline" className="text-[11px]">
                    {l.name}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Some licences genuinely do not expire. The rest of these will
              never appear in a renewal warning, because there is no date to
              count back from — they are invisible to every alarm on this page.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All licences</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {licences.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No licences recorded yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                Record the expiry date and how long a renewal actually takes.
                The second number is the one that matters: an expiry three
                months out is comfortable for a trade licence and already late
                for a pollution-control consent.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Licence</th>
                    <th className="px-4 py-2 font-medium">Authority</th>
                    <th className="px-4 py-2 font-medium">Number</th>
                    <th className="px-4 py-2 font-medium">For</th>
                    <th className="px-4 py-2 font-medium">Valid until</th>
                    <th className="px-4 py-2 font-medium">Renewal takes</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {licences.map((l) => {
                    const overdue =
                      l.daysUntilExpiry !== null && l.daysUntilExpiry < 0;
                    return (
                      <tr
                        key={l.id}
                        className={
                          overdue && l.status !== "cancelled" && l.status !== "not_required"
                            ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30"
                            : "hover:bg-muted/40"
                        }
                      >
                        <td className="px-4 py-2 font-medium">{l.name}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {AUTHORITY_LABEL[l.authority] ?? l.authority}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                          {l.licenceNumber ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {l.subjectCompanyId === null ? (
                            <span className="font-medium">You</span>
                          ) : (
                            <span className="text-muted-foreground">A client</span>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums">
                          {l.validUntil ?? (
                            <span className="text-muted-foreground">
                              not recorded
                            </span>
                          )}
                          {l.daysUntilExpiry !== null && (
                            <div
                              className={
                                overdue
                                  ? "text-xs text-red-600 dark:text-red-400"
                                  : "text-xs text-muted-foreground"
                              }
                            >
                              {overdue
                                ? `${Math.abs(l.daysUntilExpiry)}d ago`
                                : `in ${l.daysUntilExpiry}d`}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-xs text-muted-foreground">
                          {l.renewalLeadDays}d
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={statusTone(l.status)}>
                            {STATUS_LABEL[l.status] ?? l.status}
                          </Badge>
                          {/* ⭐ Computed, and shown even when status disagrees. */}
                          {l.isRenewalDue && l.status !== "renewal_due" && (
                            <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                              renewal window open
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        The renewal window is worked out from today and the expiry date against
        each licence&apos;s own lead time — not read from the status column, so
        it keeps warning even if somebody sets the status to something else.
        Where the two disagree, both are shown rather than one silently winning.
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

export default function LicencesPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Licences</h1>
          <p className="text-sm text-muted-foreground">
            Permissions that expire, and the renewal window before they do.
          </p>
        </div>
        <Link
          href="/compliance"
          className="text-sm text-muted-foreground hover:underline"
        >
          Deadlines
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <LicencesBody />
      </Suspense>
    </div>
  );
}
