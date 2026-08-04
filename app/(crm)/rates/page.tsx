/**
 * Ordence — ⭐ ENGINE 2 · RATE CARDS
 * Version: v0.62.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE LEADS WITH THE CARDS THAT PRICE SUCCESSFULLY AND WRONGLY
 * ══════════════════════════════════════════════════════════════════════
 * Everything that errors is already handled elsewhere. A band that
 * overlaps its neighbour, a gap between bands, two open-ended bands, a
 * banded card declaring `slab_mode = 'none'` — the database refuses all of
 * it at commit, with a sentence, and the form shows that sentence. Those
 * failures announce themselves.
 *
 * ⚠️ WHAT THIS SCREEN MUST SURFACE IS THE OPPOSITE: cards that produce a
 * number, plausibly, and the wrong one. None of these throws. None appears
 * in a log. Each shows up months later as a customer holding an invoice.
 *
 *   1. BANDS DECLARED, NONE STORED — the card says progressive or flat,
 *      there are no bands, and every quantity is priced from
 *      `base_amount_minor`. Somebody chose a reading of a tariff that does
 *      not exist. The screen says "progressive"; the billing run charges a
 *      flat amount.
 *   2. EXPIRED BUT STILL SWITCHED ON — the validity window closed and
 *      `is_active` is still true. `ordence_select_rate_card` will not pick
 *      it, so the rate silently stops applying while this list still shows
 *      it as live: somebody quotes ₹1,380 from a card the billing run has
 *      already stopped using.
 *   3. NO BANDS AND A ZERO BASE — ten thousand units, ₹0.00, no error.
 *      Usually a card somebody started and did not finish.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THE SLAB MODE IS SHOWN ON EVERY ROW, NEVER ABBREVIATED
 * ══════════════════════════════════════════════════════════════════════
 * It is the one field on a rate card that changes the answer by 27% and
 * leaves no trace on the invoice. A column that says "progressive" or
 * "flat" in words, on every line, is the cheapest possible defence against
 * the question nobody thinks to ask.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listRateCards } from "@/server/actions/rates";
import { RateActions } from "@/components/rates/rate-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Rates · Ordence" };

/**
 * Paise to rupees, grouped the Indian way, from a STRING.
 *
 * ⚠️ NEVER VIA `Number`. 92,23,37,20,36,85,47,758 paise is a legal bigint
 * and an inexact double, and the place that discovers the difference is a
 * customer's reconciliation.
 */
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

