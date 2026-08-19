import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE SEAT APPROVAL QUEUE
 * Version: v1.71.0-alpha (0114)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HOLE THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * Until 0114 the seat limit was advisory. There is no in-product invite,
 * so people arrive through Clerk, and that path checked the limit, wrote
 * an audit row and admitted them anyway. A workspace on ten seats could
 * have thirty people.
 *
 * ⭐ Now they arrive as `pending_seat` and land here. Two people can let
 * them in, and the two are not the same act:
 *
 *   THE WORKSPACE OWNER approves, which CONSUMES a seat. It can therefore
 *   fail, and it should — that is the whole point. The refusal names the
 *   price.
 *
 *   ORDENCE grants, which ADDS a seat. It cannot fail on capacity,
 *   because it IS capacity. It needs a reason of at least ten characters
 *   and a CHECK constraint enforces that in the database.
 *
 * ⚠️ EVERY FUNCTION HERE TAKES A `tx`, so the status change and the
 * resolution commit together. A user flipped to `active` whose request is
 * still open is a person an owner will approve twice.
 */

import { and, eq, sql } from "drizzle-orm";
import type { withTenant } from "@/db";
import { users } from "@/db/schema/core";
import { seatGrants, seatRequests } from "@/db/schema/billing";
import { PENDING_SEAT_STATUS } from "@/lib/billing/seats";
import { countSeatsInUse, countEffectiveSeats } from "@/server/billing/seats";
import { canTakeSeats } from "@/lib/billing/seats";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export class SeatApprovalRefusal extends Error {}

export type PendingSeatRow = {
  requestId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  source: string;
  requestedAt: string;
  /** 🔴 The position when they arrived, not now. See the schema comment. */
  seatsUsedAtRequest: number;
  seatsAvailableAtRequest: number;
  waitingDays: number;
};

/**
 * ⭐ THE QUEUE, OLDEST FIRST.
 *
 * ⚠️ OLDEST FIRST AND NOT NEWEST. A queue sorted newest-first buries the
 * person who has been waiting eleven days under three who arrived this
 * morning, and they are precisely the one somebody needs to deal with.
 */
