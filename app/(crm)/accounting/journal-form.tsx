"use client";

/**
 * Ordence — Double-Entry Journal Form
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SUBMIT BUTTON IS DISABLED UNTIL DEBITS EQUAL CREDITS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The database already refuses unbalanced transactions (Phase 4's deferred
 * trigger). This form's job is different: to make the imbalance *visible while
 * the user is still typing*, so they never submit something that will fail.
 *
 * Balance is computed in BigInt paise, exactly as the server does. Using
 * JavaScript floats here would let the button enable on a total that the
 * database then rejects — the UI would say balanced and the server would
 * disagree, which is far more confusing than a plain error.
 *
 * The button being disabled is a convenience, NOT the control. A user with
 * dev-tools can re-enable it; the server action and the database trigger will
 * still refuse. Three layers, in that order of politeness.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Scale, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { postTransaction } from "@/server/actions/accounting";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* EXACT DECIMAL ARITHMETIC — mirrors the server                       */
/* ------------------------------------------------------------------ */

/** Parse a user-typed amount into integer paise. Returns null if unusable. */
function toPaise(input: string): bigint | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!trimmed) return null;
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function fromPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function formatINR(paise: bigint): string {
  const asNumber = Number(paise) / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(asNumber);
}

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type LedgerOption = {
  id: string;
  code: string;
  name: string;
  type: string;
};

type LegRow = {
  ledgerId: string;
  entryType: "debit" | "credit";
  amount: string;
  description: string;
};

type JournalFormValues = {
  description: string;
  transactionDate: string;
  transactionNumber: string;
  referenceType: string;
  legs: LegRow[];
};

