"use client";

/**
 * Ordence — The Impersonation Session Register
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS TABLE IS EVIDENCE, RENDERED. IT IS NOT A LIST OF SESSIONS.
 * ══════════════════════════════════════════════════════════════════════
 * Every row is an append-only record of one of us being inside a
 * customer's workspace: who, which workspace, under what authority, from
 * what address, for how long, how much they did, and how much the policy
 * refused them. The database will not let any of that be edited, and this
 * screen exists so that somebody actually looks at it.
 *
 * Four rendering decisions that are really safety decisions:
 *
 *   • LIVE IS COMPUTED FROM THE CLOCK, SERVER-SIDE. A row is live iff
 *     `now < expires_at AND ended_at IS NULL`. It is never inferred from
 *     `ended_at` alone: a sweeper that stops running would otherwise make
 *     every past session read as still open, and an operator would go
 *     looking for an intruder who left an hour ago.
 *
 *   • BREAK-GLASS IS LABELLED IN WORDS, not only coloured. "No consent —
 *     read only" is the fact; the colour is emphasis. Meaning carried by
 *     colour alone is meaning some operators cannot read.
 *
 *   • A SESSION WITH NO CUSTOMER NOTIFICATION IS CALLED OUT. "We told
 *     them" is a claim; `tenant_notified_at` is the evidence, and a NULL
 *     there is exactly what a review should be able to find.
 *
 *   • BLOCKED ACTIONS ARE SHOWN NEXT TO ACTIONS. A session with fifteen
 *     refusals is a session where somebody kept trying to do something
 *     the policy forbids, and that is worth a conversation.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Radio } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DangerDialog } from "./danger-dialog";

export type SessionRowView = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string | null;
  actorEmail: string;
  mode: string;
  /** The ceiling the customer's consent permitted. */
  scope: string;
  /** Whether write access was actually taken during the session. */
  writeAccessTaken: boolean;
  justification: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  /** The ending in WORDS. Never inferred from a colour. */
  endedReasonLabel: string;
  live: boolean;
  minutesLeft: number;
  consentId: string | null;
  tenantNotifiedAt: string | null;
  actionCount: number;
  blockedActionCount: number;
  ipAddress: string | null;
};

type ActionResult = { ok: true } | { ok: false; error: string };

export function SessionRegister({
  rows,
  canRevoke,
  onRevoke,
}: {
  rows: SessionRowView[];
  /** Owner grade only. Rendered disabled, never hidden, when absent. */
  canRevoke: boolean;
  onRevoke: (input: { sessionId: string; reason: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<SessionRowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No impersonation sessions match these filters. For the live filter that is the
        state you want: nobody is inside a customer&rsquo;s workspace.
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workspace</TableHead>
            <TableHead>Operator</TableHead>
            <TableHead>Authority</TableHead>
            <TableHead>Window</TableHead>
            <TableHead>Activity</TableHead>
            <TableHead>Customer told</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id} data-testid={`session-${s.id}`}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/platform/tenants/${s.tenantId}`}
                    className="font-medium hover:underline"
                  >
                    {s.tenantName ?? s.tenantSlug}
                  </Link>
                  {s.live ? (
                    <span
                      data-testid={`session-live-${s.id}`}
                      className="inline-flex items-center gap-1 rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white"
                    >
                      <Radio className="h-3 w-3" aria-hidden />
                      Live now
                    </span>
                  ) : null}
                </div>
                <div className="font-mono text-xs text-muted-foreground">{s.tenantSlug}</div>
              </TableCell>

              <TableCell>
                <div className="text-sm">{s.actorEmail}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {s.ipAddress ?? "no address recorded"}
                </div>
              </TableCell>

              <TableCell>
                <Badge variant={s.mode === "break_glass" ? "destructive" : "outline"}>
                  {s.mode === "break_glass"
                    ? "Break-glass — no consent"
                    : s.mode === "standing_consent"
                      ? "Standing consent"
                      : "Incident consent"}
                </Badge>
                {/*
                  ⭐ TWO FACTS, NOT ONE. "Consent allowed changes" and
                  "changes were actually possible" are different, and a
                  register that showed only the first would report every
                  consented session as if we had been editing the
                  customer's data. Both are words; neither is a colour.
                */}
                <div className="mt-1 text-xs">
                  {s.scope === "read_only"
                    ? "Consent: read only"
                    : "Consent: changes permitted"}
                </div>
                <div className="text-xs font-medium">
                  {s.writeAccessTaken
                    ? "Write access TAKEN"
                    : "Read only — write access never taken"}
                </div>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  {s.justification}
                </p>
              </TableCell>

              <TableCell className="text-xs">
                <div>{s.startedAt.slice(0, 16).replace("T", " ")}</div>
                <div className="text-muted-foreground">
                  {s.live
                    ? `ends in ${s.minutesLeft} min`
                    : /* ⭐ THE WORDS COME FROM THE SERVER, which already
                         resolved "not live and no recorded end" to
                         "expired". Re-deriving it here would be a second
                         opinion about the one thing this table exists to
                         report. */
                      `${s.endedReasonLabel}${s.endedAt ? ` at ${s.endedAt.slice(11, 16)}` : ""}`}
                </div>
              </TableCell>

              <TableCell className="text-xs tabular-nums">
                <div>{s.actionCount} actions</div>
                {s.blockedActionCount > 0 ? (
                  <div className="font-medium text-destructive">
                    {s.blockedActionCount} refused by policy
                  </div>
                ) : (
                  <div className="text-muted-foreground">none refused</div>
                )}
              </TableCell>

              <TableCell className="text-xs">
                {s.tenantNotifiedAt ? (
                  s.tenantNotifiedAt.slice(0, 16).replace("T", " ")
                ) : (
                  <Badge variant="destructive">not notified</Badge>
                )}
              </TableCell>

              <TableCell>
                {s.live ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!canRevoke}
                    title={
                      canRevoke
                        ? undefined
                        : "Platform owner grade required to end another operator's session."
                    }
                    onClick={() => {
                      setError(null);
                      setTarget(s);
                    }}
                  >
                    End now
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">closed</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DangerDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={`End ${target?.actorEmail ?? "this operator"}'s session`}
        description={`They are inside ${target?.tenantName ?? target?.tenantSlug ?? "a workspace"} right now.`}
        consequences={[
          "Their access stops immediately — the session is looked up from the database on every request, so there is no token that keeps working.",
          "The evidence row is not deleted or edited: only the end time and the reason are written, and the database refuses anything else.",
          "This is recorded as critical in the customer's own audit log and in the security event stream.",
          "Use this when a session should not be running — a stolen laptop, a mistaken start. It is not a way to resolve a disagreement quietly.",
        ]}
        minJustification={15}
        justificationLabel="Why is this session being ended?"
        actionLabel="End the session"
        pending={pending}
        error={error}
        onConfirm={({ justification }) => {
          if (!target) return;
          setError(null);
          startTransition(async () => {
            const result = await onRevoke({ sessionId: target.id, reason: justification });
            if (result.ok) {
              setTarget(null);
              toast.success("Session ended.");
              router.refresh();
            } else {
              setError(result.error);
            }
          });
        }}
      />
    </>
  );
}
