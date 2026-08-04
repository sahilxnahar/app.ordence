/**
 * Ordence — GSTR-2B reconciliation
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 1 — PHASE 34's MATCHING ENGINE, MADE VISIBLE
 * ══════════════════════════════════════════════════════════════════════
 * Statement import, row parsing, fuzzy matching with confidence scoring
 * and per-match actions were all built and tested. No screen existed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT GSTR-2B ACTUALLY DECIDES
 * ══════════════════════════════════════════════════════════════════════
 * Input tax credit is claimable only to the extent it appears in GSTR-2B —
 * the statement the government generates from what your SUPPLIERS filed.
 * An invoice sitting in your books that your supplier never uploaded is
 * not credit; it is a receivable from a supplier who has your money.
 *
 * So the number this page leads with is **ITC at risk**: tax you have paid
 * and recorded, which the government does not currently agree you may
 * claim. Every other figure on the page exists to explain that one.
 *
 * ⚠️ THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THE UI MUST NOT PRETEND
 * THEY ARE.
 *
 *   • IN BOOKS, NOT IN 2B → you claimed credit the government has no
 *     record of. Chase the supplier. This is money at risk TODAY.
 *
 *   • IN 2B, NOT IN BOOKS → a supplier reported a sale to you that you
 *     have not recorded. Either a missing bill, or someone billing you
 *     for something you never bought. Investigate, do not celebrate.
 *
 * A single "unmatched" count would hide the difference. They are separate
 * lines with separate wording.
 *
 * ⚠️ `reconciles: false` MEANS THE ENGINE'S OWN ARITHMETIC DID NOT BALANCE
 * — matched + unmatched should equal the total on each side. When it does
 * not, the identity failures are shown loudly, because every other figure
 * on the page is then suspect and quietly rendering them would be worse
 * than showing nothing.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getGstr2bReconciliations,
  getGstr2bSummary,
  getGstr2bWorklist,
} from "@/server/actions/gstr2b";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "GSTR-2B · Ordence" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/** Category → how a human should read it. Wording is load-bearing. */
const CATEGORY_LABEL: Record<string, { label: string; tone: string; meaning: string }> = {
  matched: {
    label: "Matched",
    tone: "text-emerald-600",
    meaning: "Your record and the supplier's agree. Credit is safe.",
  },
  in_books_not_in_2b: {
    label: "In books, not in 2B",
    tone: "text-red-600",
    meaning: "The supplier has not filed it. Chase them — this credit is at risk.",
  },
  in_2b_not_in_books: {
    label: "In 2B, not in books",
    tone: "text-amber-600",
    meaning: "A supplier billed you for something you have not recorded. Investigate.",
  },
  mismatched: {
    label: "Values differ",
    tone: "text-amber-600",
    meaning: "Both sides have it, the amounts disagree. Reconcile before claiming.",
  },
  ambiguous: {
    label: "Ambiguous",
    tone: "text-muted-foreground",
    meaning: "Several plausible matches. A human decides.",
  },
};

function describeCategory(category: string) {
  return (
    CATEGORY_LABEL[category] ?? {
      label: category.replace(/_/g, " "),
      tone: "text-muted-foreground",
      meaning: "",
    }
  );
}

/* ------------------------------------------------------------------ */
/* THE PICKER — every reconciliation that exists                       */
/* ------------------------------------------------------------------ */

