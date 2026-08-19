"use client";

/**
 * Ordence — ⭐⭐ SELLING AN ASSET, AND THE TWO ANSWERS IT PRODUCES
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE SALE, TWO TREATMENTS, AND THEY ARE NOT RECONCILED HERE
 * ══════════════════════════════════════════════════════════════════════
 * To the Companies Act the consideration produces a profit or a loss
 * against the carrying amount, and that figure goes to the ledger. To
 * s.43(6)(c)(i)(B) the same rupees are "moneys payable", they come off
 * the BLOCK, and they produce no gain or loss at asset level at all —
 * unless the block empties or is exhausted, when s.50(2) or s.50(1)
 * bites.
 *
 * ⚠️ A MACHINE SOLD AT A BOOK PROFIT OF ₹2 LAKH MAY PRODUCE NO TAXABLE
 * GAIN WHATSOEVER. Showing one figure would either invent a tax
 * liability or hide a real one, so this screen shows both and labels
 * each with its statute.
 *
 * ⚠️ AND THE DISPOSAL IS REFUSED UNTIL DEPRECIATION IS POSTED TO THE DAY
 * OF SALE. That refusal is shown verbatim, because the remedy — run and
 * post the period the disposal falls in — is not guessable from
 * "something went wrong".
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMinor, parseRupeesToMinor } from "@/lib/fixed-assets/register-view";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type DisposalOutcome = {
  carryingAmountMinor: string;
  gainMinor: string;
  lossMinor: string;
  taxNote: string;
};

export type DisposeAction = (input: unknown) => Promise<Result<DisposalOutcome>>;

const money = (v: string): string => (/^-?\d+$/.test(v) ? formatMinor(BigInt(v)) : "—");

export function DisposeAsset({
  assetId,
  assetNo,
  disposeAction,
  canPost,
  alreadyDisposed,
}: {
  assetId: string;
  assetNo: string;
  disposeAction: DisposeAction;
  canPost: boolean;
  alreadyDisposed: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [disposedOn, setDisposedOn] = useState("");
  const [consideration, setConsideration] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DisposalOutcome | null>(null);

  function submit() {
    setRefusal(null);
    const minor = parseRupeesToMinor(consideration);
    if (minor === null) {
      setRefusal("Enter the sale consideration in rupees, to at most two decimal places.");
      return;
    }
    startTransition(async () => {
      const result = await disposeAction({
        assetId,
        disposedOn,
        considerationMinor: minor,
      });
      if (!result.ok) {
        setRefusal(result.error);
        return;
      }
      setOutcome(result.data);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Dispose of {assetNo}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {alreadyDisposed ? (
          <p className="text-muted-foreground">
            This asset has already left the register.
          </p>
        ) : !canPost ? (
          <p role="alert" className="text-muted-foreground">
            Recording a disposal writes a journal entry, so it needs the{" "}
            <code>fixed_assets.post</code> permission.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Depreciation must already be posted up to the day of sale. Otherwise the
              months since the last run are reported as part of the profit or loss on sale
              instead of as depreciation — two different lines of the profit and loss
              account, and the entry balances perfectly while saying the wrong thing.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="disp-on">Disposed on</Label>
                <Input
                  id="disp-on"
                  type="date"
                  value={disposedOn}
                  onChange={(e) => setDisposedOn(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="disp-amt">Consideration (₹)</Label>
                <Input
                  id="disp-amt"
                  value={consideration}
                  onChange={(e) => setConsideration(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <Button variant="secondary" onClick={submit} disabled={pending}>
                {pending ? "Working…" : "Record the disposal"}
              </Button>
            </div>
          </>
        )}

        {refusal !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <p className="font-medium">The asset is still in the register.</p>
            <p className="mt-1 whitespace-pre-line">{refusal}</p>
          </div>
        )}

        {outcome !== null && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="text-xs uppercase text-muted-foreground">
                Companies Act 2013 — the ledger
              </p>
              <p className="mt-1 text-sm">
                Carrying amount {money(outcome.carryingAmountMinor)}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {outcome.gainMinor !== "0"
                  ? `Profit on sale ${money(outcome.gainMinor)}`
                  : outcome.lossMinor !== "0"
                    ? `Loss on sale ${money(outcome.lossMinor)}`
                    : "Neither profit nor loss"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Asset by asset, against the carrying amount, and this is what was posted.
              </p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs uppercase text-muted-foreground">
                Income-tax Act 1961 — the block
              </p>
              <p className="mt-1 whitespace-pre-line">{outcome.taxNote}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The proceeds come off the pool. No gain or loss arises at asset level, and
                nothing here reaches the ledger — run the section 32 computation to turn
                this into a figure.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
