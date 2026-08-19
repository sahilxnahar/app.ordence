/**
 * Ordence — ⭐⭐⭐ MULTI-CURRENCY CONSOLE
 * Version: v1.65.0-alpha · Batch 0101
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ENGINE EXISTED AND NOTHING CALLED IT
 * ══════════════════════════════════════════════════════════════════════
 * Batch 0101 built rates, conversion, AS 11 / Ind AS 21 restatement and
 * revaluation, guarded every action, tested the arithmetic — and no
 * screen in `app/` reached any of it. `recordFxRate`, `runFxRevaluation`,
 * `getFxExposure`, `previewConversion`, `checkCurrencyUnits` and
 * `validateRateText` were reachable by RPC and invoked by nothing. This
 * route is the door.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO RULES THIS SCREEN OBEYS EVERYWHERE
 * ══════════════════════════════════════════════════════════════════════
 * ① EVERY FIGURE CARRIES ITS CURRENCY. There is no total on this page
 *    without a code beside it, because the sum of two currencies is not a
 *    number, it is two numbers. Where the currency was ASSUMED rather
 *    than chosen — a workspace that never set one — the screen says so.
 *
 * ② NOTHING HERE DIVIDES BY A HUNDRED. Every amount arrives already
 *    formatted by `formatMinorPlain`, which reads the exponent per
 *    currency: zero for the yen, three for the Gulf dinars, four for the
 *    Chilean UF. A component that formatted money itself would print
 *    ¥1,234 as ¥12.34 and KWD 1.234 as KWD 12.34.
 *
 * ⚠️ THIS IS A SERVER COMPONENT AND CALLS NO HOOK. The interactive parts
 * are separate `"use client"` modules under `components/fx/`. See
 * `npm run check:client-hooks` for the outage that rule was written after.
 */

import { Suspense } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { checkPermission } from "@/server/audit";
import {
  getFxExposure,
  listCurrencies,
  listFxRates,
  listFxRevaluations,
  type FxRateRow,
} from "@/server/actions/fx";
import {
  formatRateScaled,
  invertQuote,
  isStorableFxRateSource,
  makeQuote,
  parseRateToScaled,
} from "@/lib/fx/rates";
import { ConversionPreviewPanel } from "@/components/fx/conversion-preview";
import { RecordRateForm } from "@/components/fx/record-rate-form";
import { RevaluationRunner } from "@/components/fx/revaluation-runner";
import { labelled, trimRate } from "@/components/fx/fx-format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Currency & FX · Ordence" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * ⭐⭐ THE REVERSE DIRECTION, COMPUTED HERE AND LABELLED AS COMPUTED.
 *
 * 🔴 A STORED RATE IS ONE DIRECTION ONLY. USD/INR 83.2150 is what the
 * bank published; INR/USD is its reciprocal, which nobody published. The
 * engine's `invertQuote` marks its result `derived: true` precisely so
 * this distinction survives to a screen, and this is that screen.
 *
 * ⚠️ THE ARITHMETIC IS THE ENGINE'S, NOT THIS FILE'S. `invertQuote`
 * rounds half-up at twelve decimal places on a `bigint`; a division
 * written here in a float would disagree with the books.
 */
function inverseOf(row: FxRateRow): string | null {
  try {
    const quote = makeQuote({
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rateScaled: parseRateToScaled(row.rate),
      rateDate: row.rateDate,
      source: isStorableFxRateSource(row.source) ? row.source : "manual",
      sourceReference: row.sourceReference,
    });
    return formatRateScaled(invertQuote(quote).rateScaled);
  } catch {
    // A row this system cannot describe is left undescribed rather than
    // guessed at. The published direction is still shown.
    return null;
  }
}

