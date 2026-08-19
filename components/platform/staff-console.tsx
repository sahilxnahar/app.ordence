"use client";

/**
 * Ordence — ⭐⭐ PLATFORM ACCESS, FROM THE CONSOLE
 * Version: v1.43.0-alpha (Mega-wave 2, Batch 42)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY PLATFORM-STAFF GRANT IN THIS PRODUCT WAS A HAND-WRITTEN INSERT
 * ══════════════════════════════════════════════════════════════════════
 * `grantPlatformStaff` and `revokePlatformStaff` have been complete since
 * Phase 17 — allowlist check, self-grant refusal, mandatory expiry,
 * last-owner protection, critical audit rows — and NOTHING CALLED EITHER
 * OF THEM. Adding a colleague meant a psql prompt against production;
 * removing one meant the same prompt, at whatever hour the laptop went
 * missing.
 *
 * ⚠️ AND THE MISSING REVOKE IS THE WORSE HALF. A grant that is awkward to
 * create is a grant that gets created carefully. A revocation that
 * requires database access at 03:00 is a revocation that waits until
 * morning, and the whole design of `platform_staff` — the revocable key,
 * the one that needs no deploy — assumes it can be turned in seconds.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS ARRANGED TO ANSWER, IN ORDER
 * ══════════════════════════════════════════════════════════════════════
 *   1. WHO CAN SEE EVERY CUSTOMER'S DATA RIGHT NOW? — the first thing on
 *      the page, because it is the question somebody opens it to answer.
 *      A grant form above the list would mean reading the form to find
 *      out who already has access.
 *   2. Who used to, and who has drifted out of the allowlist.
 *   3. Only then: how to add somebody.
 *
 * ⚠️ NOTHING RENDERED HERE IS A SECURITY BOUNDARY. Every control is
 * re-decided by `requireCapability("staff:manage")` inside the engine,
 * which also re-checks the step-up, the allowlist and the expiry. A
 * disabled button is a courtesy to the operator, not a lock — the same
 * argument `components/platform/tenant-actions.tsx` makes for rendering
 * refused controls disabled rather than hidden.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HeldForApproval } from "@/components/platform/held-for-approval";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { DangerDialog } from "./danger-dialog";
import {
  PLATFORM_GRADES,
  PLATFORM_CAPABILITIES,
  GRADE_LABELS,
  capabilitiesForGrade,
  STEP_UP_MAX_AGE_MINUTES,
  type PlatformGrade,
} from "@/lib/platform/roles";

/* ------------------------------------------------------------------ */
/* TYPES — structurally the engine's, redeclared for the client bundle */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NOT IMPORTED FROM `@/server/platform/staff`. That module begins with
 * `import "server-only"` and reaches `guard.ts`; a `"use client"` file
 * that imports it fails the production build, which is the tripwire
 * working (see the header of `server/platform/actions.ts`). A `type`
 * import would be erased at compile time and would be safe — but the
 * boundary checker reads text, and teaching people that "importing from
 * server/ is fine if you write `type`" is how a value import gets added
 * later by somebody who read the line above it.
 */
type StaffRow = {
  id: string;
  email: string;
  displayName: string | null;
  grade: string;
  gradeLabel: string;
  status: string;
  grantedByEmail: string | null;
  grantedAt: string;
  expiresAt: string | null;
  expired: boolean;
  allowlisted: boolean;
  usable: boolean;
  isSelf: boolean;
  lastUsableOwner: boolean;
  lastRealOwner: boolean;
};

type Candidate = {
  email: string;
  knownClerkUserId: string | null;
  clerkIdSource: "previous_grant" | "workspace_membership" | null;
  displayName: string | null;
  hasUsableGrant: boolean;
  currentGrade: string | null;
  isSelf: boolean;
};

export type StaffConsoleProps = {
  rows: StaffRow[];
  candidates: Candidate[];
  usableOwners: number;
  usableAllowlistedOwners: number;
  operator: { clerkUserId: string; email: string; grade: string; canManage: boolean };
  allowlistConfigured: boolean;
  onGrant: (input: unknown) => Promise<ActionResult>;
  onRevoke: (input: unknown) => Promise<ActionResult>;
  onStepUp: () => Promise<{ ok: true }>;
  /** ⚠️ The console answers on two base paths. See `console-paths.ts`. */
  isConsoleHost?: boolean;
};

