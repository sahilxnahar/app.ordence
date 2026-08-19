"use client";

/**
 * Ordence — ⭐ THE BUDGET EDITOR
 * Version: v1.47.0-alpha · Batch 68
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CLOSED PERIOD RENDERS NO INPUT AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Not a disabled input, and not an input that submits and then fails.
 * A disabled field invites somebody to work out why and go looking for
 * the setting that re-enables it; an input that fails on submit teaches
 * that the product is unreliable. The field is replaced by the figure
 * and one sentence saying the period is closed and what to do about it.
 *
 * ⚠️ AND HIDING THE FIELD IS A COURTESY, NOT A CONTROL. The server
 * action refuses the write, and a BEFORE trigger on `budget_lines`
 * refuses it again — see 0084 §5. Three layers, because the reason
 * matters: this one is for the person, the action's is for the sentence,
 * and the trigger's is for the script nobody has written yet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE AMOUNT IS A TEXT INPUT AND IT IS SENT AS A STRING
 * ══════════════════════════════════════════════════════════════════════
 * `<input type="number">` hands JavaScript a `number`, and a number is
 * an IEEE-754 double: `Math.round(Number("1.005") * 100)` is 100, not
 * 101. Money never becomes a float in this product, and the boundary
 * where that rule is usually broken is exactly here — a form field.
 * `parseBudgetAmount` in `lib/accounting/budget.ts` parses the string
 * into `bigint` paise, on the server, with no double in between.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UNCOSTED_KEY, UNCOSTED_LABEL } from "@/lib/accounting/cost-centre";
import { inrFromMinor } from "./variance-table";

export type BudgetLedgerOption = {
  id: string;
  code: string;
  name: string;
  accountType: string;
};

export type BudgetCentreOption = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
};

export type ExistingBudgetLine = {
  id: string;
  ledgerId: string;
  costCentreKey: string;
  amountMinor: string;
};

type Saved = { ok: true } | { ok: false; error: string };

export function BudgetEditor({
  periodId,
  periodLabel,
  periodIsOpen,
  periodStatus,
  ledgers,
  centres,
  lines,
  mayEdit,
  onSave,
}: {
  periodId: string;
  periodLabel: string;
  periodIsOpen: boolean;
  periodStatus: string;
  ledgers: readonly BudgetLedgerOption[];
  centres: readonly BudgetCentreOption[];
  lines: readonly ExistingBudgetLine[];
  mayEdit: boolean;
  onSave: (input: {
    periodId: string;
    ledgerId: string;
    costCentreKey: string;
    amount: string;
  }) => Promise<Saved>;
}) {
  const router = useRouter();
  const [ledgerId, setLedgerId] = React.useState(ledgers[0]?.id ?? "");
  /**
   * ⭐ THE DEFAULT IS THE UN-COSTED BUCKET, NOT THE FIRST DEPARTMENT.
   * Defaulting to a real cost centre means somebody who does not read
   * the field silently assigns a budget to whichever department happened
   * to sort first — and that department's manager then argues with a
   * number nobody typed.
   */
  const [costCentreKey, setCostCentreKey] = React.useState<string>(UNCOSTED_KEY);
  const [amount, setAmount] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  const existing = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const l of lines) map.set(`${l.ledgerId}::${l.costCentreKey}`, l.amountMinor);
    return map;
  }, [lines]);

  const currentValue = existing.get(`${ledgerId}::${costCentreKey}`) ?? null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave({ periodId, ledgerId, costCentreKey, amount });
      if (result.ok) {
        toast.success("Budget saved.");
        setAmount("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  if (!periodIsOpen) {
    return (
      <div className="rounded-md border border-border bg-muted/20 p-4 text-sm">
        <p className="font-medium">
          The budget for {periodLabel} is frozen — the period is {periodStatus}.
        </p>
        {/*
          🔴 THE SENTENCE SAYS WHY, NOT JUST WHAT. "Read-only" invites a
          support ticket. This tells the reader that a budget which can
          still move is a variance that changes after it has been
          explained, which is an argument they can either accept or
          deliberately override by reopening the period — which is
          audited.
        */}
        <p className="mt-1 text-xs text-muted-foreground">
          The actuals for a closed period are frozen, so the budget they are measured
          against is frozen too. A budget that can still move is a variance that
          changes after somebody has explained it. Reopen the period if the figure is
          genuinely wrong — that is recorded in the audit log.
        </p>
      </div>
    );
  }

  if (!mayEdit) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        You can see this budget but not change it.
      </p>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Account
        <select
          value={ledgerId}
          onChange={(e) => setLedgerId(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          {ledgers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} — {l.name} ({l.accountType})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Cost centre
        <select
          value={costCentreKey}
          onChange={(e) => setCostCentreKey(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          {/*
            ⚠️ THE UN-COSTED BUCKET IS AN OPTION AND IT IS FIRST, because
            it is where every actual sits until somebody starts coding
            journal lines. A budget that could only be set against a
            department would have nothing to compare those actuals to.
          */}
          <option value={UNCOSTED_KEY}>{UNCOSTED_LABEL}</option>
          {centres
            .filter((c) => c.isActive)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Amount (₹)
        {/*
          ⚠️ type="text", NOT type="number". See the header — a number
          input hands JavaScript a double and money is never a float here.
          inputMode keeps the numeric keypad on a phone.
        */}
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={currentValue === null ? "0.00" : inrFromMinor(currentValue)}
          className="w-44 text-right font-mono"
          required
        />
      </label>

      <Button type="submit" disabled={isPending || ledgers.length === 0}>
        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {currentValue === null ? "Set budget" : "Replace budget"}
      </Button>

      <p className="w-full text-xs text-muted-foreground">
        {currentValue === null
          ? "Nothing is budgeted for this combination yet. Zero is a legitimate answer and means “we decided to spend nothing” — which the report shows differently from no budget at all."
          : `Currently ${inrFromMinor(currentValue)}. Saving replaces it; the previous figure stays in the audit log.`}
      </p>
    </form>
  );
}
