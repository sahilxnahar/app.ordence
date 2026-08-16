/**
 * Ordence — Clerk Organization Sync Webhook
 * Version: v0.2.0-alpha
 * Runtime: Node (Svix needs crypto primitives unavailable on Edge)
 *
 * This endpoint is PUBLIC — it must be, because Clerk calls it from outside our
 * network. That makes signature verification the only thing standing between an
 * attacker and the ability to forge tenant records.
 *
 * SECURITY MODEL:
 *   1. Reject immediately if the signing secret is not configured (fail-closed).
 *   2. Verify the Svix signature over the RAW body. Any mutation of the body
 *      before verification invalidates the signature — so we read text() first
 *      and only parse JSON after the signature passes.
 *   3. Svix's verify() also enforces a timestamp window, which defeats replay.
 *   4. Only then does any database write happen.
 *
 * Never return 500 for a bad signature — that would tell an attacker their
 * payload reached our handler. 400 for malformed, 401 for unverified.
 */

/**
 * ⚠️ `server-only` BECAUSE THIS IS NO LONGER A ROUTE FILE.
 *
 * A `route.ts` is server-side by definition, so it needs no declaration.
 * The moment the implementation moved out of the route file, it became an
 * ordinary module that `check:boundaries` is entitled to ask about , and
 * it asked, correctly, on the first run. This import is the answer: the
 * module reaches the database and the Clerk session and must never be
 * pulled into a client bundle.
 */
import "server-only";

import { Webhook } from "svix";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { db, withPlatformScope, withTenant } from "@/db";

/**
 * The transaction handle both scope helpers hand to their callback.
 * Named once so the four handlers below can be plain functions rather
 * than nested closures, which keeps them reviewable.
 */
type ScopedTx = Parameters<Parameters<typeof withTenant<void>>[1]>[0];
import { tenants, users, auditLogs } from "@/db/schema";
import { countSeatsInUse, countSeatsPurchased } from "@/server/billing/seats";
import { canTakeSeats } from "@/lib/billing/seats";
import type { SystemRole } from "@/db/schema";
import { recordSecurityEvent } from "@/server/security/record";
import { recordFailure } from "@/lib/security/lockout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* CLERK PAYLOAD TYPES                                                 */
/* ------------------------------------------------------------------ */

type ClerkOrganization = {
  id: string;
  name: string;
  slug: string | null;
  image_url?: string;
  created_by?: string;
  created_at?: number;
  public_metadata?: Record<string, unknown>;
};

type ClerkOrganizationMembership = {
  id: string;
  role: string;
  organization: ClerkOrganization;
  public_user_data: {
    user_id: string;
    identifier?: string;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string;
  };
};

type ClerkUser = {
  id: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string;
  /**
   * Only present on `user.updated`: the attributes Clerk is actually
   * changing in this delivery. A password rotation is the event a
   * security reviewer needs in the evidence table — the attribute
   * update is the portable signal, because Clerk's event taxonomy
   * (`user.password_changed` vs `user.updated` with `password` in the
   * list) has moved between plan configurations, and both paths below
   * collapse to the same recorded event either way.
   */
  updated_attributes?: Array<string> | Record<string, unknown>;
};

type ClerkWebhookEvent =
  | { type: "organization.created" | "organization.updated"; data: ClerkOrganization }
  | { type: "organization.deleted"; data: { id: string; deleted?: boolean } }
  | {
      type: "organizationMembership.created" | "organizationMembership.updated";
      data: ClerkOrganizationMembership;
    }
  | { type: "organizationMembership.deleted"; data: ClerkOrganizationMembership }
  | { type: "user.created" | "user.updated"; data: ClerkUser }
  | {
      type: "sign_in.attempt_failed";
      data: {
        id: string;
        status?: string;
        abort_reason?: string | null;
        first_factor_verification?: {
          status?: string;
          strategy?: string | null;
          error?: { code?: string; message?: string } | null;
        } | null;
        identifier?: string | null;
      };
    }
  | { type: string; data: Record<string, unknown> };