/** `needsStepUp` is the one refusal with a remedy — see `actions.ts`. */
/**
 * ⚠️ `data.queued` IS THE DIFFERENCE BETWEEN "THEY NOW HOLD OWNER" AND
 * "SOMEBODY HAS BEEN ASKED WHETHER THEY SHOULD". `staff.elevate` holds
 * any grant that RAISES an account's grade, inside `grantPlatformStaff`'s
 * own transaction. Announcing "X now holds owner platform access" when
 * nothing was written is how the next person stops checking the list.
 */
type ActionResult =
  | { ok: true; data?: { queued?: boolean; note?: string } }
  | { ok: false; error: string; needsStepUp?: boolean; fieldErrors?: Record<string, string[]> };

/* ------------------------------------------------------------------ */
/* EXPIRY                                                              */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE IS NO "PERMANENT" OPTION, AND THAT IS NOT AN OMISSION HERE
 * ══════════════════════════════════════════════════════════════════════
 * `grantPlatformStaffSchema.expiresAt` is `z.string().datetime()` —
 * REQUIRED, with no nullable and no default. The engine then refuses any
 * date that is not in the future. So a standing grant is not something
 * this form declines to offer; it is something the engine cannot
 * express, and the schema's own comment says why: "Standing access with
 * no end date is how contractors linger."
 *
 * ⚠️ THE TABLE STILL ALLOWS NULL, so rows with no expiry exist — every
 * one of them arrived through the psql prompt this screen replaces. The
 * list paints them red. That is the drift being made visible, not a
 * capability being offered.
 *
 * ⚠️ THE PRESETS ARE A MISTAKE GUARD, NOT A LIMIT. The server accepts any
 * future timestamp, including one in 2099. Somebody who wants that can
 * still type it into the custom field; what the presets prevent is a
 * hurried operator accidentally granting a year because the input
 * defaulted to something long.
 */
const EXPIRY_PRESETS = [
  { days: 7, label: "7 days", hint: "One incident, one on-call rotation." },
  { days: 30, label: "30 days", hint: "A project, a migration, a contractor." },
  { days: 90, label: "90 days", hint: "A quarter. Anything longer is a renewal." },
] as const;

/**
 * 🔴 `<input type="date">` YIELDS `2026-09-15`, WHICH `z.string().
 * datetime()` REJECTS. It wants a full RFC-3339 timestamp. Sending the
 * raw field value produces "Use an ISO timestamp." against a field the
 * operator filled in correctly, which reads as a broken form.
 *
 * End of day, in UTC: a grant said to last "until the 15th" that dies at
 * 00:00 on the 15th is a grant that dies on the 14th to everybody who
 * reads it.
 */
function dateInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T23:59:59.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* ================================================================== */
/* THE SCREEN                                                          */
/* ================================================================== */

