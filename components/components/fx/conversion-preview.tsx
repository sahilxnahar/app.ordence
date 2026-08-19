"use client";

/**
 * Ordence — ⭐ WHICH RATE WOULD THIS CONVERSION USE, AND WHERE FROM
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A PREVIEW, AND IT SAYS SO
 * ══════════════════════════════════════════════════════════════════════
 * It resolves the rate exactly as a posting would — same lookup, same
 * closing-rate window — so somebody about to enter a dollar invoice can
 * see the figure and its provenance BEFORE committing, rather than
 * finding out at the trial balance which rate the system picked.
 *
 * 🔴 AND IT SAYS WHEN THE RATE WAS DERIVED. The pair may be stored the
 * other way round, in which case what is shown is a reciprocal this
 * system computed and nobody published. That is a different kind of
 * evidence and it is labelled as one.
 *
 * ⚠️ "NO RATE ON FILE" IS AN ANSWER, NOT AN ERROR. It is a fact about the
 * data, and it is reported as a fact — never as 1, and never as the
 * nearest rate from some other week.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  previewConversion,
  type ConversionPreview,
  type CurrencyOption,
} from "@/server/actions/fx";
import { trimRate } from "./fx-format";

export function ConversionPreviewPanel({
  currencies,
  functionalCurrency,
  defaultDate,
}: {
  currencies: readonly CurrencyOption[];
  functionalCurrency: string;
  defaultDate: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [from, setFrom] = React.useState(
    currencies.find((c) => c.code !== functionalCurrency)?.code ?? functionalCurrency,
  );
  const [to, setTo] = React.useState(functionalCurrency);
  const [on, setOn] = React.useState(defaultDate);
  const [result, setResult] = React.useState<ConversionPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function preview() {
    startTransition(async () => {
      const outcome = await previewConversion({ from, to, on });
      if (!outcome.ok) {
        setResult(null);
        setError(outcome.error);
        return;
      }
      setError(null);
      setResult(outcome.data);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">What rate would be used?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="fx-preview-from">From</Label>
            <Select
              id="fx-preview-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fx-preview-to">To</Label>
            <Select id="fx-preview-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fx-preview-on" required>
              On
            </Label>
            <Input
              id="fx-preview-on"
              type="date"
              required
              value={on}
              onChange={(e) => setOn(e.target.value)}
            />
          </div>
        </div>

        <Button type="button" variant="outline" onClick={preview} disabled={pending || on === ""}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Preview the rate
        </Button>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {result && !result.found && (
          <p className="text-sm text-muted-foreground" data-testid="fx-preview-missing">
            No rate is on file for {from}/{to} on {on}. Nothing has been converted — a missing
            rate is reported rather than replaced with 1 or with the nearest rate from another
            week.
          </p>
        )}

        {result && result.found && (
          <div className="rounded border p-3 text-sm" data-testid="fx-preview-result">
            <p className="font-mono text-base">
              {result.pair} {trimRate(result.rate ?? "")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Rate date {result.rateDate} · source {result.source}
            </p>
            {/*
              🔴 THE DERIVED FLAG, CARRIED FROM `lib/fx/rates.ts#invertQuote`
              ALL THE WAY TO THE SCREEN. A customer evidencing this figure
              to an auditor needs to know it was computed by us, not
              published by the source named beside it.
            */}
            {result.derived ? (
              <p className="mt-2 text-xs">
                <Badge variant="outline" className="text-[10px]">
                  derived by inversion
                </Badge>{" "}
                <span className="text-muted-foreground">
                  The pair is published the other way round. This figure is its reciprocal,
                  computed here to twelve decimal places — nobody published this number.
                </span>
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Published in this direction. The number on the document is the number in the
                source.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{result.description}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
