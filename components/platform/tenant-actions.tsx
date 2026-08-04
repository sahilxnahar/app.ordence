"use client";

/**
 * Ordence — Tenant Detail Action Bar
 * Version: v0.14.0-alpha
 *
 * Suspend, reactivate, and start an impersonation. Every one of them goes
 * through `DangerDialog`, and every one of them is rendered DISABLED
 * rather than hidden when the operator's grade does not permit it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY DISABLED AND NOT HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * A hidden control teaches a support engineer that the capability does
 * not exist, so when they need it they escalate to "can you build me a
 * script" rather than "can you give me the grade". A disabled control
 * with the reason next to it teaches them the actual access model, which
 * is the thing we want them to understand.
 *
 * It leaks nothing: the capability matrix is not a secret, and the server
 * refuses regardless of what is rendered.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, KeyRound, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { DangerDialog } from "./danger-dialog";
import { MIN_JUSTIFICATION_LENGTH } from "@/lib/platform/impersonation-policy";

type ActionResult = { ok: true } | { ok: false; error: string };

export type TenantActionsProps = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  status: string;
  /** Live, unrevoked, unexpired consent exists for this workspace. */
  hasConsent: boolean;
  canSuspend: boolean;
  canImpersonate: boolean;
  canBreakGlass: boolean;
  onSuspend: (input: {
    tenantId: string;
    confirmSlug: string;
    reason: string;
  }) => Promise<ActionResult>;
  onReactivate: (input: { tenantId: string; reason: string }) => Promise<ActionResult>;
  onImpersonate: (input: {
    tenantId: string;
    mode: string;
    confirmSlug: string;
    justification: string;
    subjectUserId?: string;
  }) => Promise<ActionResult>;
  /**
   * The workspace's own users, so the operator can say WHOSE VIEW they
   * are reproducing.
   *
   * ⚠️ THIS IS NOT A LOGIN AS THAT PERSON. The audit trail still names
   * the operator; the subject only records which user's view the session
   * was opened against, which is the difference between "support was in
   * Acme" and "support was looking at what Priya sees". Optional, because
   * plenty of sessions are about the workspace rather than a person.
   */
  subjectUsers?: Array<{ id: string; email: string; role: string }>;
};

