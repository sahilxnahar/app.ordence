"use client";

/**
 * Ordence — ⭐ ENGINE 2 · RATE CARD WRITE ACTIONS & QUOTE CALCULATOR
 * Version: v0.62.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SLAB-MODE FIELD IS THE REASON THIS COMPONENT EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Every other field here could be a plain form. This one cannot, because
 * the choice it captures is worth 27% of a bill and is invisible on the
 * invoice afterwards.
 *
 * "First 100 units at ₹4.50, next 200 at ₹6.20" has two readings. For 250
 * units, PROGRESSIVE charges each band for the part of the quantity inside
 * it — 100 × 450 + 150 × 620 = ₹1,380. FLAT charges the whole quantity at
 * the rate of the band it landed in — 250 × 620 = ₹1,550. Both are in
 * daily commercial use: Indian electricity tariffs and income tax are
 * progressive, most freight rates and volume discounts are flat.
 *
 * ⚠️ SO THERE IS NO PRE-SELECTED OPTION. The select opens on "Choose…"
 * and the form will not submit without an answer. A default would be
 * right for half the workspaces on this platform and would quietly
 * misprice the other half, with nothing anywhere to say which reading was
 * taken — the error surfaces months later as a customer holding an
 * invoice that disagrees with their own spreadsheet.
 *
 * ⭐ AND BOTH NUMBERS ARE SHOWN THE MOMENT THE CHOICE IS MADE, side by
 * side, computed from this card's own bands. A dropdown with two words in
 * it asks somebody to recall a definition. Two rupee figures with a gap
 * between them asks them to recognise their own business.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PREVIEW IS TYPESCRIPT. THE INVOICE IS SQL.
 * ══════════════════════════════════════════════════════════════════════
 * `priceProgressive`, `priceFlat` and `applyBps` are imported from
 * db/schema/pricing.ts and run in the browser, because a server round trip
 * per keystroke makes a calculator that nobody uses. `ordence_quote_rate`
 * in SQL-FILES/0034 is the authority — it prices the batch run and
 * everything that reaches an invoice, and "Record this quote" stores ITS
 * figures, never these.
 *
 * ⚠️ Two implementations of one formula is a genuine hazard, so
 * tests/ui/pricing-engine.test.tsx runs both over a shared table of cases
 * and asserts identical paise. When they disagree, the SQL is right.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS COMPONENT DOES NOT CHECK BAND CONTIGUITY
 * ══════════════════════════════════════════════════════════════════════
 * Gaps, overlaps, two open-ended bands, an open-ended band that is not
 * last — all of it is refused by a deferred constraint trigger in the
 * database, whose messages are already sentences. Re-checking here would
 * produce a second, subtly different opinion that drifts from the first;
 * the refusal is surfaced verbatim instead.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveRateCard,
  saveRateSlabs,
  saveRateAdjustments,
  recordRateQuote,
  setRateCardActive,
  deleteRateCard,
  type RateCardRow,
  type RateSlabRow,
  type RateAdjustmentRow,
  type RateCustomerOption,
} from "@/server/actions/rates";
import {
  priceProgressive,
  priceFlat,
  applyBps,
  divideRoundHalfUp,
  type Slab,
} from "@/db/schema/pricing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const SCOPES = [
  "list",
  "seasonal",
  "channel",
  "segment",
  "contracted",
  "promotional",
] as const;

const BASES = [
  "per_unit",
  "per_night",
  "per_hour",
  "per_day",
  "per_km",
  "per_kg",
  "per_kwh",
  "flat_fee",
  "percentage",
] as const;

/* ------------------------------------------------------------------ */
/* MONEY FORMATTING — Indian grouping, from paise, never from a float  */
/* ------------------------------------------------------------------ */

