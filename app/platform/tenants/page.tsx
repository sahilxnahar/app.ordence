/**
 * Ordence — Platform Console · Workspaces Needing Attention (Section F)
 * Version: v0.53.0
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `/platform` WITH A FILTER ON IT
 * ══════════════════════════════════════════════════════════════════════
 * `/platform` is the DIRECTORY: every workspace, sortable, pageable,
 * searchable. It answers "find me Acme". It is a good directory and this
 * page does not replace it.
 *
 * The question it cannot answer is the one an operator has at 09:00:
 * "who needs me today?" A directory answers that only if you already know
 * which columns to sort by and you remember to check four of them. So
 * this page inverts it — it starts from the four reasons a workspace
 * needs a human and shows only the workspaces that have one:
 *
 *   trial ending    a sales call, this week
 *   over a limit    an invoice conversation, and they are blocked NOW
 *   no activity     churn, or an onboarding that never finished
 *   suspended       a decision somebody made, and may have forgotten
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EACH ROW SAYS WHAT IS WRONG, NOT HOW WRONG IT IS
 * ══════════════════════════════════════════════════════════════════════
 * There is already a health SCORE (`evaluateHealth`) and it is the right
 * tool for scanning two hundred directory rows. It is the wrong tool
 * here, because "62" does not tell anybody what to do. A REASON does:
 * "trial ends in 3 days" and "14 people in a workspace sold 10 seats" are
 * two different phone calls to two different people.
 *
 * ⚠️ NOT AUDITED PER-ROW. This is a morning dashboard; a row per glance
 * would bury the accesses that matter under the ones that do not. Opening
 * a specific workspace IS audited, and that is where the boundary belongs.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlatformOperator } from "@/server/platform/guard";
import { listWorkspacesNeedingAttention } from "@/server/platform/configuration";
import {
  troubleSignals,
  TROUBLE_KINDS,
  TROUBLE_LABELS,
  type TroubleKind,
  type TroubleSignal,
} from "@/lib/platform/configuration";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AttentionPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const kindParam = typeof params.kind === "string" ? params.kind : "all";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Needs attention</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspaces with a reason somebody should look at them today. Everything else is
          in the{" "}
          <Link href="/platform" className="underline">
            directory
          </Link>
          .
        </p>
        {/*
          ⚠️ LINKED FROM HERE BECAUSE `app/platform/layout.tsx` — where
          the console's nav lives — is not owned by this batch. A screen
          nobody can reach is the eighth complete engine this codebase
          has shipped with no caller, which is why
          `scripts/check-reachability.mjs` exists. One link now; the nav
          entry belongs in whichever batch owns the layout.
        */}
        <p className="mt-1 text-sm text-muted-foreground">
          Limits, messages and windows resolve through the{" "}
          <Link href="/platform/config" className="underline">
            configuration chain
          </Link>
          .
        </p>
      </div>

      <Suspense fallback={<div className="h-64 animate-pulse rounded-md bg-muted" />}>
        <AttentionBody kind={kindParam} />
      </Suspense>
    </div>
  );
}

async function AttentionBody({ kind }: { kind: string }) {
  const operator = await getPlatformOperator();
  if (!operator) notFound();

  const result = await listWorkspacesNeedingAttention();
  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {result.error}
      </p>
    );
  }

  const now = new Date();

  const scored = result.data
    .map((row) => ({
      row,
      signals: troubleSignals({
        status: row.status,
        planTier: row.planTier,
        trialEndsAt: row.trialEndsAt ? new Date(row.trialEndsAt) : null,
        seatsInUse: row.seatsInUse,
        seatLimit: row.seatLimit,
        storageUsedMb: row.storageUsedMb,
        storageLimitMb: row.storageLimitMb,
        lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
        createdAt: new Date(row.createdAt),
        now,
      }),
    }))
    .filter((entry) => entry.signals.length > 0);

  const counts = Object.fromEntries(
    TROUBLE_KINDS.map((k) => [
      k,
      scored.filter((e) => e.signals.some((s) => s.kind === k)).length,
    ]),
  ) as Record<TroubleKind, number>;

  const visible =
    kind === "all"
      ? scored
      : scored.filter((e) => e.signals.some((s) => s.kind === kind));

  /*
   * ⚠️ SORTED BY URGENCY, THEN BY COUNT. A workspace with three problems
   * is not three times as urgent as one whose trial ends tomorrow, but
   * "act" always outranks "watch" — the ordering exists so the top of the
   * list is the top of the list even on a bad morning.
   */
  const sorted = [...visible].sort((a, b) => {
    const urgency = (s: TroubleSignal[]) => (s.some((x) => x.urgency === "act") ? 0 : 1);
    return urgency(a.signals) - urgency(b.signals) || b.signals.length - a.signals.length;
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {TROUBLE_KINDS.map((k) => (
          <Card key={k}>
            <CardHeader>
              <CardTitle>
                <Link href={`/platform/tenants?kind=${k}`} className="hover:underline">
                  {TROUBLE_LABELS[k]}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">
              {counts[k]}
            </CardContent>
          </Card>
        ))}
      </div>

      {kind !== "all" ? (
        <p className="text-sm">
          Filtered to {TROUBLE_LABELS[kind as TroubleKind] ?? kind} ·{" "}
          <Link href="/platform/tenants" className="underline">
            show all
          </Link>
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing needs attention. That is a real answer, not an empty table — every
          workspace is inside its limits, active, and not mid-trial.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>What is wrong</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map(({ row, signals }) => (
              <TableRow key={row.id} data-testid={`attention-${row.slug}`}>
                <TableCell>
                  <Link
                    href={`/platform/tenants/${row.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.name}
                  </Link>
                  <div className="font-mono text-xs text-muted-foreground">{row.slug}</div>
                </TableCell>
                <TableCell className="text-sm">{row.planTier}</TableCell>
                <TableCell>
                  <ul className="space-y-1">
                    {signals.map((s) => (
                      <li key={s.kind + s.detail} className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant={s.urgency === "act" ? "destructive" : "outline"}>
                          {TROUBLE_LABELS[s.kind]}
                        </Badge>
                        <span>{s.detail}</span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-right text-xs">
                  <Link
                    href={`/platform/tenants/${row.id}/configure`}
                    className="underline"
                  >
                    Configure
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <p className="text-xs text-muted-foreground">
        Read over the {result.data.length} workspaces that are not archived. Seats and
        storage are rolled up per workspace, never per record — this page holds nothing a
        customer typed.
      </p>
    </div>
  );
}
