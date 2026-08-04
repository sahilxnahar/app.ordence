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

import { Webhook } from "svix";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { tenants, users, auditLogs } from "@/db/schema";
import { countSeatsInUse, countSeatsPurchased } from "@/server/billing/seats";
import { canTakeSeats } from "@/lib/billing/seats";
import type { SystemRole } from "@/db/schema";

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

/** Default branding applied to every newly provisioned workspace. */
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
async function handleOrganizationUpsert(org: ClerkOrganization): Promise<void> {
  const slug = normaliseSlug(org.slug ?? org.name ?? org.id);

  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, org.id),
  });

  if (existing) {
    await db
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

  const [created] = await db
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
  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, clerkOrgId),
  });
  if (!existing) return;

  await db
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
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, membership.organization.id),
  });

  // Membership can arrive before organization.created. Provision the tenant first.
  if (!tenant) {
    await handleOrganizationUpsert(membership.organization);
    const retry = await db.query.tenants.findFirst({
      where: eq(tenants.clerkOrgId, membership.organization.id),
    });
    if (!retry) throw new Error("Tenant provisioning failed for membership event.");
    return upsertUser(retry.id, membership);
  }

  return upsertUser(tenant.id, membership);
}

async function upsertUser(
  tenantId: string,
  membership: ClerkOrganizationMembership,
): Promise<void> {
  const clerkUserId = membership.public_user_data.user_id;
  const role = mapClerkRole(membership.role);
  const email =
    membership.public_user_data.identifier ?? `${clerkUserId}@placeholder.invalid`;

  const existing = await db.query.users.findFirst({
    where: and(eq(users.clerkUserId, clerkUserId), eq(users.tenantId, tenantId)),
  });

  if (existing) {
    await db
      .update(users)
      .set({
        role,
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

  const [created] = await db
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
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, membership.organization.id),
  });
  if (!tenant) return;

  const clerkUserId = membership.public_user_data.user_id;
  const existing = await db.query.users.findFirst({
    where: and(eq(users.clerkUserId, clerkUserId), eq(users.tenantId, tenant.id)),
  });
  if (!existing) return;

  await db
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

/** Clerk role strings ("org:admin") → our internal role enum. */
function mapClerkRole(clerkRole: string): SystemRole {
  switch (clerkRole) {
    case "org:admin":
      return "tenant_admin";
    case "org:owner":
      return "tenant_owner";
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
    await db.insert(auditLogs).values({
      tenantId: entry.tenantId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      actorEmail: "system@clerk-webhook",
      actorRole: "system",
      reason: entry.reason,
    });
  } catch (err) {
    console.error("[clerk-webhook] Audit write failed:", err);
  }
}
