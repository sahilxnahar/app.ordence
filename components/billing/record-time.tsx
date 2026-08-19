"use client";

/**
 * Ordence — ⭐ Recording an hour
 * Version: v1.2.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FORM SHOWS WHAT WILL BE BILLED, NOT WHAT WAS TYPED
 * ══════════════════════════════════════════════════════════════════════
 * Somebody types "7m" and the client is charged for twelve minutes,
 * because the six-minute unit is the thing being sold. If that only
 * becomes visible on the invoice, the first time anybody discovers the
 * convention is when a client queries a bill.
 *
 * ⚠️ THE PREVIEW COMES OUT OF THE SAME FUNCTIONS THE SERVER USES —
 * `billableMinutes` and `timeValueMinor` from `lib/billing/time.ts`. A
 * second implementation "just for the form" is how a preview and an
 * invoice come to disagree, and the person who trusted the preview is
 * the one who has to explain it.
 *
 * ⚠️ THE RATE IS NOT PREVIEWED. It is resolved on the server against
 * the ENTRY DATE, from rows this form cannot see. Showing a guess here
 * would be worse than showing nothing — see the note beside the value.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordTimeEntry } from "@/server/actions/time-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  BILLING_INCREMENTS,
  billableMinutes,
  minutesToHoursLabel,
  parseDuration,
  type BillingIncrement,
} from "@/lib/billing/time";

const INCREMENT_LABELS: Record<BillingIncrement, string> = {
  six_minutes: "6 minutes (tenths of an hour) — the professional standard",
  fifteen_minutes: "15 minutes",
  thirty_minutes: "30 minutes",
  exact: "Exact — no rounding",
};

export function RecordTime({
  companies,
  defaultDate,
}: {
  companies: readonly { id: string; name: string }[];
  defaultDate: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState(defaultDate);
  const [companyId, setCompanyId] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");
  const [duration, setDuration] = useState("");
  const [increment, setIncrement] = useState<BillingIncrement>("six_minutes");
  const [isBillable, setIsBillable] = useState(true);
  const [narrative, setNarrative] = useState("");

  /**
   * ⚠️ PARSED, NOT VALIDATED-THEN-PARSED. "2h 30m", "2:30" and "2.5" are
   * all how people write two and a half hours, and a form that accepts
   * only one of them gets filled in wrongly rather than carefully.
   */
  const minutes = useMemo(() => parseDuration(duration), [duration]);
  const billable = useMemo(() => {
    if (minutes === null || minutes <= 0) return null;
    if (!isBillable) return 0;
    try {
      return billableMinutes(minutes, increment);
    } catch {
      return null;
    }
  }, [minutes, increment, isBillable]);

  function submit() {
    setError(null);
    setSaved(null);
    if (minutes === null || minutes <= 0) {
      setError("Enter how long it took — 2h 30m, 2:30 or 2.5 all work.");
      return;
    }
    start(async () => {
      const res = await recordTimeEntry({
        entryDate,
        minutes,
        increment,
        isBillable,
        ...(companyId ? { companyId } : {}),
        ...(subjectLabel.trim() ? { subjectLabel: subjectLabel.trim() } : {}),
        ...(narrative.trim() ? { narrative: narrative.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      /**
       * ⚠️ AN UNRATED ENTRY IS SAVED AND SAID SO. It is a question for a
       * partner, not a lost hour — but silently saving a ₹0.00 entry
       * would let a month of work reach a bill as nothing.
       */
      setSaved(
        res.data.rated
          ? "Recorded."
          : "Recorded — but no rate applies to it, so it is worth ₹0.00 until one is set.",
      );
      setDuration("");
      setNarrative("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Record time
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="te-date" required>
            Date the work was done
          </Label>
          <Input
            id="te-date"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/* The rate that applied that day is the rate it bills at. */}
            This decides which rate applies — not today&apos;s.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="te-duration" required>
            How long
          </Label>
          <Input
            id="te-duration"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="2h 30m · 2:30 · 2.5"
            className="tabular-nums"
          />
          {duration.trim() !== "" && minutes === null && (
            <p className="text-xs text-destructive">
              Not a duration. Try 2h 30m, 2:30 or 2.5.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="te-company">Client</Label>
          <Select
            id="te-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">— internal, not for a client —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="te-subject">Matter or engagement</Label>
          <Input
            id="te-subject"
            value={subjectLabel}
            onChange={(e) => setSubjectLabel(e.target.value)}
            placeholder="Arbitration — Sharma v. Kaveri Infra"
          />
          <p className="text-xs text-muted-foreground">
            {/* This is the line the client reads on the bill. */}
            One invoice line per matter, so write it the way the client should
            see it.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="te-increment">Billing unit</Label>
          <Select
            id="te-increment"
            value={increment}
            onChange={(e) => setIncrement(e.target.value as BillingIncrement)}
          >
            {(Object.keys(BILLING_INCREMENTS) as BillingIncrement[]).map((k) => (
              <option key={k} value={k}>
                {INCREMENT_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-end gap-2">
          <input
            id="te-billable"
            type="checkbox"
            checked={isBillable}
            onChange={(e) => setIsBillable(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="te-billable" className="pb-2">
            Billable to the client
          </Label>
        </div>
      </div>

      <Textarea
        value={narrative}
        onChange={(e) => setNarrative(e.target.value)}
        placeholder="Drafted written statement; conference with counsel on limitation."
        rows={2}
      />

      {/**
       * ⭐ THE ROUNDING IS SHOWN BEFORE IT IS APPLIED, NOT AFTER.
       */}
      {minutes !== null && minutes > 0 && billable !== null && (
        <div className="rounded border-l-2 border-sky-500 bg-sky-50 p-3">
          {isBillable ? (
            <>
              <p className="font-medium tabular-nums">
                {minutes} minutes worked → {billable} minutes billed (
                {minutesToHoursLabel(billable)} on the bill)
              </p>
              {billable > minutes && (
                <p className="mt-1 text-muted-foreground">
                  {/* Rounding UP is the engagement-letter convention. */}
                  Rounded up to the next whole {BILLING_INCREMENTS[increment]}
                  -minute unit, because the unit is what is sold.
                </p>
              )}
            </>
          ) : (
            <p className="font-medium">
              {minutes} minutes worked, none of it billed. It still counts
              towards how much of the day was recoverable.
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {/**
             * ⚠️ DELIBERATELY NOT PREVIEWED. The rate is resolved on the
             * server against the entry date and the client's engagement
             * letter — showing a house rate here would be a number the
             * form cannot stand behind.
             */}
            The rupee value is worked out on saving, from the rate that applied
            on {entryDate || "that date"}.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-700">{saved}</p>}

      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save entry"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
