"use client";

/**
 * Ordence — Platform Console · MAINTENANCE MODE CONTROLS
 * Version: v1.58.0-alpha
 *
 * ⚠️ EVERYTHING HERE IS A MISTAKE GUARD. The typed confirmation, the
 * disabled button, the countdown — none of it constrains anybody. The
 * boundary is `server/platform/maintenance.ts`, called from inside the
 * gate every tenant mutation already makes. This component exists so an
 * operator does not freeze the fleet by clicking the wrong row.
 *
 * ⭐ BOTH SCOPES ARE ON ONE SCREEN, ABOVE EACH OTHER, ALWAYS RENDERED.
 * "Global: OFF" is a sentence somebody needs to read at 3am; a global
 * card that only appears when global maintenance is on means its absence
 * is ambiguous — off, or not loaded?
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDestructive } from "./confirm-destructive";
import { useVisiblePoll } from "./use-visible-poll";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatRemaining,
  maintenanceStatusWord,
  remainingMs,
  type MaintenanceState,
} from "@/lib/platform/maintenance-policy";

type ActionResult = { ok: true } | { ok: false; error: string };

export type TenantWindow = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  state: MaintenanceState;
};

export type TenantOption = { id: string; name: string; slug: string };

export type MaintenanceConsoleProps = {
  global: MaintenanceState | null;
  /** Server-computed at render, from the stored end timestamp. */
  globalRemainingMs: number;
  tenantWindows: readonly TenantWindow[];
  tenantOptions: readonly TenantOption[];
  /** ISO of the server's render time — the countdown's origin. */
  renderedAt: string;
  onSetGlobal: (input: {
    enabled: boolean;
    reason: string;
    endsAt?: string | null;
    message?: string;
  }) => Promise<ActionResult>;
  onSetTenant: (input: {
    tenantId: string;
    enabled: boolean;
    reason: string;
    endsAt?: string | null;
    message?: string;
  }) => Promise<ActionResult>;
};

/** 20 s. Two operators can be on this screen during the same incident. */
const CONSOLE_POLL_MS = 20_000;

/**
 * ⚠️ RECOMPUTED FROM THE ABSOLUTE END TIME, NEVER DECREMENTED — the same
 * rule the customer banner follows, for the same reason: a background tab
 * throttles timers, and a subtracting counter would drift by exactly the
 * time the operator spent elsewhere.
 */
function useLiveRemaining(endsAt: string | null, initialMs: number): number {
  const [ms, setMs] = useState(initialMs);
  useEffect(() => {
    if (!endsAt) return;
    const tick = () => setMs(remainingMs(endsAt));
    tick();
    const id = window.setInterval(tick, 10_000);
    return () => window.clearInterval(id);
  }, [endsAt]);
  return endsAt ? ms : 0;
}

function Countdown({ endsAt, initialMs }: { endsAt: string | null; initialMs: number }) {
  const ms = useLiveRemaining(endsAt, initialMs);
  if (!endsAt) return <span>no end time set</span>;
  if (ms <= 0) return <span>scheduled end has PASSED</span>;
  return <span>ends in {formatRemaining(ms)}</span>;
}

/**
 * ⚠️ A `datetime-local` VALUE IS LOCAL WALL-CLOCK WITH NO ZONE. Converted
 * through `Date` here so the server stores a real instant; an operator in
 * IST typing 02:00 means 02:00 IST, and shipping that string unconverted
 * would have frozen the fleet five and a half hours late.
 */
