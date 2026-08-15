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
import { Textarea } from "@/components/ui/textarea";
import { DangerDialog } from "./danger-dialog";
import { MIN_JUSTIFICATION_LENGTH } from "@/lib/platform/impersonation-policy";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A QUEUED ACTION IS NOT A COMPLETED ACTION, AND `ok: true` MEANT
 *      BOTH
 * ══════════════════════════════════════════════════════════════════════
 * `requestSuspend` does not suspend anything. It writes a row to the
 * approval queue and returns `ok: true` with a sentence that begins
 * "Nothing has happened yet." The server got this exactly right.
 *
 * ⚠️ THIS COMPONENT THREW THE SENTENCE AWAY AND SAID "Done." The
 * operator closed the dialog believing a live workspace was locked, and
 * the two ways that goes are both bad: they tell the customer it is done
 * and it is not, or they walk away from an incident they think they have
 * contained. Nothing on the screen contradicted them — the tenant row
 * still said `active`, which reads as a stale page.
 *
 * 🔴 THE TYPE WAS THE ROOT CAUSE. `ActionResult` was `{ ok: true }` with
 * no payload, so the note was not merely ignored — it was unreachable.
 * A shape that cannot express "accepted but not performed" forces every
 * caller to guess, and the cheerful guess is the one that gets written.
 *
 * ⭐ SO THE QUEUED PATH HAS ITS OWN RETURN TYPE. `data.note` is required,
 * not optional, which means a future caller cannot forget to render it.
 */