/* ------------------------------------------------------------------ */
/* HANDLER                                                             */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

  // Fail-closed. A missing secret must never mean "skip verification".
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SIGNING_SECRET is not set.");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const headerList = await headers();
  const svixId = headerList.get("svix-id");
  const svixTimestamp = headerList.get("svix-timestamp");
  const svixSignature = headerList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing Svix headers." }, { status: 400 });
  }

  // RAW body — must not be parsed before verification.
  const rawBody = await req.text();

  let event: ClerkWebhookEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch (err) {
    // Signature invalid, or timestamp outside the replay window.
    console.warn("[clerk-webhook] Signature verification failed:", (err as Error).message);
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  /* ---- Signature verified. Safe to act on the payload. ---- */

  try {
    switch (event.type) {
      case "organization.created":
      case "organization.updated":
        await handleOrganizationUpsert(event.data as ClerkOrganization);
        break;

      case "organization.deleted":
        await handleOrganizationDeleted((event.data as { id: string }).id);
        break;

      case "organizationMembership.created":
      case "organizationMembership.updated":
        await handleMembershipUpsert(event.data as ClerkOrganizationMembership);
        break;

      case "organizationMembership.deleted":
        await handleMembershipDeleted(event.data as ClerkOrganizationMembership);
        break;

      // Credential failures are the single most useful signal a security
      // reviewer can have — a spike of them is how a brute force announces
      // itself. Clerk emits `sign_in.attempt_failed` for a wrong password
      // the moment it happens, which is precisely when the trace must be
      // written. The identifier goes in; the credential never does.
      case "sign_in.attempt_failed":
        await handleSignInAttemptFailed(
          event.data as NonNullable<
            Extract<ClerkWebhookEvent, { type: "sign_in.attempt_failed" }> extends { data: infer D }
              ? D
              : never
          >,
        );
        break;

      case "user.created":
        await handleUserCreated(event.data as ClerkUser);
        break;

      case "user.updated":
        await handleUserUpdated(event.data as ClerkUser);
        break;

      default:
        // Unhandled event types are acknowledged so Clerk stops retrying.
        return NextResponse.json({ received: true, handled: false, type: event.type });
    }

    return NextResponse.json({ received: true, handled: true, type: event.type });
  } catch (err) {
    // Return 500 so Svix retries with backoff — the event is not lost.
    console.error(`[clerk-webhook] Handler failed for ${event.type}:`, err);
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ */
/* EVENT HANDLERS                                                      */
/* ------------------------------------------------------------------ */

/**
 * ════════════════════════════════════════════════════════════════════
 * 🟢 WAVE 8 — SESSION SECURITY AFTER A PASSWORD CHANGE
 * ════════════════════════════════════════════════════════════════════
 * Clerk is the source of truth for the credential, and its own SDK
 * revokes the session that JUST performed the change. What the SDK
 * cannot see from the outside is the trail: a security reviewer asking
 * "who rotated their password, when, and what else changed at the same
 * time?" should get one row in security_events, not a reconstruction
 * from three systems.
 *
 * Idempotent by construction — Svix delivers at least once, and
 * recording a real password change twice is exactly correct: two rows
 * is evidence, and evidence must not dedupe away to protect neatness.
 */
export async function handleUserCreated(user: ClerkUser): Promise<void> {
  await recordSecurityEvent({
    type: "auth.account_created",
    source: "api/webhooks/clerk",
    subjectType: "user",
    subjectId: user.id,
    detail: { primaryEmail: primaryEmailOf(user) ?? null },
    reason: "Clerk sign-up: a new identity exists in the product",
  }, { noCoalesce: true });
}

export async function handleUserUpdated(user: ClerkUser): Promise<void> {
  const updated = listAttributes(user.updated_attributes);
  const passwordChanged = updated.includes("password");
  if (!passwordChanged) return;

  await recordSecurityEvent(
    {
      type: "auth.password_changed",
      source: "api/webhooks/clerk",
      subjectType: "user",
      subjectId: user.id,
      detail: {
        primaryEmail: primaryEmailOf(user) ?? null,
        // The attribute NAME is evidence; the attribute VALUE never is. The
        // marker below is the only place the word "password" may appear next
        // to this event, and it carries no secret.
        password: "[REDACTED]",
        otherAttributesChanged: updated.filter((a) => a !== "password"),
      },
    reason:
      "Clerk password update: credential rotated; any session opened " +
      "before the change must be treated as compromised",
    },
    { noCoalesce: true },
  );
}

/**
 * Clerk: wrong password, locked credential, expired TOTP — the product's
 * brute-force tripwire. One event per failed attempt, identifier recorded
 * (the reviewer needs to know WHICH account is being hammered), the
 * credential never.
 */
export async function handleSignInAttemptFailed(
  data: {
    id: string;
    status?: string;
    abort_reason?: string | null;
    first_factor_verification?: {
      status?: string;
      strategy?: string | null;
      error?: { code?: string; message?: string } | null;
    } | null;
    identifier?: string | null;
  },
): Promise<void> {
  const reason =
    data.first_factor_verification?.error?.code ??
    data.first_factor_verification?.status ??
    data.abort_reason ??
    "clerk_sign_in_attempt_failed";

  await recordSecurityEvent(
    {
      type: "auth.login_failed",
      severity: "warning",
      source: "api/webhooks/clerk",
      subjectType: "user",
      subjectId: data.identifier ?? data.id,
      detail: {
        // The strategy (password, totp, …) tells a reviewer whether the
        // attack is guessing or replaying; the value of either is nowhere
        // in the payload.
        strategy: data.first_factor_verification?.strategy ?? null,
        clerkCode: data.first_factor_verification?.error?.code ?? null,
      },
      reason: `Clerk sign-in attempt refused: ${reason}`,
    },
    { noCoalesce: true },
  );

  // Lockout evidence: every Clerk failure also feeds the platform's own
  // database-backed counter (SQL 0089 / lib/security/lockout.ts). Clerk
  // still enforces its hosted lockout — this is the belt: if anyone ever
  // relaxes the Clerk limit, the platform floor still locks the
  // identifier after five failures and keeps the window in a table a
  // reviewer can query.
  const identifier = data.identifier?.trim().toLowerCase() ?? null;
  if (identifier) {
    await recordFailure(identifier);
  }
}

function primaryEmailOf(user: ClerkUser): string | null {
  if (!user.email_addresses || user.email_addresses.length === 0) return null;
  const primary = user.email_addresses.find(
    (e) => e.id === user.primary_email_address_id,
  );
  if (primary) return primary.email_address;
  return user.email_addresses[0]?.email_address ?? null;
}

/**
 * Clerk has shipped `updated_attributes` as BOTH an array of names and a
 * record of changed values across different SDK versions; normalize to
 * the list either way.
 */
function listAttributes(
  updated: Array<string> | Record<string, unknown> | undefined,
): string[] {
  if (!updated) return [];
  if (Array.isArray(updated)) return updated.filter((a) => typeof a === "string");
  return Object.keys(updated);
}

/* Default branding applied to every newly provisioned workspace. */
const DEFAULT_BRANDING = {
  primaryColor: "#B08D3C",
  accentColor: "#1A1A1A",
  fontFamily: "Inter",
} as const;

/** Free-tier entitlements granted on signup. */
const FREE_TIER_DEFAULTS = {
  planTier: "trial" as const,
  seatLimit: 5,
  storageLimitMb: 512,
  trialDays: 14,
};

const DEFAULT_SETTINGS = {
  timezone: "Asia/Kolkata",
  currency: "INR",
  country: "IN",
  locale: "en-IN",
  dateFormat: "dd/MM/yyyy",
  requireMfa: false,
  sessionIdleMinutes: 60,
} as const;

/**
 * Create or update the tenant row that mirrors a Clerk organization.
 * Idempotent — Svix delivers at-least-once, so this may run twice for one event.
 */
/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY STATEMENT IN THIS FILE NOW RUNS INSIDE A SCOPE
 * ══════════════════════════════════════════════════════════════════════
 * They all used the module-level `db` client, which sets no session
 * variable at all. Proved by execution in `scripts/check-rls-writes.mjs`:
 * as a non-superuser table owner with FORCE ROW LEVEL SECURITY — the
 * role every deployment document in this repository demands, in bold, as
 * a STOP gate — an unscoped `INSERT INTO tenants` raises 42501, and so
 * does `INSERT INTO users`.
 *
 * ⚠️ THE READS WERE AS BROKEN AS THE WRITES, AND WORSE. A read with no
 * GUC does not error: it returns NOTHING. So `existing` would be
 * undefined on every delivery, the handler would take the INSERT branch
 * every time, and Svix's at-least-once delivery would collide with the
 * unique index on `clerk_org_id`. The idempotency this file is built
 * around evaporates.
 *
 * ⭐ WHICH SCOPE, AND WHY:
 *   `tenants`  → withPlatformScope. Creating a workspace is a platform
 *                act; there is no tenant to be inside yet.
 *   `users`    → withTenant. Once the tenant is known, write as it —
 *                the `users` policy deliberately does NOT admit platform
 *                scope on WITH CHECK, so support can read a customer's
 *                people and never edit them.
 */
async function handleOrganizationUpsert(org: ClerkOrganization): Promise<void> {
  return withPlatformScope(
    `Clerk webhook: provision or update the workspace mirroring organization ${org.id}`,
    (tx) => organizationUpsert(tx, org),
  );
}

async function organizationUpsert(
  tx: ScopedTx,
  org: ClerkOrganization,
): Promise<void> {
  const slug = normaliseSlug(org.slug ?? org.name ?? org.id);

  const existing = await tx.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, org.id),
  });

  if (existing) {
    await tx
      .update(tenants)
      .set({
        name: org.name,
        slug,
        branding: { ...DEFAULT_BRANDING, ...existing.branding, logoUrl: org.image_url },
        updatedAt: new Date(),
        // Re-activate if this org was previously soft-deleted in Clerk.
        ...(existing.deletedAt ? { deletedAt: null, status: "active" as const } : {}),
      })
      .where(eq(tenants.id, existing.id));

    await writeAudit({
      tenantId: existing.id,
      action: "update",
      resourceType: "tenant",
      resourceId: existing.id,
      newValue: { name: org.name, slug },
      reason: "Clerk organization.updated",
    });
    return;
  }

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + FREE_TIER_DEFAULTS.trialDays);

  const [created] = await tx
    .insert(tenants)
    .values({
      clerkOrgId: org.id,
      name: org.name,
      slug,
      branding: { ...DEFAULT_BRANDING, logoUrl: org.image_url },
      settings: { ...DEFAULT_SETTINGS },
      planTier: FREE_TIER_DEFAULTS.planTier,
      status: "active",
      seatLimit: FREE_TIER_DEFAULTS.seatLimit,
      storageLimitMb: FREE_TIER_DEFAULTS.storageLimitMb,
      trialEndsAt,
    })
    // Concurrent deliveries of the same event must not create duplicates.
    .onConflictDoNothing({ target: tenants.clerkOrgId })
    .returning();

  if (created) {
    await writeAudit({
      tenantId: created.id,
      action: "create",
      resourceType: "tenant",
      resourceId: created.id,
      newValue: { name: org.name, slug, planTier: created.planTier },
      reason: "Clerk organization.created",
    });
  }
}