const REFERENCE_TYPES = [
  { value: "journal", label: "Journal Entry" },
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "invoice", label: "Invoice" },
  { value: "adjustment", label: "Adjustment" },
  { value: "opening_balance", label: "Opening Balance" },
] as const;

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function JournalEntryForm({
  ledgers,
  lockedDates,
}: {
  ledgers: LedgerOption[];
  /** Closed period ranges, so the date picker can warn before submission. */
  lockedDates: Array<{ name: string; startDate: string; endDate: string }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();

  const { register, control, handleSubmit, watch, reset, formState } =
    useForm<JournalFormValues>({
      defaultValues: {
        description: "",
        transactionDate: new Date().toISOString().slice(0, 10),
        transactionNumber: "",
        referenceType: "journal",
        legs: [
          { ledgerId: "", entryType: "debit", amount: "", description: "" },
          { ledgerId: "", entryType: "credit", amount: "", description: "" },
        ],
      },
      mode: "onChange",
    });

  const { fields, append, remove } = useFieldArray({ control, name: "legs" });

  // ══════════════════════════════════════════════════════════════
  // WHY `useWatch` AND NOT `watch("legs")`
  // ══════════════════════════════════════════════════════════════
  // `watch(name)` does not reliably re-render on changes to a field
  // array managed by `useFieldArray` — it can keep handing back the
  // value the array was initialised with.
  //
  // That failure is silent and it is severe. The running balance would
  // read ZERO no matter what was typed, so `isBalanced` never became
  // true and the submit button could never enable: a form that looks
  // finished and simply refuses to post, with nothing on screen
  // explaining why.
  //
  // `useWatch` subscribes to the field array properly and re-renders on
  // every keystroke, which is exactly what a live balance needs.
  // Caught by tests/ui/journal-balance.test.tsx.
  const legs = useWatch({ control, name: "legs" });
  const transactionDate = useWatch({ control, name: "transactionDate" });

  /* ---- Live balance, computed in exact paise -------------------- */
  const balance = React.useMemo(() => {
    let debits = 0n;
    let credits = 0n;
    let hasInvalidAmount = false;
    let filledLegs = 0;

    for (const leg of legs ?? []) {
      if (!leg?.amount?.trim()) continue;
      const paise = toPaise(leg.amount);
      if (paise === null) {
        hasInvalidAmount = true;
        continue;
      }
      if (paise <= 0n) {
        hasInvalidAmount = true;
        continue;
      }
      filledLegs++;
      if (leg.entryType === "debit") debits += paise;
      else credits += paise;
    }

    const difference = debits - credits;

    return {
      debits,
      credits,
      difference,
      isBalanced: difference === 0n && debits > 0n,
      hasInvalidAmount,
      filledLegs,
    };
  }, [legs]);

  /* ---- Is the chosen date inside a closed period? --------------- */
  const lockedPeriod = React.useMemo(() => {
    if (!transactionDate) return null;
    return (
      lockedDates.find((p) => transactionDate >= p.startDate && transactionDate <= p.endDate) ?? null
    );
  }, [transactionDate, lockedDates]);

  /* ---- Every condition that must hold before submitting --------- */
  const allLegsHaveLedger = (legs ?? []).every((l) => !l?.amount?.trim() || l.ledgerId);
  const canSubmit =
    balance.isBalanced &&
    !balance.hasInvalidAmount &&
    balance.filledLegs >= 2 &&
    allLegsHaveLedger &&
    !lockedPeriod;

  const blockedReason = (() => {
    if (lockedPeriod) return `${transactionDate} is inside the closed period "${lockedPeriod.name}".`;
    if (balance.hasInvalidAmount) return "One or more amounts are not valid positive numbers.";
    if (balance.filledLegs < 2) return "A transaction needs at least two entries.";
    if (!allLegsHaveLedger) return "Every entry with an amount needs a ledger.";
    if (!balance.isBalanced) {
      return `Out of balance by ${formatINR(balance.difference < 0n ? -balance.difference : balance.difference)}.`;
    }
    return undefined;
  })();

  /* ---- Submit ---------------------------------------------------- */
  const onSubmit = handleSubmit((values) => {
    startTransition(async () => {
      const usableLegs = values.legs
        .filter((l) => l.amount.trim() && l.ledgerId)
        .map((l) => ({
          ledgerId: l.ledgerId,
          entryType: l.entryType,
          amount: fromPaise(toPaise(l.amount) ?? 0n),
          description: l.description || undefined,
        }));

      const result = await postTransaction({
        description: values.description,
        transactionDate: values.transactionDate,
        transactionNumber: values.transactionNumber || undefined,
        referenceType: values.referenceType as "journal",
        currency: "INR",
        legs: usableLegs,
      });

      if (result.ok) {
        toast.success(
          `Transaction posted — ${result.data.legCount} entries, ₹${result.data.totalAmount}.`,
        );
        reset();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-4 w-4" aria-hidden="true" />
          New Journal Entry
        </CardTitle>
        <CardDescription>
          Debits must equal credits. The Post button unlocks only when they do.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-5">
          {/* ---- Header fields ------------------------------------ */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="je-description" required>Description</Label>
              <Input
                id="je-description"
                placeholder="e.g. Booking advance received — Unit A-1204"
                {...register("description", { required: true, maxLength: 1000 })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="je-date" required>Date</Label>
              <Input
                id="je-date"
                type="date"
                aria-invalid={lockedPeriod ? true : undefined}
                className={lockedPeriod ? "border-destructive" : undefined}
                {...register("transactionDate", { required: true })}
              />
              {lockedPeriod && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  Inside closed period &ldquo;{lockedPeriod.name}&rdquo;
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="je-type">Type</Label>
              <Select id="je-type" {...register("referenceType")}>
                {REFERENCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </Select>
            </div>
          </div>

          {/* ---- Legs --------------------------------------------- */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Entries</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ ledgerId: "", entryType: "debit", amount: "", description: "" })}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add entry
              </Button>
            </div>

            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Journal entry lines</caption>
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Ledger</th>
                    <th scope="col" className="w-28 px-3 py-2 font-medium">Type</th>
                    <th scope="col" className="w-40 px-3 py-2 text-right font-medium">Amount (₹)</th>
                    <th scope="col" className="px-3 py-2 font-medium">Note</th>
                    <th scope="col" className="w-12 px-3 py-2"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <Select aria-label={`Ledger for entry ${index + 1}`} {...register(`legs.${index}.ledgerId`)}>
                          <option value="">Select ledger…</option>
                          {ledgers.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.code} — {l.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-3 py-1.5">
                        <Select aria-label={`Type for entry ${index + 1}`} {...register(`legs.${index}.entryType`)}>
                          <option value="debit">Debit</option>
                          <option value="credit">Credit</option>
                        </Select>
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          type="text"
                          inputMode="decimal"
                          placeholder="0.00"
                          aria-label={`Amount for entry ${index + 1}`}
                          className="text-right tabular-nums"
                          {...register(`legs.${index}.amount`)}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          placeholder="Optional"
                          aria-label={`Note for entry ${index + 1}`}
                          {...register(`legs.${index}.description`)}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(index)}
                          disabled={fields.length <= 2}
                          aria-label={`Remove entry ${index + 1}`}
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- Live balance indicator ---------------------------- */}
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3",
              balance.isBalanced
                ? "border-primary/40 bg-primary/5"
                : "border-destructive/40 bg-destructive/5",
            )}
            // Announced to screen readers as the totals change.
            role="status"
            aria-live="polite"
          >
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Debits</span>
                <p className="font-semibold tabular-nums">{formatINR(balance.debits)}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Credits</span>
                <p className="font-semibold tabular-nums">{formatINR(balance.credits)}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Difference</span>
                <p
                  className={cn(
                    "font-semibold tabular-nums",
                    balance.difference === 0n ? "text-primary" : "text-destructive",
                  )}
                >
                  {formatINR(balance.difference < 0n ? -balance.difference : balance.difference)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm font-medium">
              {balance.isBalanced ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
                  <span className="text-primary">Balanced</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
                  <span className="text-destructive">Out of balance</span>
                </>
              )}
            </div>
          </div>

          {/* ---- Actions ------------------------------------------- */}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            {blockedReason && (
              <p className="mr-auto text-xs text-destructive" role="status">
                {blockedReason}
              </p>
            )}
            <Button type="button" variant="outline" onClick={() => reset()} disabled={isPending}>
              Clear
            </Button>
            <Button
              type="submit"
              // ── THE GATE ──
              disabled={!canSubmit || isPending || !formState.isValid}
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? "Posting…" : "Post Transaction"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