function day(value: string | null): string {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function when(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const SLAB_MODE_LABEL: Record<string, string> = {
  progressive: "Progressive",
  flat: "Flat",
  none: "No bands",
};

const BASIS_LABEL: Record<string, string> = {
  per_unit: "per unit",
  per_night: "per night",
  per_hour: "per hour",
  per_day: "per day",
  per_km: "per km",
  per_kg: "per kg",
  per_kwh: "per kWh",
  flat_fee: "flat fee",
  percentage: "percentage",
};

function slabModeTone(mode: string): string {
  if (mode === "progressive")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  if (mode === "flat")
    return "border-violet-400 text-violet-700 dark:border-violet-700 dark:text-violet-300";
  return "text-muted-foreground";
}

async function RatesBody() {
  const result = await listRateCards();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Rates unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    cards,
    slabs,
    adjustments,
    quotes,
    customers,
    bandsIgnored,
    expiredButActive,
    zeroPriced,
  } = result.data;

  const activeCards = cards.filter((c) => c.isActive);
  const bandedCards = cards.filter(
    (c) => c.slabMode === "progressive" || c.slabMode === "flat",
  );
  const progressiveCount = cards.filter((c) => c.slabMode === "progressive").length;
  const flatCount = cards.filter((c) => c.slabMode === "flat").length;

  return (
    <div className="space-y-6">
      <RateActions
        cards={cards}
        slabs={slabs}
        adjustments={adjustments}
        customers={customers}
      />

      {/* ── 1 · BANDS DECLARED, NONE STORED. Silent. ───────────────── */}
      {bandsIgnored.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {bandsIgnored.length} card{bandsIgnored.length === 1 ? "" : "s"} declare
              banded pricing and have no bands
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {bandsIgnored.slice(0, 12).map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{c.code}</span>
                  <span className="font-medium">{c.name}</span>
                  <Badge variant="outline" className={slabModeTone(c.slabMode)}>
                    {SLAB_MODE_LABEL[c.slabMode] ?? c.slabMode}
                  </Badge>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    base {inr(c.baseAmountMinor)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Somebody chose a reading — progressive or flat — for a tariff that
              has no bands to read. Every quantity is priced from the base
              amount instead, so the mode on the card is doing nothing. Nothing
              errors, the number is plausible, and the screen goes on saying
              &ldquo;progressive&rdquo; to the person quoting from it.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · EXPIRED, STILL SWITCHED ON. ────────────────────────── */}
      {expiredButActive.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {expiredButActive.length} card
              {expiredButActive.length === 1 ? " is" : "s are"} past their validity
              window and still switched on
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {expiredButActive.slice(0, 12).map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{c.code}</span>
                  <span className="font-medium">{c.name}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    ended {day(c.validTo)}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {c.scope}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The end date is EXCLUSIVE, so a card ending 1 April was already
              dead on 1 April. The selection function has stopped picking these
              — which means the rate quietly stopped applying while this list
              carried on showing them as live. Somebody quotes from a card the
              billing run is no longer using, and the two numbers meet on an
              invoice. Retire them, or extend the window.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · ZERO-PRICED. ───────────────────────────────────────── */}
      {zeroPriced.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {zeroPriced.length} card{zeroPriced.length === 1 ? "" : "s"} price
              everything at ₹0.00
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {zeroPriced.slice(0, 12).map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{c.code}</span>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    no bands, base {inr(c.baseAmountMinor)}
                  </span>
                  {c.isActive && (
                    <Badge
                      variant="outline"
                      className="border-red-400 text-[10px] text-red-700 dark:border-red-700 dark:text-red-300"
                    >
                      live
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              No bands and a zero base amount. Ten thousand units, ₹0.00, no
              error anywhere — this is almost always a card somebody started and
              did not finish, and it will keep quoting free of charge until
              somebody notices the revenue.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · The numbers. ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Rate cards
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{cards.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {activeCards.length} switched on.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Banded cards
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{bandedCards.length}</p>
            {/* ⭐ The split is worth stating out loud: it is the one field
                that changes the answer by a quarter. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {progressiveCount} progressive, {flatCount} flat.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Bands stored
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{slabs.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {adjustments.length} surcharge{adjustments.length === 1 ? "" : "s"} and
              discount{adjustments.length === 1 ? "" : "s"}.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Quotes recorded
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{quotes.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Frozen. None of them can be edited.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · The cards. ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Rate cards</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {cards.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">No rate cards yet.</p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                A rate card is a quantity, banded, times a rate, plus levies —
                the same shape whether it is an electricity tariff, a freight
                rate, a volume discount or a seasonal room rate. The one
                decision it forces is how the bands are read: &ldquo;first 100
                at ₹4.50, next 200 at ₹6.20&rdquo; costs ₹1,380 progressively
                and ₹1,550 flat, for 250 units. Both readings are in daily use,
                so the field has no default and the form will not save without
                an answer.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 font-medium">Scope</th>
                    {/* ⭐ Never abbreviated. See the file header. */}
                    <th className="px-4 py-2 font-medium">Bands read</th>
                    <th className="px-4 py-2 text-right font-medium">Bands</th>
                    <th className="px-4 py-2 text-right font-medium">Priority</th>
                    <th className="px-4 py-2 font-medium">Valid</th>
                    <th className="px-4 py-2 font-medium">For</th>
                    <th className="px-4 py-2 text-right font-medium">Base</th>
                    <th className="px-4 py-2 text-right font-medium">Tax</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {cards.map((c) => {
                    const alarmed =
                      c.bandsDeclaredButAbsent ||
                      c.expiredButActive ||
                      c.pricesEverythingAtZero;
                    return (
                      <tr
                        key={c.id}
                        className={
                          !c.isActive
                            ? "opacity-60"
                            : alarmed
                              ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                              : "hover:bg-muted/40"
                        }
                      >
                        <td className="px-4 py-2">
                          <span className="font-medium">{c.name}</span>
                          <div className="font-mono text-xs text-muted-foreground">
                            {c.code} · {BASIS_LABEL[c.basis] ?? c.basis}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className="text-[10px]">
                            {c.scope}
                          </Badge>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            rank {c.scopeRank}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={slabModeTone(c.slabMode)}>
                            {SLAB_MODE_LABEL[c.slabMode] ?? c.slabMode}
                          </Badge>
                          {c.bandsDeclaredButAbsent && (
                            <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                              no bands to read
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {c.slabCount}
                          {c.adjustmentCount > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              +{c.adjustmentCount} adj
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.priority}</td>
                        <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                          {c.validFrom || c.validTo ? (
                            <>
                              {day(c.validFrom)} → {day(c.validTo)}
                              {c.expiredButActive && (
                                <div className="text-[10px] text-red-600 dark:text-red-400">
                                  expired, still on
                                </div>
                              )}
                            </>
                          ) : (
                            "always"
                          )}
                          {c.daysOfWeek && (
                            <div className="font-mono text-[10px]">{c.daysOfWeek}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {c.customerName ?? c.channel ?? c.appliesToKind ?? "anyone"}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(c.baseAmountMinor)}
                          {c.pricesEverythingAtZero && (
                            <div className="text-[10px] text-red-600 dark:text-red-400">
                              prices at zero
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">
                          {c.taxRateBps > 0
                            ? `${(c.taxRateBps / 100).toFixed(2)}%`
                            : "—"}
                          {c.taxRateBps > 0 && c.isTaxInclusive && (
                            <div className="text-[10px] text-muted-foreground">
                              inclusive
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

      {/* ── 6 · The bands themselves, per card. ────────────────────── */}
      {slabs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bands</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {cards
              .filter((c) => c.slabCount > 0)
              .map((c) => {
                const own = slabs
                  .filter((s) => s.rateCardId === c.id)
                  .sort((a, b) => a.sequence - b.sequence);
                return (
                  <div key={c.id} className="space-y-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs">{c.code}</span>
                      <span className="text-sm font-medium">{c.name}</span>
                      <Badge variant="outline" className={slabModeTone(c.slabMode)}>
                        {SLAB_MODE_LABEL[c.slabMode] ?? c.slabMode}
                      </Badge>
                    </div>
                    <ul className="divide-y rounded-md border text-sm">
                      {own.map((s, i) => {
                        const lower = i === 0 ? "0" : own[i - 1]?.upToQuantity ?? "0";
                        return (
                          <li
                            key={s.id}
                            className="flex flex-wrap items-baseline gap-3 px-3 py-1.5"
                          >
                            <span className="w-6 shrink-0 tabular-nums text-xs text-muted-foreground">
                              {s.sequence}
                            </span>
                            {/* ⚠️ The lower bound is DERIVED from the previous
                                band's upper bound, never stored. Two stored
                                boundaries can drift apart and leave a gap that
                                prices its contents at zero. */}
                            <span className="tabular-nums">
                              ({lower} – {s.upToQuantity ?? "∞"}]
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {inr(s.unitAmountMinor)} {BASIS_LABEL[c.basis] ?? c.basis}
                            </span>
                            {s.fixedAmountMinor !== "0" && (
                              <span className="tabular-nums text-xs text-muted-foreground">
                                + {inr(s.fixedAmountMinor)} fixed
                              </span>
                            )}
                            {s.label && (
                              <span className="ml-auto text-xs text-muted-foreground">
                                {s.label}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      )}

      {/* ── 7 · Adjustments, in order. ─────────────────────────────── */}
      {adjustments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Surcharges and discounts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {adjustments.map((a) => {
                const card = cards.find((c) => c.id === a.rateCardId);
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                  >
                    <span className="w-6 shrink-0 tabular-nums text-xs text-muted-foreground">
                      {a.sequence}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {card?.code ?? "—"}
                    </span>
                    <span className="font-medium">{a.label}</span>
                    <span
                      className={
                        a.percentageBps < 0
                          ? "tabular-nums text-emerald-700 dark:text-emerald-300"
                          : "tabular-nums"
                      }
                    >
                      {a.percentageBps !== 0
                        ? `${a.percentageBps > 0 ? "+" : ""}${(a.percentageBps / 100).toFixed(2)}%`
                        : "—"}
                    </span>
                    {a.fixedAmountMinor !== "0" && (
                      <span className="tabular-nums text-xs">
                        {inr(a.fixedAmountMinor)}
                      </span>
                    )}
                    {a.isStatutory && (
                      <Badge variant="outline" className="text-[10px]">
                        statutory
                      </Badge>
                    )}
                    {!a.isVisible && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        hidden on invoice
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── 8 · Quote history. The point of the engine. ────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quotes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {quotes.length === 0 ? (
            <div className="space-y-3 px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">Nothing quoted yet.</p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                &ldquo;What did you quote us on 14 March?&rdquo; is the question
                this table exists to answer, and recomputing cannot answer it —
                the card has been edited since, so recomputation returns
                today&rsquo;s number with total confidence and no relationship
                to the conversation that happened.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 font-medium">For</th>
                    <th className="px-4 py-2 text-right font-medium">Quantity</th>
                    <th className="px-4 py-2 text-right font-medium">Subtotal</th>
                    <th className="px-4 py-2 text-right font-medium">Adjustments</th>
                    <th className="px-4 py-2 text-right font-medium">Tax</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {quotes.map((q) => (
                    <tr key={q.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {when(q.quotedAt)}
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-xs">{q.cardCode}</span>
                        {/* ⭐ WHY this card won, frozen with the number. A
                            quote that records ₹1,380 and not why is half an
                            answer six months later. */}
                        {q.selectionReason && (
                          <div className="text-[10px] text-muted-foreground">
                            {q.selectionReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">{q.quotedFor ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{q.quantity}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs">
                        {inr(q.subtotalMinor)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs">
                        {inr(q.adjustmentsMinor)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs">
                        {inr(q.taxMinor)}
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {inr(q.totalMinor)}
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
        Bands cannot overlap or leave a gap — one exclusive upper bound per
        band makes an overlap unrepresentable, and a deferred constraint
        trigger refuses a set that is out of order, doubly open-ended, or
        numbered with a hole in it. Money is whole paise and rates are integer
        basis points throughout; rounding happens once, at the end, half-up —
        the same rule Tally uses, so a reconciliation against a customer&rsquo;s
        own books does not drift by a rupee a line. Quotes are append-only at
        the privilege level as well as by trigger: the application role has no
        UPDATE on that table at all.
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

export default function RatesPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Rates</h1>
          <p className="text-sm text-muted-foreground">
            What a thing costs, why that card won, and what was quoted on the day.
          </p>
        </div>
        <Link
          href="/scheduling"
          className="text-sm text-muted-foreground hover:underline"
        >
          Scheduling
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <RatesBody />
      </Suspense>
    </div>
  );
}
