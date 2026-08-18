"use client";

/**
 * Ordence — Plan and seats, edited in place
 * Version: v1.52.0-alpha (Batch 125)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OPTIMISTIC VALUE IS A DISPLAY CONVENIENCE. IT IS NEVER A DECISION.
 * ══════════════════════════════════════════════════════════════════════
 * `useOptimistic` paints the typed numbers the instant the transition
 * starts, so an operator on a phone call is not staring at a spinner
 * while they talk. React throws that painted value away the moment the
 * transition ends, and the card falls back to the props — which are the
 * server's numbers, re-fetched by `router.refresh()`.
 *
 * ⚠️ THE FAILURE MODE THAT WOULD MAKE THIS DANGEROUS is the silent
 * revert: the operator types 25 seats, sees 25, the server refuses, the
 * number flicks back to 10 in a frame nobody watched, and the operator
 * tells the customer they now have 25 seats. So a refusal is LATCHED into
 * `refusal` state and rendered as a standing `role="alert"` block naming
 * (a) what was attempted, (b) what the workspace is actually on, and
 * (c) the server's own words for why. It stays until the operator
 * dismisses it or succeeds. A refusal that scrolls past is a refusal that
 * was swallowed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MONEY IS `bigint` MINOR UNITS THE WHOLE WAY DOWN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * The "what this seat count would bill at" line multiplies a per-seat
 * paise amount by a seat count in `bigint`. Doing it in `Number` would be
 * correct for every workspace we have today and wrong for the first one
 * big enough to matter — and it would be wrong quietly, by a paisa, in a
 * figure an operator reads out to a customer.
 *
 * ⚠️ Amounts arrive as STRINGS because `bigint` cannot cross the
 * server→client boundary. `BigInt(str)` here, never `Number(str)`.
 */

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDestructive } from "./confirm-destructive";
import { formatMoney } from "@/lib/billing/money";
import { CONFIGURABLE_PLAN_TIERS } from "@/lib/platform/configuration";

type SaveResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** The three fields this card owns. Everything else on it is read-only. */
type Draft = {
  planTier: string;
  seatLimit: number;
  storageLimitMb: number;
};

export type PlanSeatsCardProps = {
  tenantId: string;
  tenantName: string;
  planTier: string;
  seatLimit: number;
  seatsInUse: number;
  storageLimitMb: number;
  storageUsedMb: number;
  /** paise, as a string — see the money note in the header. */
  mrrMinor: string;
  /** paise, as a string. Null when this workspace has no subscription. */
  perSeatMinor: string | null;
  currency: string;
  canEdit: boolean;
  onSave: (input: {
    tenantId: string;
    planTier: string;
    seatLimit: number;
    storageLimitMb: number;
    acceptOverCommit: boolean;
    reason: string;
  }) => Promise<SaveResult>;
};

/**
 * ⚠️ MIRRORS `justification(20, ...)` IN `lib/platform/configuration.ts`.
 * A courtesy, not a control: the server re-validates and this number
 * only decides when the confirm button lights up.
 */
const MIN_REASON = 20;