type QueuedResult =
  | { ok: true; data: { note: string } }
  | { ok: false; error: string };

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
  /** ⚠️ Returns a QUEUE RECEIPT, not a completed suspension. */
  onSuspend: (input: {
    tenantId: string;
    confirmSlug: string;
    reason: string;
    /** ⭐ The tenant layer of `suspension.customer_message`. See below. */
    customerMessage?: string;
  }) => Promise<QueuedResult>;
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
  /**
   * ⭐⭐ THE RECEIPT STAYS ON THE SCREEN AFTER THE DIALOG CLOSES.
   *
   * ⚠️ A TOAST IS THE WRONG CARRIER FOR "nothing happened yet". It
   * fades in four seconds, it is easy to miss behind a dialog closing,
   * and what the operator is left looking at is a tenant row that still
   * says `active` — which reads as a stale page rather than as the
   * truth. The sentence has to outlive the animation.
   */
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  /** Blank means "use the plan's sentence", never "use an empty one". */
  const [customerMessage, setCustomerMessage] = useState("");

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

  /**
   * 🔴 A SEPARATE RUNNER FOR THE QUEUED PATH, DELIBERATELY NOT A FLAG ON
   * `run`.
   *
   * ⚠️ `run` SAYS "Done." AND THAT IS CORRECT FOR REACTIVATE AND FOR
   * IMPERSONATE — both of those really have happened by the time they
   * return. The bug was one function serving both meanings, so the
   * cheerful wording leaked onto the one action that had not happened.
   * Two runners means the compiler decides which sentence you get,
   * rather than whoever edits this file next.
   *
   * ⭐ THE SERVER'S OWN WORDS ARE SHOWN VERBATIM. `queueForApproval`
   * writes the note — what is waiting, why it is held, and when the
   * request expires — and a summary written here would drift from it and
   * would drop the expiry, which is the part that matters at 2am.
   */
  function runQueued(fn: () => Promise<QueuedResult>) {
    setError(null);
    setQueuedNote(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setOpen(null);
        setQueuedNote(result.data.note);
        // ⚠️ NOT `toast.success`. Green with a tick is read as "it
        // worked", and the whole point of this branch is that it has not
        // worked yet. `toast.info` plus the persistent block below.
        toast.info(result.data.note);
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
        title={`Request suspension of ${props.tenantName}`}
        description="This goes to the approval queue. Nothing happens until a second owner approves it."
        /**
         * 🔴 THIS LIST USED TO SAY "They can still sign in, reach
         * billing, and export all of their data." IT IS NOT TRUE.
         * `requireTenantContext` refuses any workspace whose status is
         * not `active` or `pending`, before the billing gate and before
         * the export exemption, and `/settings/billing` lives inside the
         * same layout — so a suspended customer cannot reach the page
         * this console tells you to send them to.
         *
         * ⚠️ THE FIX IS A SEPARATE BATCH because it opens a door that is
         * currently shut and every route has to be checked against
         * `canWrite: false` first. Until then the operator is told what
         * actually happens, not what was intended. An operator making a
         * suspension decision on a false description of its effect is
         * worse than the lockout itself.
         */
        consequences={[
          "NOTHING is deleted. Every record stays exactly where it is.",
          "⚠️ Today this is a FULL lockout: they cannot sign in, cannot reach billing and cannot export. That is not the intended behaviour and is being fixed.",
          "This is fully reversible and the previous status is restored.",
          "The reason below appears in the customer's own audit log, and in the approval request.",
        ]}
        confirmValue={props.tenantSlug}
        actionLabel="Send for approval"
        pending={pending}
        error={error}
        /*
          ══════════════════════════════════════════════════════════════
          ⭐⭐ THE CUSTOMER-FACING MESSAGE, COLLECTED AT LAST — BATCH 47
          ══════════════════════════════════════════════════════════════
          `suspendTenantSchema` has carried `customerMessage` since
          v0.14.0 and NO SCREEN HAS EVER COLLECTED IT. The field existed,
          the plumbing existed all the way to the audit row, and the only
          way to populate it was to call the server action by hand.

          ⭐ It now writes the tenant layer of
          `suspension.customer_message` in the configuration chain —
          typed, capped, versioned, with this operator's name on it — and
          leaving it blank falls back to the plan's sentence rather than
          to nothing.

          ⚠️ AND THE HONEST LINE UNDERNEATH, because the alternative is
          an operator carefully writing a sentence for a customer who
          will never see it: the lockout banner is still a fixed string
          in `lib/billing/access-state.ts`.
        */
        extra={
          <div className="space-y-1">
            <Label htmlFor="suspend-customer-message">
              What should this customer be told? (optional)
            </Label>
            <Textarea
              id="suspend-customer-message"
              rows={2}
              maxLength={500}
              value={customerMessage}
              onChange={(e) => setCustomerMessage(e.target.value)}
              placeholder="Left blank, they get their plan's standard suspension sentence."
            />
            <p className="text-xs text-muted-foreground">
              Stored as this workspace&rsquo;s override for{" "}
              <code className="font-mono">suspension.customer_message</code>, separately from
              the internal reason below. ⚠️ It is not rendered to them yet — the lockout
              banner is a fixed sentence in <code className="font-mono">access-state.ts</code>.
            </p>
          </div>
        }
        onConfirm={({ confirmValue, justification }) =>
          runQueued(() =>
            props.onSuspend({
              tenantId: props.tenantId,
              confirmSlug: confirmValue,
              reason: justification,
              // Omitted entirely when blank: the schema treats an empty
              // string as absent, and sending "" would overwrite a
              // message somebody wrote earlier with nothing.
              ...(customerMessage.trim() ? { customerMessage: customerMessage.trim() } : {}),
            }),
          )
        }
      />

      {/*
        ⭐⭐ THE ONE THING THE OPERATOR MUST NOT MISREAD, RENDERED AS A
        BLOCK RATHER THAN A NOTIFICATION.
        ⚠️ IT SAYS "still running" IN ITS OWN WORDS AS WELL AS QUOTING
        THE SERVER, because the server's sentence explains the queue and
        this one answers the question actually in the operator's head:
        "is the customer locked out right now?" No.
      */}
      {queuedNote ? (
        <div
          className="w-full rounded border border-amber-400 p-3 text-xs"
          role="status"
          data-testid="suspend-queued-notice"
        >
          <span className="font-medium">
            {props.tenantName} has NOT been suspended. It is still running
            normally and its users are unaffected.{" "}
          </span>
          {queuedNote}{" "}
          <a className="underline" href="/platform/approvals">
            Open the approvals queue
          </a>
          .
        </div>
      ) : null}

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
