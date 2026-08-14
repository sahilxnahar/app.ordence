/**
 * Ordence — Platform Console · ⭐⭐⭐ APPROVALS
 * Version: v1.22.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THAT MAKES THE QUEUE REAL
 * ══════════════════════════════════════════════════════════════════════
 * A queue with no screen is a table that fills up. Ordence has shipped
 * that shape seven times — a complete engine nothing reaches — and
 * `scripts/check-reachability.mjs` exists because of it. This page is
 * the reach.
 *
 * ⚠️ EVERY GUARD IS ON THE SERVER ACTION, NOT HERE. `getApprovalQueue`
 * and `decideRequest` both call `requireCapability` themselves, because
 * a server action is a POST to whatever URL the browser is on and this
 * route's protection does not extend to it.
 */

import { getApprovalQueue, decideRequest } from "@/server/platform/control-actions";
import { getPlatformOperator } from "@/server/platform/guard";
import { ApprovalQueue, type ApprovalRowView } from "@/components/platform/approval-queue";
import { APPROVAL_POLICIES } from "@/lib/platform/approvals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

export default async function ApprovalsPage() {
  const operator = await getPlatformOperator();
  const result = await getApprovalQueue();

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
      </Card>
    );
  }

  const rows: ApprovalRowView[] = result.data.rows.map((r) => ({
    id: String(r.id),
    actionKind: String(r.actionKind),
    targetLabel: String(r.targetLabel),
    justification: String(r.justification ?? ""),
    requestedBy: String(r.requestedBy),
    requestedAt: iso(r.requestedAt),
    expiresAt: iso(r.expiresAt),
    status: String(r.status),
    requiredGrade: String(r.requiredGrade),
    selfApproved: Boolean(r.selfApproved),
    decisionNote: r.decisionNote === null || r.decisionNote === undefined ? null : String(r.decisionNote),
    executionError:
      r.executionError === null || r.executionError === undefined ? null : String(r.executionError),
    proposedAfter: (r.proposedAfter ?? null) as Record<string, unknown> | null,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Six actions in the whole console are held here rather than executed.
          Everything else still runs immediately, and that is on purpose: a
          queue that fires on routine work is a queue people learn to
          rubber-stamp, and a rubber-stamped approval is worse than none
          because it looks like a control in an audit.
        </p>
      </div>

      <ApprovalQueue
        rows={rows}
        myStaffId={result.data.myStaffId}
        myGrade={(operator?.grade ?? "support") as "support" | "engineer" | "owner"}
        soleOperator={result.data.soleOperator}
        onDecide={decideRequest}
      />

      {/*
        ⭐ THE LIST IS PUBLISHED ON THE SCREEN THAT ENFORCES IT. An
        operator who knows which six actions are held does not experience
        the seventh as arbitrary.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What is held, and why</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {APPROVAL_POLICIES.map((p) => (
            <div key={p.kind} className="text-xs">
              <div className="font-medium">
                {p.label}{" "}
                <span className="font-normal text-muted-foreground">
                  — {p.approverGrade} approves · expires in {p.expiryHours}h
                </span>
              </div>
              <p className="text-muted-foreground">{p.because}</p>
            </div>
          ))}
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Deliberately absent: provisioning, consented read-only
            impersonation, and overrides on trial workspaces. All three are
            routine and reversible.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