async function FxBody({
  asOfDate,
  from,
  to,
}: {
  asOfDate: string;
  from: string;
  to: string;
}) {
  const [rates, revaluations, exposure, currencies, manage, revalue] = await Promise.all([
    listFxRates({ from, to }),
    listFxRevaluations(),
    getFxExposure({ asOfDate }),
    listCurrencies(),
    checkPermission("fx:manage_rates"),
    checkPermission("fx:revalue"),
  ]);

  /**
   * ⭐ A DENIAL IS A VISIBLE STATE, NOT AN EMPTY TABLE. Every read on
   * this page needs `fx:read`; when it is absent the actions all refuse
   * with the same sentence, and showing four empty panels would tell the
   * customer their workspace has no rates rather than that they may not
   * see them.
   */
  if (!rates.ok && !revaluations.ok && !exposure.ok) {
    return (
      <Card className="border-amber-300 dark:border-amber-800">
        <CardHeader>
          <CardTitle className="text-sm">You cannot see exchange rates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p data-testid="fx-read-denied">{rates.error}</p>
          <p className="text-xs">
            Reading rates needs <span className="font-mono">fx:read</span>. Entering them
            needs <span className="font-mono">fx:manage_rates</span> and running a
            restatement needs <span className="font-mono">fx:revalue</span>, both of which
            are dangerous permissions held separately.
          </p>
        </CardContent>
      </Card>
    );
  }

  const currencyOptions = currencies.ok ? currencies.data : [];
  const functionalCurrency = exposure.ok ? exposure.data.functionalCurrency : "INR";
  const functionalIsAssumed = exposure.ok ? exposure.data.functionalCurrencyIsDefault : true;

  return (
    <div className="space-y-6">
      {/* ── EXPOSURE ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Open receivables by currency · as at {asOfDate}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!exposure.ok ? (
            <p className="text-sm text-destructive">{exposure.error}</p>
          ) : (
            <>
              {/*
                🔴 THE SUBTOTALS COME FIRST AND THE SINGLE FIGURE SECOND.
                A caller cannot get the one number without the working,
                and when a rate is missing the answer degrades from one
                number to several rather than from correct to wrong.
              */}
              {exposure.data.byCurrency.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing outstanding at this date.
                </p>
              ) : (
                <div className="overflow-x-auto rounded border">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="p-3 font-medium">Currency</th>
                        <th className="p-3 text-right font-medium">Outstanding</th>
                        <th className="p-3 text-right font-medium">Invoices</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {exposure.data.byCurrency.map((b) => (
                        <tr key={b.currency} className="hover:bg-muted/30">
                          <td className="p-3 font-mono text-xs">{b.currency}</td>
                          <td className="p-3 text-right tabular-nums">{b.formatted}</td>
                          <td className="p-3 text-right tabular-nums text-muted-foreground">
                            {b.count}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="rounded border p-3">
                <p className="text-xs text-muted-foreground">
                  Total in the books&apos; own currency
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {exposure.data.convertedTotalFormatted ?? "Not a single number"}
                </p>
                {/* ⭐ THE SENTENCE THAT MUST APPEAR NEXT TO THE FIGURE. */}
                <p className="mt-1 text-xs text-muted-foreground">{exposure.data.basis}</p>
                {exposure.data.unconvertible.length > 0 && (
                  <p className="mt-1 text-xs text-destructive">
                    No rate on file for {exposure.data.unconvertible.join(", ")} at {asOfDate}.
                    Those amounts are shown above in their own currency rather than folded in
                    at a guessed rate.
                  </p>
                )}
                {exposure.data.functionalCurrencyIsDefault && (
                  <p className="mt-1 text-xs text-amber-600" data-testid="fx-assumed-currency">
                    The functional currency was ASSUMED to be{" "}
                    {exposure.data.functionalCurrency} — nobody has set one for this
                    workspace. Set it in Settings · Financial.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── RATES ────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RecordRateForm
          currencies={currencyOptions}
          functionalCurrency={functionalCurrency}
          canManage={manage.allowed}
        />
        <ConversionPreviewPanel
          currencies={currencyOptions}
          functionalCurrency={functionalCurrency}
          defaultDate={asOfDate}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Rates on file · {from} to {to}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!rates.ok ? (
            <p className="p-6 text-sm text-destructive">{rates.error}</p>
          ) : rates.data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No rate is on file for this window. Every conversion in this window will report
              a missing rate rather than assume one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Pair</th>
                    <th className="p-3 font-medium">Rate date</th>
                    <th className="p-3 text-right font-medium">As published</th>
                    <th className="p-3 text-right font-medium">Reverse direction</th>
                    <th className="p-3 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rates.data.map((r) => {
                    const inverse = inverseOf(r);
                    return (
                      <tr key={r.id} className="hover:bg-muted/30">
                        <td className="p-3 font-mono text-xs">
                          {r.baseCurrency}/{r.quoteCurrency}
                        </td>
                        <td className="p-3 text-xs">
                          {r.rateDate}
                          {r.backfilled && (
                            <span className="block text-xs text-amber-600">
                              loaded {r.publishedAt?.slice(0, 10)} — after the day it is for
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums">
                          {trimRate(r.rate)}
                        </td>
                        <td className="p-3 text-right">
                          {/*
                            🔴 THE DERIVED RATE, SHOWN AND LABELLED. This
                            number is a reciprocal this system computed;
                            nobody published it. An auditor being handed a
                            figure needs to know which of the two it is.
                          */}
                          {inverse === null ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <>
                              <span className="font-mono text-xs tabular-nums">
                                {r.quoteCurrency}/{r.baseCurrency} {trimRate(inverse)}
                              </span>
                              <Badge variant="outline" className="ml-2 text-[10px]">
                                derived by inversion
                              </Badge>
                            </>
                          )}
                        </td>
                        <td className="p-3 text-xs">
                          <Badge
                            variant={r.isPublished ? "secondary" : "outline"}
                            className="text-[10px]"
                          >
                            {r.source}
                          </Badge>
                          <span className="block text-muted-foreground">
                            {r.isPublished
                              ? "published — the same fact for every workspace"
                              : "this workspace's own"}
                          </span>
                          {r.sourceReference && (
                            <span className="block text-muted-foreground">
                              {r.sourceReference}
                            </span>
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

      {/* ── REVALUATION ──────────────────────────────────────────── */}
      <RevaluationRunner
        canRevalue={revalue.allowed}
        functionalCurrency={functionalCurrency}
        functionalCurrencyIsAssumed={functionalIsAssumed}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Revaluations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!revaluations.ok ? (
            <p className="p-6 text-sm text-destructive">{revaluations.error}</p>
          ) : revaluations.data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No restatement has been run. Until one is, foreign-currency balances stay at the
              rate they were first recognised at.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Reporting date</th>
                    <th className="p-3 text-right font-medium">Gain</th>
                    <th className="p-3 text-right font-medium">Loss</th>
                    <th className="p-3 text-right font-medium">Net</th>
                    <th className="p-3 text-right font-medium">Restated</th>
                    <th className="p-3 text-right font-medium">Not restated</th>
                    <th className="p-3 font-medium">In the ledger</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {revaluations.data.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="p-3">
                        <Link href={`/fx/${r.id}`} className="underline">
                          {r.asOfDate}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          books in {r.functionalCurrency} · {r.status}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {labelled(r.gain, r.functionalCurrency)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {labelled(r.loss, r.functionalCurrency)}
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {labelled(r.net, r.functionalCurrency)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{r.restatedCount}</td>
                      <td className="p-3 text-right tabular-nums">{r.skippedCount}</td>
                      <td className="p-3 text-xs">
                        <Badge
                          variant={r.posted ? "secondary" : "outline"}
                          className="text-[10px]"
                        >
                          {r.posted ? "posted" : "not posted"}
                        </Badge>
                        {r.unpostedReason && (
                          <span className="block text-muted-foreground">
                            {r.unpostedReason}
                          </span>
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
    </div>
  );
}

function FxSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-48 animate-pulse rounded-lg border bg-muted/40" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
      </div>
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function FxPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  // ⚠️ A DATE FROM THE QUERY STRING IS ACCEPTED ONLY IN THE ONE SHAPE
  // the actions parse. Anything else falls back rather than being passed
  // through to a validator that would refuse the whole page.
  const asOfDate = params.asOf && iso.test(params.asOf) ? params.asOf : today();
  const to = params.to && iso.test(params.to) ? params.to : asOfDate;
  const from = params.from && iso.test(params.from) ? params.from : daysBefore(to, 90);

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Currency &amp; FX</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Exchange rates, what they convert to, and the reporting-date restatement of
            foreign-currency balances under AS 11 / Ind AS 21. A rate is a direction, a date
            and a source — never a bare number.
          </p>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/accounting" className="hover:underline">
            Ledger
          </Link>
          <Link href="/settings/financial" className="hover:underline">
            Financial settings
          </Link>
        </div>
      </header>

      <Suspense fallback={<FxSkeleton />}>
        <FxBody asOfDate={asOfDate} from={from} to={to} />
      </Suspense>
    </div>
  );
}
