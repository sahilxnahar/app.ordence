"use client";

/**
 * Ordence — Plan Tier & Limits (Section D)
 * Version: v0.53.0
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ USAGE IS RENDERED BESIDE THE FIELD, NOT ON ANOTHER TAB
 * ══════════════════════════════════════════════════════════════════════
 * The mistake this screen exists to prevent is setting a ceiling below
 * the floor: dropping a customer to 10 seats when 14 people are already
 * signed in. It does not delete anybody — it blocks the fifteenth invite
 * and produces a support ticket a week later that nobody connects back to
 * this screen.
 *
 * A "current usage" panel three clicks away does not prevent that,
 * because the operator is looking at the number they are typing. So the
 * usage sits under the input, and the input turns red the moment the
 * proposed limit crosses it.
 *
 * ⚠️ AND THEN IT STILL LETS YOU DO IT. A downgrade is a legitimate
 * commercial decision and the ceiling genuinely has to move before the
 * smaller plan can be billed. A console that refuses outright is a
 * console the operator abandons for a database client, where there is no
 * audit row at all. So it demands an explicit acknowledgement and writes
 * both the number and the acknowledgement into the customer's audit log.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE HONEST WARNING AT THE TOP OF THIS FORM
 * ══════════════════════════════════════════════════════════════════════
 * With a live subscription, `tenants.plan_tier` is a CACHE and the
 * entitlement gate reads the subscription instead. Changing the tier here
 * will not change what that customer can reach. The banner says so rather
 * than letting an operator discover it by watching nothing happen.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CONFIGURABLE_PLAN_TIERS,
  previewTierChange,
  tierLabel,
  type LimitPressure,
} from "@/lib/platform/configuration";
import { configDefinition } from "@/lib/platform/config-chain";
import type { PlanTier } from "@/db/schema/core";
import { HeldForApproval } from "@/components/platform/held-for-approval";

/**
 * ⚠️ A TIER MOVE IS HELD BY `tenant.plan_change` AND DOES NOT HAPPEN ON
 * THE CLICK. `setPlanAndLimits` holds it inside its own transaction and
 * raises a request; seat and storage edits at the same tier are not held
 * and still save immediately. Reporting the first as "updated" is the
 * bug that already shipped once on the suspend button.
 */
type SetResult =
  | { ok: true; data?: { queued?: boolean; note?: string } }
  | { ok: false; error: string; needsStepUp?: boolean };

const MIN_REASON = 20;