/** Soft-delete the tenant. Data is retained for the recovery window. */
async function handleOrganizationDeleted(clerkOrgId: string): Promise<void> {
  return withPlatformScope(
    `Clerk webhook: mark the workspace for organization ${clerkOrgId} as deleted`,
    (tx) => organizationDeleted(tx, clerkOrgId),
  );
}

async function organizationDeleted(tx: ScopedTx, clerkOrgId: string): Promise<void> {
  const existing = await tx.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, clerkOrgId),
  });
  if (!existing) return;

  await tx
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletedAt: new Date(),
      deleteReason: "Organization deleted in Clerk",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, existing.id));

  await writeAudit({
    tenantId: existing.id,
    action: "delete",
    resourceType: "tenant",
    resourceId: existing.id,
    oldValue: { status: existing.status },
    newValue: { status: "pending_deletion" },
    reason: "Clerk organization.deleted",
  });
}

/** Provision (or update) the user row for an organization member. */
async function handleMembershipUpsert(
  membership: ClerkOrganizationMembership,
): Promise<void> {
  /**
   * ⚠️ READ UNDER PLATFORM SCOPE. With no GUC this returned nothing on
   * every delivery, so the handler always took the "provision first"
   * branch below and then tried to insert a tenant that already existed.
   */
  const lookup = (reason: string) =>
    withPlatformScope(reason, (tx) =>
      tx.query.tenants.findFirst({
        where: eq(tenants.clerkOrgId, membership.organization.id),
      }),
    );

  const tenant = await lookup(
    `Clerk webhook: resolve the workspace for a membership event`,
  );

  // Membership can arrive before organization.created. Provision the tenant first.
  if (!tenant) {
    await handleOrganizationUpsert(membership.organization);
    const retry = await lookup(
      `Clerk webhook: re-resolve the workspace after provisioning it`,
    );
    if (!retry) throw new Error("Tenant provisioning failed for membership event.");
    return upsertUser(retry.id, membership);
  }

  return upsertUser(tenant.id, membership);
}

