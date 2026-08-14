"use client";

/**
 * Ordence — ⭐ THE MODULE SWITCHBOARD (Section C)
 * Version: v0.53.0
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A LIST OF TOGGLES
 * ══════════════════════════════════════════════════════════════════════
 * A toggle has two positions and this problem has four states. The
 * question an operator is actually holding — "why can this customer see
 * that?" — cannot be answered by a switch, because ON means two
 * completely different things:
 *
 *   ON because their plan includes it        → turning it off withdraws
 *                                              something they PAY FOR
 *   ON because a colleague granted it        → somebody decided this, on
 *                                              a date, for a reason, and
 *                                              it expires
 *
 * So every row shows BOTH columns: what the plan gives them, and what
 * has been done to them on top of it. The right-hand control offers
 * whichever moves are meaningful from the state they are in — including
 * "put it back on the plan", which a two-position switch cannot express
 * at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE THINGS THIS UI REFUSES TO LET AN OPERATOR FORGET
 * ══════════════════════════════════════════════════════════════════════
 *   1. Granting above the plan needs an END DATE. Shown as a required
 *      field before the fact, not as a validation error after it.
 *   2. Several menu items share one feature key. Switching "Guests" off
 *      switches Patients, Consumers and Contacts off too, and the row
 *      says so BEFORE the click rather than after the phone call.
 *   3. Every change needs a reason, and the reason lands in the
 *      CUSTOMER'S own audit log.
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
import {
  MODULE_STATE_LABELS,
  grantRequiresExpiry,
  type ModuleMatrix,
  type ModuleRow,
} from "@/lib/platform/configuration";
import type { EntitlementDiff } from "@/lib/platform/entitlement-diff";

type SetResult =
  | { ok: true }
  | { ok: false; error: string; needsStepUp?: boolean };

type PreviewResult = { ok: true; data: EntitlementDiff } | { ok: false; error: string };

const MIN_REASON = 15;

function stateBadge(row: ModuleRow) {
  switch (row.state) {
    case "granted_by_override":
      // Not `default` — a grant above the plan is not a normal state and
      // should not look like one on a page of forty rows.
      return <Badge variant="secondary">on · above plan</Badge>;
    case "revoked_by_override":
      return <Badge variant="destructive">off · despite plan</Badge>;
    case "included_by_plan":
      return <Badge>on · in plan</Badge>;
    case "not_in_plan":
      return <Badge variant="outline">off · not in plan</Badge>;
    case "always_on":
      return <Badge variant="outline">always on</Badge>;
  }
}

export function ModuleSwitchboard({
  tenantId,
  matrix,
  canWrite,
  onSet,
  onStepUp,
  onPreview,
}: {
  tenantId: string;
  matrix: ModuleMatrix;
  canWrite: boolean;
  onSet: (input: {
    tenantId: string;
    feature: string;
    mode: "grant" | "revoke" | "clear";
    reason: string;
    expiresAt: string | null;
  }) => Promise<SetResult>;
  /** Re-confirm identity. See the step-up caveat in `server/platform/guard.ts`. */
  onStepUp: () => Promise<{ ok: true }>;
  /**
   * ⭐⭐⭐ WHAT THIS TOGGLE ACTUALLY DOES, FETCHED WHEN THE PANEL OPENS.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE SWITCHBOARD HAS ALWAYS WORKED AND HAS NEVER EXPLAINED ITSELF
   * ══════════════════════════════════════════════════════════════════
   * Every fact on the card above describes the STATE. None of them
   * describes the CONSEQUENCE, and the consequence is the thing an
   * operator hesitates over on a call: does the customer's data go
   * away?
   *
   * ⚠️ IT DOES NOT, AND UNTIL NOW NOTHING ON THIS SCREEN SAID SO. An
   * operator who knows an entitlement controls visibility rather than
   * existence toggles confidently; one who does not, does not.
   *
   * ⭐ OPTIONAL, SO THE COMPONENT STILL RENDERS WITHOUT IT. A preview
   * that fails must never be the reason a support engineer cannot fix
   * a customer's access.
   */
  onPreview?: (input: {
    tenantId: string;
    featureKey: string;
    direction: "enable" | "disable";
  }) => Promise<PreviewResult>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [preview, setPreview] = useState<EntitlementDiff | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setEditing(null);
    setReason("");
    setExpiresAt("");
    setPreview(null);
    setPreviewError(null);
  }

  /**
   * ⚠️ THE DIRECTION IS DERIVED FROM WHAT THE CUSTOMER CAN REACH TODAY,
   * not from the plan. `effective` is what they see; `planDefault` is
   * what they bought, and on an overridden workspace those disagree —
   * which is exactly when somebody is looking at this screen.
   */
  function loadPreview(row: ModuleRow) {
    if (!onPreview || !row.feature) return;
    const featureKey = row.feature;
    const direction = row.effective ? "disable" : "enable";
    startTransition(async () => {
      const result = await onPreview({ tenantId, featureKey, direction });
      if (result.ok) {
        setPreview(result.data);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(result.error);
      }
    });
  }

  function submit(row: ModuleRow, mode: "grant" | "revoke" | "clear") {
    if (!row.feature) return;
    startTransition(async () => {
      const result = await onSet({
        tenantId,
        feature: row.feature!,
        mode,
        reason,
        /*
         * ⚠️ `datetime-local` HAS NO TIME ZONE. Sending its raw string
         * would land the expiry in whatever zone the SERVER happens to be
         * in — which is how a flag that "expires Friday" expires on
         * Thursday afternoon for the customer. Converted here, in the
         * browser, where the operator's zone is known.
         */
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });

      if (result.ok) {
        close();
        toast.success(
          mode === "clear"
            ? `${row.label} follows the plan again.`
            : `${row.label} switched ${mode === "grant" ? "on" : "off"}.`,
        );
        router.refresh();
        return;
      }

      if (result.needsStepUp) {
        toast.error("Confirm your identity, then try again.");
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-4 text-sm">
          <span>
            Plan in force: <strong>{matrix.effectiveTier}</strong>
            {matrix.effectiveTier !== matrix.planTier ? (
              <span className="text-muted-foreground">
                {" "}
                (recorded as {matrix.planTier})
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground">
            {matrix.totals.visible} modules visible · {matrix.totals.hidden} hidden
          </span>
          {matrix.totals.granted > 0 ? (
            <Badge variant="secondary">{matrix.totals.granted} granted above plan</Badge>
          ) : null}
          {matrix.totals.revoked > 0 ? (
            <Badge variant="destructive">{matrix.totals.revoked} revoked</Badge>
          ) : null}
          {!matrix.subscriptionGrantsAccess ? (
            <Badge variant="destructive">
              subscription not granting access — reads as {matrix.effectiveTier}
            </Badge>
          ) : null}

          {/*
            The step-up button is visible ALWAYS, not only after a refusal.
            An operator who has just been told "confirm your identity" and
            has to hunt for the control is an operator who reloads the page
            and loses the reason they had typed.
          */}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await onStepUp();
                toast.success("Identity confirmed for the next 15 minutes.");
              })
            }
          >
            Confirm identity
          </Button>
        </CardContent>
      </Card>

      {matrix.groups.map((group) => (
        <section key={group.group} aria-labelledby={`group-${group.group}`}>
          <h3 id={`group-${group.group}`} className="mb-2 text-sm font-medium">
            {group.label}
          </h3>

          <div className="space-y-2">
            {group.modules.map((row) => {
              const isEditing = editing === row.navId;
              const needsExpiry = grantRequiresExpiry(row);

              return (
                <Card key={row.navId} data-testid={`module-${row.navId}`}>
                  <CardContent className="space-y-2 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.label}</span>
                      {stateBadge(row)}
                      <code className="ml-auto font-mono text-xs text-muted-foreground">
                        {row.feature ?? "no entitlement"}
                      </code>
                    </div>

                    <p className="text-xs text-muted-foreground">{row.description}</p>

                    {/*
                      ⭐ THE TWO FACTS, SIDE BY SIDE. Conflating them is what
                      makes "why can this customer see that" unanswerable.
                    */}
                    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">Plan gives them</dt>
                        <dd>{row.planDefault ? "yes" : "no"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">They can reach it</dt>
                        <dd>{row.effective ? "yes" : "no"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Why</dt>
                        <dd>{MODULE_STATE_LABELS[row.state]}</dd>
                      </div>
                    </dl>

                    {row.override ? (
                      <p className="rounded-md border border-border p-2 text-xs">
                        <span className="text-muted-foreground">Set by </span>
                        {row.override.setByEmail ?? "unknown"}
                        {row.override.expiresAt ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · ends {row.override.expiresAt.slice(0, 10)}
                          </span>
                        ) : (
                          <span className="text-destructive"> · no end date</span>
                        )}
                        {row.override.reason ? <> — {row.override.reason}</> : null}
                      </p>
                    ) : null}

                    {row.sharedWith.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        ⚠️ Shares one entitlement with {row.sharedWith.join(", ")} — they
                        move together. That is deliberate: a hospital must not be able to
                        lose Patients while keeping Contacts.
                      </p>
                    ) : null}

                    {row.state === "always_on" ? (
                      <p className="text-xs text-muted-foreground">
                        Part of what a workspace is, not something sold. There is no
                        switch because there is nothing to sell.
                      </p>
                    ) : isEditing ? (
                      <div className="space-y-2 rounded-md border border-border p-3">
                        {/*
                          ⭐⭐ THE PREVIEW, ABOVE THE REASON FIELD AND ABOVE
                          THE BUTTONS. Below them it would be read after the
                          decision, which is not a preview.
                        */}
                        {previewError ? (
                          <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">
                            The preview could not be worked out ({previewError}). The
                            toggle still works, and nothing about what it does has
                            changed — you are just doing it without the explanation.
                          </p>
                        ) : preview ? (
                          <div
                            className="space-y-2 rounded border border-border bg-muted/40 p-2 text-xs"
                            data-testid={`preview-${row.navId}`}
                          >
                            <p className="font-medium">{preview.headline}</p>

                            {preview.gains.length > 0 ? (
                              <p>
                                Appears for {preview.affectedUsers} user
                                {preview.affectedUsers === 1 ? "" : "s"}:{" "}
                                {preview.gains.map((m) => m.label).join(", ")}
                              </p>
                            ) : null}

                            {preview.hides.length > 0 ? (
                              <p>
                                Disappears from view for {preview.affectedUsers} user
                                {preview.affectedUsers === 1 ? "" : "s"}:{" "}
                                {preview.hides.map((m) => m.label).join(", ")}
                              </p>
                            ) : null}

                            {/*
                              🔴 THE SENTENCE THE WHOLE PREVIEW EXISTS FOR.
                              Everybody says "your data is safe"; this says
                              what actually happens to it.
                            */}
                            {preview.keepsNote ? (
                              <p className="text-foreground">{preview.keepsNote}</p>
                            ) : null}

                            {preview.notes.map((n) => (
                              <p key={n} className="text-muted-foreground">
                                {n}
                              </p>
                            ))}

                            {preview.blockers.map((b) => (
                              <p key={b} className="text-destructive">
                                {b}
                              </p>
                            ))}
                          </div>
                        ) : null}

                        <div className="space-y-1">
                          <Label htmlFor={`reason-${row.navId}`}>
                            Why? (goes to the customer&rsquo;s audit log)
                          </Label>
                          <Textarea
                            id={`reason-${row.navId}`}
                            rows={2}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </div>

                        {needsExpiry ? (
                          <div className="space-y-1">
                            <Label htmlFor={`expiry-${row.navId}`}>
                              End date (required — this is not in their plan)
                            </Label>
                            <Input
                              id={`expiry-${row.navId}`}
                              type="datetime-local"
                              value={expiresAt}
                              onChange={(e) => setExpiresAt(e.target.value)}
                              aria-describedby={`expiry-help-${row.navId}`}
                            />
                            <p
                              id={`expiry-help-${row.navId}`}
                              className="text-xs text-muted-foreground"
                            >
                              A grant with no end date is a discount nobody signed off,
                              invisible in every revenue report. It reads as off the
                              instant this time passes — no cleanup job is involved.
                            </p>
                          </div>
                        ) : null}

                        <div className="flex flex-wrap gap-2">
                          {!row.effective ? (
                            <Button
                              size="sm"
                              /*
                                🔴 A BLOCKER DISABLES THE BUTTON RATHER THAN
                                LETTING THE SUBMIT FAIL. Enabling a module
                                that is not built yet puts a menu item in
                                front of a customer that goes nowhere, and
                                everything else we told them is then in
                                question.
                              */
                              disabled={
                                pending ||
                                reason.trim().length < MIN_REASON ||
                                (preview?.blockers.length ?? 0) > 0
                              }
                              onClick={() => submit(row, "grant")}
                            >
                              Switch on
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={pending || reason.trim().length < MIN_REASON}
                              onClick={() => submit(row, "revoke")}
                            >
                              {row.planDefault ? "Switch off (they pay for this)" : "Switch off"}
                            </Button>
                          )}

                          {row.override ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending || reason.trim().length < MIN_REASON}
                              onClick={() => submit(row, "clear")}
                            >
                              Remove the override — follow the plan
                            </Button>
                          ) : null}

                          <Button size="sm" variant="ghost" onClick={close}>
                            Cancel
                          </Button>
                        </div>

                        {row.planDefault && row.effective ? (
                          <p className="text-xs text-destructive">
                            Their plan includes this. Switching it off takes away
                            something they are paying for, and the message they see will
                            NOT offer them an upgrade — it will tell them to contact
                            support, because a human did this.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canWrite}
                        title={canWrite ? undefined : "Engineer grade or above required."}
                        onClick={() => {
                          close();
                          setEditing(row.navId);
                          loadPreview(row);
                        }}
                      >
                        Change
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