function inr(minorUnits: string | bigint | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
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

function toBigInt(v: string | null | undefined): bigint {
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * ⭐ The illustration used when a card has no bands yet.
 *
 * ⚠️ IT IS THE EXAMPLE FROM THE SCHEMA HEADER AND THE SQL, DELIBERATELY.
 * ≤100 @ ₹4.50, ≤300 @ ₹6.20, ∞ @ ₹8.00. Somebody creating their first
 * card has nothing of their own to compare, and an abstract explanation of
 * "progressive" is exactly the thing that gets skimmed.
 */
const ILLUSTRATION: Slab[] = [
  { sequence: 1, upToQuantity: 100n, unitAmountMinor: 450n, fixedAmountMinor: 0n },
  { sequence: 2, upToQuantity: 300n, unitAmountMinor: 620n, fixedAmountMinor: 0n },
  { sequence: 3, upToQuantity: null, unitAmountMinor: 800n, fixedAmountMinor: 0n },
];
const ILLUSTRATION_QTY = 250n;

function asSlabs(rows: readonly RateSlabRow[]): Slab[] {
  return rows.map((r) => ({
    sequence: r.sequence,
    upToQuantity: r.upToQuantity === null ? null : toBigInt(r.upToQuantity),
    unitAmountMinor: toBigInt(r.unitAmountMinor),
    fixedAmountMinor: toBigInt(r.fixedAmountMinor),
  }));
}

/**
 * The whole quote, in the browser: bands, then adjustments in sequence
 * against the RUNNING subtotal, then tax.
 *
 * ⚠️ ADJUSTMENTS COMPOUND. A 10% discount followed by a 5% surcharge is
 * not 95% of the base, and folding them into one percentage — which is
 * the tempting simplification — produces a number that is right on one
 * card and wrong on every card with two adjustments.
 *
 * ⚠️ INCLUSIVE TAX IS EXTRACTED, NOT ADDED, AND IT IS NOT 18% OF THE
 * GROSS. On ₹118 at 18% the tax is ₹18 — that is 118 × 1800 / 11800.
 * Taking 18% of 118 gives ₹21.24 and overstates the levy on every
 * inclusive-priced line.
 *
 * Mirrors `ordence_quote_rate`. The SQL is the authority; see the header.
 */
function quoteInBrowser(args: {
  quantity: bigint;
  slabs: Slab[];
  slabMode: string;
  baseAmountMinor: bigint;
  adjustments: readonly RateAdjustmentRow[];
  taxRateBps: number;
  isTaxInclusive: boolean;
}): {
  subtotal: bigint;
  adjustmentsTotal: bigint;
  tax: bigint;
  total: bigint;
  lines: Array<{ label: string; amount: bigint; note?: string }>;
} {
  const { quantity, slabs, slabMode, baseAmountMinor } = args;

  // ⚠️ No bands at all means the base amount IS the answer — for every
  // quantity. That is the third alarm on the page: a card with no bands
  // and a zero base prices ten thousand units at ₹0.00 without erroring.
  const subtotal =
    slabs.length === 0
      ? baseAmountMinor
      : slabMode === "progressive"
        ? priceProgressive(quantity, slabs)
        : slabMode === "flat"
          ? priceFlat(quantity, slabs)
          : baseAmountMinor;

  let running = subtotal;
  let adjustmentsTotal = 0n;
  const lines: Array<{ label: string; amount: bigint; note?: string }> = [];

  for (const adj of [...args.adjustments].sort((a, b) => a.sequence - b.sequence)) {
    const delta = applyBps(running, adj.percentageBps) + toBigInt(adj.fixedAmountMinor);
    running += delta;
    adjustmentsTotal += delta;
    lines.push({
      label: `${adj.sequence}. ${adj.label}`,
      amount: delta,
      note: adj.isStatutory ? "statutory" : adj.isVisible ? undefined : "hidden on invoice",
    });
  }

  let tax = 0n;
  if (args.taxRateBps > 0) {
    if (args.isTaxInclusive) {
      tax = divideRoundHalfUp(
        running * BigInt(args.taxRateBps),
        BigInt(10_000 + args.taxRateBps),
      );
      // The total does not move — the tax was already inside the price.
    } else {
      tax = applyBps(running, args.taxRateBps);
      running += tax;
    }
  }

  return { subtotal, adjustmentsTotal, tax, total: running, lines };
}

/* ------------------------------------------------------------------ */

type Panel = "none" | "card" | "slabs" | "adjustments" | "quote";

type SlabDraft = {
  upToQuantity: string;
  unitAmountMinor: string;
  fixedAmountMinor: string;
  label: string;
};

type AdjustmentDraft = {
  label: string;
  percentageBps: string;
  fixedAmountMinor: string;
  isVisible: boolean;
  isStatutory: boolean;
};

export function RateActions({
  cards,
  slabs,
  adjustments,
  customers,
}: {
  cards: RateCardRow[];
  slabs: RateSlabRow[];
  adjustments: RateAdjustmentRow[];
  customers: RateCustomerOption[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** ⭐ Deliberately "" — there is no defensible default. See the header. */
  const [slabMode, setSlabMode] = useState<string>("");
  const [editingCardId, setEditingCardId] = useState<string>(cards[0]?.id ?? "");

  const [slabDrafts, setSlabDrafts] = useState<SlabDraft[]>([]);
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<AdjustmentDraft[]>([]);

  const [quoteCardId, setQuoteCardId] = useState<string>(cards[0]?.id ?? "");
  const [quoteQty, setQuoteQty] = useState<string>("250");
  const [quotedFor, setQuotedFor] = useState<string>("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        /**
         * ⚠️ SHOWN VERBATIM. The database's refusals here name the card and
         * the band — "slab 3 ends at 200 but the slab before it already
         * ended at 300". Replacing that with "Could not save" throws away
         * the only part that tells somebody which row to fix.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      router.refresh();
    });
  }

  /* --- The side-by-side consequence of the slab-mode choice. -------- */
  const editingCard = cards.find((c) => c.id === editingCardId) ?? null;
  const editingSlabs = useMemo(
    () => asSlabs(slabs.filter((s) => s.rateCardId === editingCardId)),
    [slabs, editingCardId],
  );

  const modeComparison = useMemo(() => {
    const usingOwn = editingSlabs.length > 0;
    const bands = usingOwn ? editingSlabs : ILLUSTRATION;
    const qty = usingOwn ? toBigInt(quoteQty) || ILLUSTRATION_QTY : ILLUSTRATION_QTY;
    return {
      usingOwn,
      quantity: qty,
      progressive: priceProgressive(qty, bands),
      flat: priceFlat(qty, bands),
    };
  }, [editingSlabs, quoteQty]);

  const gap = modeComparison.flat - modeComparison.progressive;
  const gapPercent =
    modeComparison.progressive === 0n
      ? null
      : Number((gap * 1000n) / modeComparison.progressive) / 10;

  /* --- The live quote preview. ------------------------------------- */
  const quoteCard = cards.find((c) => c.id === quoteCardId) ?? null;
  const preview = useMemo(() => {
    if (!quoteCard) return null;
    return quoteInBrowser({
      quantity: toBigInt(quoteQty),
      slabs: asSlabs(slabs.filter((s) => s.rateCardId === quoteCard.id)),
      slabMode: quoteCard.slabMode,
      baseAmountMinor: toBigInt(quoteCard.baseAmountMinor),
      adjustments: adjustments.filter((a) => a.rateCardId === quoteCard.id),
      taxRateBps: quoteCard.taxRateBps,
      isTaxInclusive: quoteCard.isTaxInclusive,
    });
  }, [quoteCard, quoteQty, slabs, adjustments]);

  function loadSlabDrafts(cardId: string) {
    setEditingCardId(cardId);
    setSlabDrafts(
      slabs
        .filter((s) => s.rateCardId === cardId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          upToQuantity: s.upToQuantity ?? "",
          unitAmountMinor: s.unitAmountMinor,
          fixedAmountMinor: s.fixedAmountMinor,
          label: s.label ?? "",
        })),
    );
  }

  function loadAdjustmentDrafts(cardId: string) {
    setEditingCardId(cardId);
    setAdjustmentDrafts(
      adjustments
        .filter((a) => a.rateCardId === cardId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((a) => ({
          label: a.label,
          percentageBps: String(a.percentageBps),
          fixedAmountMinor: a.fixedAmountMinor,
          isVisible: a.isVisible,
          isStatutory: a.isStatutory,
        })),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "card" ? "default" : "outline"}
          onClick={() => {
            setSlabMode("");
            setPanel(panel === "card" ? "none" : "card");
          }}
        >
          New rate card
        </Button>
        <Button
          size="sm"
          variant={panel === "slabs" ? "default" : "outline"}
          disabled={cards.length === 0}
          onClick={() => {
            if (panel !== "slabs") loadSlabDrafts(editingCardId || cards[0]?.id || "");
            setPanel(panel === "slabs" ? "none" : "slabs");
          }}
        >
          Edit bands
        </Button>
        <Button
          size="sm"
          variant={panel === "adjustments" ? "default" : "outline"}
          disabled={cards.length === 0}
          onClick={() => {
            if (panel !== "adjustments")
              loadAdjustmentDrafts(editingCardId || cards[0]?.id || "");
            setPanel(panel === "adjustments" ? "none" : "adjustments");
          }}
        >
          Surcharges &amp; discounts
        </Button>
        <Button
          size="sm"
          variant={panel === "quote" ? "default" : "outline"}
          disabled={cards.length === 0}
          onClick={() => setPanel(panel === "quote" ? "none" : "quote")}
        >
          Quote calculator
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {/* ══ NEW / EDIT CARD ═════════════════════════════════════════ */}
      {panel === "card" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New rate card</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveRateCard({
                      code: f.get("code"),
                      name: f.get("name"),
                      description: f.get("description") || null,
                      scope: f.get("scope"),
                      // ⭐ Sent from state, and state starts empty. The server
                      // schema has no default either — both ends refuse.
                      slabMode: slabMode || undefined,
                      basis: f.get("basis"),
                      priority: f.get("priority"),
                      appliesToKind: f.get("appliesToKind") || null,
                      customerCompanyId: f.get("customerCompanyId") || null,
                      channel: f.get("channel") || null,
                      validFrom: f.get("validFrom") || null,
                      validTo: f.get("validTo") || null,
                      daysOfWeek: f.get("daysOfWeek") || null,
                      currency: f.get("currency") || "INR",
                      baseAmountMinor: f.get("baseAmountMinor") || "0",
                      taxRateBps: f.get("taxRateBps") || 0,
                      isTaxInclusive: f.get("isTaxInclusive") === "on",
                      isActive: f.get("isActive") === "on",
                    }),
                  "Rate card saved.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="c-code">Code</Label>
                <Input id="c-code" name="code" required maxLength={80} placeholder="LT-DOMESTIC" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-name">Name</Label>
                <Input
                  id="c-name"
                  name="name"
                  required
                  maxLength={200}
                  placeholder="LT domestic tariff"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-basis">Charged per</Label>
                <select id="c-basis" name="basis" defaultValue="per_unit" className={SELECT_CLASS}>
                  {BASES.map((b) => (
                    <option key={b} value={b}>
                      {b.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>

              {/* ══ ⭐ THE DECISION. No default. Both numbers shown. ══ */}
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="c-slabmode">How are the bands read?</Label>
                <select
                  id="c-slabmode"
                  name="slabMode"
                  required
                  value={slabMode}
                  onChange={(e) => setSlabMode(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {/* ⚠️ The empty option is selected on open and cannot be
                      submitted. Pre-selecting either real option would be
                      right for half of this platform's customers. */}
                  <option value="" disabled>
                    Choose — there is no default, and the two differ by up to 27%
                  </option>
                  <option value="progressive">
                    Progressive — each band charged for the part inside it
                  </option>
                  <option value="flat">
                    Flat — the whole quantity at the rate of the band it lands in
                  </option>
                  <option value="none">
                    None — one flat amount, no bands at all
                  </option>
                </select>

                {slabMode === "" && (
                  <p className="text-[11px] text-muted-foreground">
                    An electricity tariff is progressive. A freight rate or a
                    volume discount is usually flat. There is no answer that is
                    safe for both, so this field has no default and the form
                    will not save without one.
                  </p>
                )}

                {(slabMode === "progressive" || slabMode === "flat") && (
                  <div className="mt-2 rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      {modeComparison.usingOwn
                        ? `On ${editingCard?.code ?? "this card"}'s own bands, ${String(modeComparison.quantity)} units:`
                        : "On the worked example — first 100 at ₹4.50, next 200 at ₹6.20, the rest at ₹8.00 — 250 units:"}
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <div
                        className={
                          slabMode === "progressive"
                            ? "rounded-md border-2 border-emerald-400 p-3 dark:border-emerald-700"
                            : "rounded-md border p-3 opacity-60"
                        }
                      >
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Progressive
                        </p>
                        <p className="text-xl font-semibold tabular-nums">
                          {inr(modeComparison.progressive)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Each band charged for the part of the quantity inside
                          it. Indian electricity tariffs. Income tax.
                        </p>
                      </div>
                      <div
                        className={
                          slabMode === "flat"
                            ? "rounded-md border-2 border-emerald-400 p-3 dark:border-emerald-700"
                            : "rounded-md border p-3 opacity-60"
                        }
                      >
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Flat
                        </p>
                        <p className="text-xl font-semibold tabular-nums">
                          {inr(modeComparison.flat)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          The whole quantity at the rate of the band it landed
                          in. Most freight rates. Most volume discounts.
                        </p>
                      </div>
                    </div>
                    {gap !== 0n && (
                      <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                        {inr(gap < 0n ? -gap : gap)} apart
                        {gapPercent !== null && ` — ${Math.abs(gapPercent).toFixed(1)}%`}
                        . That difference lands on every invoice this card
                        prices, and nothing on the invoice records which
                        reading was taken.
                      </p>
                    )}
                  </div>
                )}

                {slabMode === "none" && (
                  <p className="mt-2 rounded-md border p-3 text-xs text-muted-foreground">
                    No bands. Every quantity is priced at the base amount below.
                    ⚠️ The database will refuse to let you add bands to this card
                    while it says &ldquo;none&rdquo; — a banded card declaring no
                    bands would have its bands silently ignored at billing time,
                    which is the failure this engine exists to prevent.
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="c-scope">Scope</Label>
                <select id="c-scope" name="scope" defaultValue="list" className={SELECT_CLASS}>
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Decides which card wins when several match. Contracted beats
                  promotional beats segment beats channel beats seasonal beats
                  list.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-priority">Priority</Label>
                <Input
                  id="c-priority"
                  name="priority"
                  type="number"
                  min={0}
                  defaultValue={100}
                />
                <p className="text-[11px] text-muted-foreground">
                  Higher wins, within a scope. Stated, never inferred from a
                  date — otherwise the price moves when somebody edits an
                  unrelated card.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-customer">Contracted customer</Label>
                <select
                  id="c-customer"
                  name="customerCompanyId"
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">Anyone</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  A card naming a customer is never handed to a different one —
                  that would be somebody else&rsquo;s negotiated margin on your
                  invoice.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="c-kind">Applies to (kind)</Label>
                <Input id="c-kind" name="appliesToKind" maxLength={60} placeholder="room_type" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-channel">Channel</Label>
                <Input id="c-channel" name="channel" maxLength={60} placeholder="direct" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-currency">Currency</Label>
                <Input id="c-currency" name="currency" maxLength={3} defaultValue="INR" />
              </div>

              <div className="space-y-1">
                <Label htmlFor="c-from">Valid from</Label>
                <Input id="c-from" name="validFrom" type="date" />
              </div>
              <div className="space-y-1">
                {/* ⚠️ EXCLUSIVE. Said here, because getting it wrong makes two
                    cards both apply on the changeover day and the winner
                    depends on sort order. */}
                <Label htmlFor="c-to">Valid to (exclusive)</Label>
                <Input id="c-to" name="validTo" type="date" />
                <p className="text-[11px] text-muted-foreground">
                  A card for the whole of March ends 1 April, not 31 March.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-dow">Days of week</Label>
                <Input
                  id="c-dow"
                  name="daysOfWeek"
                  maxLength={7}
                  placeholder="1111100"
                  pattern="[01]{7}"
                />
                <p className="text-[11px] text-muted-foreground">
                  Monday first. Empty means every day.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="c-base">Base amount (paise)</Label>
                <Input
                  id="c-base"
                  name="baseAmountMinor"
                  inputMode="numeric"
                  pattern="\d*"
                  defaultValue="0"
                />
                <p className="text-[11px] text-muted-foreground">
                  Used when the card has no bands. ⚠️ Left at 0 with no bands,
                  the card prices everything at ₹0.00 and nothing errors.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-tax">Tax (basis points)</Label>
                <Input
                  id="c-tax"
                  name="taxRateBps"
                  type="number"
                  min={0}
                  max={10000}
                  defaultValue={0}
                />
                <p className="text-[11px] text-muted-foreground">1800 = 18%.</p>
              </div>
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isTaxInclusive" className="h-4 w-4" />
                  Tax already in the price
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isActive" defaultChecked className="h-4 w-4" />
                  Active
                </label>
              </div>

              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="c-desc">Description</Label>
                <Input id="c-desc" name="description" maxLength={2000} />
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || slabMode === ""}>
                  {pending ? "Saving…" : "Save rate card"}
                </Button>
                {slabMode === "" && (
                  <span className="ml-3 text-xs text-muted-foreground">
                    Choose how the bands are read first.
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ══ BANDS ═══════════════════════════════════════════════════ */}
      {panel === "slabs" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Bands</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="s-card">Rate card</Label>
                <select
                  id="s-card"
                  value={editingCardId}
                  onChange={(e) => loadSlabDrafts(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name} ({c.slabMode})
                    </option>
                  ))}
                </select>
              </div>
              {editingCard?.slabMode === "none" && (
                <p className="self-end text-xs text-amber-700 dark:text-amber-300">
                  ⚠️ This card is set to &ldquo;none&rdquo;. The database will
                  refuse any band saved against it, because bands on a
                  &ldquo;none&rdquo; card are silently ignored at billing time.
                  Change the card&rsquo;s mode first.
                </p>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Up to (exclusive)</th>
                    <th className="px-2 py-2 font-medium">Rate per unit (paise)</th>
                    <th className="px-2 py-2 font-medium">Fixed charge (paise)</th>
                    <th className="px-2 py-2 font-medium">Label</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {slabDrafts.map((s, i) => (
                    <tr key={i}>
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Input
                          value={s.upToQuantity}
                          inputMode="numeric"
                          placeholder={i === slabDrafts.length - 1 ? "empty = ∞" : "100"}
                          onChange={(e) =>
                            setSlabDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, upToQuantity: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={s.unitAmountMinor}
                          inputMode="numeric"
                          onChange={(e) =>
                            setSlabDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, unitAmountMinor: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={s.fixedAmountMinor}
                          inputMode="numeric"
                          onChange={(e) =>
                            setSlabDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, fixedAmountMinor: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={s.label}
                          maxLength={120}
                          onChange={(e) =>
                            setSlabDrafts((d) =>
                              d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSlabDrafts((d) => d.filter((_, j) => j !== i))
                          }
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSlabDrafts((d) => [
                    ...d,
                    {
                      upToQuantity: "",
                      unitAmountMinor: "0",
                      fixedAmountMinor: "0",
                      label: "",
                    },
                  ])
                }
              >
                Add band
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending || !editingCardId}
                onClick={() =>
                  run(
                    () =>
                      saveRateSlabs({
                        rateCardId: editingCardId,
                        slabs: slabDrafts.map((s) => ({
                          upToQuantity: s.upToQuantity.trim(),
                          unitAmountMinor: s.unitAmountMinor.trim() || "0",
                          fixedAmountMinor: s.fixedAmountMinor.trim() || "0",
                          label: s.label.trim() || null,
                        })),
                      }),
                    "Bands saved. The whole set was replaced.",
                  )
                }
              >
                {pending ? "Saving…" : "Save bands"}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Positions are assigned from the order above — 1, 2, 3 … — and the
              whole set is replaced in one transaction. Only the LAST band may
              have an empty upper limit; the database refuses gaps, overlaps and
              an open-ended band that is not last, judged at commit so a
              legitimate rewrite of four bands is never rejected halfway
              through. A gap between bands would price the units inside it at
              zero and error on nothing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ══ ADJUSTMENTS ═════════════════════════════════════════════ */}
      {panel === "adjustments" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Surcharges and discounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1 sm:max-w-md">
              <Label htmlFor="a-card">Rate card</Label>
              <select
                id="a-card"
                value={editingCardId}
                onChange={(e) => loadAdjustmentDrafts(e.target.value)}
                className={SELECT_CLASS}
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Label</th>
                    <th className="px-2 py-2 font-medium">Percent (bps)</th>
                    <th className="px-2 py-2 font-medium">Fixed (paise)</th>
                    <th className="px-2 py-2 font-medium">On invoice</th>
                    <th className="px-2 py-2 font-medium">Statutory</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {adjustmentDrafts.map((a, i) => (
                    <tr key={i}>
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Input
                          value={a.label}
                          maxLength={160}
                          placeholder="Fuel surcharge"
                          onChange={(e) =>
                            setAdjustmentDrafts((d) =>
                              d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={a.percentageBps}
                          inputMode="numeric"
                          placeholder="-1000 = 10% off"
                          onChange={(e) =>
                            setAdjustmentDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, percentageBps: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={a.fixedAmountMinor}
                          inputMode="numeric"
                          onChange={(e) =>
                            setAdjustmentDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, fixedAmountMinor: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={a.isVisible}
                          onChange={(e) =>
                            setAdjustmentDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, isVisible: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={a.isStatutory}
                          onChange={(e) =>
                            setAdjustmentDrafts((d) =>
                              d.map((x, j) =>
                                j === i ? { ...x, isStatutory: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setAdjustmentDrafts((d) => d.filter((_, j) => j !== i))
                          }
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setAdjustmentDrafts((d) => [
                    ...d,
                    {
                      label: "",
                      percentageBps: "0",
                      fixedAmountMinor: "0",
                      isVisible: true,
                      isStatutory: false,
                    },
                  ])
                }
              >
                Add adjustment
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending || !editingCardId}
                onClick={() =>
                  run(
                    () =>
                      saveRateAdjustments({
                        rateCardId: editingCardId,
                        adjustments: adjustmentDrafts.map((a) => ({
                          label: a.label.trim(),
                          percentageBps: a.percentageBps.trim() || "0",
                          fixedAmountMinor: a.fixedAmountMinor.trim() || "0",
                          isVisible: a.isVisible,
                          isStatutory: a.isStatutory,
                        })),
                      }),
                    "Adjustments saved, in the order shown.",
                  )
                }
              >
                {pending ? "Saving…" : "Save adjustments"}
              </Button>
            </div>

            {/* ⭐ The order is not cosmetic and the screen has to say so. */}
            <p className="text-xs text-muted-foreground">
              Applied top to bottom, each against the RUNNING subtotal rather
              than the original — so a 10% discount followed by a 5% surcharge
              is not 95% of the base. Reordering these rows changes the invoice
              total. Negative basis points are a discount: −1000 is 10% off.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ══ QUOTE CALCULATOR ════════════════════════════════════════ */}
      {panel === "quote" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quote calculator</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="q-card">Rate card</Label>
                <select
                  id="q-card"
                  value={quoteCardId}
                  onChange={(e) => setQuoteCardId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-qty">Quantity</Label>
                <Input
                  id="q-qty"
                  value={quoteQty}
                  inputMode="numeric"
                  onChange={(e) => setQuoteQty(e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-for">Quoted for</Label>
                <Input
                  id="q-for"
                  value={quotedFor}
                  maxLength={200}
                  placeholder="Who asked"
                  onChange={(e) => setQuotedFor(e.target.value)}
                />
              </div>
            </div>

            {preview && quoteCard && (
              <div className="rounded-md border">
                <div className="border-b px-4 py-2 text-xs text-muted-foreground">
                  {quoteCard.slabCount} band{quoteCard.slabCount === 1 ? "" : "s"}, read{" "}
                  <span className="font-medium">{quoteCard.slabMode}</span>
                  {quoteCard.slabCount === 0 &&
                    " — no bands stored, so the base amount is the whole answer"}
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y">
                    <tr>
                      <td className="px-4 py-2">
                        {quoteCard.slabCount === 0 ? "Base amount" : "Banded subtotal"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {inr(preview.subtotal)}
                      </td>
                    </tr>
                    {preview.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2">
                          {l.label}
                          {l.note && (
                            <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                              {l.note}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(l.amount)}
                        </td>
                      </tr>
                    ))}
                    {quoteCard.taxRateBps > 0 && (
                      <tr>
                        <td className="px-4 py-2">
                          Tax {(quoteCard.taxRateBps / 100).toFixed(2)}%
                          {quoteCard.isTaxInclusive && (
                            <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                              already in the price
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(preview.tax)}
                        </td>
                      </tr>
                    )}
                    <tr className="bg-muted/40">
                      <td className="px-4 py-2 font-medium">Total</td>
                      <td className="px-4 py-2 text-right text-lg font-semibold tabular-nums">
                        {inr(preview.total)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                disabled={pending || !quoteCardId || quoteQty === ""}
                onClick={() =>
                  run(
                    () =>
                      recordRateQuote({
                        rateCardId: quoteCardId,
                        quantity: quoteQty || "0",
                        quotedFor: quotedFor.trim() || null,
                      }),
                    "Quote recorded. It cannot be edited afterwards — that is the point.",
                  )
                }
              >
                {pending ? "Recording…" : "Record this quote"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Recording re-prices in SQL and stores THAT answer, with the
                reason this card won, frozen.
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              ⚠️ The figures above are computed in your browser so the total
              moves as you type. The database is the authority: pressing
              &ldquo;record&rdquo; asks <code>ordence_quote_rate</code> for the
              answer and stores that, not this. The two are asserted equal to
              the paise in tests/ui/pricing-engine.test.tsx.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ══ PER-CARD CONTROLS ═══════════════════════════════════════ */}
      {cards.length > 0 && (
        <details className="rounded-md border px-4 py-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Retire or remove a card
          </summary>
          <ul className="mt-2 divide-y">
            {cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-mono text-xs">{c.code}</span>
                <span>{c.name}</span>
                {c.quoteCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {c.quoteCount} quote{c.quoteCount === 1 ? "" : "s"} recorded
                  </span>
                )}
                <span className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => setRateCardActive({ id: c.id, isActive: !c.isActive }),
                        c.isActive
                          ? "Card retired. It will not be selected; its quotes are untouched."
                          : "Card switched on.",
                      )
                    }
                  >
                    {c.isActive ? "Retire" : "Switch on"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(() => deleteRateCard({ id: c.id }), "Card removed from the list.")
                    }
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Retiring is the honest operation: it stops the card being selected
            from the moment it is saved, and leaves every quote built from it
            exactly where it is. Removing hides it from these lists; the
            recorded quotes still survive, because the moment somebody most
            wants the evidence gone is the moment it matters most.
          </p>
        </details>
      )}
    </div>
  );
}