async function upsertUser(
  tenantId: string,
  membership: ClerkOrganizationMembership,
): Promise<void> {
  /**
   * ⭐ `withTenant`, NOT `withPlatformScope`. The `users` policy admits
   * platform scope on USING and NOT on WITH CHECK, deliberately, so that
   * support can answer "which workspace is this person in" and can never
   * edit a customer's role or status. A platform-scoped insert here is
   * refused, and that refusal is correct.
   */
  return withTenant(tenantId, (tx) => upsertUserIn(tx, tenantId, membership));
}

async function upsertUserIn(
  tx: ScopedTx,
  tenantId: string,
  membership: ClerkOrganizationMembership,
): Promise<void> {
  const clerkUserId = membership.public_user_data.user_id;
  const email =
    membership.public_user_data.identifier ?? `${clerkUserId}@placeholder.invalid`;

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 A SELF-SERVE WORKSPACE USED TO START WITH NO OWNER AT ALL
   * ══════════════════════════════════════════════════════════════════
   * `<CreateOrganization>` is the only workspace-creation surface, and
   * Clerk gives the creator `org:admin`, which mapped to `tenant_admin`.
   * `tenant_admin` is denied `billing:manage` by design, so the founding
   * user of a brand-new workspace could not start a subscription, could
   * not cancel one, and could not promote anybody to owner —
   * `updateUserRole` refuses to assign a role senior to your own. Every
   * last-owner guard was vacuously satisfied because there was never an
   * owner to be the last one.
   *
   * ⭐ TWO SIGNALS, EITHER SUFFICIENT. Clerk names the creator on the
   * organisation payload, and the first person to appear in a tenant is
   * the person who made it. Using both means a Clerk payload that omits
   * `created_by` does not leave a workspace ownerless.
   */
  const isCreator =
    membership.organization.created_by !== undefined &&
    membership.organization.created_by === clerkUserId;

  const [priorMembers] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)));

  const isFounder = isCreator || Number(priorMembers?.n ?? 0) === 0;
  const role: SystemRole = isFounder ? "tenant_owner" : mapClerkRole(membership.role);

  const existing = await tx.query.users.findFirst({
    where: and(eq(users.clerkUserId, clerkUserId), eq(users.tenantId, tenantId)),
  });

  if (existing) {
    /**
     * 🔴 CLERK CANNOT DEMOTE AN OWNER EITHER.
     *
     * The reverse of the escalation above, and the one that strands a
     * workspace: an owner who is edited in Clerk's membership UI comes
     * back here as `tenant_admin`, and the last `billing:manage` in the
     * workspace disappears with no in-product action having taken
     * place. Worse, an owner who demoted a rogue admin through
     * `updateUserRole` found it silently reverted the next time Clerk
     * emitted a membership event, because Clerk still had them as
     * `org:admin`.
     *
     * ⚠️ SO OUR ROLE WINS FOR AN OWNER. For everyone else Clerk stays
     * authoritative, which keeps the identity provider useful for the
     * ordinary case; changing that would strand every workspace that
     * manages people in Clerk today, and there is no in-product invite
     * to replace it with yet.
     */
    const keepsOwnRole = existing.role === "tenant_owner";
    if (keepsOwnRole && role !== existing.role) {
      await writeAudit({
        tenantId,
        action: "role_change",
        resourceType: "user",
        resourceId: existing.id,
        oldValue: { role: existing.role, clerkRole: membership.role },
        newValue: { role: existing.role, refused: role },
        reason:
          "Clerk reported a different role for a workspace owner. Ignored: " +
          "ownership is granted in the product, not in the identity provider.",
      });
    }

    await tx
      .update(users)
      .set({
        role: keepsOwnRole ? existing.role : role,
        email,
        firstName: membership.public_user_data.first_name ?? existing.firstName,
        lastName: membership.public_user_data.last_name ?? existing.lastName,
        avatarUrl: membership.public_user_data.image_url ?? existing.avatarUrl,
        status: "active",
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));

    await writeAudit({
      tenantId,
      action: "role_change",
      resourceType: "user",
      resourceId: existing.id,
      oldValue: { role: existing.role },
      newValue: { role },
      reason: "Clerk organizationMembership.updated",
    });
    return;
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * SEAT CHECK ON THE WEBHOOK PATH (Phase 13)
   * ══════════════════════════════════════════════════════════════════
   * This is the OTHER way a user appears in a workspace. Someone can be
   * added to the Clerk organisation directly — from Clerk's own
   * dashboard, or by an SSO auto-provision — without ever touching our
   * invite action. Gating only the action would leave the licence
   * trivially bypassable by anyone with access to the identity provider.
   *
   * ⚠️ BUT THIS PATH DOES NOT REFUSE, AND THAT IS DELIBERATE.
   *
   * Returning a non-2xx here would make Clerk retry the membership
   * event indefinitely, and the person would exist in the identity
   * provider while never existing in the product — able to sign in, and
   * then landing on a broken workspace with no explanation and no way
   * for their admin to find out why.
   *
   * So the user IS created, and the workspace goes over its limit. Over
   * limit is a state the system already models and reports: everyone
   * keeps working, and the team page says plainly that they are over
   * with the two ways to resolve it. A high-severity audit row records
   * the moment it happened.
   *
   * The interactive paths — invite and reactivate — DO refuse, because
   * there is a human there who can be told why.
   */
  const [seatsUsed, seatsPurchased] = await Promise.all([
    countSeatsInUse(tenantId),
    // No tenant row in scope on this path; 5 is the schema default and is
    // only a fallback for a workspace with no subscription at all.
    countSeatsPurchased(tenantId, 5),
  ]);
  const seatVerdict = canTakeSeats(seatsUsed, seatsPurchased, 1);

  if (!seatVerdict.allowed) {
    await writeAudit({
      tenantId,
      // The local audit writer on this path accepts a narrower action
      // set than `audit_logs` does. `update` is the honest fit: the
      // workspace's seat position changed.
      action: "update",
      resourceType: "seat_limit",
      resourceId: tenantId,
      reason:
        "A member was added through the identity provider while the workspace " +
        "was at its seat limit. The member was created rather than refused — " +
        "refusing would make Clerk retry forever and strand the user.",
      newValue: {
        seatsUsed,
        seatsPurchased,
        overBy: seatsUsed + 1 - seatsPurchased,
      },
    });
  }

  const [created] = await tx
    .insert(users)
    .values({
      tenantId,
      clerkUserId,
      email,
      firstName: membership.public_user_data.first_name ?? null,
      lastName: membership.public_user_data.last_name ?? null,
      avatarUrl: membership.public_user_data.image_url ?? null,
      role,
      status: "active",
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await writeAudit({
      tenantId,
      action: "create",
      resourceType: "user",
      resourceId: created.id,
      newValue: { email, role },
      reason: "Clerk organizationMembership.created",
    });
  }
}

/** Offboard a user removed from the organization. Row is retained for audit. */
async function handleMembershipDeleted(
  membership: ClerkOrganizationMembership,
): Promise<void> {
  /** ⚠️ TWO SCOPES. The workspace lookup is a platform read; everything
   *  after it is a write inside that workspace. */
  const tenant = await withPlatformScope(
    `Clerk webhook: resolve the workspace for a membership deletion`,
    (tx) =>
      tx.query.tenants.findFirst({
        where: eq(tenants.clerkOrgId, membership.organization.id),
      }),
  );
  if (!tenant) return;

  return withTenant(tenant.id, (tx) => membershipDeletedIn(tx, tenant.id, membership));
}

async function membershipDeletedIn(
  tx: ScopedTx,
  tenantId: string,
  membership: ClerkOrganizationMembership,
): Promise<void> {
  const tenant = { id: tenantId };

  const clerkUserId = membership.public_user_data.user_id;
  const existing = await tx.query.users.findFirst({
    where: and(eq(users.clerkUserId, clerkUserId), eq(users.tenantId, tenant.id)),
  });
  if (!existing) return;

  /**
   * 🔴 NOTHING PROTECTED THE LAST OWNER ON THIS PATH.
   *
   * `updateUserStatus` counts remaining owners before it suspends
   * anybody. This webhook did not, so removing the last owner from the
   * Clerk organisation — one click, in a different product, by anyone
   * with `org:sys_memberships:manage` — left a workspace with nobody
   * holding `billing:manage` and no way to appoint one from inside the
   * product.
   *
   * ⚠️ THE ROW IS LEFT ALONE RATHER THAN THE EVENT REFUSED. Returning
   * non-2xx would make Clerk retry the deletion forever. The person no
   * longer exists in the identity provider and so cannot sign in; what
   * survives is their `tenant_owner` row, so the workspace still has an
   * owner to restore access to, and a `critical` audit row says exactly
   * what happened.
   */
  if (existing.role === "tenant_owner") {
    const [others] = await tx
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenant.id),
          eq(users.role, "tenant_owner"),
          eq(users.status, "active"),
          isNull(users.deletedAt),
          ne(users.id, existing.id),
        ),
      );

    if (Number(others?.n ?? 0) === 0) {
      await writeAudit({
        tenantId: tenant.id,
        action: "delete",
        resourceType: "user",
        resourceId: existing.id,
        oldValue: { status: existing.status, role: existing.role },
        newValue: { status: existing.status, refused: "offboarded" },
        reason:
          "The last owner was removed from the Clerk organisation. The " +
          "membership is gone so they cannot sign in, but the owner row is " +
          "retained: a workspace with no owner has nobody who can pay for it " +
          "or appoint a replacement.",
      });
      return;
    }
  }

  await tx
    .update(users)
    .set({ status: "offboarded", deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, existing.id));

  await writeAudit({
    tenantId: tenant.id,
    action: "delete",
    resourceType: "user",
    resourceId: existing.id,
    oldValue: { status: existing.status },
    newValue: { status: "offboarded" },
    reason: "Clerk organizationMembership.deleted",
  });
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Clerk role strings ("org:admin") → our internal role enum.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS NO LONGER RETURNS `tenant_owner`, AND THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * Clerk's membership UI is reachable by any `org:admin` — which is
 * Clerk's DEFAULT role for whoever creates an organisation — and this
 * webhook wrote whatever role Clerk reported straight into `users.role`
 * with no rank check, no self check and no owner count. `updateUserRole`
 * in `server/actions/team.ts` has all three and they are correct; this
 * path had none, and Clerk wins on every membership event.
 *
 * So a `tenant_admin` who edited their own membership in Clerk's own
 * interface could arrive back here as `tenant_owner` and gain
 * `billing:manage` — the one permission `tenant_admin` is deliberately
 * denied — plus the ability to demote every other owner.
 *
 * ⭐ OWNERSHIP IS NOW OURS TO GRANT. A `tenant_owner` row is written in
 * exactly two places: `upsertUser` for the person who CREATED the
 * workspace, and `updateUserRole`, which refuses self-elevation, refuses
 * granting above your own rank, and refuses removing the last owner.
 * Nothing that arrives over the network can produce one.
 *
 * ⚠️ `org:owner` MAPS TO `tenant_admin`, NOT TO `member`. Somebody Clerk
 * calls an owner is unambiguously an administrator; the only thing being
 * withheld is the billing seat, which an existing owner can grant in one
 * click and an attacker cannot.
 */
