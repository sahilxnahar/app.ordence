"use client";

/**
 * Ordence — 🔴🔴🔴 DEFINING A FINANCIAL PERIOD
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE DEFECT THIS CLOSES IS NOT A MISSING FEATURE. IT IS A
 *        CONTROL THAT COULD NOT FIRE.
 * ══════════════════════════════════════════════════════════════════════
 * `createFinancialPeriod` has existed in `server/actions/periods.ts`
 * since Phase 5. It is the ONLY insert into `financial_periods` anywhere
 * in this product, and until this file nothing called it. Not a screen,
 * not a route, not a job, not a seed.
 *
 * ⚠️ MEANWHILE THREE SCREENS CALL `closeFinancialPeriod`, one calls
 * `reopenFinancialPeriod`, and two list periods. You could close a
 * period. You could not create one. The accounting page rendered "No
 * periods defined yet" to every tenant, for ever.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THIS IS THE PART THAT MATTERS: THE PERIOD LOCK READS THAT TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `closedPeriodFor()` in `server/accounting/post-sales.ts` runs
 *
 *     SELECT name FROM financial_periods
 *      WHERE tenant_id = $1 AND $2::date BETWEEN start_date AND end_date
 *        AND status IN ('closed', 'locked')
 *
 * on every single posting. Against an empty table it ALWAYS RETURNS
 * NULL. So every period-lock guarantee in this codebase has been vacuous
 * in production since the day it was written:
 *
 *   • `writePosting`'s `period_closed` outcome, since v1.21.0
 *   • `0073`'s database-side lock
 *   • `0100`'s depreciation lock
 *   • Brief D's `journal_entries_period_lock` trigger in `0108`
 *   • `0102`'s reconciliation lock
 *   • and the refusal in `0112` telling an operator to reopen a closed
 *     period, which could never appear
 *
 * ⭐ NONE OF THOSE WERE WRONG. Every one of them is correct code that
 * reads a table one missing form kept empty. That is a worse failure
 * than a bug, because a bug shows up. This showed up as a product where
 * nothing was ever refused.
 *
 * ⚠️ THE OVERLAP CHECK IS THE SERVER'S, NOT THIS FORM'S. The action
 * checks in the application for a readable message and the database has
 * an exclusion constraint as the actual guarantee. Repeating the check
 * here would be a third opinion that can disagree with both.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const BLANK = {
  name: "",
  startDate: "",
  endDate: "",
  fiscalYear: "",
  periodNumber: "",
};

/**
 * ⭐ THE INDIAN FINANCIAL YEAR, OFFERED AS A STARTING POINT AND NOT
 * IMPOSED. April to March. A month picked here fills the three fields
 * below and every one of them stays editable, because a company with a
 * different book-closing convention is not wrong and should not have to
 * fight a helper.
 */
function monthPreset(isoMonth: string): {
  name: string;
  startDate: string;
  endDate: string;
  fiscalYear: string;
  periodNumber: string;
} | null {
  const m = /^(\d{4})-(\d{2})$/.exec(isoMonth);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;

  /**
   * ⚠️ `new Date(y, m, 0)` IS THE LAST DAY OF MONTH `m`, INCLUDING
   * FEBRUARY IN A LEAP YEAR. Hard-coding 30 or 31 is the classic way a
   * period ends a day short and a transaction dated the 31st falls
   * outside every period there is — which, with the lock reading
   * BETWEEN, would silently let a posting through into a closed month.
   */
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");

  /**
   * ⚠️ THE FY LABEL TURNS OVER IN APRIL, NOT IN JANUARY. March 2027 is
   * FY 2026-27; April 2027 is FY 2027-28. Getting this backwards puts a
   * whole quarter in the wrong year on every statutory report that
   * groups by it.
   */
  const fyStart = month >= 4 ? year : year - 1;
  const fiscalYear = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
  /** April is period 1. */
  const periodNumber = month >= 4 ? month - 3 : month + 9;

  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return {
    name: label,
    startDate: `${year}-${pad(month)}-01`,
    endDate: `${year}-${pad(month)}-${pad(last)}`,
    fiscalYear,
    periodNumber: String(periodNumber),
  };
}

