"use client";

/**
 * Ordence — ⭐⭐ EVERYTHING YOU CAN DO TO ONE LEAD
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 35)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE OF THE EIGHT ACTIONS IN `sales-leads.ts` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * `getLead`, `updateLead` and `logLeadActivity` were written, guarded and
 * tested, and nothing in the tree imported them. A lead could be created
 * by an integration and dragged between columns on the board, and that
 * was the entire set of things the product could do to it: no editing, no
 * call log, no way to open one at all — `/sales/leads/:id` was a 404 on
 * every row of the table and every card on the board.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE STAGE BUTTONS ARE DERIVED, AND FROM WHAT
 * ══════════════════════════════════════════════════════════════════════
 * `canTransition()` in `lib/sales/pipeline.ts` is pure and isomorphic,
 * and it is the SAME function `transitionLead` runs on the server. The
 * board already uses it for the same reason.
 *
 * ⚠️ IT IS NOT THE AUTHORITY, AND THAT DISTINCTION IS NOT PEDANTRY. The
 * database holds `leads_lost_has_reason`, the `leads_cp_lock` trigger and
 * the bookings check the server re-runs against live rows — this screen
 * cannot see a booking somebody registered thirty seconds ago. So the
 * screen only stops OFFERING what will be refused; it never decides that
 * something is allowed. If the two disagree, the server wins and says so.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  transitionLead,
  updateLead,
  logLeadActivity,
} from "@/server/actions/sales-leads";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  canTransition,
} from "@/lib/sales/pipeline";
import { LeadForm, type LeadFormOption, type LeadFormValues } from "@/components/sales/lead-form";
import type { LeadStatus } from "@/db/schema/sales";

/**
 * ⚠️ `status_change` and `assignment` ARE NOT OFFERED HERE.
 *
 * `transitionLead` writes those two itself, inside the same transaction
 * as the change they describe. Letting somebody hand-write one produces
 * an append-only history that says a stage moved when nothing moved —
 * and the whole point of `lead_activities` being append-only is that six
 * weeks later, in a commission dispute, it is the record nobody can tidy.
 */
const LOGGABLE = [
  ["call", "Call"],
  ["whatsapp", "WhatsApp"],
  ["email", "Email"],
  ["meeting", "Meeting"],
  ["site_visit", "Site visit"],
  ["note", "Note"],
] as const;