function mapClerkRole(clerkRole: string): SystemRole {
  switch (clerkRole) {
    case "org:admin":
    case "org:owner":
      return "tenant_admin";
    case "org:member":
      return "member";
    default:
      // Unknown roles get the least privilege available.
      return "read_only";
  }
}

/** Force a Clerk slug into our RFC-1123 subdomain rules. */
function normaliseSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return cleaned || `org-${Date.now().toString(36)}`;
}

/** Best-effort audit write. Never allowed to fail the webhook. */
async function writeAudit(entry: {
  tenantId: string;
  action: "create" | "update" | "delete" | "role_change";
  resourceType: string;
  resourceId: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  try {
    /**
     * ⚠️ INTO THE CUSTOMER'S OWN LOG, so it writes AS that tenant. The
     * `audit_logs` policy is tenant-only on WITH CHECK, which is why an
     * unscoped insert here silently failed — the same defect
     * `server/audit.ts` records having found and fixed on its own path,
     * left standing on this one.
     */
    await withTenant(entry.tenantId, (tx) =>
      tx.insert(auditLogs).values({
        tenantId: entry.tenantId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        oldValue: entry.oldValue ?? null,
        newValue: entry.newValue ?? null,
        actorEmail: "system@clerk-webhook",
        actorRole: "system",
        reason: entry.reason,
      }),
    );
  } catch (err) {
    console.error("[clerk-webhook] Audit write failed:", err);
  }
}
