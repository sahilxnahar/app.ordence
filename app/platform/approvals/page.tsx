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
import { getApprovalEnforcement } from "@/server/platform/approvals";
import { getPlatformOperator } from "@/server/platform/guard";
import { ApprovalQueue, type ApprovalRowView } from "@/components/platform/approval-queue";
import {
  ApprovalPolicyBoard,
  type PolicyEnforcementView,
} from "@/components/platform/approval-policy-board";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

export default async function ApprovalsPage() {
  const operator = await getPlatformOperator();
  const result = await getApprovalQueue();
  /**
   * ⭐⭐ THE POLICY LIST IS NOW A SERVER READ, NOT A RENDER OF A
   * CONSTANT.
   *
   * ⚠️ IT USED TO BE `APPROVAL_POLICIES.map(...)` INLINE. That is the
   * whole defect: the constant describes what SHOULD be held, and the
   * screen presented it as what IS held. `getApprovalEnforcement` reads
   * the live executor registry, so the badge on each row cannot claim
   * more than the code can do.
   *
   * 🔴 IT MUST BE CALLED AT REQUEST TIME AND FROM A MODULE THAT HAS
   * ALREADY IMPORTED `control-actions`, because that is the import whose
   * side effect registers the executors. The import above does it; a
   * report computed at module-evaluation time would find an empty
   * registry and tell an operator nothing is enforced.
   */
  const enforcement = await getApprovalEnforcement();

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
    /**
     * ⭐⭐ PER ROW, NOT PER SCREEN, AND IT IS THE SAME NUMBER THE SERVER
     * WILL USE WHEN THE BUTTON IS PRESSED.
     *
     * ⚠️ `result.data.soleOperator` is a single flag for the whole list,
     * derived from a count of ALL usable grants regardless of grade. Every
     * policy here needs `owner`, so on a platform with one owner and one
     * support engineer that flag says "you are not alone" to the only
     * person who can decide anything — and `mayApprove` then refuses the
     * support engineer on grade. Nobody can approve, every request expires,
     * and the queue is a wall.
     *
     * 🔴 `listPending` now computes, for each row, how many usable grants
     * at or above that policy's approver grade belong to somebody who is
     * NOT the requester. Zero means genuinely nobody else to ask, which is
     * the only condition the self-approval hatch was ever meant to turn on.
     */
    otherEligibleApprovers: Number(r.otherEligibleApprovers ?? 0),
  }));

  const policies: readonly PolicyEnforcementView[] = enforcement.ok
    ? enforcement.data
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        {/*
          🔴 THIS PARAGRAPH USED TO OPEN "Six actions in the whole console
          are held here rather than executed." It was the same claim the
          list below made and it was wrong in the same way: one of the six
          is held. Saying six on the page that exists to be honest about
          approvals is the exact sentence an auditor would quote back.
        */}
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A short list of actions is held here rather than executed —
          currently the ones marked Enforced below, and no others.
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
        onDecide={decideRequest}
      />

      {/*
        ⭐ THE LIST IS PUBLISHED ON THE SCREEN THAT ENFORCES IT — and now
        it says which of them that screen actually enforces. An operator
        who knows which actions are held does not experience the next one
        as arbitrary; an operator who is told six are held when one is
        stops checking.
      */}
      {enforcement.ok ? (
        <ApprovalPolicyBoard policies={policies} />
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {enforcement.error}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