async function ReconciliationList({
  selected,
}: {
  selected: { gstin?: string; taxPeriod?: string };
}) {
  const result = await getGstr2bReconciliations();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GSTR-2B unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const rows = result.data.rows;

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing reconciled yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Import a GSTR-2B statement for a GSTIN and tax period to begin. The
            engine parses it, matches every row against your purchase invoices,
            and scores each match.
          </p>
          <p className="text-xs">
            Credit is claimable only to the extent it appears in GSTR-2B. An
            invoice your supplier never filed is not credit — it is a debt they
            owe you.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconciliations</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">GSTIN</th>
                <th className="p-3 font-medium">Period</th>
                <th className="p-3 text-right font-medium">ITC in books</th>
                <th className="p-3 text-right font-medium">ITC in 2B</th>
                <th className="p-3 text-right font-medium">Claimed</th>
                <th className="p-3 text-right font-medium">At risk</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const isSelected =
                  selected.gstin === r.gstin && selected.taxPeriod === r.taxPeriod;
                return (
                  <tr
                    key={r.id}
                    className={isSelected ? "bg-muted/50" : "hover:bg-muted/30"}
                  >
                    <td className="p-3 font-mono text-xs">
                      {/*
                        A link, not client state. The whole view is
                        reproducible from the URL — it can be pasted into a
                        ticket and it survives a reload.
                      */}
                      <Link
                        href={`/gstr2b?gstin=${encodeURIComponent(r.gstin)}&period=${encodeURIComponent(r.taxPeriod)}`}
                        className="hover:underline"
                      >
                        {r.gstin}
                      </Link>
                    </td>
                    <td className="p-3 font-mono text-xs">{r.taxPeriod}</td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(r.booksItcEligibleMinor)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(r.twobItcAvailableMinor)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(r.itcClaimedMinor)}
                    </td>
                    <td className="p-3 text-right font-medium tabular-nums">
                      {r.itcAtRiskMinor !== "0" ? (
                        <span className="text-red-600">{inr(r.itcAtRiskMinor)}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={r.filedAt ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {r.filedAt ? "filed" : r.status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* THE DETAIL — one GSTIN, one period                                  */
/* ------------------------------------------------------------------ */

async function ReconciliationDetail({
  gstin,
  taxPeriod,
}: {
  gstin: string;
  taxPeriod: string;
}) {
  const [summaryResult, worklistResult] = await Promise.all([
    getGstr2bSummary({ gstin, taxPeriod }),
    getGstr2bWorklist({ gstin, taxPeriod }),
  ]);

  if (!summaryResult.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {gstin} · {taxPeriod}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{summaryResult.error}</p>
        </CardContent>
      </Card>
    );
  }

  const s = summaryResult.data;
  const matches = worklistResult.ok ? worklistResult.data.rows : [];

  const byCategory = new Map<string, { count: number; atRisk: bigint }>();
  for (const m of matches) {
    const current = byCategory.get(m.category) ?? { count: 0, atRisk: 0n };
    current.count += 1;
    current.atRisk += BigInt(m.itcAtRiskMinor || "0");
    byCategory.set(m.category, current);
  }

  const totalAtRisk = matches
    .reduce((acc, m) => acc + BigInt(m.itcAtRiskMinor || "0"), 0n)
    .toString();

  return (
    <div className="space-y-6">
      {/* ⚠️ Identity failure first. Everything else is suspect if this fires. */}
      {!s.reconciles && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              This reconciliation does not balance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Matched plus unmatched should equal the total on each side, and it
              does not. Treat every figure below as unreliable until this is
              resolved — do not file from it.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {s.identityFailures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={totalAtRisk !== "0" ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ITC at risk
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-red-600">
              {inr(totalAtRisk)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Recorded by you, not confirmed by the government
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ITC per books
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(s.itcAsPerBooksMinor)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ITC per GSTR-2B
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(s.itcAsPerTwoBMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Books vs 2B: {inr(s.booksVsTwoBMinor)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Claimed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(s.itcClaimedMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Claimed vs 2B: {inr(s.claimedVsTwoBMinor)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* The two directions, stated separately. See the page header. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">In your books, not in GSTR-2B</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-red-600">
              {inr(s.inBooksNotIn2BTaxMinor)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your supplier has not filed these. The credit is not claimable
              until they do — chase them. Of {inr(s.booksTaxMinor)} in books,{" "}
              {inr(s.matchedBooksTaxMinor)} is confirmed.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">In GSTR-2B, not in your books</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-amber-600">
              {inr(s.in2BNotInBooksTaxMinor)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              A supplier reported a sale to you that you have not recorded.
              Either a bill you never received, or one you never agreed to. Of{" "}
              {inr(s.twoBTaxMinor)} in 2B, {inr(s.matchedTwoBTaxMinor)} is
              matched.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Worklist</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {matches.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No matches recorded for this period.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 border-b p-4">
                {[...byCategory.entries()].map(([category, agg]) => {
                  const d = describeCategory(category);
                  return (
                    <div
                      key={category}
                      className="rounded-md border border-border px-3 py-2"
                    >
                      <p className={`text-sm font-medium ${d.tone}`}>
                        {d.label} · {agg.count}
                      </p>
                      {agg.atRisk !== 0n && (
                        <p className="text-xs text-muted-foreground">
                          {inr(agg.atRisk.toString())} at risk
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="p-3 font-medium">Supplier</th>
                      <th className="p-3 font-medium">Category</th>
                      <th className="p-3 text-right font-medium">Confidence</th>
                      <th className="p-3 text-right font-medium">Taxable Δ</th>
                      <th className="p-3 text-right font-medium">Tax Δ</th>
                      <th className="p-3 text-right font-medium">At risk</th>
                      <th className="p-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {matches.map((m) => {
                      const d = describeCategory(m.category);
                      return (
                        <tr key={m.id} className="hover:bg-muted/30">
                          <td className="p-3 font-mono text-xs">
                            {m.supplierGstin ?? "—"}
                          </td>
                          <td className="p-3">
                            <span className={`text-xs font-medium ${d.tone}`}>
                              {d.label}
                            </span>
                            {/*
                              The engine's own explanation, verbatim. It says
                              WHY this scored the way it did — an operator
                              overriding a match should see the reasoning
                              rather than just a number.
                            */}
                            <span className="block text-xs text-muted-foreground">
                              {m.explanation}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            <Badge variant="outline" className="text-[10px]">
                              {m.confidence} · {m.score}
                            </Badge>
                            {m.ambiguousCandidates > 1 && (
                              <span className="block text-xs text-amber-600">
                                {m.ambiguousCandidates} candidates
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {m.taxableDeltaMinor !== "0"
                              ? inr(m.taxableDeltaMinor)
                              : "—"}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {m.taxDeltaMinor !== "0" ? inr(m.taxDeltaMinor) : "—"}
                          </td>
                          <td className="p-3 text-right font-medium tabular-nums">
                            {m.itcAtRiskMinor !== "0" ? (
                              <span className="text-red-600">
                                {inr(m.itcAtRiskMinor)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="p-3">
                            <Badge variant="secondary" className="text-[10px]">
                              {m.action}
                            </Badge>
                            {m.actionReason && (
                              <span className="block text-xs text-muted-foreground">
                                {m.actionReason}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">How to read the categories</p>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {Object.entries(CATEGORY_LABEL).map(([key, d]) => (
            <li key={key}>
              <span className={`font-medium ${d.tone}`}>{d.label}</span> —{" "}
              {d.meaning}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-48 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function Gstr2bPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const gstin = typeof params.gstin === "string" ? params.gstin : undefined;
  const taxPeriod = typeof params.period === "string" ? params.period : undefined;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            GSTR-2B reconciliation
          </h1>
          <p className="text-sm text-muted-foreground">
            What you recorded, against what your suppliers actually filed.
          </p>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          {gstin && (
            <Link href="/gstr2b" className="hover:underline">
              All periods
            </Link>
          )}
          <Link href="/purchases" className="hover:underline">
            Purchases
          </Link>
        </div>
      </header>

      <Suspense fallback={<Skeleton />}>
        <ReconciliationList selected={{ gstin, taxPeriod }} />
      </Suspense>

      {gstin && taxPeriod ? (
        <Suspense fallback={<Skeleton />}>
          <ReconciliationDetail gstin={gstin} taxPeriod={taxPeriod} />
        </Suspense>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a GSTIN and period above to see the matching worklist.
        </p>
      )}
    </div>
  );
}
