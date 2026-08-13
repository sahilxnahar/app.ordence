"use client";

/**
 * Ordence — ⭐⭐⭐ APPROVE, AND STOP
 * Version: v1.17.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE STOP BUTTON IS THE MOST IMPORTANT CONTROL IN THE PRODUCT AND
 * IT HAS NEVER BEEN ON A SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `stopCampaign` was written in v1.15.0 with a header explaining that it
 * has to work in one click, from a phone, by somebody who has just
 * realised the wording is wrong. Nothing called it. The only way to stop
 * a campaign was to open a database client.
 *
 * ⚠️ THE SEND LOOP DOES NOT PAUSE FOR THAT. `ordence_enforce_campaign_stop`
 * fires on every single `message_sends` insert, so the button genuinely
 * bites in flight — but only if a person can reach it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE TWO CONTROLS ARE DELIBERATELY ASYMMETRIC
 * ══════════════════════════════════════════════════════════════════════
 * APPROVING IS SLOW ON PURPOSE. The amount is TYPED, not ticked, because
 * the number being typed is the number being spent, and a tick box
 * records agreement to whatever was on screen rather than to a figure
 * anybody read. `ordence_guard_campaign` refuses an approval whose count
 * and cost do not match the resolved audience, so a stale screen cannot
 * approve a different campaign from the one it is showing.
 *
 * STOPPING IS ONE CLICK AND A SHORT REASON. A long form on a stop button
 * is a stop button nobody presses in time.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function CampaignControls({
  campaignId,
  name,
  status,
  included,
  approvedCost,
  approveAction,
  stopAction,
}: {
  campaignId: string;
  name: string;
  status: string;
  included: number;
  /** ⭐ Formatted by the server. The browser never does money arithmetic. */
  approvedCost: string;
  approveAction: (
    i: unknown,
  ) => Promise<Result<{ recipients: number; costMinor: string }>>;
  stopAction: (i: unknown) => Promise<Result<{ stopped: true }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);

  // ⚠️ A campaign that has finished or been stopped cannot be either
  // approved or stopped again, and showing the controls anyway invites
  // a click that returns an error for no reason.
  //
  // 🔴 THE STATUS NAMES COME FROM `campaigns_status_known` IN 0067:
  // draft · review · approved · sending · sent · stopped · cancelled.
  // Guessing them here is how a Stop button renders on a campaign that
  // finished last week and vanishes from the one that is sending now.
  const running = status === "approved" || status === "sending";
  const approvable = status === "draft" || status === "review";

  function approve() {
    startTransition(async () => {
      const r = await approveAction({ campaignId, typedAmount: typed });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setConfirming(false);
      setTyped("");
      toast.success(`Approved for ${r.data.recipients} recipients.`);
    });
  }

  function stop() {
    // 🔴 ONE PROMPT, NOT A DIALOG WITH A FORM IN IT. The reason is
    // required by the action, so asking for it here means the failure is
    // a sentence rather than a rejected round trip.
    const reason = window.prompt(`Stop "${name}" now. Why?`);
    if (!reason || reason.trim().length < 3) {
      if (reason !== null) toast.error("A few words are enough, but there has to be some.");
      return;
    }
    startTransition(async () => {
      const r = await stopAction({ campaignId, reason: reason.trim() });
      if (!r.ok) toast.error(r.error);
      else toast.success("Stopped. Nothing further can send from this campaign.");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      {running && (
        /**
         * ⭐ FIRST IN THE MARKUP AND VISUALLY LOUDEST. On a phone, at
         * ninety seconds into a send, this is the only control that
         * matters and it should not be the third thing found.
         */
        <Button variant="destructive" disabled={pending} onClick={stop}>
          Stop now
        </Button>
      )}

      {approvable &&
        (confirming ? (
          <>
            <div>
              <Label htmlFor={`amt-${campaignId}`}>
                Type the amount to approve: {approvedCost}
              </Label>
              <Input
                id={`amt-${campaignId}`}
                value={typed}
                inputMode="decimal"
                placeholder={approvedCost}
                onChange={(e) => setTyped(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {included} recipient{included === 1 ? "" : "s"}. Typing it rather than
                ticking a box is the point: this is real money, and it leaves as
                soon as you press the button.
              </p>
            </div>
            <Button disabled={pending || typed.trim().length === 0} onClick={approve}>
              Approve and send
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="secondary" disabled={pending} onClick={() => setConfirming(true)}>
            Approve
          </Button>
        ))}
    </div>
  );
}