export function CreatePeriodForm({
  createAction,
  disabled,
  disabledReason,
}: {
  createAction: (input: {
    name: string;
    startDate: string;
    endDate: string;
    fiscalYear?: string;
    periodNumber?: number;
  }) => Promise<Result<{ id: string; name: string }>>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function applyPreset(isoMonth: string) {
    const preset = monthPreset(isoMonth);
    if (preset) setForm(preset);
  }

  function submit() {
    setFieldErrors({});
    startTransition(async () => {
      const res = await createAction({
        name: form.name.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        fiscalYear: form.fiscalYear.trim() || undefined,
        periodNumber: form.periodNumber ? Number(form.periodNumber) : undefined,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(
        `"${res.data.name}" is open. Postings dated inside it are permitted until it is closed, and refused once it is.`,
      );
      setForm({ ...BLANK });
      setOpen(false);
    });
  }

  if (disabled) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        {disabledReason ??
          "Your role does not include permission to define a period."}
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Define a period
      </Button>
    );
  }

  const ready =
    form.name.trim() !== "" && form.startDate !== "" && form.endDate !== "";

  return (
    <div className="space-y-4 rounded-md border border-border p-4 text-sm">
      <div className="space-y-1">
        <Label htmlFor="period-preset">Start from a month</Label>
        <Input
          id="period-preset"
          type="month"
          onChange={(e) => applyPreset(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Fills the four fields below with the Indian financial year
          convention, April to March. Every one of them stays editable, so a
          different book-closing convention is not fought with.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="period-name">Name</Label>
          <Input
            id="period-name"
            value={form.name}
            placeholder="March 2027"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {/**
           * ⚠️ THE NAME IS WHAT A REFUSAL SAYS BACK. `closedPeriodFor`
           * returns this string and it is printed verbatim to whoever
           * tried to post — "that period is closed" with no name is a
           * refusal nobody can act on.
           */}
          <p className="text-xs text-muted-foreground">
            This is the name a refused posting will quote back.
          </p>
          {fieldErrors.name?.map((m) => (
            <p key={m} className="text-xs text-destructive">
              {m}
            </p>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="period-fy">Fiscal year</Label>
          <Input
            id="period-fy"
            value={form.fiscalYear}
            placeholder="2026-27"
            onChange={(e) => setForm({ ...form, fiscalYear: e.target.value })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="period-start">First day</Label>
          <Input
            id="period-start"
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
          {fieldErrors.startDate?.map((m) => (
            <p key={m} className="text-xs text-destructive">
              {m}
            </p>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="period-end">Last day</Label>
          <Input
            id="period-end"
            type="date"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
          {/**
           * 🔴 INCLUSIVE, AND THE COPY SAYS SO. The lock reads `BETWEEN
           * start_date AND end_date`, which includes both ends. A period
           * ending on the 30th of a 31-day month leaves the 31st outside
           * every period there is, and a posting on that date is
           * permitted into a month everybody believes is shut.
           */}
          <p className="text-xs text-muted-foreground">
            Inclusive. A posting dated on this day is inside the period.
          </p>
          {fieldErrors.endDate?.map((m) => (
            <p key={m} className="text-xs text-destructive">
              {m}
            </p>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending || !ready} onClick={submit}>
          Create the period
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setForm({ ...BLANK });
            setFieldErrors({});
          }}
        >
          Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        ⚠️ Periods may not overlap. The server refuses an overlapping range and
        names the period it collides with; the database has an exclusion
        constraint behind that as the actual guarantee.
      </p>
    </div>
  );
}

/** ⭐ Exported for the test that asserts the leap-year and April rules. */
export { monthPreset };
