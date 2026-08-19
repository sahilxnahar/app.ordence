"use client";

/**
 * Ordence — ⭐⭐ THE INTEREST POLICY
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY FIELD HERE ENDS UP ON A LEGAL DOCUMENT
 * ══════════════════════════════════════════════════════════════════════
 *   interestRateBps       what we charge
 *   referenceRateBps      what a forum will compare it against. The
 *                         server returns `rateFlagged` and a sentence
 *                         when the first exceeds the second, and that
 *                         sentence is shown verbatim.
 *   appropriationOrder    interest first or principal first. Under
 *                         Section 60 of the Contract Act this is OURS to
 *                         choose only when the buyer gave no direction ,
 *                         and it decides how long a debt takes to clear.
 *   graceForgivesElapsed  whether the grace period, once exceeded,
 *                         forgives the days inside it or not. Two
 *                         defensible readings, and the choice has to be
 *                         made once and written down rather than
 *                         re-argued per demand.
 *
 * ⚠️ RATES ARE ENTERED AS PERCENTAGES AND STORED AS BASIS POINTS. 18%
 * is 1800 bps. Showing bps to the person setting a policy would be
 * precise and unreadable; storing percentages would lose the quarter
 * point that an 18.25% clause needs.
 */

import { useState, useTransition } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const COMPOUNDING = ["simple", "monthly", "quarterly", "annually"] as const;
const DAY_COUNTS = ["actual_365", "actual_360", "thirty_360"] as const;

export function ReceivablePolicyForm(props: {
  save: (
    input: unknown,
  ) => Promise<Result<{ id: string; rateFlagged: boolean; rateMessage: string }>>;
}) {
  const [name, setName] = useState("");
  const [interestPct, setInterestPct] = useState("18");
  const [referencePct, setReferencePct] = useState("18");
  const [compounding, setCompounding] = useState<string>("simple");
  const [dayCount, setDayCount] = useState<string>("actual_365");
  const [graceDays, setGraceDays] = useState("7");
  const [graceForgives, setGraceForgives] = useState(false);
  const [demandDueDays, setDemandDueDays] = useState("15");
  const [gstPct, setGstPct] = useState("18");
  const [appropriationOrder, setAppropriationOrder] = useState<string>("interest_first");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Percent to basis points, without a float in the middle. */
  function bps(percent: string): number {
    return Math.round(Number(percent) * 100);
  }

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.save({
        name,
        interestRateBps: bps(interestPct),
        referenceRateBps: bps(referencePct),
        compounding,
        dayCount,
        graceDays: Number(graceDays),
        graceForgivesElapsedDays: graceForgives,
        demandDueDays: Number(demandDueDays),
        gstRateBps: bps(gstPct),
        appropriationOrder,
        defaultAllocationStrategy: "oldest_first",
        isActive: true,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      /*
        ⭐ THE FLAG IS SURFACED, NOT SWALLOWED. The policy saved either
        way; the sentence is what tells the person what they have just
        committed to.
      */
      setNotice(
        result.data.rateFlagged
          ? `Saved. ⚠️ ${result.data.rateMessage}`
          : "Saved.",
      );
      setName("");
    });
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Add an interest policy</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm sm:col-span-3">
          <span className="font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Standard terms, residential"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Interest rate (% a year)</span>
          <input
            value={interestPct}
            onChange={(e) => setInterestPct(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Reference rate (% a year)</span>
          <input
            value={referencePct}
            onChange={(e) => setReferencePct(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            What a forum will compare ours against. A demand above it is routinely set aside
            in full rather than reduced.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">GST on interest (%)</span>
          <input
            value={gstPct}
            onChange={(e) => setGstPct(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Compounding</span>
          <select
            value={compounding}
            onChange={(e) => setCompounding(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {COMPOUNDING.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Day count</span>
          <select
            value={dayCount}
            onChange={(e) => setDayCount(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {DAY_COUNTS.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, "/")}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Appropriation order</span>
          <select
            value={appropriationOrder}
            onChange={(e) => setAppropriationOrder(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="interest_first">Interest first</option>
            <option value="principal_first">Principal first</option>
          </select>
          <span className="block text-xs text-muted-foreground">
            Only ours to choose when the buyer gave no direction. It decides how long a debt
            takes to clear.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Grace days</span>
          <input
            type="number"
            min={0}
            max={365}
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Demand due in (days)</span>
          <input
            type="number"
            min={0}
            max={365}
            value={demandDueDays}
            onChange={(e) => setDemandDueDays(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={graceForgives}
          onChange={(e) => setGraceForgives(e.target.checked)}
        />
        <span>
          <span className="block">The grace period forgives the days inside it</span>
          <span className="block text-xs text-muted-foreground">
            Both readings are defensible. On: interest runs from the end of the grace period.
            Off: once the grace period is exceeded, interest runs from the due date. Decide
            once here rather than per demand.
          </span>
        </span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm">{notice}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={pending || name.trim() === ""}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save the policy"}
      </button>
    </section>
  );
}
