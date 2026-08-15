"use client";

/**
 * Ordence — ⭐⭐ THE ORDER LIFECYCLE, REACHABLE AT LAST
 * Version: v1.41.0-alpha (Mega-wave 1, Batch 34)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ELEVEN OF TWELVE ACTIONS IN `orders.ts` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * 1,288 lines implementing confirmation with credit assessment,
 * amendment with revisions, cancellation with a mandatory reason, hold
 * and release, close, fulfilment recording and delivery. Only
 * `listOrders` was imported anywhere. There was a list of orders that
 * could not be created, confirmed, amended, held or cancelled.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE BUTTONS ARE DERIVED FROM STATUS RATHER THAN ALWAYS SHOWN
 * ══════════════════════════════════════════════════════════════════════
 * The legal transitions are enforced by triggers in
 * `SQL-FILES/0028_phase39_orders.sql`, not here, and that is correct:
 * this is one write path of several.
 *
 * ⚠️ BUT SHOWING A BUTTON THAT THE DATABASE WILL REFUSE IS ITS OWN BUG.
 * An operator who presses "Confirm" on a cancelled order and is told
 * "that change is not allowed" learns nothing about what IS allowed, and
 * the next thing they try is the same button again. So the screen offers
 * only what the status permits, and the database remains the authority.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = { ok: true; data: unknown } | { ok: false; error: string };
type Act = (input: unknown) => Promise<Result>;

/**
 * ⭐ THE TRANSITION TABLE, MIRRORED FROM THE TRIGGERS.
 *
 * ⚠️ A MIRROR IS NOT A SECOND SOURCE OF TRUTH, AND THE DIFFERENCE
 * MATTERS. If this drifts, the screen offers something the database
 * refuses, which is a confusing afternoon. If the database drifted from
 * the screen, an order would change in a way nobody meant, which is a
 * dispute. Only one of those is recoverable, so only one of them is
 * allowed to be authoritative.
 */
const ALLOWS = {
  confirm: ["draft", "pending_approval"],
  amend: ["draft", "confirmed", "partially_fulfilled", "on_hold"],
  hold: ["draft", "pending_approval", "confirmed", "partially_fulfilled"],
  release: ["on_hold"],
  cancel: ["draft", "pending_approval", "confirmed", "on_hold"],
  close: ["fulfilled", "partially_fulfilled"],
} as const;

export function OrderLifecycle({
  orderId,
  status,
  confirmAction,
  cancelAction,
  holdAction,
  releaseAction,
  closeAction,
}: {
  orderId: string;
  status: string;
  confirmAction: Act;
  cancelAction: Act;
  holdAction: Act;
  releaseAction: Act;
  closeAction: Act;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"cancel" | "hold" | null>(null);

  const can = (k: keyof typeof ALLOWS) =>
    (ALLOWS[k] as readonly string[]).includes(status);

  function run(action: Act, input: unknown) {
    setError(null);
    start(async () => {
      const result = await action(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAsking(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="font-medium">What you can do</h2>

      <div className="flex flex-wrap gap-2">
        {can("confirm") ? (
          <Button
            type="button"
            disabled={pending}
            onClick={() => run(confirmAction, { id: orderId })}
          >
            Confirm
          </Button>
        ) : null}

        {can("hold") ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setAsking(asking === "hold" ? null : "hold")}
          >
            Put on hold
          </Button>
        ) : null}

        {can("release") ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => run(releaseAction, { id: orderId })}
          >
            Take off hold
          </Button>
        ) : null}

        {can("close") ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => run(closeAction, { id: orderId })}
          >
            Close
          </Button>
        ) : null}

        {can("cancel") ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setAsking(asking === "cancel" ? null : "cancel")}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {/*
        🔴 THE REASON IS ASKED FOR BEFORE THE ACTION, NOT AFTER A REJECTION.
        `cancelOrderSchema` requires ten characters, because the customer
        will ask why. Firing the action and surfacing a validation error
        teaches the operator to type "x" ten times.
      */}
      {asking === "cancel" ? (
        <form
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          action={(fd) =>
            run(cancelAction, {
              id: orderId,
              reason: String(fd.get("reason") ?? ""),
            })
          }
        >
          <Label htmlFor="cancel-reason">Why is it being cancelled?</Label>
          <Input
            id="cancel-reason"
            name="reason"
            required
            minLength={10}
            maxLength={2000}
            placeholder="The customer withdrew after the site visit"
          />
          <p className="text-xs text-muted-foreground">
            The customer will ask, and this is what the answer is read from.
          </p>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            Cancel this order
          </Button>
        </form>
      ) : null}

      {asking === "hold" ? (
        <form
          className="space-y-2 rounded-md border p-3"
          action={(fd) =>
            run(holdAction, {
              id: orderId,
              reason: String(fd.get("reason") ?? ""),
            })
          }
        >
          <Label htmlFor="hold-reason">Why is it on hold?</Label>
          <Input
            id="hold-reason"
            name="reason"
            required
            minLength={5}
            maxLength={2000}
            placeholder="Waiting for the revised drawings"
          />
          <Button type="submit" size="sm" disabled={pending}>
            Put on hold
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/*
        ⚠️ A TERMINAL ORDER SAYS SO RATHER THAN SHOWING NOTHING. An empty
        row of buttons reads as a page that failed to load.
      */}
      {!can("confirm") && !can("hold") && !can("release") && !can("close") && !can("cancel") ? (
        <p className="text-sm text-muted-foreground">
          This order is {status.replace(/_/g, " ")}. Nothing further can be done
          to it, which is what that status means.
        </p>
      ) : null}
    </div>
  );
}