export function PlanLimitsEditor({
  tenantId,
  planTier,
  seats,
  storage,
  subscriptionStatus,
  subscriptionIsAuthority,
  subscriptionGrantsAccess,
  canWrite,
  onSave,
  onStepUp,
  isConsoleHost = false,
}: {
  tenantId: string;
  planTier: PlanTier;
  seats: LimitPressure;
  storage: LimitPressure;
  subscriptionStatus: string | null;
  subscriptionIsAuthority: boolean;
  subscriptionGrantsAccess: boolean;
  canWrite: boolean;
  onSave: (input: {
    tenantId: string;
    planTier: string;
    seatLimit: number;
    storageLimitMb: number;
    acceptOverCommit: boolean;
    reason: string;
  }) => Promise<SetResult>;
  onStepUp: () => Promise<{ ok: true }>;
  /** ⚠️ The console answers on two base paths. See `console-paths.ts`. */
  isConsoleHost?: boolean;
}) {
  const router = useRouter();
  const [heldNote, setHeldNote] = useState<string | null>(null);
  const [tier, setTier] = useState<PlanTier>(planTier);
  const [seatLimit, setSeatLimit] = useState(String(seats.limit));
  const [storageLimit, setStorageLimit] = useState(String(storage.limit));
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const nextSeats = Number.parseInt(seatLimit, 10);
  const nextStorage = Number.parseInt(storageLimit, 10);

  const seatOverCommit = Number.isFinite(nextSeats) && seats.used > nextSeats;
  const storageOverCommit = Number.isFinite(nextStorage) && storage.used > nextStorage;
  const overCommits = seatOverCommit || storageOverCommit;

  const preview = previewTierChange(planTier, tier, {
    subscriptionGrantsAccess,
  });

  // The chain's plan layer for the tier CURRENTLY SELECTED in the form,
  // not the tier the workspace is on — the two differ exactly while
  // somebody is moving a customer between plans, which is when the
  // question "is this number the plan's or ours?" actually matters.
  const storageDef = configDefinition("limits.storage_mb");
  const planStorageMb = Number(storageDef.planDefaults[tier] ?? storageDef.globalDefault);
  const storageIsPlanDefault = nextStorage === planStorageMb;

  function save() {
    startTransition(async () => {
      const result = await onSave({
        tenantId,
        planTier: tier,
        seatLimit: nextSeats,
        storageLimitMb: nextStorage,
        acceptOverCommit: acknowledged,
        reason,
      });
      if (result.ok) {
        setReason("");
        setAcknowledged(false);
        if (result.data?.queued) {
          // 🔴 The tier select below still shows what the operator chose
          // and the workspace is still on the old plan. Say so, and keep
          // saying it.
          setHeldNote(result.data.note ?? "This change is waiting for approval.");
          router.refresh();
          return;
        }
        setHeldNote(null);
        toast.success("Plan and limits updated.");
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
    <div className="space-y-4">
      {heldNote ? (
        <HeldForApproval
          note={heldNote}
          isConsoleHost={isConsoleHost}
          testId="plan-held-for-approval"
        />
      ) : null}

      {subscriptionIsAuthority ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          ⚠️ This workspace has a live subscription ({subscriptionStatus}), and the
          entitlement gate reads the SUBSCRIPTION, not this column. Changing the tier here
          changes what the console reports and does <strong>not</strong> change what the
          customer can reach. Re-pricing them is a billing operation.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <UsageCard
          title="Seats"
          pressure={seats}
          proposed={Number.isFinite(nextSeats) ? nextSeats : null}
          unit=""
        />
        <UsageCard
          title="Storage"
          pressure={storage}
          proposed={Number.isFinite(nextStorage) ? nextStorage : null}
          unit=" MB"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Change the plan and the ceilings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="plan-tier">Plan tier</Label>
              {/* Plain select — the design system has no combobox, and a
                  bespoke one on a console that must work when the bundle
                  is broken is a bad trade. */}
              <select
                id="plan-tier"
                value={tier}
                onChange={(e) => setTier(e.target.value as PlanTier)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {CONFIGURABLE_PLAN_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {tierLabel(t)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="seat-limit">Seat limit</Label>
              <Input
                id="seat-limit"
                type="number"
                min={1}
                value={seatLimit}
                onChange={(e) => setSeatLimit(e.target.value)}
                aria-invalid={seatOverCommit}
                aria-describedby="seat-limit-help"
              />
              <p
                id="seat-limit-help"
                className={
                  seatOverCommit ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
              >
                {seatOverCommit
                  ? `${seats.used} seats are already occupied. Nobody is removed — new invites are blocked.`
                  : `${seats.used} occupied right now.`}
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="storage-limit">Storage limit (MB)</Label>
              <Input
                id="storage-limit"
                type="number"
                min={100}
                value={storageLimit}
                onChange={(e) => setStorageLimit(e.target.value)}
                aria-invalid={storageOverCommit}
                aria-describedby="storage-limit-help storage-limit-chain"
              />
              <p
                id="storage-limit-help"
                className={
                  storageOverCommit
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {storageOverCommit
                  ? `${storage.used} MB is already stored. Nothing is deleted — new uploads are blocked.`
                  : `${storage.used} MB stored right now.`}
              </p>
              {/*
                ══════════════════════════════════════════════════════
                ⭐⭐ THIS FIELD USED TO BE A NUMBER WITH NO PROVENANCE
                ══════════════════════════════════════════════════════
                It wrote straight into a column. Six months later "why is
                this workspace on 8192?" had three candidate answers —
                the plan, a promise in a sales call, a typo — and no way
                to tell them apart, so nobody dared move it.

                ⭐ NOW IT SAYS WHICH LAYER THE TYPED NUMBER WILL LAND IN,
                BEFORE THE SAVE. Equal to the chosen plan's ceiling, and
                the workspace override is REMOVED so a later upgrade
                actually lifts them; different, and an override is
                written with this operator's name against it.

                ⚠️ COMPUTED FROM THE SAME PURE CATALOGUE THE SERVER
                RESOLVES WITH. A second copy of the plan ceilings in this
                file would disagree with the server on the first price
                change, and the field would be lying with confidence.
              */}
              <p id="storage-limit-chain" className="text-xs text-muted-foreground">
                {storageIsPlanDefault ? (
                  <>
                    This is the <strong>{tierLabel(tier)}</strong> plan&rsquo;s ceiling.
                    Saving removes any workspace override, so a later plan change moves them
                    with it.
                  </>
                ) : (
                  <>
                    <strong>Above or below the {tierLabel(tier)} plan&rsquo;s{" "}
                    {planStorageMb} MB.</strong> Saving writes a workspace override in your
                    name, and this workspace stops following the plan&rsquo;s ceiling.
                  </>
                )}
              </p>
            </div>
          </div>

          {/*
            ⭐ WHAT THE TIER CHANGE DOES TO THEIR MENU, IN MODULE NAMES.
            "They lose Trust Accounting and Dynamic Pricing" is a sentence
            an operator can read out on a call. "They lose accounting.trust"
            is not.
          */}
          {!preview.sameTier ? (
            <div className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">
                {tierLabel(planTier)} → {tierLabel(tier)}
              </p>
              {preview.gained.length > 0 ? (
                <p className="mt-1 text-xs">
                  <span className="text-muted-foreground">Gains: </span>
                  {preview.gained.join(", ")}
                </p>
              ) : null}
              {preview.lost.length > 0 ? (
                <p className="mt-1 text-xs text-destructive">
                  Loses: {preview.lost.join(", ")} — the records stay, the screens go
                  read-only.
                </p>
              ) : null}
              {preview.gained.length === 0 && preview.lost.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No module changes hands. Trial is treated as Advanced for feature
                  access, so the difference is in the quotas, not the menu.
                </p>
              ) : null}
            </div>
          ) : null}

          {overCommits ? (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1"
              />
              <span>
                I know this limit is below what the workspace already uses. Nothing is
                deleted; they are blocked from adding more until they upgrade or clear
                space.
              </span>
            </label>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="plan-reason">
              Why? (goes to the customer&rsquo;s audit log)
            </Label>
            <Textarea
              id="plan-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={
                !canWrite ||
                pending ||
                reason.trim().length < MIN_REASON ||
                !Number.isFinite(nextSeats) ||
                !Number.isFinite(nextStorage) ||
                (overCommits && !acknowledged)
              }
              title={canWrite ? undefined : "Platform owner grade required."}
              onClick={save}
            >
              Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
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
            {!canWrite ? (
              <span className="text-xs text-muted-foreground">
                Your grade can read this and cannot change it.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UsageCard({
  title,
  pressure,
  proposed,
  unit,
}: {
  title: string;
  pressure: LimitPressure;
  proposed: number | null;
  unit: string;
}) {
  const breach = proposed !== null && pressure.used > proposed;
  const percent = pressure.fraction === null ? null : Math.round(pressure.fraction * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {breach ? <Badge variant="destructive">below current usage</Badge> : null}
          {pressure.overCommitted && !breach ? (
            <Badge variant="destructive">already over</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold tabular-nums">
          {pressure.used}
          {unit}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            of {pressure.limit}
            {unit}
            {proposed !== null && proposed !== pressure.limit ? (
              <> → {proposed}{unit}</>
            ) : null}
          </span>
        </p>
        {/* A bar rather than a number alone: 900 of 1000 and 90 of 100 are
            the same situation and read completely differently as digits. */}
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={
            percent === null ? `${title}: no limit set` : `${title}: ${percent}% used`
          }
        >
          <div
            className={
              pressure.overCommitted || breach ? "h-full bg-destructive" : "h-full bg-primary"
            }
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
