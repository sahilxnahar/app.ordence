"use client";

/**
 * Ordence — Tenant Feature Flag Editor
 * Version: v0.14.0-alpha
 *
 * Renders the WHOLE catalogue, not just the rows that exist, so turning a
 * new flag on is a toggle rather than something that feels like creating
 * a database record.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TWO THINGS THIS UI REFUSES TO LET AN OPERATOR FORGET
 * ══════════════════════════════════════════════════════════════════════
 *   1. A flag that grants a PAID capability needs an end date. Shown as a
 *      required field, not a validation error after the fact. Without it
 *      the price list quietly moves into a table with no invoice attached
 *      to it, and the first person to notice is whoever runs the renewal.
 *
 *   2. Every change needs a reason, and the reason lands in the
 *      CUSTOMER'S audit log. A capability appearing in someone's
 *      workspace with no explanation anywhere they can see it is how a
 *      support win becomes a trust problem.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HeldForApproval } from "@/components/platform/held-for-approval";

export type FlagRowView = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string | null;
  expiresAt: string | null;
  expired: boolean;
  setByEmail: string | null;
  grantsPaidCapability: boolean;
};

/**
 * ⚠️ `data.queued` IS OPTIONAL IN THE TYPE AND REQUIRED IN THE SERVER'S.
 * `setTenantFlag` returns it on every success; it is optional here only
 * because this prop is also satisfied by test doubles, and a component
 * that cannot be rendered without a live server is a component nobody
 * writes a test for.
 *
 * 🔴 WHAT IS NOT OPTIONAL IS CHECKING IT. An `entitlement:` write against
 * a PAYING workspace is held by the approval queue and nothing changes;
 * reporting that as "enabled" is the bug that has already shipped once on
 * the suspend button.
 */
type ActionResult =
  | { ok: true; data?: { queued?: boolean; note?: string } }
  | { ok: false; error: string };

export function FlagEditor({
  tenantId,
  flags,
  canWrite,
  onSet,
  isConsoleHost = false,
}: {
  tenantId: string;
  flags: FlagRowView[];
  canWrite: boolean;
  onSet: (input: {
    tenantId: string;
    flagKey: string;
    enabled: boolean;
    reason: string;
    expiresAt: string | null;
  }) => Promise<ActionResult>;
  /** ⚠️ The console answers on two base paths. See `console-paths.ts`. */
  isConsoleHost?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [heldNote, setHeldNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(flag: FlagRowView, nextEnabled: boolean) {
    startTransition(async () => {
      const result = await onSet({
        tenantId,
        flagKey: flag.key,
        enabled: nextEnabled,
        reason,
        // `datetime-local` has no zone; the server parses ISO. Sending
        // the browser's zone-less string would land the expiry in
        // whatever zone the SERVER happens to be in, which is how a
        // "expires Friday" flag expires on Thursday for someone.
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      if (result.ok) {
        setEditing(null);
        setReason("");
        setExpiresAt("");
        /*
         * 🔴 NOT A SUCCESS TOAST WHEN NOTHING HAPPENED. Green with a tick
         * is read as "it worked", and the flag row below still shows the
         * old value — which the operator then reads as a stale render and
         * clicks again.
         */
        if (result.data?.queued) {
          setHeldNote(result.data.note ?? "This change is waiting for approval.");
        } else {
          setHeldNote(null);
          toast.success(`${flag.label} ${nextEnabled ? "enabled" : "disabled"}.`);
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      {/*
        ⭐ ABOVE THE LIST, NOT INSIDE ONE ROW. The change that was held is
        no longer visible as a pending edit anywhere — the row it came
        from has closed — so a notice attached to that row would vanish
        with it.
      */}
      {heldNote ? (
        <HeldForApproval
          note={heldNote}
          isConsoleHost={isConsoleHost}
          testId="flag-held-for-approval"
        />
      ) : null}

      {flags.map((flag) => (
        <Card key={flag.key} data-testid={`flag-${flag.key}`}>
          <CardContent className="space-y-2 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{flag.label}</span>
              {flag.enabled ? <Badge>On</Badge> : <Badge variant="outline">Off</Badge>}
              {flag.grantsPaidCapability ? (
                <Badge variant="secondary">grants paid capability</Badge>
              ) : null}
              {flag.expired ? <Badge variant="destructive">expired</Badge> : null}
              <code className="ml-auto font-mono text-xs text-muted-foreground">
                {flag.key}
              </code>
            </div>

            <p className="text-xs text-muted-foreground">{flag.description}</p>

            {flag.reason ? (
              <p className="text-xs">
                <span className="text-muted-foreground">Reason: </span>
                {flag.reason}
                {flag.setByEmail ? (
                  <span className="text-muted-foreground"> — {flag.setByEmail}</span>
                ) : null}
                {flag.expiresAt ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · ends {new Date(flag.expiresAt).toISOString().slice(0, 10)}
                  </span>
                ) : null}
              </p>
            ) : null}

            {editing === flag.key ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="space-y-1">
                  <Label htmlFor={`reason-${flag.key}`}>
                    Why? (goes to the customer&rsquo;s audit log)
                  </Label>
                  <Textarea
                    id={`reason-${flag.key}`}
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>

                {/*
                  ⭐ THE END DATE IS OFFERED FOR EVERY FLAG, NOT ONLY THE
                  PAID ONES, AND THAT IS A PHASE 29 CHANGE.

                  It is REQUIRED where the flag grants a paid capability —
                  otherwise the price list quietly moves into a table with
                  no invoice attached and the first person to notice is
                  whoever runs the renewal.

                  It is OFFERED everywhere else because a permanent
                  per-customer override is a fork of the product that
                  nobody remembers agreeing to. A beta opt-in with no end
                  date is how one workspace ends up running code no other
                  workspace runs, for two years, unnoticed.
                */}
                {!flag.enabled ? (
                  <div className="space-y-1">
                    <Label htmlFor={`expiry-${flag.key}`}>
                      {flag.grantsPaidCapability
                        ? "End date (required — this grants a paid capability)"
                        : "End date (optional, and strongly recommended)"}
                    </Label>
                    <Input
                      id={`expiry-${flag.key}`}
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      aria-describedby={`expiry-help-${flag.key}`}
                    />
                    <p
                      id={`expiry-help-${flag.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      A flag with no end date is a permanent fork for this one customer.
                      The flag reads as OFF the instant this time passes — no cleanup job
                      is involved.
                    </p>
                  </div>
                ) : null}

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending || reason.trim().length < 15}
                    onClick={() => submit(flag, !flag.enabled)}
                  >
                    {flag.enabled ? "Turn off" : "Turn on"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                title={canWrite ? undefined : "Engineer grade or above required."}
                onClick={() => setEditing(flag.key)}
              >
                {flag.enabled ? "Turn off" : "Turn on"}
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
