"use client";

/**
 * Ordence — ⭐⭐⭐ THE OTHER STATUTE, SIDE BY SIDE WITH THE BOOKS
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TWO COMPUTATIONS ON THE SAME ASSETS. NEITHER CORRECTS THE OTHER.
 * ══════════════════════════════════════════════════════════════════════
 * The Companies Act charge is per ASSET, useful-life based, pro-rated by
 * days, and it hits the profit and loss account. The section 32
 * allowance is per BLOCK, rate based, halved for an asset used under 180
 * days, and it never touches the ledger at all.
 *
 * ⚠️ THEY DIVERGE PERMANENTLY AND THE DIVERGENCE IS THE POINT. This
 * screen therefore never puts one below the other as a "correction", and
 * never shows a single "depreciation" figure. It shows two columns and
 * names the statute over each. The difference between them is the timing
 * difference deferred tax is computed on — a product that computes only
 * one of them cannot produce deferred tax at all.
 *
 * ⭐ AND THE TAX RUN HAS NO POST BUTTON, ANYWHERE. There is deliberately
 * no way to reach `postDepreciation` from this panel: posting the
 * Income-tax Act's number into a Companies Act balance sheet is the
 * single worst thing this module could do, and the server refuses it
 * whatever the screen offers.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IT_BLOCK_CLASSES, IT_RATES_BY_CLASS } from "@/lib/fixed-assets/depreciation";
import {
  formatBp,
  formatMinor,
  parseRupeesToMinor,
  type BlockRow,
} from "@/lib/fixed-assets/register-view";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type ItRun = {
  runId: string;
  fyFrom: string;
  fyTo: string;
  totalAllowanceMinor: string;
  blocks: ReadonlyArray<Record<string, unknown>>;
  note: string;
};

type Deferred = {
  fyLabel: string;
  bookCarryingMinor: string;
  taxWdvMinor: string;
  differenceMinor: string;
  gives: string;
  note: string;
} | null;

export type ItRunAction = (input: unknown) => Promise<Result<ItRun>>;
export type DeferredAction = (input: unknown) => Promise<Result<Deferred>>;
export type SaveBlockAction = (input: unknown) => Promise<Result<{ id: string }>>;

const text = (v: unknown): string => (v === null || v === undefined ? "—" : String(v));
const money = (v: unknown): string => {
  const s = String(v ?? "");
  return /^-?\d+$/.test(s) ? formatMinor(BigInt(s)) : "—";
};

const GIVES_LABEL: Record<string, string> = {
  deferred_tax_liability: "a deferred tax LIABILITY",
  deferred_tax_asset: "a deferred tax ASSET",
  none: "no timing difference",
};

export function IncomeTaxPanel({
  blocks,
  defaultAnyDayInYear,
  runItAction,
  deferredAction,
  saveBlockAction,
  canManage,
}: {
  blocks: readonly BlockRow[];
  defaultAnyDayInYear: string;
  runItAction: ItRunAction;
  deferredAction: DeferredAction;
  saveBlockAction: SaveBlockAction;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [anyDay, setAnyDay] = useState(defaultAnyDayInYear);
  const [run, setRun] = useState<ItRun | null>(null);
  const [deferred, setDeferred] = useState<Deferred>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [blockRefusal, setBlockRefusal] = useState<string | null>(null);
  const [blockSaved, setBlockSaved] = useState<string | null>(null);

  const [blockName, setBlockName] = useState("");
  const [blockClass, setBlockClass] = useState<string>("plant_machinery");
  const [rateBp, setRateBp] = useState("1500");
  const [openingWdv, setOpeningWdv] = useState("0");
  const [openingAsAt, setOpeningAsAt] = useState("");
  const [blockNotes, setBlockNotes] = useState("");

  const permitted = IT_RATES_BY_CLASS[blockClass as keyof typeof IT_RATES_BY_CLASS] ?? [];

  function computeTax() {
    setRefusal(null);
    startTransition(async () => {
      const result = await runItAction({ anyDayInYear: anyDay });
      if (!result.ok) {
        setRefusal(result.error);
        setRun(null);
        return;
      }
      setRun(result.data);
      // ⭐ The comparison is only meaningful once the tax year has been
      // computed, so it is fetched immediately after and not before.
      const working = await deferredAction({ anyDayInYear: anyDay });
      setDeferred(working.ok ? working.data : null);
      if (!working.ok) setRefusal(working.error);
    });
  }

  function saveBlock() {
    setBlockRefusal(null);
    setBlockSaved(null);
    const opening = parseRupeesToMinor(openingWdv);
    if (opening === null) {
      setBlockRefusal("Enter the opening written-down value in rupees.");
      return;
    }
    startTransition(async () => {
      const result = await saveBlockAction({
        name: blockName,
        blockClass,
        rateBp: Number(rateBp) || 0,
        openingWdvMinor: opening,
        openingWdvAsAt: openingAsAt,
        notes: blockNotes.trim() === "" ? null : blockNotes,
      });
      if (!result.ok) {
        setBlockRefusal(result.error);
        return;
      }
      setBlockSaved(blockName);
      setBlockName("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Blocks of assets — s.2(11)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Section 32 depreciates a BLOCK. Every asset of the same class attracting the
            same prescribed rate is one pool, and the written-down value belongs to the
            pool rather than to any asset in it — so there is no per-asset tax figure and
            no per-asset profit on sale.
          </p>

          {blocks.length === 0 ? (
            <p className="text-muted-foreground">
              No blocks yet. Until one exists there is no section 32 computation to make.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Block</th>
                  <th className="py-2 pr-3 font-medium">Class</th>
                  <th className="py-2 pr-3 font-medium">Rate</th>
                  <th className="py-2 pr-3 font-medium">Opening WDV</th>
                  <th className="py-2 pr-3 font-medium">As at</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{b.name}</td>
                    <td className="py-2 pr-3">{b.blockClass}</td>
                    <td className="py-2 pr-3 tabular-nums">{formatBp(b.rateBp)}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {formatMinor(b.openingWdvMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{b.openingWdvAsAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canManage ? (
            <div className="space-y-3 border-t pt-4">
              <p className="text-muted-foreground">
                {/* ⚠️ The rate is typed in, not derived — and it is honest to say why. */}
                The rate is typed in rather than guessed: which Appendix I entry an asset
                falls under is a judgement about the asset, and a computer at 40% and
                general plant at 15% look identical on a purchase invoice. The opening
                written-down value is an opening balance, dated — every later year is
                computed from it.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="blk-name">Block name</Label>
                  <Input
                    id="blk-name"
                    value={blockName}
                    onChange={(e) => setBlockName(e.target.value)}
                    placeholder="Plant & machinery — 15%"
                  />
                </div>
                <div>
                  <Label htmlFor="blk-class">Class</Label>
                  <Select
                    id="blk-class"
                    value={blockClass}
                    onChange={(e) => {
                      setBlockClass(e.target.value);
                      const first =
                        IT_RATES_BY_CLASS[e.target.value as keyof typeof IT_RATES_BY_CLASS]?.[0];
                      if (first !== undefined) setRateBp(String(first));
                    }}
                  >
                    {IT_BLOCK_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="blk-rate">Rate (basis points)</Label>
                  <Select
                    id="blk-rate"
                    value={rateBp}
                    onChange={(e) => setRateBp(e.target.value)}
                  >
                    {permitted.map((r) => (
                      <option key={r} value={String(r)}>
                        {formatBp(r)}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Appendix I prescribes {permitted.map((r) => formatBp(r)).join(", ")} for
                    this class and nothing else.
                  </p>
                </div>
                <div>
                  <Label htmlFor="blk-wdv">Opening written-down value (₹)</Label>
                  <Input
                    id="blk-wdv"
                    value={openingWdv}
                    onChange={(e) => setOpeningWdv(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <Label htmlFor="blk-asat">Opening WDV as at</Label>
                  <Input
                    id="blk-asat"
                    type="date"
                    value={openingAsAt}
                    onChange={(e) => setOpeningAsAt(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="blk-notes">Notes</Label>
                  <Textarea
                    id="blk-notes"
                    value={blockNotes}
                    onChange={(e) => setBlockNotes(e.target.value)}
                    rows={2}
                  />
                </div>
              </div>

              {blockRefusal !== null && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  {blockRefusal}
                </p>
              )}
              {blockSaved !== null && (
                <p role="status" className="text-sm text-emerald-700">
                  {blockSaved} saved.
                </p>
              )}

              <Button onClick={saveBlock} disabled={pending}>
                Save the block
              </Button>
            </div>
          ) : (
            <p role="alert" className="border-t pt-4 text-muted-foreground">
              Setting up a block needs the <code>fixed_assets.manage</code> permission.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Section 32, for one previous year</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!canManage ? (
            <p role="alert" className="text-muted-foreground">
              Running the income-tax computation needs the{" "}
              <code>fixed_assets.manage</code> permission.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="it-day">Any day in the previous year</Label>
                <Input
                  id="it-day"
                  type="date"
                  value={anyDay}
                  onChange={(e) => setAnyDay(e.target.value)}
                />
              </div>
              <Button onClick={computeTax} disabled={pending}>
                {pending ? "Working…" : "Compute the allowance"}
              </Button>
            </div>
          )}

          {refusal !== null && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <p className="whitespace-pre-line">{refusal}</p>
            </div>
          )}

          {run !== null && (
            <div className="space-y-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Allowance for {run.fyFrom} to {run.fyTo}
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {money(run.totalAllowanceMinor)}
                </p>
                <Badge variant="outline" className="mt-1">
                  never posted
                </Badge>
              </div>
              <p className="text-muted-foreground">{run.note}</p>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Block</th>
                      <th className="py-2 pr-3 font-medium">Rate</th>
                      <th className="py-2 pr-3 font-medium">Opening WDV</th>
                      <th className="py-2 pr-3 font-medium">Full-rate additions</th>
                      <th className="py-2 pr-3 font-medium">Half-rate additions</th>
                      <th className="py-2 pr-3 font-medium">Moneys payable</th>
                      <th className="py-2 pr-3 font-medium">Allowance</th>
                      <th className="py-2 pr-3 font-medium">Closing WDV</th>
                      <th className="py-2 pr-3 font-medium">s.50</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.blocks.map((b, index) => (
                      <tr key={text(b.blockId) + index} className="border-b align-top last:border-0">
                        <td className="py-2 pr-3 font-medium">{text(b.blockName)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {formatBp(Number(b.rateBp ?? 0))}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{money(b.openingWdvMinor)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {money(b.fullRateAdditionsMinor)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {money(b.halfRateAdditionsMinor)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{money(b.moneysPayableMinor)}</td>
                        <td className="py-2 pr-3 tabular-nums font-medium">
                          {money(b.depreciationMinor)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{money(b.closingWdvMinor)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {String(b.shortTermCapitalGainMinor ?? "0") !== "0" && (
                            <span>gain {money(b.shortTermCapitalGainMinor)}</span>
                          )}
                          {String(b.shortTermCapitalLossMinor ?? "0") !== "0" && (
                            <span>loss {money(b.shortTermCapitalLossMinor)}</span>
                          )}
                          {String(b.shortTermCapitalGainMinor ?? "0") === "0" &&
                            String(b.shortTermCapitalLossMinor ?? "0") === "0" &&
                            "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-1 text-xs text-muted-foreground">
                {run.blocks.flatMap((b, index) => {
                  const notes = Array.isArray(b.notes) ? b.notes : [];
                  return notes.map((n, i) => (
                    <li key={`${index}-${i}`}>
                      {text(b.blockName)}: {String(n)}
                    </li>
                  ));
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/**
       * 🔴 THE TWO COLUMNS. Neither is a correction of the other, and the
       * headings say which statute each one belongs to.
       */}
      {deferred !== null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              The divergence — {deferred.fyLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase text-muted-foreground">
                  Companies Act 2013, Schedule II
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {money(deferred.bookCarryingMinor)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Carrying amount in the books. Per asset, useful-life based, pro-rated by
                  days, and this is the figure that is in the ledger.
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase text-muted-foreground">
                  Income-tax Act 1961, section 32
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {money(deferred.taxWdvMinor)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Written-down value of the blocks. Per pool, rate based, halved below 180
                  days, and it is never posted anywhere.
                </p>
              </div>
            </div>

            <div className="rounded-md border p-3">
              <p className="text-xs uppercase text-muted-foreground">
                Timing difference — the books less the tax computation
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {money(deferred.differenceMinor)}
              </p>
              <p className="mt-1">
                This gives {GIVES_LABEL[deferred.gives] ?? deferred.gives}.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{deferred.note}</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
