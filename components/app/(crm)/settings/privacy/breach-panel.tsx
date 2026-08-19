"use client";

/**
 * ⭐ THE BREACH REGISTER, AND THE FOUR CLOCKS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY FOUR ROWS AND NOT ONE "REPORTED" TICK
 * ══════════════════════════════════════════════════════════════════════
 * A workspace that filed with CERT-In inside six hours and told nobody
 * else has met one duty of four. A single tick would let that read as
 * compliance, on the screen somebody looks at during the worst week of
 * their year.
 *
 * ⚠️ AND TWO OF THE FOUR ARE NOT YET IN FORCE. The DPDP Rules 2025
 * commence around May 2027; CERT-In's six hours binds today. The panel
 * says which is which rather than showing a deadline that is not one.
 */

import { useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { recordBreachIntimation } from "@/server/actions/dpdp";
import { cn } from "@/lib/utils";

type Deadline = { duty: string; provision: string; dueBy: Date | string; state: string };

type Breach = {
  id: string;
  reference: string;
  breachClass: string;
  status: string;
  noticedAt: Date | string;
  overdue: number;
  deadlines: Deadline[];
  blockers: string[];
  missing: string[];
};

const STATE_STYLE: Record<string, string> = {
  done: "text-emerald-700 dark:text-emerald-300",
  due: "text-amber-700 dark:text-amber-300",
  overdue: "font-semibold text-red-700 dark:text-red-300",
  "not-yet-in-force": "text-muted-foreground",
};

const STATE_LABEL: Record<string, string> = {
  done: "done",
  due: "due",
  overdue: "OVERDUE",
  "not-yet-in-force": "not yet in force",
};

export function BreachPanel({ breaches }: { breaches: Breach[] }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function mark(id: string, audience: "certin" | "board" | "board_detailed") {
    setBusy(id);
    try {
      const result = await recordBreachIntimation({ id, audience, text: null });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.data.blockers.length > 0
          ? `Recorded. ${result.data.blockers.length} thing(s) still stop this being closed.`
          : "Recorded.",
      );
    } catch {
      toast.error("That could not be recorded. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  if (breaches.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No personal data breaches recorded. Rule 7 of the DPDP Rules 2025 has no
        materiality threshold — every personal data breach is reportable, and
        both clocks start when you NOTICE it, not when you are sure.
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-4">
      {breaches.map((b) => (
        <li key={b.id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {b.reference}
              {b.overdue > 0 ? (
                <span className="ml-2 inline-flex items-center gap-1 text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {b.overdue} overdue
                </span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {b.status} ·{" "}
              {b.breachClass === "anticipatory"
                ? "raised before the DPDP Rules commence"
                : "under the DPDP Rules 2025"}
            </p>
          </div>

          <ul className="mt-2 space-y-1">
            {b.deadlines.map((d) => (
              <li key={d.duty} className="flex flex-wrap items-baseline gap-2 text-xs">
                <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="font-medium">{d.duty}</span>
                <span className={cn(STATE_STYLE[d.state] ?? "")}>
                  {STATE_LABEL[d.state] ?? d.state}
                </span>
                <span className="text-muted-foreground">
                  by {new Date(d.dueBy).toISOString().replace("T", " ").slice(0, 16)} — {d.provision}
                </span>
              </li>
            ))}
          </ul>

          {b.missing.length > 0 ? (
            <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              The intimation cannot be sent yet: Rule 7 requires {b.missing.join("; ")}.
            </p>
          ) : null}

          {b.blockers.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
              {b.blockers.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ["certin", "Reported to CERT-In"],
                ["board", "Board intimated"],
                ["board_detailed", "Detailed report filed"],
              ] as const
            ).map(([audience, label]) => (
              <button
                key={audience}
                type="button"
                onClick={() => mark(b.id, audience)}
                disabled={busy !== null}
                className={cn(
                  "rounded-md border border-border px-2 py-1 text-xs font-medium",
                  "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                )}
              >
                {label}
              </button>
            ))}
            {/*
              ⚠️ NO BUTTON FOR "PRINCIPALS INTIMATED".
              That one requires the text exactly as sent, which is a form
              and not a click. `recordBreachIntimation` refuses it without
              the text and 0113 has a CHECK constraint behind that — a
              button here would be a button that produces an error.
            */}
          </div>
        </li>
      ))}
    </ul>
  );
}