export function StaffConsole(props: StaffConsoleProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [revoking, setRevoking] = useState<StaffRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heldNote, setHeldNote] = useState<string | null>(null);

  const live = props.rows.filter((r) => r.usable);
  const ended = props.rows.filter((r) => !r.usable);

  function run(fn: () => Promise<ActionResult>, success: string) {
    setError(null);
    setHeldNote(null);
    start(async () => {
      const result = await fn();
      if (result.ok) {
        setRevoking(null);
        /*
         * 🔴 NOT A SUCCESS TOAST FOR SOMETHING THAT HAS NOT HAPPENED.
         * The list below still shows the old grade — or no row at all —
         * and a green "X now holds owner platform access" turns that
         * into an apparently stale screen.
         */
        if (result.data?.queued) {
          setHeldNote(result.data.note ?? "This grant is waiting for approval.");
          router.refresh();
          return;
        }
        toast.success(success);
        router.refresh();
        return;
      }
      /**
       * ⚠️ THE STEP-UP CASE IS NOT AN ERROR MESSAGE, IT IS AN
       * INSTRUCTION. The operator's grade was fine; their second factor
       * was stale. Rendering it identically to "you may not do this"
       * teaches them the wrong thing about their own access.
       */
      if (result.needsStepUp) {
        setError(`${result.error} The button is at the top of this page.`);
        toast.error("Confirm your identity, then try again.");
        return;
      }
      setError(result.error);
      toast.error(result.error);
    });
  }

  return (
    <div className="space-y-6">
      {/*
        ⭐ AT THE TOP, ABOVE THE LIST IT CONTRADICTS. An elevation held by
        `staff.elevate` leaves this page looking exactly as it did before
        the click, which is the state a fading toast is worst at.
      */}
      {heldNote ? (
        <HeldForApproval
          note={heldNote}
          isConsoleHost={props.isConsoleHost ?? false}
          testId="staff-held-for-approval"
        />
      ) : null}

      {/* ============================================================ */}
      {/* ① RIGHT NOW                                                  */}
      {/* ============================================================ */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {live.length === 0
                ? "Nobody currently holds platform access"
                : `${live.length} ${live.length === 1 ? "person" : "people"} can cross a tenant boundary`}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Each of these can read every customer&rsquo;s records. Both keys are
              required to sign in, so a row marked <em>not on allowlist</em> cannot —
              but it is a grant nobody cleaned up.
            </p>
          </div>

          {/*
            ⚠️ THE STEP-UP BUTTON IS ALWAYS VISIBLE, not only after a
            refusal. An operator told "confirm your identity" who then has
            to hunt for the control reloads the page and loses the reason
            they had typed. Same decision as `module-switchboard.tsx`.
          */}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !props.operator.canManage}
            title={
              props.operator.canManage
                ? undefined
                : "Only platform owners can grant or revoke access."
            }
            onClick={() =>
              start(async () => {
                await props.onStepUp();
                toast.success(
                  `Identity confirmed for the next ${STEP_UP_MAX_AGE_MINUTES} minutes.`,
                );
              })
            }
          >
            <ShieldCheck className="h-4 w-4" aria-hidden /> Confirm identity
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {/*
            ══════════════════════════════════════════════════════════
            🔴 THE CONSOLE IS THE ONLY DOOR BACK IN. SAY SO BEFORE THE
               CLICK, NOT AFTERWARDS.
            ══════════════════════════════════════════════════════════
            `grantPlatformStaff` requires `staff:manage`, which only the
            `owner` grade holds. If the last owner goes, nobody can grant
            anybody — including themselves — and the way back is a
            hand-written row in the production database.

            The engine DOES refuse that (see REVOKE in
            `server/platform/staff.ts`): it counts the owners that would
            REMAIN and refuses when the answer is zero. Self-revocation
            stays possible while somebody else can still get in, which is
            the right trade — being unable to kill your own compromised
            session at 3am is the worse failure.

            ⚠️ BUT THE ENGINE'S COUNT IS NOT THE REAL COUNT. It filters on
            status and expiry and says nothing about the allowlist, so an
            owner row that is active-but-stale satisfies it while being
            unable to sign in. `usableAllowlistedOwners` is the honest
            number and the banner below shows the difference the moment
            there is one.
          */}
          <div
            className={`rounded-md border p-3 text-sm ${
              props.usableAllowlistedOwners === 0
                ? "border-destructive/50 bg-destructive/5"
                : props.usableAllowlistedOwners < props.usableOwners ||
                    props.usableAllowlistedOwners === 1
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-border bg-muted/40"
            }`}
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">
                  {props.usableAllowlistedOwners === 0
                    ? "No owner can currently sign in. This console has no way back."
                    : props.usableAllowlistedOwners === 1
                      ? "One owner. This console is the only way to create another."
                      : `${props.usableAllowlistedOwners} owners can sign in.`}
                </p>
                <p className="text-muted-foreground">
                  Granting platform access needs the <strong>owner</strong> grade. If the
                  last owner is revoked, nobody can grant anybody again and recovery is a
                  hand-written row in the production database. The server refuses to
                  revoke the last owner it can count — grant somebody else owner grade
                  first.
                </p>
                {props.usableAllowlistedOwners < props.usableOwners ? (
                  <p className="text-destructive">
                    ⚠️ {props.usableOwners - props.usableAllowlistedOwners} owner
                    {props.usableOwners - props.usableAllowlistedOwners === 1 ? "" : "s"}{" "}
                    below {props.usableOwners === 1 ? "is" : "are"} active but no longer
                    in PLATFORM_ADMIN_EMAILS. The server&rsquo;s last-owner check counts
                    them; they cannot actually sign in. This screen does not count them.
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {live.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No active grants. On a fresh deployment this is correct — and the console
              cannot be opened at all until the first grant is written directly into the
              database, because there is nobody to authorise one.
            </p>
          ) : (
            <StaffTable
              rows={live}
              canManage={props.operator.canManage}
              pending={pending}
              onRevoke={setRevoking}
            />
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ============================================================ */}
      {/* ② WHAT ENDED — evidence, not clutter                         */}
      {/* ============================================================ */}
      {ended.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Ended · {ended.length} expired or revoked
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {/*
                ⚠️ NOTHING IN THIS ENGINE DELETES. Revocation is a status
                change precisely so the record of who held platform access
                — and who ended it — survives the revocation. A DELETE
                would let somebody remove the evidence that they were ever
                staff, which is why this list is on the page rather than
                filtered out of it.
              */}
              Revocation is a status change, never a delete. Who held access, who granted
              it and who ended it stays readable.
            </p>
          </CardHeader>
          <CardContent>
            <StaffTable rows={ended} canManage={false} pending={pending} onRevoke={() => {}} />
          </CardContent>
        </Card>
      ) : null}

      {/* ============================================================ */}
      {/* ③ GRANT                                                      */}
      {/* ============================================================ */}
      <GrantCard {...props} pending={pending} run={run} />

      {/*
        ---- REVOKE ----
        ⚠️ MOUNTED CONDITIONALLY, unlike `tenant-actions.tsx` which keeps
        its dialogs mounted with `open={false}`. `DangerDialog` holds the
        typed confirmation and the justification in its OWN state, so a
        permanently-mounted instance carries whatever was typed for one
        person into the dialog opened for the next one — and this list is
        a column of near-identical addresses at the same domain, which is
        the precise mistake the typed confirmation exists to prevent.
        Unmounting between targets throws that state away.
      */}
      {revoking ? (
        <DangerDialog
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title={`Revoke platform access for ${revoking.email}`}
          description={
            revoking.isSelf
              ? "This is your own access. You will lose the console on your next request."
              : "Effective on their next request. They keep no session and no grace period."
          }
          consequences={[
            "Nothing is deleted. The row stays, marked revoked, naming you as the person who ended it.",
            "They lose the console immediately — the grant is re-read on every request, not cached in a session.",
            `Their entry in PLATFORM_ADMIN_EMAILS is NOT touched. Removing that needs a reviewed deploy${
              revoking.allowlisted ? "" : " — and this address is already off it"
            }.`,
            "Restoring access means a new grant, from an owner, with a new expiry — not an undo.",
            revoking.grade === "owner"
              ? "⚠️ This is an OWNER. Owners are the only grade that can grant access at all."
              : "This grade cannot grant access to anybody, so revoking it cannot lock the console.",
          ]}
          /**
           * ⚠️ THE TYPED EMAIL IS A MISTAKE GUARD, NOT SECURITY. Anyone
           * can type an email. It exists because this list is a column of
           * near-identical addresses at the same company domain and the
           * realistic failure is revoking the colleague one row up.
           */
          confirmValue={revoking.email}
          confirmLabel="Type their email address to confirm"
          justificationLabel="Why is this access ending?"
          minJustification={15}
          actionLabel={revoking.isSelf ? "Revoke my own access" : "Revoke access"}
          pending={pending}
          error={error}
          onConfirm={({ justification }) =>
            run(
              () => props.onRevoke({ staffId: revoking.id, reason: justification }),
              `${revoking.email} no longer has platform access.`,
            )
          }
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE LIST                                                            */
/* ------------------------------------------------------------------ */

function StaffTable({
  rows,
  canManage,
  pending,
  onRevoke,
}: {
  rows: StaffRow[];
  canManage: boolean;
  pending: boolean;
  onRevoke: (row: StaffRow) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Person</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>On allowlist</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Granted by</TableHead>
          <TableHead className="text-right">Access</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          /**
           * ⭐ THE REFUSAL IS SHOWN BEFORE THE CLICK, NOT AFTER IT.
           * `revokePlatformStaff` returns a paragraph explaining that
           * this is the last usable owner. Being told that only once the
           * dialog has been filled in and submitted reads as a bug, and
           * the operator has already decided by then.
           *
           * `lastRealOwner` is the stricter of the two: the engine would
           * permit the revoke, and the console would still be lost.
           */
          const blocked = row.lastUsableOwner || row.lastRealOwner;
          const blockedWhy = row.lastUsableOwner
            ? "The server refuses this: it is the last owner it can count. Grant somebody else owner grade first."
            : "The only owner who is still on PLATFORM_ADMIN_EMAILS. The server would allow this and the console would be unreachable afterwards.";

          return (
            <TableRow key={row.id} data-testid={`staff-${row.email}`}>
              <TableCell>
                <div className="font-medium">
                  {row.displayName ?? row.email}
                  {row.isSelf ? (
                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">{row.email}</div>
              </TableCell>
              <TableCell>{row.gradeLabel}</TableCell>
              <TableCell>
                <Badge variant={row.status === "active" ? "secondary" : "outline"}>
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell>
                {row.allowlisted ? (
                  <Badge variant="secondary">yes</Badge>
                ) : (
                  <Badge variant="destructive">no — stale grant</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {row.expiresAt ? (
                  <span className={row.expired ? "text-destructive" : undefined}>
                    {formatDay(row.expiresAt)}
                    {row.expired ? " (expired)" : ""}
                  </span>
                ) : (
                  <span className="text-destructive">never — review this</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.grantedByEmail ?? "—"}
              </TableCell>
              <TableCell className="text-right">
                {row.usable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !canManage || blocked}
                    title={
                      !canManage
                        ? "Only platform owners can revoke access."
                        : blocked
                          ? blockedWhy
                          : undefined
                    }
                    onClick={() => onRevoke(row)}
                  >
                    <UserMinus className="h-4 w-4" aria-hidden /> Revoke
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">ended</span>
                )}
                {blocked && row.usable ? (
                  <p className="mt-1 max-w-[16rem] text-right text-xs text-amber-600 dark:text-amber-500">
                    {blockedWhy}
                  </p>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* THE GRANT FORM                                                      */
/* ------------------------------------------------------------------ */

function GrantCard({
  candidates,
  operator,
  allowlistConfigured,
  onGrant,
  pending,
  run,
}: StaffConsoleProps & {
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, success: string) => void;
}) {
  const [email, setEmail] = useState("");
  /**
   * ⭐ NO DEFAULT GRADE. `support`, `engineer` and `owner` are three
   * materially different amounts of power over every customer in the
   * system, and a pre-selected one is the one that gets granted by
   * somebody who was concentrating on the expiry field. The submit
   * button stays disabled until this is a deliberate click.
   */
  const [grade, setGrade] = useState<PlatformGrade | "">("");
  const [expiryDays, setExpiryDays] = useState<number | "custom">(7);
  const [customDate, setCustomDate] = useState("");
  const [clerkUserId, setClerkUserId] = useState("");
  const [reason, setReason] = useState("");

  const candidate = useMemo(
    () => candidates.find((c) => c.email === email) ?? null,
    [candidates, email],
  );

  // Re-selecting a person replaces the id; an operator who has typed one
  // by hand keeps it, because they typed it for a reason.
  function pickEmail(value: string) {
    setEmail(value);
    const next = candidates.find((c) => c.email === value) ?? null;
    setClerkUserId(next?.knownClerkUserId ?? "");
  }

  const expiresAt =
    expiryDays === "custom" ? dateInputToIso(customDate) : daysFromNowIso(expiryDays);

  const ready =
    Boolean(email) &&
    Boolean(grade) &&
    clerkUserId.trim().length > 0 &&
    Boolean(expiresAt) &&
    reason.trim().length >= 20 &&
    !candidate?.isSelf &&
    operator.canManage &&
    !pending;

  const maxDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  function submit() {
    if (!ready || !expiresAt) return;
    run(
      () =>
        onGrant({
          clerkUserId: clerkUserId.trim(),
          email,
          displayName: candidate?.displayName ?? undefined,
          grade,
          reason: reason.trim(),
          expiresAt,
        }),
      `${email} now holds ${grade} platform access until ${formatDay(expiresAt)}.`,
    );
    setReason("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Give somebody platform access</CardTitle>
        {/*
          ══════════════════════════════════════════════════════════════
          ⭐ THIS FORM CANNOT MINT ACCESS, AND SAYING SO IS THE POINT
          ══════════════════════════════════════════════════════════════
          `grantPlatformStaff` refuses any address that is not already in
          `PLATFORM_ADMIN_EMAILS` — a deploy-time file that no database
          compromise can edit. So this turns the SECOND key for somebody
          who already holds the first, and an attacker sitting on a
          stolen owner session can only promote people the organisation
          has already decided to trust.

          ⚠️ WHICH IS ALSO WHY THE PERSON PICKER IS A LIST AND NOT A TEXT
          BOX. Every value a text box could carry that is not on this
          list is a round-trip ending in a refusal, and a form whose
          normal outcome is a refusal is a form people learn to fight.
        */}
        <p className="mt-1 text-sm text-muted-foreground">
          Only addresses already in <code className="font-mono">PLATFORM_ADMIN_EMAILS</code>{" "}
          can be granted. That file changes by reviewed deploy, so this screen turns the
          second key for somebody who already holds the first — it cannot create access
          on its own.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {!operator.canManage ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {/*
              Shown disabled rather than hidden. A support engineer who
              cannot see this form learns that the capability does not
              exist and asks for a script; one who sees it greyed out with
              the reason learns the access model.
            */}
            Your grade is {GRADE_LABELS[operator.grade as PlatformGrade] ?? operator.grade}.
            Only a platform owner can grant or revoke access — everything below is
            read-only for you.
          </p>
        ) : null}

        {!allowlistConfigured ? (
          <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <code className="font-mono">PLATFORM_ADMIN_EMAILS</code> is empty, so nobody
            can be granted access and — because an empty allowlist matches nobody —
            nobody can sign in either. That is the correct failure mode for a missing
            environment variable; it is also a deploy that needs fixing.
          </p>
        ) : null}

        {/* ---- ① WHO ---------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="grant-email">Who</Label>
          <Select
            id="grant-email"
            value={email}
            disabled={!operator.canManage || pending}
            onChange={(e) => pickEmail(e.target.value)}
          >
            <option value="">Choose an allowlisted address…</option>
            {candidates.map((c) => (
              <option key={c.email} value={c.email} disabled={c.isSelf}>
                {c.email}
                {c.isSelf ? " — you, and you cannot grant to yourself" : ""}
                {c.hasUsableGrant ? ` — already ${c.currentGrade}` : ""}
              </option>
            ))}
          </Select>

          {candidate?.isSelf ? (
            /*
              🔴 THE ENGINE REFUSES THIS AND THE REASON IS NOT OBVIOUS.
              The grant is an upsert on `clerk_user_id`, so it is also the
              RENEWAL path — without the self check an owner could extend
              their own grant forever, clear their own revocation and
              re-grade themselves with no second party anywhere in the
              flow. Revocation stays self-serviceable; extension does not.
            */
            <p className="text-xs text-destructive">
              You cannot grant or renew your own access. Ask another owner — the mandatory
              expiry is worth nothing if the person it expires can extend it.
            </p>
          ) : null}

          {candidate?.hasUsableGrant ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              ⚠️ This replaces their existing {candidate.currentGrade} grant rather than
              adding a second one: new grade, new expiry, and their step-up is cleared so
              they must prove a factor again before doing anything dangerous.
            </p>
          ) : null}
        </div>

        {/* ---- ② WHICH ACCOUNT ------------------------------------ */}
        <div className="space-y-1.5">
          <Label htmlFor="grant-clerk-id">Clerk user id</Label>
          <Input
            id="grant-clerk-id"
            value={clerkUserId}
            disabled={!operator.canManage || pending}
            autoComplete="off"
            spellCheck={false}
            placeholder="user_2abc…"
            onChange={(e) => setClerkUserId(e.target.value)}
          />
          {/*
            ⭐ THE ID IS THE IDENTITY; THE EMAIL BESIDE IT IS A LABEL.
            `platform_staff` keys on `clerk_user_id` because an address
            can be changed, re-verified onto another account or recycled
            after somebody leaves.

            ⚠️ A MISTYPED ID FAILS QUIETLY IN BOTH DIRECTIONS. The person
            you meant to grant gets nothing and finds out during an
            incident; a stranger gets a `platform_staff` row, which alone
            opens nothing — their own email is not allowlisted, so KEY 1
            still refuses — but it is a grant nobody intended, sitting in
            the table an access review reads.
          */}
          <p className="text-xs text-muted-foreground">
            {candidate?.clerkIdSource === "previous_grant"
              ? "Taken from their previous grant — the same account, not a new one."
              : candidate?.clerkIdSource === "workspace_membership"
                ? "Found from a workspace membership under this address. Check it against Clerk before granting."
                : "We have never seen this person. Copy the id from the Clerk dashboard — the email is only a label, this is the identity the grant keys on."}
          </p>
        </div>

        {/* ---- ③ HOW MUCH ----------------------------------------- */}
        <fieldset className="space-y-2" disabled={!operator.canManage || pending}>
          <legend className="text-sm font-medium">What they may do</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PLATFORM_GRADES.map((g) => {
              const caps = capabilitiesForGrade(g);
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={grade === g}
                  onClick={() => setGrade(g)}
                  className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                    grade === g
                      ? "border-foreground/40 bg-accent/40"
                      : "hover:bg-accent/20"
                  }`}
                >
                  <div className="font-medium">{GRADE_LABELS[g]}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {caps.length} of {Object.keys(PLATFORM_CAPABILITIES).length}{" "}
                    capabilities
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    {/*
                      ⭐ THE CAPABILITIES ARE LISTED, NOT SUMMARISED IN AN
                      ADJECTIVE. "Engineer" tells an operator nothing about
                      whether that person can read every customer's billing
                      record without asking. The matrix is not a secret and
                      it is the whole content of the decision being made.
                    */}
                    {caps.map((c) => (
                      <li key={c}>· {PLATFORM_CAPABILITIES[c]}</li>
                    ))}
                  </ul>
                  {g === "owner" ? (
                    <p className="mt-2 text-xs text-destructive">
                      Owners can grant and revoke platform access, including yours.
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
          {grade === "" ? (
            <p className="text-xs text-muted-foreground">
              Pick one. There is no default, deliberately — these are three different
              amounts of power over every customer in the system.
            </p>
          ) : null}
        </fieldset>

        {/* ---- ④ FOR HOW LONG ------------------------------------- */}
        <fieldset className="space-y-2" disabled={!operator.canManage || pending}>
          <legend className="text-sm font-medium">Until when</legend>
          <div className="flex flex-wrap gap-2">
            {EXPIRY_PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                aria-pressed={expiryDays === p.days}
                onClick={() => setExpiryDays(p.days)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  expiryDays === p.days
                    ? "border-foreground/40 bg-accent/40"
                    : "hover:bg-accent/20"
                }`}
              >
                <div className="font-medium">{p.label}</div>
                <div className="text-xs text-muted-foreground">{p.hint}</div>
              </button>
            ))}
            <button
              type="button"
              aria-pressed={expiryDays === "custom"}
              onClick={() => setExpiryDays("custom")}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                expiryDays === "custom"
                  ? "border-foreground/40 bg-accent/40"
                  : "hover:bg-accent/20"
              }`}
            >
              <div className="font-medium">A specific date</div>
              <div className="text-xs text-muted-foreground">Ends at 23:59 UTC.</div>
            </button>
          </div>

          {expiryDays === "custom" ? (
            <Input
              type="date"
              aria-label="Access ends on"
              value={customDate}
              max={maxDate}
              onChange={(e) => setCustomDate(e.target.value)}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">
            {/*
              ⚠️ NO PERMANENT OPTION EXISTS TO OFFER. `expiresAt` is a
              required field on the schema — see EXPIRY_PRESETS above.
              Saying so is better than leaving an operator hunting for a
              "never" they will conclude is a missing feature.
            */}
            There is no permanent option: every grant made here ends by itself, because
            standing access with no end date is how a contractor from two years ago still
            reads customer billing records. A longer stay is a renewal by another owner,
            which is a decision somebody makes again rather than one nobody revisits.
            {expiresAt ? ` Ends ${formatDay(expiresAt)}.` : ""}
          </p>
        </fieldset>

        {/* ---- ⑤ WHY ---------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="grant-reason">Why does this person need it?</Label>
          <Textarea
            id="grant-reason"
            rows={3}
            value={reason}
            disabled={!operator.canManage || pending}
            placeholder="Name, ticket or rota, and what they are doing. Written to the permanent platform record."
            onChange={(e) => setReason(e.target.value)}
          />
          {/*
            The minimum is not a formality. Nothing can check whether the
            sentence is true; it is the field a reviewer reads six months
            later, and the twenty-character floor exists to make "test"
            impossible rather than to make the operator suffer.
          */}
          <p className="text-xs text-muted-foreground">
            {reason.trim().length}/20 characters minimum. This is written to the platform
            action log at <strong>critical</strong> severity, next to your name.
          </p>
        </div>

        <Button disabled={!ready} onClick={submit}>
          <UserPlus className="h-4 w-4" aria-hidden />
          {pending
            ? "Granting…"
            : grade
              ? `Grant ${GRADE_LABELS[grade]} access`
              : "Grant access"}
        </Button>
      </CardContent>
    </Card>
  );
}
