/**
 * Ordence — GST
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ANOTHER FINISHED ENGINE WITH NO FACE
 * ══════════════════════════════════════════════════════════════════════
 * Phase 32 built GST registrations, HSN/SAC codes and dated rate periods —
 * including the part that is genuinely hard: rates that change on a
 * notification date, stored so that an invoice raised last March is still
 * priced at last March's rate no matter what today's rate is. It shipped
 * with no screens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ UNRATED CODES ARE THE ALARM ON THIS PAGE
 * ══════════════════════════════════════════════════════════════════════
 * An HSN/SAC code with no rate period covering today cannot price an
 * invoice. The failure is not loud — nothing crashes — it simply refuses
 * at the moment somebody is trying to raise a bill, which is the worst
 * possible time to discover it.
 *
 * So the count of unrated codes sits at the top of this page, before the
 * registrations, before anything reassuring. If it is zero, the panel says
 * so plainly and takes one line.
 *
 * ⚠️ Rates are basis points throughout — 1800 is 18%, not 18. Displaying
 * them means dividing by 100 exactly once, here, at the edge. Nothing
 * upstream ever holds a percentage.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getRegistrations, getUnratedCodes, getHsnSacCodes } from "@/server/actions/gst";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "GST · Ordence" };

/** Basis points to a display percentage. The only place this conversion happens. */
function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type HsnRow = {
  id?: string;
  code?: string;
  kind?: string;
  description?: string | null;
  currentRateBps?: number | null;
};

async function GstBody() {
  const [registrations, unrated, codes] = await Promise.all([
    getRegistrations(),
    getUnratedCodes(today()),
    getHsnSacCodes(),
  ]);

  const unratedRows = unrated.ok ? (unrated.data.rows as HsnRow[]) : [];
  const codeRows = codes.ok ? (codes.data.rows as HsnRow[]) : [];

  return (
    <div className="space-y-6">
      {/* The alarm goes first. See the page header for why. */}
      {unratedRows.length > 0 ? (
        <Card className="border-red-300 dark:border-red-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
              {unratedRows.length} code{unratedRows.length === 1 ? "" : "s"} cannot
              price an invoice today
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              These HSN/SAC codes have no rate period covering {today()}. Any
              invoice line using one will be refused — at the moment somebody is
              trying to raise a bill.
            </p>
            <ul className="flex flex-wrap gap-2">
              {unratedRows.slice(0, 40).map((row, i) => (
                <li key={row.id ?? row.code ?? i}>
                  <Badge variant="destructive" className="font-mono">
                    {row.code ?? "—"}
                  </Badge>
                </li>
              ))}
            </ul>
            {unratedRows.length > 40 && (
              <p className="text-xs text-muted-foreground">
                …and {unratedRows.length - 40} more.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          Every HSN/SAC code has a rate covering today.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Our GST registrations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!registrations.ok ? (
            <p className="p-6 text-sm text-muted-foreground">{registrations.error}</p>
          ) : registrations.data.rows.length === 0 ? (
            <div className="space-y-2 p-6">
              <p className="text-sm text-muted-foreground">
                No registration recorded yet.
              </p>
              <p className="text-xs text-muted-foreground">
                Ordence decides IGST versus CGST+SGST by comparing the place of
                supply against your own state code. Without a registration it
                cannot make that call, so it refuses rather than guessing.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">GSTIN</th>
                    <th className="p-3 font-medium">Legal name</th>
                    <th className="p-3 font-medium">State</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Effective</th>
                    <th className="p-3 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {registrations.data.rows.map((row) => (
                    <tr key={row.id} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{row.gstin}</td>
                      <td className="p-3">
                        {row.legalName}
                        {row.tradeName ? (
                          <span className="block text-xs text-muted-foreground">
                            trading as {row.tradeName}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-3 font-mono text-xs">{row.stateCode}</td>
                      <td className="p-3 text-muted-foreground">
                        {row.registrationType}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {row.effectiveFrom}
                        {row.effectiveTo ? ` → ${row.effectiveTo}` : ""}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          {row.isPrimary && <Badge>primary</Badge>}
                          {!row.isActive && <Badge variant="secondary">retired</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>HSN / SAC codes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {codeRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No codes yet. Each one carries dated rate periods, so a rate change
              never rewrites history — an invoice raised last March keeps last
              March&apos;s rate.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Code</th>
                    <th className="p-3 font-medium">Kind</th>
                    <th className="p-3 font-medium">Description</th>
                    <th className="p-3 text-right font-medium">Rate today</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {codeRows.map((row, i) => (
                    <tr key={row.id ?? i} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{row.code ?? "—"}</td>
                      <td className="p-3 uppercase text-muted-foreground">
                        {row.kind ?? "—"}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {row.description ?? "—"}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.currentRateBps === null || row.currentRateBps === undefined ? (
                          <span className="text-red-600">no rate</span>
                        ) : (
                          bpsToPct(row.currentRateBps)
                        )}
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
        Rate periods cannot overlap — the database enforces it with an exclusion
        constraint, not application code, so two rates can never both be valid on
        the same day for the same code.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-16 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function GstPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">GST</h1>
          <p className="text-sm text-muted-foreground">
            Registrations, HSN/SAC codes and the rates that apply on any given
            date.
          </p>
        </div>
        <Link
          href="/settings/financial"
          className="text-sm text-muted-foreground hover:underline"
        >
          Financial settings
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <GstBody />
      </Suspense>
    </div>
  );
}