export function TenantActions(props: TenantActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<null | "suspend" | "reactivate" | "impersonate">(null);
  const [error, setError] = useState<string | null>(null);
  // Standing consent is offered first when it exists; break-glass is
  // never the pre-selected option, because the default is the one people
  // take without reading.
  const [mode, setMode] = useState(props.hasConsent ? "standing_consent" : "break_glass");
  // Empty means "the workspace, not a person" — the honest default,
  // because most sessions are about a broken workspace and pre-selecting
  // somebody would put a name in the evidence that nobody chose.
  const [subjectUserId, setSubjectUserId] = useState("");

  const suspended = props.status === "suspended";

  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setOpen(null);
        toast.success("Done.");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {suspended ? (
        <Button
          variant="outline"
          disabled={!props.canSuspend}
          title={props.canSuspend ? undefined : "Platform owner grade required."}
          onClick={() => setOpen("reactivate")}
        >
          <RotateCcw className="h-4 w-4" aria-hidden /> Reactivate
        </Button>
      ) : (
        <Button
          variant="destructive"
          disabled={!props.canSuspend}
          title={props.canSuspend ? undefined : "Platform owner grade required."}
          onClick={() => setOpen("suspend")}
        >
          <Ban className="h-4 w-4" aria-hidden /> Suspend
        </Button>
      )}

      <Button
        variant="outline"
        disabled={!props.canImpersonate || suspended}
        title={
          suspended
            ? "Reactivate the workspace first."
            : props.canImpersonate
              ? undefined
              : "Your grade cannot impersonate."
        }
        onClick={() => setOpen("impersonate")}
      >
        <KeyRound className="h-4 w-4" aria-hidden /> Impersonate
      </Button>

      {/* ---- SUSPEND ---- */}
      <DangerDialog
        open={open === "suspend"}
        onOpenChange={(v) => setOpen(v ? "suspend" : null)}
        title={`Suspend ${props.tenantName}`}
        description="Everyone in this workspace loses access until it is reactivated."
        consequences={[
          "NOTHING is deleted. Every record stays exactly where it is.",
          "They can still sign in, reach billing, and export all of their data.",
          "This is fully reversible and the previous status is restored.",
          "The reason below appears in the customer's own audit log.",
        ]}
        confirmValue={props.tenantSlug}
        actionLabel="Suspend workspace"
        pending={pending}
        error={error}
        onConfirm={({ confirmValue, justification }) =>
          run(() =>
            props.onSuspend({
              tenantId: props.tenantId,
              confirmSlug: confirmValue,
              reason: justification,
            }),
          )
        }
      />

      {/* ---- REACTIVATE ---- */}
      <DangerDialog
        open={open === "reactivate"}
        onOpenChange={(v) => setOpen(v ? "reactivate" : null)}
        title={`Reactivate ${props.tenantName}`}
        description="Restores the status this workspace had before it was suspended."
        consequences={[
          "The previous status is read from the append-only audit record.",
          "A workspace that was `pending` returns to `pending`, not to active.",
        ]}
        destructive={false}
        minJustification={15}
        actionLabel="Reactivate workspace"
        pending={pending}
        error={error}
        onConfirm={({ justification }) =>
          run(() =>
            props.onReactivate({ tenantId: props.tenantId, reason: justification }),
          )
        }
      />

      {/* ---- IMPERSONATE ---- */}
      <DangerDialog
        open={open === "impersonate"}
        onOpenChange={(v) => setOpen(v ? "impersonate" : null)}
        title={`Enter ${props.tenantName}`}
        description="You will see the workspace as its users do, with a banner you cannot dismiss."
        consequences={[
          "The session expires automatically. Consented: 60 minutes. Break-glass: 15.",
          "Every action is recorded against YOUR name and flagged as impersonated.",
          "You can never delete data, change billing, export, or alter roles.",
          "The workspace owners are emailed that you entered.",
          props.hasConsent
            ? "This workspace has granted support access."
            : "No consent on file — break-glass only, and it is READ-ONLY.",
        ]}
        confirmValue={props.tenantSlug}
        minJustification={MIN_JUSTIFICATION_LENGTH}
        justificationLabel="Why do you need to enter this workspace?"
        actionLabel="Start session"
        pending={pending}
        error={error}
        extra={
          <div className="space-y-1">
            <Label htmlFor="impersonation-mode">Authorised by</Label>
            <Select
              id="impersonation-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="standing_consent" disabled={!props.hasConsent}>
                Standing consent — read and write
              </option>
              <option value="incident_consent" disabled={!props.hasConsent}>
                Incident consent — read and write
              </option>
              <option value="break_glass" disabled={!props.canBreakGlass}>
                Break-glass — READ ONLY, no consent, customer notified
              </option>
            </Select>
            <p className="text-xs text-muted-foreground">
              Break-glass is refused when consent already exists — use the consent.
            </p>

            {props.subjectUsers && props.subjectUsers.length > 0 ? (
              <div className="space-y-1 pt-2">
                <Label htmlFor="impersonation-subject">
                  Whose view are you reproducing? (optional)
                </Label>
                <Select
                  id="impersonation-subject"
                  value={subjectUserId}
                  onChange={(e) => setSubjectUserId(e.target.value)}
                >
                  <option value="">The workspace — not a specific person</option>
                  {props.subjectUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email} ({u.role})
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  Recorded on the session. It does not sign you in as them — every action
                  is still attributed to you by name.
                </p>
              </div>
            ) : null}
          </div>
        }
        onConfirm={({ confirmValue, justification }) =>
          run(() =>
            props.onImpersonate({
              tenantId: props.tenantId,
              mode,
              confirmSlug: confirmValue,
              justification,
              // Omitted entirely when blank: the Zod schema takes an
              // optional uuid, and an empty string is not one.
              ...(subjectUserId ? { subjectUserId } : {}),
            }),
          )
        }
      />
    </div>
  );
}

/** Small affordance used on the console home for a one-click return. */
export function EndImpersonationButton({
  onEnd,
}: {
  onEnd: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await onEnd();
          if (!r.ok) toast.error(r.error);
          router.refresh();
        })
      }
    >
      <Play className="h-4 w-4 rotate-180" aria-hidden />
      {pending ? "Ending…" : "End impersonation"}
    </Button>
  );
}