export async function listPendingSeats(
  tx: Tx,
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly PendingSeatRow[]> {
  const rows = await tx
    .select({
      requestId: seatRequests.id,
      userId: seatRequests.userId,
      source: seatRequests.source,
      requestedAt: seatRequests.requestedAt,
      seatsUsedAtRequest: seatRequests.seatsUsedAtRequest,
      seatsAvailableAtRequest: seatRequests.seatsAvailableAtRequest,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
    })
    .from(seatRequests)
    .innerJoin(users, eq(users.id, seatRequests.userId))
    .where(
      and(
        eq(seatRequests.tenantId, tenantId),
        sql`${seatRequests.resolvedAt} IS NULL`,
      ),
    )
    .orderBy(seatRequests.requestedAt);

  return rows.map((r: Record<string, unknown>) => {
    const at =
      r.requestedAt instanceof Date
        ? r.requestedAt
        : new Date(String(r.requestedAt));
    return {
      requestId: r.requestId as string,
      userId: r.userId as string,
      email: (r.email as string) ?? "",
      name:
        [r.firstName, r.lastName].filter(Boolean).join(" ").trim() ||
        ((r.email as string) ?? "someone"),
      role: (r.role as string) ?? "member",
      source: r.source as string,
      requestedAt: at.toISOString(),
      seatsUsedAtRequest: Number(r.seatsUsedAtRequest ?? 0),
      seatsAvailableAtRequest: Number(r.seatsAvailableAtRequest ?? 0),
      waitingDays: Math.max(
        0,
        Math.floor((now.getTime() - at.getTime()) / 86_400_000),
      ),
    };
  });
}

/**
 * ⭐⭐⭐ THE OWNER APPROVES, AND IT CONSUMES A SEAT.
 *
 * 🔴 IT CAN FAIL, AND THE FAILURE IS THE FEATURE. If there is no seat
 * free the approval is refused with the price named. Letting it through
 * and adding the seat to next month's invoice is what
 * `lib/billing/seats.ts` already refuses to do, and its reason holds
 * here: *"an admin adding twelve people on a Friday afternoon discovers a
 * bill they never agreed to on the first of the month."*
 */
export async function approvePendingSeat(
  tx: Tx,
  args: {
    tenantId: string;
    requestId: string;
    approvedByUserId: string;
    fallbackSeatLimit: number;
  },
): Promise<{ userId: string; seatsRemaining: number }> {
  const [request] = await tx
    .select()
    .from(seatRequests)
    .where(
      and(
        eq(seatRequests.tenantId, args.tenantId),
        eq(seatRequests.id, args.requestId),
        sql`${seatRequests.resolvedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!request) {
    throw new SeatApprovalRefusal(
      "That request is no longer open. Somebody may have resolved it, or the person may have been removed from the workspace.",
    );
  }

  /**
   * ⚠️ RE-COUNTED HERE, NEVER READ OFF THE REQUEST ROW. The frozen
   * numbers on the request explain why it was raised; they are not a
   * licence to admit somebody today. Between the two, three people may
   * have left or four more may have arrived.
   */
  const [used, effective] = await Promise.all([
    countSeatsInUse(args.tenantId),
    countEffectiveSeats(args.tenantId, args.fallbackSeatLimit),
  ]);
  const verdict = canTakeSeats(used, effective, 1);
  if (!verdict.allowed) throw new SeatApprovalRefusal(verdict.message);

  await tx
    .update(users)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(users.tenantId, args.tenantId),
        eq(users.id, request.userId as string),
        eq(users.status, PENDING_SEAT_STATUS),
      ),
    );

  await tx
    .update(seatRequests)
    .set({
      resolvedAt: new Date(),
      resolution: "approved",
      resolvedBy: args.approvedByUserId,
    })
    .where(eq(seatRequests.id, args.requestId));

  return {
    userId: request.userId as string,
    seatsRemaining: Math.max(0, effective - used - 1),
  };
}

/**
 * ⭐ DECLINING, AND IT NEEDS A REASON.
 *
 * 🔴 THE ASYMMETRY IS DELIBERATE and matches the GSTR-2B worklist:
 * approving is explained by the seat count, refusing is explained by
 * nothing. Without the sentence, "why was this person never let in" has
 * no answer three months later, and the person is still sitting on a
 * screen telling them their administrator has been asked.
 *
 * ⚠️ THE USER IS NOT DELETED. They stay `pending_seat`, which means they
 * can still sign in and still see the explanation. Deleting them would
 * make the decision invisible to the only person it affects.
 */
export async function declinePendingSeat(
  tx: Tx,
  args: {
    tenantId: string;
    requestId: string;
    declinedByUserId: string;
    reason: string;
  },
): Promise<void> {
  if (args.reason.trim().length < 10) {
    throw new SeatApprovalRefusal(
      "Say why this person is not being given a seat. They can see that they are waiting, and a refusal with no reason leaves them waiting for ever.",
    );
  }

  const result = await tx
    .update(seatRequests)
    .set({
      resolvedAt: new Date(),
      resolution: "declined",
      resolvedBy: args.declinedByUserId,
      resolutionReason: args.reason.trim(),
    })
    .where(
      and(
        eq(seatRequests.tenantId, args.tenantId),
        eq(seatRequests.id, args.requestId),
        sql`${seatRequests.resolvedAt} IS NULL`,
      ),
    )
    .returning({ id: seatRequests.id });

  if (result.length === 0) {
    throw new SeatApprovalRefusal("That request is no longer open.");
  }
}

/**
 * ⭐⭐⭐ ORDENCE GRANTS CAPACITY. This is the "unless I approve it" half.
 *
 * 🔴 A GRANT RAISES THE LIMIT; IT DOES NOT FILL A SEAT. So it survives
 * the person who prompted it leaving, and the workspace keeps the
 * concession somebody deliberately made rather than losing it silently on
 * an offboarding.
 *
 * ⚠️ IT DOES NOT APPROVE ANYBODY BY ITSELF. Granting capacity and
 * choosing who fills it are two decisions, and only one of them is
 * Ordence's to make. After a grant the owner's queue simply has seats
 * available, and they approve whom they like.
 */
export async function grantSeats(
  tx: Tx,
  args: {
    tenantId: string;
    seats: number;
    reason: string;
    grantedByKind: "platform" | "owner";
    grantedByUserId: string | null;
    expiresAt: Date | null;
  },
): Promise<{ id: string }> {
  if (!Number.isInteger(args.seats) || args.seats <= 0) {
    throw new SeatApprovalRefusal("A grant of zero seats is not a grant.");
  }
  if (args.reason.trim().length < 10) {
    throw new SeatApprovalRefusal(
      "A granted seat needs a reason. Without one it is indistinguishable from a mistake in the billing table, and it is found by somebody asking why revenue per workspace does not foot.",
    );
  }

  const [row] = await tx
    .insert(seatGrants)
    .values({
      tenantId: args.tenantId,
      seats: args.seats,
      reason: args.reason.trim(),
      grantedByKind: args.grantedByKind,
      grantedByUserId: args.grantedByUserId,
      expiresAt: args.expiresAt,
    })
    .returning({ id: seatGrants.id });

  if (!row) throw new SeatApprovalRefusal("The grant could not be recorded.");
  return { id: row.id as string };
}

/**
 * ⚠️ REVOKING NEEDS A REASON TOO, and a CHECK enforces it. Taking
 * capacity back with no note reads, three months later, as a bug in the
 * billing table rather than as a decision.
 *
 * 🔴 IT DOES NOT SUSPEND ANYBODY. Revoking capacity can put a workspace
 * over its limit, and `describeOverage()` already states why nothing
 * auto-suspends: *"picking six of eleven employees to lock out — by join
 * date, by role, by anything — is a decision no algorithm should make on
 * a customer's behalf."*
 */
export async function revokeGrant(
  tx: Tx,
  args: {
    tenantId: string;
    grantId: string;
    reason: string;
  },
): Promise<void> {
  if (args.reason.trim().length < 10) {
    throw new SeatApprovalRefusal(
      "Say why the capacity is being withdrawn. The workspace may go over its limit as a result, and somebody will ask.",
    );
  }
  const result = await tx
    .update(seatGrants)
    .set({ revokedAt: new Date(), revokedReason: args.reason.trim() })
    .where(
      and(
        eq(seatGrants.tenantId, args.tenantId),
        eq(seatGrants.id, args.grantId),
        sql`${seatGrants.revokedAt} IS NULL`,
      ),
    )
    .returning({ id: seatGrants.id });

  if (result.length === 0) {
    throw new SeatApprovalRefusal("That grant is already revoked, or is not this workspace's.");
  }
}