export function LeadDetailPanel({
  leadId,
  status,
  hasLiveBooking,
  initial,
  projects,
  partners,
  owners,
  withheld,
  canWrite,
}: {
  leadId: string;
  status: LeadStatus;
  /**
   * ⚠️ A HINT, NOT A FACT, and the same hint the board uses: a lead in
   * `booked` or `won` is holding a unit. `transitionLead` COUNTS the
   * live bookings before it allows anything, because a booking somebody
   * registered thirty seconds ago is invisible to this render. All this
   * flag does is stop the screen offering a move that would be refused.
   */
  hasLiveBooking: boolean;
  initial: LeadFormValues;
  projects: LeadFormOption[];
  partners: LeadFormOption[];
  owners: LeadFormOption[];
  withheld: string[];
  /**
   * Whether this workspace has paid for the pipeline. Read once on the
   * server with the NON-THROWING entitlement check, because a page that
   * throws on an entitlement shows an error instead of an upgrade prompt.
   */
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"lost" | "log" | "edit" | null>(null);

  /**
   * The stages this lead may move to, decided by the same rule the server
   * runs. `won` is absent from `PIPELINE_STAGES` on purpose — a lead is
   * won by registering a booking, so offering the button would produce a
   * refusal every single time it was pressed.
   */
  const reachable = PIPELINE_STAGES.filter(
    (stage) =>
      stage !== status &&
      canTransition({ from: status, to: stage, hasLiveBooking }).allowed,
  );

  /**
   * ⚠️ `lost` IS TESTED WITH A REASON ALREADY SUPPLIED.
   *
   * `canTransition` refuses `lost` without one, so asking it the plain
   * question would hide the button and the rep would have no way to
   * record a loss at all. What is being asked here is the OTHER rule —
   * whether a live booking blocks it — and the reason is then collected
   * before the action fires rather than after a rejection.
   */
  const mayLose =
    status !== "lost" &&
    canTransition({
      from: status,
      to: "lost",
      hasLiveBooking,
      lostReason: "checking the other rules",
    }).allowed;

  function move(to: LeadStatus, lostReason?: string) {
    setError(null);
    start(async () => {
      const result = await transitionLead({ id: leadId, status: to, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAsking(null);
      router.refresh();
    });
  }

  function log(formData: FormData) {
    setError(null);
    const scheduled = String(formData.get("scheduledAt") ?? "").trim();
    const occurred = String(formData.get("occurredAt") ?? "").trim();

    start(async () => {
      const result = await logLeadActivity({
        leadId,
        type: String(formData.get("type") ?? "call"),
        subject: String(formData.get("subject") ?? "").trim() || null,
        notes: String(formData.get("notes") ?? "").trim() || null,
        outcome: String(formData.get("outcome") ?? "").trim() || null,
        /**
         * ⚠️ SENT AS THE LOCAL STRING THE BROWSER PRODUCED, coerced by
         * `z.coerce.date()` on the server. Empty means "leave the
         * follow-up where it is" — sending `null` would CLEAR it, and a
         * rep who logged a note would silently un-schedule the call they
         * had booked.
         */
        scheduledAt: scheduled || undefined,
        occurredAt: occurred || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAsking(null);
      router.refresh();
    });
  }

  if (!canWrite) {
    /*
      ⚠️ AN UPGRADE PROMPT, NOT A HIDDEN PANEL. Every write below runs
      through `guardSalesWrite`, which refuses when the workspace has no
      `sales.pipeline` entitlement. Rendering the buttons anyway would
      turn a billing question into a series of identical refusals; showing
      nothing at all reads as a page that failed to load.
    */
    return (
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">
          Your plan does not include the sales pipeline, so this lead can be
          read but not worked. The record is intact and stays yours.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="font-medium">What you can do</h2>

      <div className="flex flex-wrap gap-2">
        {reachable.map((stage) => (
          <Button
            key={stage}
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => move(stage)}
          >
            Move to {STAGE_LABELS[stage].toLowerCase()}
          </Button>
        ))}

        {mayLose ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setAsking(asking === "lost" ? null : "lost")}
          >
            Mark lost
          </Button>
        ) : null}

        <Button
          type="button"
          disabled={pending}
          onClick={() => setAsking(asking === "log" ? null : "log")}
        >
          Log a call or visit
        </Button>

        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setAsking(asking === "edit" ? null : "edit")}
        >
          Edit details
        </Button>
      </div>

      {/*
        ⚠️ A LEAD WITH A LIVE BOOKING SAYS SO RATHER THAN SHOWING THREE
        BUTTONS AND NO EXPLANATION. It cannot go backwards or be lost
        while a buyer holds a unit, and "the buttons are missing" is not
        an answer anybody can act on.
      */}
      {hasLiveBooking ? (
        <p className="text-sm text-muted-foreground">
          This lead has a live booking against a unit, so it cannot move
          backwards or be marked lost. Cancel the booking first, with a
          reason — that frees the unit and releases the lead.
        </p>
      ) : null}

      {/*
        🔴 THE REASON IS COLLECTED BEFORE THE ACTION, NOT AFTER A
        REJECTION. `leads_lost_has_reason` is a database CHECK and
        `canTransition` refuses without one; firing first and surfacing the
        refusal teaches the rep to type "x" and move on, and a pipeline of
        unexplained losses teaches nobody anything.
      */}
      {asking === "lost" ? (
        <form
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          action={(fd) => move("lost", String(fd.get("lostReason") ?? ""))}
        >
          <Label htmlFor="lead-lost-reason">Why was it lost?</Label>
          <Input
            id="lead-lost-reason"
            name="lostReason"
            required
            maxLength={2000}
            placeholder="Bought a larger flat from a competitor in the same locality"
          />
          <p className="text-xs text-muted-foreground">
            Price, location, timing, or lost to a competitor. This is what the
            next quarter&apos;s pipeline review reads.
          </p>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            Mark this lead lost
          </Button>
        </form>
      ) : null}

      {asking === "log" ? (
        <form className="space-y-3 rounded-md border p-3" action={log}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="activity-type">What happened</Label>
              <select
                id="activity-type"
                name="type"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {LOGGABLE.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="activity-outcome">Outcome</Label>
              <Input
                id="activity-outcome"
                name="outcome"
                maxLength={160}
                placeholder="Asked for a corner unit quote"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="activity-subject">Subject</Label>
            <Input id="activity-subject" name="subject" maxLength={255} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="activity-notes">Notes</Label>
            <textarea
              id="activity-notes"
              name="notes"
              rows={3}
              maxLength={8000}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="activity-occurred">When it happened</Label>
              <Input id="activity-occurred" name="occurredAt" type="datetime-local" />
              <p className="text-xs text-muted-foreground">
                Leave blank for now. Backdating a call you made yesterday is
                normal; the entry cannot be edited afterwards.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="activity-scheduled">Next follow-up</Label>
              <Input id="activity-scheduled" name="scheduledAt" type="datetime-local" />
              {/*
                ⭐ SETTING THIS MOVES THE LEAD'S FOLLOW-UP DATE, in the
                same call. Without that the rep makes the call and the
                lead still shows as overdue — so they stop trusting the
                overdue list, which is the only list that matters.
              */}
              <p className="text-xs text-muted-foreground">
                Setting this moves the follow-up date on the lead itself, so it
                leaves the overdue list.
              </p>
            </div>
          </div>

          <Button type="submit" size="sm" disabled={pending}>
            Save to the history
          </Button>
        </form>
      ) : null}

      {asking === "edit" ? (
        <div className="rounded-md border p-3">
          <LeadForm
            action={updateLead}
            mode="edit"
            leadId={leadId}
            initial={initial}
            projects={projects}
            partners={partners}
            owners={owners}
            withheld={withheld}
            onDone={() => setAsking(null)}
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