function toIso(local: string): string | null {
  if (!local.trim()) return null;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function MaintenanceConsole({
  global,
  globalRemainingMs,
  tenantWindows,
  tenantOptions,
  renderedAt,
  onSetGlobal,
  onSetTenant,
}: MaintenanceConsoleProps) {
  const router = useRouter();
  useVisiblePoll(() => router.refresh(), CONSOLE_POLL_MS);

  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  const [globalEnd, setGlobalEnd] = useState("");
  const [globalMessage, setGlobalMessage] = useState("");
  const [confirmGlobalOn, setConfirmGlobalOn] = useState(false);
  const [confirmGlobalOff, setConfirmGlobalOff] = useState(false);

  const [tenantId, setTenantId] = useState("");
  const [tenantEnd, setTenantEnd] = useState("");
  const [tenantMessage, setTenantMessage] = useState("");
  const [confirmTenantOn, setConfirmTenantOn] = useState(false);
  const [liftTenant, setLiftTenant] = useState<TenantWindow | null>(null);

  const globalWord = maintenanceStatusWord(global, new Date(renderedAt));
  const chosen = tenantOptions.find((t) => t.id === tenantId) ?? null;

  function run(work: () => Promise<ActionResult>) {
    setProblem(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {problem ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          Refused: {problem}
        </p>
      ) : null}

      {/* ───────────────────────── GLOBAL ───────────────────────── */}
      <Card data-testid="maintenance-global">
        <CardHeader>
          <CardTitle className="text-base">
            {/* ⚠️ THE STATE IS A WORD. Never a colour, never a dot alone. */}
            Global — every workspace:{" "}
            <span data-testid="maintenance-global-word">{globalWord}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {global && global.enabled ? (
            <div className="space-y-1">
              <p>
                <Countdown endsAt={global.endsAt} initialMs={globalRemainingMs} />
              </p>
              <p className="text-muted-foreground">
                Switched on by {global.setBy ?? "unknown operator"}
                {global.since ? ` at ${global.since}` : ""}.
              </p>
              <p className="text-muted-foreground">Reason: {global.reason}</p>
              {global.message.trim() ? (
                <p className="text-muted-foreground">
                  Customers are told: “{global.message}”
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Customers are told nothing beyond the standard notice.
                </p>
              )}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setConfirmGlobalOff(true)}
              >
                Lift global maintenance
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground">
                Every workspace accepts writes normally.
              </p>
              <label className="block">
                <span className="text-xs font-medium">
                  End time (optional — leave empty for “until lifted”)
                </span>
                <input
                  type="datetime-local"
                  value={globalEnd}
                  onChange={(e) => setGlobalEnd(e.target.value)}
                  className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">
                  What customers are told (optional, shown verbatim)
                </span>
                <input
                  type="text"
                  maxLength={400}
                  value={globalMessage}
                  onChange={(e) => setGlobalMessage(e.target.value)}
                  className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm"
                />
              </label>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => setConfirmGlobalOn(true)}
              >
                Turn the whole product read-only
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ──────────────────────── PER TENANT ─────────────────────── */}
      <Card data-testid="maintenance-tenants">
        <CardHeader>
          <CardTitle className="text-base">
            Per workspace — {tenantWindows.length} currently read-only
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {tenantWindows.length === 0 ? (
            <p className="text-muted-foreground">
              No workspace is individually in maintenance mode.
            </p>
          ) : (
            <ul className="space-y-2">
              {tenantWindows.map((w) => (
                <li
                  key={w.tenantId}
                  data-testid="maintenance-tenant-row"
                  className="rounded-md border p-3"
                >
                  <p className="font-medium">
                    {w.tenantName} ({w.tenantSlug}) —{" "}
                    {maintenanceStatusWord(w.state, new Date(renderedAt))}
                  </p>
                  <p className="text-muted-foreground">
                    <Countdown
                      endsAt={w.state.endsAt}
                      initialMs={remainingMs(w.state.endsAt, new Date(renderedAt))}
                    />
                    {" · "}
                    {w.state.reason}
                  </p>
                  <Button
                    className="mt-2"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setLiftTenant(w)}
                  >
                    Lift for this workspace
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-3 border-t pt-4">
            <label className="block">
              <span className="text-xs font-medium">Workspace</span>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm"
              >
                <option value="">Choose a workspace…</option>
                {tenantOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium">End time (optional)</span>
              <input
                type="datetime-local"
                value={tenantEnd}
                onChange={(e) => setTenantEnd(e.target.value)}
                className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">
                What this workspace's users are told (optional)
              </span>
              <input
                type="text"
                maxLength={400}
                value={tenantMessage}
                onChange={(e) => setTenantMessage(e.target.value)}
                className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
            <Button
              variant="destructive"
              disabled={pending || !chosen}
              onClick={() => setConfirmTenantOn(true)}
            >
              Turn this workspace read-only
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────── CONFIRMATIONS ───────────────────── */}
      <ConfirmDestructive
        open={confirmGlobalOn}
        onOpenChange={setConfirmGlobalOn}
        // ⚠️ Typed to the word every operator can read off the screen, and
        // not to "YES": the point of typing is to slow the hand down.
        objectName="ORDENCE"
        objectLabel="product"
        actionLabel="Turn the whole product read-only"
        consequence="Every user in every workspace stops being able to save anything, immediately. Reads and exports keep working."
        consequences={[
          "No data is deleted and nothing already saved is affected.",
          "A non-dismissible banner appears for every customer, naming the window.",
          "Platform console actions are unaffected — you can lift this from here.",
          "If you set no end time, it stays on until a human lifts it.",
        ]}
        pending={pending}
        onConfirm={({ reason }) =>
          run(() =>
            onSetGlobal({
              enabled: true,
              reason,
              endsAt: toIso(globalEnd),
              message: globalMessage,
            }),
          )
        }
      />

      <ConfirmDestructive
        open={confirmGlobalOff}
        onOpenChange={setConfirmGlobalOff}
        objectName="ORDENCE"
        objectLabel="product"
        actionLabel="Lift global maintenance"
        consequence="Every workspace starts accepting writes again on the next request."
        consequences={[
          "Lifting early, during the migration this was protecting, is the more dangerous of the two directions.",
          "Per-workspace windows are NOT lifted by this — they are listed separately.",
        ]}
        pending={pending}
        onConfirm={({ reason }) => run(() => onSetGlobal({ enabled: false, reason }))}
      />

      <ConfirmDestructive
        open={confirmTenantOn && chosen !== null}
        onOpenChange={setConfirmTenantOn}
        objectName={chosen?.slug ?? ""}
        objectLabel="workspace"
        actionLabel="Turn this workspace read-only"
        consequence={`Every user in ${chosen?.name ?? "this workspace"} stops being able to save anything, immediately. Reads and exports keep working.`}
        consequences={[
          "No data is deleted and nothing already saved is affected.",
          "Their users see a non-dismissible banner naming the window.",
          "Other workspaces are unaffected.",
        ]}
        pending={pending}
        onConfirm={({ reason }) =>
          run(() =>
            onSetTenant({
              tenantId: chosen?.id ?? "",
              enabled: true,
              reason,
              endsAt: toIso(tenantEnd),
              message: tenantMessage,
            }),
          )
        }
      />

      <ConfirmDestructive
        open={liftTenant !== null}
        onOpenChange={(open) => {
          if (!open) setLiftTenant(null);
        }}
        objectName={liftTenant?.tenantSlug ?? ""}
        objectLabel="workspace"
        actionLabel="Lift maintenance for this workspace"
        consequence={`${liftTenant?.tenantName ?? "This workspace"} starts accepting writes again on the next request.`}
        consequences={[
          "Global maintenance, if it is on, still applies and is lifted separately.",
        ]}
        pending={pending}
        onConfirm={({ reason }) =>
          run(async () => {
            const target = liftTenant;
            if (!target) return { ok: false as const, error: "No workspace selected." };
            const result = await onSetTenant({
              tenantId: target.tenantId,
              enabled: false,
              reason,
            });
            setLiftTenant(null);
            return result;
          })
        }
      />
    </div>
  );
}
