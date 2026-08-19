"use client";

/**
 * Ordence — ⭐⭐ THE DUNNING LADDER
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EACH RUNG MUST COME STRICTLY AFTER THE ONE BEFORE IT
 * ══════════════════════════════════════════════════════════════════════
 * The server's own message says why, and it is worth repeating on the
 * form: otherwise the sweep sends two letters on the same morning, which
 * "reads to the buyer as a machine and to the Authority as a developer
 * who never gave them a chance."
 *
 * The check is mirrored here so the person sees it while they are still
 * looking at all four numbers, rather than after a round trip that tells
 * them one of them is wrong.
 *
 * ⚠️ `minGapDays` IS NOT THE SAME CHECK. The rungs are measured from the
 * DUE DATE; the gap is the minimum between two letters actually sent. A
 * ladder that satisfies the ordering can still fire twice in a week for
 * a demand that was raised late, and the gap is what stops that.
 */

import { useState, useTransition } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function DunningPolicyForm(props: {
  save: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [name, setName] = useState("");
  const [preDue, setPreDue] = useState("3");
  const [reminder, setReminder] = useState("7");
  const [first, setFirst] = useState("21");
  const [final, setFinal] = useState("45");
  const [cancellation, setCancellation] = useState("75");
  const [minGap, setMinGap] = useState("7");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ordered =
    Number(reminder) < Number(first) &&
    Number(first) < Number(final) &&
    Number(final) < Number(cancellation);

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.save({
        name,
        preDueReminderDays: Number(preDue),
        reminderAfterDays: Number(reminder),
        firstNoticeAfterDays: Number(first),
        finalNoticeAfterDays: Number(final),
        cancellationWarningAfterDays: Number(cancellation),
        minGapDays: Number(minGap),
        isActive: true,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Ladder saved.");
      setName("");
    });
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Add a dunning ladder</h2>
      <p className="text-sm text-muted-foreground">
        Days measured from the demand&rsquo;s due date. Each step must come strictly after the
        one before it.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm sm:col-span-3">
          <span className="font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Standard ladder"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        {[
          ["Courtesy reminder before due", preDue, setPreDue, "Days BEFORE the due date. Zero to send none."],
          ["Reminder after", reminder, setReminder, null],
          ["First notice after", first, setFirst, null],
          ["Final notice after", final, setFinal, null],
          ["Cancellation warning after", cancellation, setCancellation, null],
          ["Minimum gap between letters", minGap, setMinGap, "Stops two letters landing in one week when a demand was raised late."],
        ].map(([label, value, setter, hint]) => (
          <label key={label as string} className="space-y-1 text-sm">
            <span className="font-medium">{label as string}</span>
            <input
              type="number"
              min={0}
              value={value as string}
              onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {hint && <span className="block text-xs text-muted-foreground">{hint as string}</span>}
          </label>
        ))}
      </div>

      {!ordered && (
        <p className="text-sm text-destructive">
          Each step must come strictly after the one before it. Otherwise the sweep sends two
          letters on the same morning, which reads to the buyer as a machine and to the
          Authority as a developer who never gave them a chance.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={pending || name.trim() === "" || !ordered}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save the ladder"}
      </button>
    </section>
  );
}
