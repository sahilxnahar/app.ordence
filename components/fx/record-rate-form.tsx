"use client";

/**
 * Ordence — ⭐⭐ ENTER A RATE: A DIRECTION, A DATE AND A SOURCE
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO FIELD ON THIS FORM CALLED "THE RATE"
 * ══════════════════════════════════════════════════════════════════════
 * "The dollar rate is 83.21" is not a fact anybody can defend. What can
 * be defended is "USD/INR 83.2150 on 31 March 2026, from our bank's
 * advice". So the form asks for four things and refuses to submit
 * without three of them:
 *
 *   • THE DIRECTION — base and quote are two separate pickers, and the
 *     sentence under them reads the pair back in words, because 83.215
 *     and 0.012017 are the same rate written two ways and multiplying by
 *     the wrong one is an error of four orders of magnitude that still
 *     looks like money.
 *   • THE DATE — no default. Ind AS 21 ¶21 measures a transaction at the
 *     spot rate AT THE DATE OF THE TRANSACTION, so a rate entered
 *     "today" by a person who meant "31 March" is the wrong measurement
 *     rather than a rounding error. Defaulting the field to today is
 *     exactly how that mistake gets made, so the submit button stays
 *     disabled until somebody chooses a day.
 *   • THE SOURCE — every rate typed here is stored as `manual`, and the
 *     reference field is where the bank advice number goes. An auditor
 *     asking where 83.2150 came from gets an answer.
 *
 * ⚠️ THE RATE IS VALIDATED BY THE SERVER'S OWN PARSER, NOT BY A SECOND
 * ONE WRITTEN HERE. `validateRateText` calls `parseRateToScaled` — the
 * same function the write path uses. A looser check in the browser is
 * how "the form accepted it and the server refused it" happens.
 *
 * ⚠️ AND THE BUTTON IS A COURTESY, NOT A CONTROL. `recordFxRate` requires
 * `fx:manage_rates`, which is on `DANGEROUS_PERMISSIONS`; hiding the form
 * decides nothing, the server decides.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { recordFxRate, validateRateText, type CurrencyOption } from "@/server/actions/fx";

export function RecordRateForm({
  currencies,
  functionalCurrency,
  canManage,
}: {
  currencies: readonly CurrencyOption[];
  functionalCurrency: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [baseCurrency, setBaseCurrency] = React.useState(
    currencies.find((c) => c.code !== functionalCurrency)?.code ?? "",
  );
  const [quoteCurrency, setQuoteCurrency] = React.useState(functionalCurrency);
  const [rate, setRate] = React.useState("");
  /** 🔴 NO DEFAULT. See the header. */
  const [rateDate, setRateDate] = React.useState("");
  /**
   * 🔴 NO DEFAULT EITHER, AND FOR A HARDER REASON THAN THE DATE.
   *
   * Mid, telegraphic transfer buying and telegraphic transfer selling are
   * three different numbers on the same day, routinely half a rupee apart
   * on the dollar. Rule 26 of the Income-tax Rules computes the TDS on a
   * foreign payment from the TT BUYING rate and from nothing else. A
   * pre-selected "mid" would produce rates that are silently ineligible
   * for that; a pre-selected "TT buying" would produce rates that are
   * silently WRONG for it. So the person holding the advice says which.
   */
  const [rateType, setRateType] = React.useState("");
  const [sourceReference, setSourceReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const [normalised, setNormalised] = React.useState<string | null>(null);
  const [rateError, setRateError] = React.useState<string | null>(null);

  const samePair = baseCurrency === quoteCurrency;
  const missingDate = rateDate.trim() === "";
  const missingRateType = rateType === "";
  const canSubmit =
    canManage &&
    !pending &&
    !samePair &&
    !missingDate &&
    !missingRateType &&
    rate.trim() !== "";

  /**
   * ⚠️ THE SERVER'S PARSER, ON BLUR. It returns the number as it will be
   * STORED — twelve decimal places — so a person who typed "83.215" can
   * see that nothing was silently truncated or rounded.
   */
  function checkRate() {
    const typed = rate.trim();
    if (typed === "") {
      setNormalised(null);
      setRateError(null);
      return;
    }
    startTransition(async () => {
      const result = await validateRateText(typed);
      if (result.ok) {
        setNormalised(result.data.normalised);
        setRateError(null);
      } else {
        setNormalised(null);
        setRateError(result.error);
      }
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await recordFxRate({
        baseCurrency,
        quoteCurrency,
        rate: rate.trim(),
        rateDate,
        rateType: rateType as "mid" | "tt_buying" | "tt_selling",
        sourceReference: sourceReference.trim() || null,
        note: note.trim() || null,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${baseCurrency}/${quoteCurrency} on ${rateDate} recorded at ${result.data.rate}.`,
      );
      setRate("");
      setNormalised(null);
      setRateType("");
      setSourceReference("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Record a rate</CardTitle>
      </CardHeader>
      <CardContent>
        {!canManage ? (
          <p className="text-sm text-muted-foreground" data-testid="fx-rate-form-denied">
            You do not have permission to enter exchange rates. A rate changes the profit and
            loss account, so <span className="font-mono text-xs">fx:manage_rates</span> is held
            separately from the permission to read them. Ask an administrator.
          </p>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fx-base" required>
                  One unit of
                </Label>
                <Select
                  id="fx-base"
                  value={baseCurrency}
                  onChange={(e) => setBaseCurrency(e.target.value)}
                >
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.exponent} decimal{c.exponent === 1 ? "" : "s"}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="fx-quote" required>
                  buys this many
                </Label>
                <Select
                  id="fx-quote"
                  value={quoteCurrency}
                  onChange={(e) => setQuoteCurrency(e.target.value)}
                >
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.exponent} decimal{c.exponent === 1 ? "" : "s"}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fx-rate" required>
                  Rate
                </Label>
                <Input
                  id="fx-rate"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="83.2150"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  onBlur={checkRate}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="fx-rate-date" required>
                  The day this rate is for
                </Label>
                <Input
                  id="fx-rate-date"
                  type="date"
                  required
                  aria-describedby="fx-rate-date-help"
                  value={rateDate}
                  onChange={(e) => setRateDate(e.target.value)}
                />
                <p id="fx-rate-date-help" className="text-xs text-muted-foreground">
                  Not the day you are typing it. A rate without a date is not a rate.
                </p>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="fx-rate-type" required>
                Which rate is this
              </Label>
              <Select
                id="fx-rate-type"
                value={rateType}
                aria-describedby="fx-rate-type-help"
                onChange={(e) => setRateType(e.target.value)}
              >
                <option value="">Choose — this is not a default</option>
                <option value="tt_buying">Telegraphic transfer buying rate</option>
                <option value="tt_selling">Telegraphic transfer selling rate</option>
                <option value="mid">Mid rate (a reference or market feed)</option>
              </Select>
              <p id="fx-rate-type-help" className="text-xs text-muted-foreground">
                Your bank&rsquo;s advice quotes a buying and a selling rate; a reference
                circular or a market feed quotes a mid. They are different numbers, and
                Rule 26 of the Income-tax Rules computes the TDS on a payment in foreign
                currency from the <em>telegraphic transfer buying</em> rate only. A rate
                entered as something else will be refused for that purpose rather than
                quietly used.
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              {samePair ? (
                <span className="text-destructive">
                  {baseCurrency} to {baseCurrency} is exactly 1 and is never stored — a row
                  saying so is a row somebody could later edit to something else.
                </span>
              ) : (
                <>
                  Reads as: <span className="font-medium">1 {baseCurrency}</span> ={" "}
                  <span className="font-medium">
                    {rate.trim() === "" ? "…" : rate.trim()} {quoteCurrency}
                  </span>
                  . Stored in the direction it is published; the reverse direction is computed
                  by inversion and is labelled <em>derived</em> everywhere it is used.
                </>
              )}
            </p>

            {normalised && (
              <p className="text-xs text-muted-foreground">
                Stored as <span className="font-mono">{normalised}</span> — twelve decimal
                places, because four cannot hold the reciprocal.
              </p>
            )}
            {rateError && <p className="text-xs text-destructive">{rateError}</p>}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fx-source-ref">Where it came from</Label>
                <Input
                  id="fx-source-ref"
                  placeholder="Bank advice no. / RBI circular"
                  value={sourceReference}
                  onChange={(e) => setSourceReference(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-note">Note</Label>
                <Input
                  id="fx-note"
                  placeholder="Forward cover booked 12 Feb"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSubmit}>
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Record this rate
              </Button>
              {missingDate && (
                <span className="text-xs text-muted-foreground">
                  Choose the day the rate is for before saving.
                </span>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