export function PlanSeatsCard({
  tenantId,
  tenantName,
  planTier,
  seatLimit,
  seatsInUse,
  storageLimitMb,
  storageUsedMb,
  mrrMinor,
  perSeatMinor,
  currency,
  canEdit,
  onSave,
}: PlanSeatsCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /** The server's answer. Re-derived from props on every refresh. */
  const truth: Draft = { planTier, seatLimit, storageLimitMb };

  /**
   * ⭐ The reducer ignores the previous optimistic value entirely: there
   * is only ever one edit in flight from one card, so "last write wins"
   * is the whole semantic and a merge would only invent states.
   */
  const [shown, showOptimistically] = useOptimistic(truth, (_prev, next: Draft) => next);

  const [draft, setDraft] = useState<Draft>(truth);
  const [refusal, setRefusal] = useState<{ attempted: Draft; message: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const dirty =
    draft.planTier !== truth.planTier ||
    draft.seatLimit !== truth.seatLimit ||
    draft.storageLimitMb !== truth.storageLimitMb;

  /**
   * ⚠️ A COPY OF THE SERVER'S CHECK, AND KNOWN TO BE STALE.
   * `setPlanAndLimits()` re-runs this against usage read inside the same
   * transaction, because the customer can invite three people while the
   * operator is typing the reason. This copy only decides which dialog
   * opens; the server decides whether it happens.
   */
  const overCommits: string[] = [];
  if (draft.seatLimit < seatsInUse) {
    overCommits.push(
      `${seatsInUse} people already hold seats — a limit of ${draft.seatLimit} is below that, so nobody new can be invited.`,
    );
  }
  if (draft.storageLimitMb < storageUsedMb) {
    overCommits.push(
      `${storageUsedMb} MB is already stored — a limit of ${draft.storageLimitMb} MB is below that, so no new uploads will be accepted.`,
    );
  }
  const overCommitting = overCommits.length > 0;

  function commit(reason: string) {
    const attempted = draft;
    startTransition(async () => {
      // Paint first. React discards this when the transition settles.
      showOptimistically(attempted);
      const result = await onSave({
        tenantId,
        planTier: attempted.planTier,
        seatLimit: attempted.seatLimit,
        storageLimitMb: attempted.storageLimitMb,
        acceptOverCommit: overCommitting,
        reason,
      });

      if (!result.ok) {
        // 🔴 LATCHED, NOT TOASTED. See the header.
        setRefusal({ attempted, message: result.error });
        return;
      }
      setRefusal(null);
      setConfirmOpen(false);
      router.refresh();
    });
  }

  /** What the seat ceiling would bill at, if a per-seat price is on file. */
  const seatLineMinor =
    perSeatMinor === null ? null : BigInt(perSeatMinor) * BigInt(shown.seatLimit);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan and seats</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Plan on file</dt>
            <dd className="font-medium" data-testid="plan-shown">
              {shown.planTier}
              {shown.planTier !== truth.planTier ? (
                // The word, not a colour: this value is not the server's yet.
                <Badge variant="outline" className="ml-2">
                  saving
                </Badge>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Seats</dt>
            <dd className="font-medium" data-testid="seats-shown">
              {seatsInUse} of {shown.seatLimit} in use
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Storage</dt>
            <dd className="font-medium">
              {storageUsedMb} MB of {shown.storageLimitMb} MB
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Committed MRR</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(BigInt(mrrMinor), currency)}
            </dd>
          </div>
          {seatLineMinor === null ? null : (
            <div>
              <dt className="text-xs text-muted-foreground">
                Seat ceiling at the per-seat price
              </dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(seatLineMinor, currency)}
              </dd>
            </div>
          )}
        </dl>

        {/*
          🔴 THE ROLLBACK, SAID OUT LOUD. Three sentences because three
          things have to be true in the operator's head afterwards: what
          they asked for, what is actually on file now, and why.
        */}
        {refusal ? (
          <div
            role="alert"
            data-testid="plan-refusal"
            className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium">
              Refused by the server — nothing changed, the form rolled back.
            </p>
            <p>
              You asked for <strong>{refusal.attempted.planTier}</strong>,{" "}
              {refusal.attempted.seatLimit} seats, {refusal.attempted.storageLimitMb} MB.
            </p>
            <p>
              This workspace is still on <strong>{truth.planTier}</strong>,{" "}
              {truth.seatLimit} seats, {truth.storageLimitMb} MB.
            </p>
            <p className="text-muted-foreground">{refusal.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRefusal(null)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="plan-tier">Plan</Label>
            <select
              id="plan-tier"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={draft.planTier}
              disabled={!canEdit || pending}
              onChange={(e) => setDraft((d) => ({ ...d, planTier: e.target.value }))}
            >
              {CONFIGURABLE_PLAN_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="seat-limit">Seat limit</Label>
            <Input
              id="seat-limit"
              type="number"
              min={1}
              max={10000}
              className="mt-1"
              value={draft.seatLimit}
              disabled={!canEdit || pending}
              onChange={(e) =>
                setDraft((d) => ({ ...d, seatLimit: Number(e.target.value) }))
              }
            />
          </div>
          <div>
            <Label htmlFor="storage-limit">Storage limit (MB)</Label>
            <Input
              id="storage-limit"
              type="number"
              min={100}
              max={1000000}
              className="mt-1"
              value={draft.storageLimitMb}
              disabled={!canEdit || pending}
              onChange={(e) =>
                setDraft((d) => ({ ...d, storageLimitMb: Number(e.target.value) }))
              }
            />
          </div>
        </div>

        {overCommitting ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {overCommits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-3">
          {/*
            ⚠️ RENDERED DISABLED RATHER THAN HIDDEN for a grade that
            cannot configure — the same choice `RenameSlugCard` makes. A
            hidden control teaches an engineer the capability does not
            exist, so they ask for a database script instead of a grade.
          */}
          <Button
            type="button"
            data-testid="plan-save"
            disabled={!canEdit || !dirty || pending}
            onClick={() => setConfirmOpen(true)}
          >
            {pending ? "Saving…" : "Change plan and limits"}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setDraft(truth)}
            >
              Discard
            </Button>
          ) : null}
          {!canEdit ? (
            <span className="text-xs text-muted-foreground">
              Your grade cannot configure workspaces — ask for `tenants:configure`.
            </span>
          ) : null}
        </div>

        {/*
          ⭐ THE SAME DIALOG EITHER WAY, WITH A DIFFERENT CONSEQUENCE.
          A plan change is always a commercial promise written into the
          customer's own audit log, so it always costs a typed name and a
          reason; the over-commit case only changes what the loud line
          says. Two different confirmation experiences for one button
          would be a UI whose seriousness the operator has to guess.
        */}
        <ConfirmDestructive
          open={confirmOpen}
          onOpenChange={(open) => {
            setConfirmOpen(open);
          }}
          objectName={tenantName}
          objectLabel="workspace"
          actionLabel="Change plan and limits"
          minReasonLength={MIN_REASON}
          pending={pending}
          error={refusal?.message ?? null}
          consequence={
            overCommitting
              ? `This sets a ceiling BELOW what ${tenantName} is already using. Nothing is deleted, and they will be blocked from adding more.`
              : `${tenantName} moves to ${draft.planTier} with ${draft.seatLimit} seats and ${draft.storageLimitMb} MB.`
          }
          consequences={[
            "The reason is written verbatim into the customer's own audit log.",
            "Billing is not touched: a price change is a purchase decision and belongs to the customer.",
            "Nothing already stored is deleted by lowering a limit.",
          ]}
          onConfirm={({ reason }) => commit(reason)}
        />
      </CardContent>
    </Card>
  );
}
