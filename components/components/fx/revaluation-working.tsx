/**
 * Ordence — ⭐⭐⭐ THE WORKING OF A REVALUATION, INCLUDING WHAT IT SKIPPED
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SKIPPED LINES ARE THE POINT OF THIS TABLE
 * ══════════════════════════════════════════════════════════════════════
 * AS 11 ¶11(a) restates MONETARY items at the closing rate. ¶11(b) leaves
 * NON-MONETARY items carried at historical cost — advances against
 * machinery, prepayments, fixed assets — and getting that the wrong way
 * round is the classic error in this area, because both directions
 * balance and only one is right.
 *
 * `fx_revaluation_lines` records the non-monetary items with
 * `restated = false` and a reason IN WORDS, rather than omitting them. A
 * run that silently ignores rows is indistinguishable from a run whose
 * query has a missing join, so this component renders the skips as
 * prominently as the restatements and prints the reason next to each one.
 *
 * ⚠️ NO HOOKS AND NO `"use client"`. It is rendered by a server page and
 * by a client component, so it must be safe in both — see
 * `npm run check:client-hooks` for what happens when that line is crossed.
 *
 * 🔴 EVERY FIGURE CARRIES ITS CURRENCY. The foreign column is in the
 * document's own currency and the three functional columns are in the
 * books' currency, and they are not the same currency, so neither is
 * printed bare.
 */

import { Badge } from "@/components/ui/badge";
import type { RevaluationLineRow } from "@/server/actions/fx";
import { labelled, trimRate } from "./fx-format";

export function RevaluationWorking({
  functionalCurrency,
  lines,
}: {
  functionalCurrency: string;
  lines: readonly RevaluationLineRow[];
}) {
  const restated = lines.filter((l) => l.restated);
  const skipped = lines.filter((l) => !l.restated);

  if (lines.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This run considered nothing. Every open item is already in {functionalCurrency}, so
        there is no currency risk to restate.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="px-1 pb-2 text-sm font-semibold">
          Restated at the closing rate · {restated.length}
        </h3>
        {restated.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            Nothing was restated. Either no monetary item is in a foreign currency, or no
            closing rate was on file — the rows below say which.
          </p>
        ) : (
          <LineTable
            lines={restated}
            functionalCurrency={functionalCurrency}
            showSkipReason={false}
          />
        )}
      </section>

      {/*
        🔴 SHOWN EVEN WHEN EMPTY IS WRONG, BUT HIDDEN WHEN NON-EMPTY IS
        WORSE. A run with skips must never look like a run without them.
      */}
      {skipped.length > 0 && (
        <section data-testid="fx-skipped-lines">
          <h3 className="px-1 pb-1 text-sm font-semibold">
            Not restated · {skipped.length}
          </h3>
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            A non-monetary item stays at the rate it was first recognised at — AS 11 ¶11(b).
            It is listed here with its reason rather than left out, because a row that is
            absent and a row that was skipped on purpose look identical from the outside.
          </p>
          <LineTable
            lines={skipped}
            functionalCurrency={functionalCurrency}
            showSkipReason
          />
        </section>
      )}
    </div>
  );
}

function LineTable({
  lines,
  functionalCurrency,
  showSkipReason,
}: {
  lines: readonly RevaluationLineRow[];
  functionalCurrency: string;
  showSkipReason: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">Item</th>
            <th className="p-3 font-medium">Monetary</th>
            <th className="p-3 text-right font-medium">Foreign amount</th>
            <th className="p-3 text-right font-medium">Carried at ({functionalCurrency})</th>
            <th className="p-3 text-right font-medium">Restated to ({functionalCurrency})</th>
            <th className="p-3 text-right font-medium">P&amp;L effect ({functionalCurrency})</th>
            <th className="p-3 font-medium">Closing rate</th>
            {showSkipReason && <th className="p-3 font-medium">Why it was not restated</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((l, i) => (
            <tr key={`${l.sourceReference ?? l.itemKind}-${i}`} className="hover:bg-muted/30">
              <td className="p-3">
                <span className="font-medium">{l.sourceReference ?? "—"}</span>
                <span className="block text-xs text-muted-foreground">{l.itemKind}</span>
              </td>
              <td className="p-3">
                {/*
                  ⚠️ `isMonetaryItem` IS DERIVED FROM THE KIND BY
                  `isMonetary()`, never chosen by a person. It is shown so
                  the reader can check the classification, which is the
                  half of AS 11 that is easy to get backwards.
                */}
                <Badge variant={l.isMonetaryItem ? "secondary" : "outline"} className="text-[10px]">
                  {l.isMonetaryItem ? "monetary" : "non-monetary"}
                </Badge>
              </td>
              <td className="p-3 text-right tabular-nums">
                {labelled(l.foreignAmount, l.foreignCurrency)}
              </td>
              <td className="p-3 text-right tabular-nums">
                {labelled(l.carrying, functionalCurrency)}
              </td>
              <td className="p-3 text-right tabular-nums">
                {labelled(l.restatedTo, functionalCurrency)}
              </td>
              <td className="p-3 text-right font-medium tabular-nums">
                {labelled(l.plEffect, functionalCurrency)}
              </td>
              <td className="p-3 text-xs">
                {l.rate === null ? (
                  <span className="text-muted-foreground">no rate used</span>
                ) : (
                  <>
                    <span className="font-mono">{trimRate(l.rate)}</span>
                    <span className="block text-muted-foreground">
                      {l.rateDate ?? "—"} · {l.rateSource ?? "—"}
                    </span>
                    {/*
                      🔴 A DERIVED RATE IS SAID TO BE DERIVED, HERE, ON
                      THE ROW. The pair was published the other way round
                      and this figure is its reciprocal — computed by us,
                      not published by anybody. A customer evidencing the
                      restatement to an auditor needs that distinction.
                    */}
                    {l.rateDerived && (
                      <Badge variant="outline" className="mt-1 text-[10px]">
                        derived by inversion
                      </Badge>
                    )}
                  </>
                )}
              </td>
              {showSkipReason && (
                <td className="p-3 text-xs text-muted-foreground">
                  {l.skipReason ?? "No reason was recorded, which is itself a defect."}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
