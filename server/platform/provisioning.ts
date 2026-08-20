"use server";

/**
 * Ordence — Tenant Provisioning & Domain Automation
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BUSINESS SCALES EXACTLY AS FAST AS THIS FILE
 * ══════════════════════════════════════════════════════════════════════════
 * Every tenant that ever exists is born here. If provisioning takes an hour
 * of somebody's attention, the platform can onboard a few customers a week.
 * If it takes one screen and sixty seconds, it can onboard as many as sales
 * can sign.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY DRY-RUN IS THE DEFAULT AND NOT A CONVENIENCE
 * ══════════════════════════════════════════════════════════════════════════
 * Provisioning is the only operation in the platform that is genuinely hard
 * to undo. It mints a slug that becomes a public hostname, a Clerk
 * organisation that becomes a billing identity, and a seeded dataset a
 * customer will immediately start editing. "Delete it and try again" stops
 * being true the moment somebody logs in.
 *
 * So `plan()` — which writes nothing — is a separate exported function from
 * `provision()`, and the UI runs `plan()` first every time. The operator
 * reads exactly what will happen, in order, and then approves it. Not a
 * checkbox that defaults to off; a distinct step.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════════
 * It does not call Cloudflare, and it does not create the Clerk organisation.
 * Both are external side effects that cannot participate in the database
 * transaction, so doing them inside it would produce the worst possible
 * failure: a live hostname pointing at a tenant row that got rolled back.
 *
 * Instead this file produces the DNS instructions and the Clerk payload as
 * DATA, records the tenant as `pending_domain`, and lets the operator (or a
 * later job) complete them. A half-finished provision is then visible and
 * resumable rather than invisible and orphaned.
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { requireCapability, recordPlatformAudit } from "./guard";
import { claimSlug } from "./claim-slug";
import {
  createOrgForProvisionedTenant,
  resolveOwnerUserId,
} from "@/server/platform/adopt-clerk-org";
import type { PlatformResult } from "@/lib/platform/schemas";
import { checkSlugShape, foldSlug, rejection, type SlugRejection } from "@/lib/slug";
import { operatorSlugSchema } from "@/lib/slug-schema";
import {
  INDUSTRY_TEMPLATES,
  INDUSTRY_KEYS,
  isIndustryKey,
  filterNavigationByRole,
  type IndustryKey,
} from "@/lib/industry-templates";
import { filterNavigationByEntitlement } from "@/lib/modules/nav";
import { CONFIGURABLE_PLAN_TIERS } from "@/lib/platform/configuration";
import {
  FEATURE_CATALOG,
  TIER_RANK,
  TIER_LABELS,
  effectiveTier,
  type FeatureKey,
} from "@/lib/entitlements/features";

/* ------------------------------------------------------------------ */
/* PRIVATE HELPERS                                                     */
/* ------------------------------------------------------------------ */

/*
 * 🔴 NOTHING IN THIS SECTION MAY EVER BE EXPORTED. `"use server"` at the top
 *    of this file publishes EVERY export as a network-reachable endpoint, and
 *    the tier-2 capability guard sits one hop from each of them. A class or a
 *    helper exported from here is either a broken build or an unguarded
 *    surface, depending on Next's mood.
 */

/**
 * Carries a typed slug refusal out of the `withPlatformScope` callback.
 *
 * ⚠️ IT EXISTS TO UNWIND THE TRANSACTION, not merely to signal. A refusal
 * from the guard trigger or a unique index leaves the transaction aborted;
 * returning a value from the callback would COMMIT it, and every subsequent
 * statement on the handle would have failed with 25P02 anyway. Throwing is
 * the mechanism, the message is a side effect.
 */
class SlugClaimRefused extends Error {
  readonly rejection: SlugRejection;

  constructor(rejection: SlugRejection) {
    super(`slug_claim_refused:${rejection.code}`);
    this.name = "SlugClaimRefused";
    this.rejection = rejection;
  }
}

/**
 * ⚠️ `tx.execute()` RETURNS TWO DIFFERENT SHAPES depending on which Neon
 * driver built the client: the HTTP driver hands back a bare array of rows,
 * the WebSocket/pool driver a pg-style `QueryResult` with `.rows`. Indexing
 * `[0]` on the second yields `undefined`, which in the dry run below would
 * read as "nothing is blocked" for EVERY plan — a check that always passes
 * is worse than no check, because the operator believes it.
 */
function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    return (result[0] as Record<string, unknown> | undefined) ?? null;
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) {
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SLUG RULES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RESERVED LIST AND THE SLUG REGEX THAT USED TO LIVE HERE ARE GONE.
 * ══════════════════════════════════════════════════════════════════════
 * This file carried its own 34-name reserved set and its own regex, and
 * `lib/tenant.ts` carried a different 33-name set and a different regex.
 * They disagreed by eight names in each direction and by one character of
 * minimum length. Provisioning would happily mint `assets`, `ns1`, `ftp`,
 * `clerk`, `preview`, `vercel` and `logout`; resolution then refused them
 * and fell back to the root site, so the workspace provisioned
 * "successfully" and the customer's front door was dead, with nothing
 * anywhere reporting it.
 *
 * ⚠️ THE FIX IS NOT "KEEP THEM IN SYNC" — discipline is what produced the
 *    drift. There is now ONE list (`lib/slug.ts`), one schema built from it
 *    (`lib/slug-schema.ts`), and one enforcer (`0091_slug_authority.sql`),
 *    with a test asserting the TypeScript mirror equals the `reserved_slugs`
 *    table. 🔴 Do not reintroduce a local copy of either here.
 *
 * `operatorSlugSchema` is the staff-facing wording of exactly the same
 * rules the public signup form uses — the only difference is the message,
 * and it must stay that way. If the two ever differ in what they ACCEPT, an
 * operator has been handed the power to provision a workspace the resolver
 * will not serve, which is the original incident rebuilt.
 *
 * ⚠️ AND IT IS STILL ONLY A MISTAKE GUARD. Reserved, taken, too-similar and
 *    recently-released are decided by the database at INSERT time, inside
 *    `claimSlug()`. Nothing here may ever be the only refusal.
 */
const provisionSchema = z.object({
  name: z.string().trim().min(2, "Give the workspace a name.").max(120),
  legalName: z.string().trim().max(200).optional(),
  slug: operatorSlugSchema,
  industry: z
    .string()
    .refine(isIndustryKey, "Unknown industry pack.")
    .transform((value) => value as IndustryKey),
  /**
   * ⚠️ FIXED IN v0.53.0, AND IT HAD NEVER WORKED.
   *
   * This field used to read `z.enum(["free","starter","growth","scale"])`.
   * Those are not plan tiers — `plan_tier` is a POSTGRES ENUM whose values
   * are `trial | basic | advanced | ai | enterprise` (db/schema/core.ts).
   * So the INSERT below sent `'free'` into that column and Postgres
   * refused it with `invalid input value for enum plan_tier`, which the
   * catch block turned into "Provisioning failed. Nothing was created."
   *
   * Nothing type-checked it: the value went into a raw `sql` template, and
   * a template literal takes any string. The single source of truth is
   * `CONFIGURABLE_PLAN_TIERS`, which is `satisfies readonly PlanTier[]` —
   * so a future tier rename fails the build rather than the insert.
   */
  planTier: z.enum(CONFIGURABLE_PLAN_TIERS).default("trial"),
  seatLimit: z.number().int().min(1).max(10_000).default(5),
  storageLimitMb: z.number().int().min(100).max(1_000_000).default(1_024),
  trialDays: z.number().int().min(0).max(90).default(14),
  /** Where the welcome message goes. Never stored as a login — Clerk owns that. */
  ownerEmail: z.string().trim().email("A valid email for the welcome message."),
  /** Optional. When present, the DNS instructions are generated for it. */
  customDomain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
      "That does not look like a hostname.",
    )
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Free text, recorded in the audit trail. Required — see below. */
  reason: z
    .string()
    .trim()
    .min(10, "Say who this is for. It goes in the audit trail."),
});

export type ProvisionInput = z.input<typeof provisionSchema>;

/* ------------------------------------------------------------------ */
/* THE PLAN                                                            */
/* ------------------------------------------------------------------ */

export type ProvisionStep = {
  order: number;
  title: string;
  detail: string;
  /** Whether this step writes anything. Reads are cheap to be wrong about. */
  mutating: boolean;
  /** External systems cannot join the transaction. Flagged so it is obvious. */
  external: boolean;
};

export type DnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  note: string;
};

export type ProvisionPlan = {
  slug: string;
  workspaceUrl: string;
  industryLabel: string;
  steps: ProvisionStep[];
  /** Empty unless a custom domain was requested. */
  dns: DnsRecord[];
  /** Anything that would make `provision()` refuse. Non-empty means stop. */
  blockers: string[];
  /** Worth reading, but not fatal. */
  warnings: string[];

  /**
   * ⭐ WHAT THE CUSTOMER WILL SEE ON DAY ONE — v0.53.0.
   *
   * The industry pack and the plan tier were both already inputs here and
   * neither was ever shown as an OUTCOME. That gap is where onboarding
   * mistakes live: an operator picks Healthcare and Basic, the customer
   * signs in, and the six screens the sales call promised are not there —
   * not because provisioning failed, but because Basic does not include
   * them. Nobody discovers that until the customer says so.
   *
   * `dayOneMenu` is what the template and the plan agree on.
   * `hiddenByPlan` is the difference, listed by name, so the promise
   * gets corrected before the workspace exists rather than after.
   */
  planTierLabel: string;
  dayOneMenu: string[];
  hiddenByPlan: string[];
};

const ROOT_DOMAIN =
  (process.env as Record<string, string | undefined>)["NEXT_PUBLIC_ROOT_DOMAIN"] ??
  "app.ordence.com";

/**
 * Work out exactly what provisioning would do. **Writes nothing.**
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS ADVISORY, AND IT ASKS THE DATABASE'S OWN QUESTIONS IN THE
 *    DATABASE'S OWN ORDER.
 * ══════════════════════════════════════════════════════════════════════
 * Nothing here decides anything. `claimSlug()` decides, at INSERT time,
 * because between reading this plan and approving it an operator can take a
 * phone call and somebody else can take the name.
 *
 * ⚠️ BUT A DRY RUN THAT USES DIFFERENT LOGIC FROM THE INSERT IS A DRY RUN
 *    THAT LIES, and the lie is worse than no dry run at all: the operator
 *    reads "no blockers", clicks provision, and gets a refusal that the
 *    screen just told them could not happen. So the five checks below are
 *    the five the database applies, in the order it applies them:
 *
 *      1. shape          `tenants_slug_shape` / `tenants_slug_lowercase`
 *      2. reserved       `ordence_guard_tenant_slug()` → P0091
 *      3. retention      the same trigger        → P0092 (exact), P0093 (fold)
 *      4. exact unique   `tenants_slug_unique`   → 23505
 *      5. fold unique    `tenants_slug_fold_unique` → 23505
 *
 *    The order matters for the MESSAGE, not for the outcome: a reserved name
 *    that is also taken should be reported as reserved, because that is what
 *    the operator would be told if they pressed on.
 */
export async function planProvision(input: unknown): Promise<PlatformResult<ProvisionPlan>> {
  const operator = await requireCapability("tenants:provision");

  const parsed = provisionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Some details need fixing before this can be planned.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const data = parsed.data;

  try {
    const slugFold = foldSlug(data.slug);

    const conflicts = await withPlatformScope(
      "Provisioning dry-run: asking the reserved-slug list, the 365-day slug retention log " +
        "(exact and confusable-folded) and the two tenant slug unique indexes whether a " +
        "candidate workspace address is claimable, plus custom-domain uniqueness, across all tenants.",
      async (tx) => {
        /*
         * ⚠️ THE RETENTION LOOKUPS DELIBERATELY DO NOT EXCLUDE ANY TENANT.
         * The trigger excludes the row's own tenant (`tenant_id IS DISTINCT
         * FROM NEW.id`) so that a workspace may re-claim a slug it released
         * itself. A provision has no tenant yet, so there is nothing to
         * exclude and the unfiltered query is the identical question.
         *
         * ⚠️ `reserved_slugs`, `tenant_slug_history` and `tenants.slug_fold`
         * all arrive with 0091. On a database where 0091 has not been
         * applied this query fails LOUDLY rather than quietly reporting
         * "no blockers" — which is the correct failure for a check whose
         * whole job is to agree with the enforcer.
         */
        const result = await tx.execute(sql`
          SELECT
            EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = ${data.slug})     AS reserved,
            EXISTS (
              SELECT 1 FROM tenant_slug_history
               WHERE slug = ${data.slug}
                 AND released_at IS NOT NULL
                 AND released_at > now() - interval '365 days'
            )                                                                   AS released_exact,
            EXISTS (
              SELECT 1 FROM tenant_slug_history
               WHERE slug_fold = ${slugFold}
                 AND released_at IS NOT NULL
                 AND released_at > now() - interval '365 days'
            )                                                                   AS released_fold,
            EXISTS (SELECT 1 FROM tenants WHERE slug = ${data.slug})            AS slug_taken,
            EXISTS (SELECT 1 FROM tenants WHERE slug_fold = ${slugFold})        AS fold_taken,
            (
              ${data.customDomain ?? null}::text IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM tenants WHERE custom_domain = ${data.customDomain ?? null}
              )
            )                                                                   AS domain_taken
        `);
        return firstRow(result) ?? {};
      },
    );

    const blockers: string[] = [];
    const warnings: string[] = [];

    /*
     * ⚠️ 1 — SHAPE. `operatorSlugSchema` has already refused anything
     * malformed, so this is normally unreachable. It is here because "the
     * schema already checked it" is precisely the assumption that let the
     * two reserved lists drift: if `checkSlugShape()` and the schema ever
     * disagree, the operator sees it here rather than discovering it as a
     * CHECK violation from an INSERT.
     */
    const shape = checkSlugShape(data.slug);
    if (shape && shape.code !== "reserved") {
      blockers.push(`The slug "${data.slug}" is not a legal workspace address. ${shape.operatorMessage}`);
    }

    /* 2 — RESERVED. The database's list is the authority; the in-process
     * mirror in lib/slug.ts is checked too, and a disagreement between the
     * two is itself worth showing, because the test that keeps them equal
     * has evidently stopped being true. */
    if (conflicts.reserved === true || shape?.code === "reserved") {
      blockers.push(
        `The slug "${data.slug}" is reserved. ${rejection("reserved").operatorMessage}`,
      );
      if (conflicts.reserved !== (shape?.code === "reserved")) {
        warnings.push(
          "The reserved_slugs table and the RESERVED_SLUGS mirror in lib/slug.ts disagree " +
            `about "${data.slug}". One of them has drifted; tests/slug-contract.test.ts should be failing.`,
        );
      }
    }

    /* 3 — RETENTION, exact then folded, matching P0092 then P0093. */
    if (conflicts.released_exact === true) {
      blockers.push(
        `The slug "${data.slug}" was released by another workspace within the last 365 days. ` +
          rejection("recently_released").operatorMessage,
      );
    }
    if (conflicts.released_fold === true) {
      blockers.push(
        `The slug "${data.slug}" folds to "${slugFold}", which another workspace released ` +
          `within the last 365 days. ${rejection("recently_released").operatorMessage}`,
      );
    }

    /* 4 — EXACT UNIQUE. */
    if (conflicts.slug_taken === true) {
      blockers.push(
        `The slug "${data.slug}" is already in use by another workspace. ` +
          rejection("taken").operatorMessage,
      );
    }

    /* 5 — FOLD UNIQUE. ⚠️ Reported even when the exact slug is free: this is
     * the check that refuses `acme-corp` when `acmecorp` exists, and an
     * operator who does not know it exists will read a bare refusal as a
     * bug. */
    if (conflicts.fold_taken === true && conflicts.slug_taken !== true) {
      blockers.push(
        `The slug "${data.slug}" folds to "${slugFold}", which an existing workspace already ` +
          `occupies. ${rejection("too_similar").operatorMessage}`,
      );
    }

    if (conflicts.domain_taken === true) {
      blockers.push(`${data.customDomain} is already attached to another workspace.`);
    }
    // ⚠️ `trial`, not the "free" tier this used to name — there is no free
    // tier in `plan_tier` and there never was. A trial is treated as
    // ADVANCED for feature access (see TRIAL_EFFECTIVE_TIER), so a large
    // seat count on one is a real workspace running on nobody's card.
    if (data.planTier === "trial" && data.seatLimit > 5) {
      warnings.push(
        `${data.seatLimit} seats on a trial. Allowed, but nothing will enforce payment ` +
          `and a trial reads as Advanced for feature access.`,
      );
    }
    if (data.trialDays === 0) {
      warnings.push("No trial. The workspace is billable from the moment it exists.");
    }

    const template = INDUSTRY_TEMPLATES[data.industry];
    const workspaceUrl = `https://${data.slug}.${ROOT_DOMAIN}`;

    /*
     * ⭐ THE INDUSTRY PACK AND THE PLAN, RESOLVED TOGETHER.
     *
     * ⚠️ `subscriptionGrantsAccess: true` — a workspace being provisioned
     * has no subscription row yet, which is exactly the case
     * `getEntitlementContext()` treats as granting. Passing `false` here
     * would show the operator the LAPSED tier and understate what the
     * customer gets on their first login.
     *
     * The role filter is `tenant_owner`: the widest view anybody in the
     * new workspace will have. Previewing a narrower role would hide
     * items from the operator that the customer's owner then finds.
     */
    const dayOneTier = effectiveTier({
      planTier: data.planTier,
      subscriptionGrantsAccess: true,
    });
    const allowed: Record<string, boolean> = {};
    for (const key of Object.keys(FEATURE_CATALOG) as FeatureKey[]) {
      allowed[key] = TIER_RANK[dayOneTier] >= TIER_RANK[FEATURE_CATALOG[key].minTier];
    }
    const roleFiltered = filterNavigationByRole(template.navigation, "tenant_owner");
    const entitled = filterNavigationByEntitlement(roleFiltered, allowed);

    const dayOneMenu = entitled.flatMap((s) => s.items.map((i) => i.label));
    const visibleIds = new Set(entitled.flatMap((s) => s.items.map((i) => i.id)));
    const hiddenByPlan = roleFiltered
      .flatMap((s) => s.items)
      .filter((i) => !visibleIds.has(i.id))
      .map((i) => i.label);

    if (hiddenByPlan.length > 0) {
      warnings.push(
        `${hiddenByPlan.length} screen${hiddenByPlan.length === 1 ? "" : "s"} in the ` +
          `${template.label} pack ${hiddenByPlan.length === 1 ? "is" : "are"} not in the ` +
          `${TIER_LABELS[data.planTier]} plan and will not appear: ${hiddenByPlan.join(", ")}.`,
      );
    }

    const steps: ProvisionStep[] = [
      {
        order: 1,
        title: "Create the workspace row",
        detail: `${data.name} · slug ${data.slug} · ${data.planTier} · ${data.seatLimit} seats · ${data.storageLimitMb} MB`,
        mutating: true,
        external: false,
      },
      {
        order: 2,
        title: "Apply the industry pack",
        detail: `${template.label} — navigation, terminology and dashboard widgets. No customer data is invented.`,
        mutating: true,
        external: false,
      },
      {
        order: 3,
        title: "Seed roles and permissions",
        detail: "Owner, admin, member. Row-level security applies from the first insert, not from a later migration.",
        mutating: true,
        external: false,
      },
      {
        order: 4,
        title: "Workspace address goes live",
        detail: `${workspaceUrl} — the wildcard record already resolves, so there is nothing to wait for.`,
        mutating: false,
        external: false,
      },
      {
        order: 5,
        title: "Create the Clerk organisation",
        detail: `Invites ${data.ownerEmail} as owner. Runs AFTER the transaction commits — an external call cannot be rolled back with it.`,
        mutating: true,
        external: true,
      },
    ];

    const dns: DnsRecord[] = [];
    if (data.customDomain) {
      steps.push({
        order: 6,
        title: "Custom domain — awaiting DNS",
        detail: `${data.customDomain} is recorded but NOT verified. It goes live when the records below resolve.`,
        mutating: true,
        external: true,
      });
      dns.push(
        {
          type: "CNAME",
          name: data.customDomain,
          value: `${data.slug}.${ROOT_DOMAIN}`,
          note: "Points the customer's hostname at their workspace.",
        },
        {
          type: "TXT",
          name: `_ordence-verify.${data.customDomain}`,
          // Deterministic from the slug: re-running the plan gives the same
          // token, so an operator can hand it over twice without confusion.
          value: `ordence-verify=${data.slug}`,
          note: "Proves the customer controls the domain before a certificate is issued for it.",
        },
      );
      warnings.push(
        "Custom domains need Cloudflare for SaaS enabled on the account. Until it is, the workspace address is the live one.",
      );
    }

    steps.push({
      order: dns.length > 0 ? 7 : 6,
      title: "Send the welcome message",
      detail: `To ${data.ownerEmail}, with the sign-in link. Queued, not sent inline — a mail outage must not fail a provision.`,
      mutating: true,
      external: true,
    });

    await recordPlatformAudit({
      operator,
      tenantId: null,
      action: "read",
      resourceType: "tenant_provisioning_plan",
      reason: data.reason,
      severity: "info",
      metadata: { slug: data.slug, industry: data.industry, blockers: blockers.length },
    });

    return {
      ok: true,
      data: {
        slug: data.slug,
        workspaceUrl,
        industryLabel: template.label,
        steps,
        dns,
        blockers,
        warnings,
        planTierLabel: TIER_LABELS[data.planTier],
        dayOneMenu,
        hiddenByPlan,
      },
    };
  } catch (error) {
    console.error("[provisioning] plan failed:", error);
    return { ok: false, error: "Could not build the provisioning plan. The failure was logged." };
  }
}

/* ------------------------------------------------------------------ */
/* THE ACT                                                             */
/* ------------------------------------------------------------------ */

export type ProvisionOutcome = {
  tenantId: string;
  slug: string;
  workspaceUrl: string;
  /** Steps that still need a human or a job. Never silently skipped. */
  pending: string[];
};

/**
 * Actually create the workspace.
 *
 * ⚠️ RE-PLANS FIRST, EVERY TIME. The operator may have read a plan five
 * minutes ago and in that time somebody else could have taken the slug. The
 * plan is advice; this check is the gate. Re-running it costs two existence
 * queries and removes a whole class of race.
 */
export async function provisionTenant(
  input: unknown,
): Promise<PlatformResult<ProvisionOutcome>> {
  const operator = await requireCapability("tenants:provision");

  const parsed = provisionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Some details need fixing.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const data = parsed.data;

  const plan = await planProvision(input);
  if (!plan.ok) return plan;
  if (plan.data.blockers.length > 0) {
    return { ok: false, error: plan.data.blockers.join(" ") };
  }

  try {
    const template = INDUSTRY_TEMPLATES[data.industry];
    const trialEndsAt =
      data.trialDays > 0
        ? new Date(Date.now() + data.trialDays * 86_400_000).toISOString()
        : null;

    const tenantId = await withPlatformScope(
      `Provisioning workspace "${data.slug}". ${data.reason}`,
      async (tx) => {
        /*
         * ⭐ THE CLAIM. The mechanism that used to be written out inline
         * here — INSERT ... ON CONFLICT (slug) DO NOTHING RETURNING id,
         * then check how many rows came back — now lives in
         * `server/platform/claim-slug.ts`, unchanged in substance, because
         * self-serve signup is a second caller and a second copy of a race
         * guard is how one of the two copies stops being fixed.
         *
         * `claimSlug` also writes the `tenant_slug_history` row in this same
         * transaction, so a tenant can never exist without the record of
         * when its hostname went live — which is what makes the 365-day
         * retention rule enforceable later.
         *
         * ⚠️ `clerk_org_id` IS A PLACEHOLDER AND THE INSERT DOES NOT WORK
         * WITHOUT ONE. `tenants.clerk_org_id` is NOT NULL with no default.
         * The real organisation is created AFTER this transaction commits
         * (an external call cannot be rolled back with it), so there is no
         * true value available at this moment. The placeholder is
         * deterministic from the slug and carries a "pending:" marker, so an
         * unfinished provision is greppable —
         *   SELECT slug FROM tenants WHERE clerk_org_id LIKE 'pending:%'
         * is the list of workspaces whose Clerk organisation still needs
         * creating. It is also unique, which that column's index requires.
         */
        const claim = await claimSlug(tx, {
          slug: data.slug,
          actor: operator.email,
          tenant: {
            clerkOrgId: `pending:${data.slug}`,
            name: data.name,
            legalName: data.legalName ?? null,
            planTier: data.planTier,
            seatLimit: data.seatLimit,
            storageLimitMb: data.storageLimitMb,
            trialEndsAt,
            customDomain: data.customDomain ?? null,
            settings: { industry: data.industry, provisionedBy: operator.email },
            /*
             * ⚠️ Branding is left EMPTY on purpose, not defaulted to the
             * industry's colour. Per-tenant theming derives from a single
             * accent token the customer sets; writing a guess here would
             * make every workspace in a vertical look identical on day one
             * and teach the customer that the theming control does nothing.
             * Absent means "not chosen yet", which is true.
             */
            branding: {},
          },
        });

        /*
         * 🔴 THROWN, NOT RETURNED, AND THAT IS THE POINT. A refusal from
         * the guard trigger or a unique index has already put this
         * transaction into the aborted state — every further statement on
         * this handle would fail with 25P02. Throwing unwinds it cleanly
         * and guarantees that nothing which depended on the claim survives
         * a claim that never happened.
         */
        if (!claim.ok) throw new SlugClaimRefused(claim.rejection);
        return claim.tenantId;
      },
    );

    /*
     * What is deliberately NOT done inside the transaction, and is therefore
     * still outstanding. Returned rather than hidden: a provision that
     * half-happened must be visible, or it becomes an orphan nobody knows
     * to finish.
     */
    /*
     * ══════════════════════════════════════════════════════════════════
     * ⭐⭐⭐ WAVE 1 , THE CLERK ORGANISATION IS CREATED HERE, NOT DESCRIBED
     * ══════════════════════════════════════════════════════════════════
     * 🔴 THIS USED TO BE A SENTENCE IN `pending`:
     *
     *      "Create the Clerk organisation and invite {email} as owner,
     *       then replace the placeholder clerk_org_id."
     *
     * ⚠️ NOTHING IN CODE DID IT, AND DOING IT BY HAND MADE THINGS WORSE
     *    RATHER THAN FINISHING THE JOB. The operator creates the
     *    organisation in Clerk's dashboard; `organization.created` fires;
     *    `organizationUpsert()` looks the workspace up by
     *    `clerk_org_id = org.id`, finds NOTHING because the row still says
     *    `pending:<slug>`, and provisions a SECOND workspace , on a
     *    fallback hostname, because the good one is held by the first.
     *
     *    One unreachable workspace on the right address, one real
     *    workspace on an address nobody chose. Verified: nothing anywhere
     *    read the `pending:` marker.
     *
     * ⭐ `server/actions/claim.ts` has created organisations this way for
     *    self-serve signup since v1.7x. This makes the console the SAME
     *    shape rather than a second one.
     *
     * ⚠️ AND IT RUNS AFTER THE TRANSACTION COMMITS, WHICH IS NOT A
     *    COMPROMISE , it is forced. Clerk is an HTTP call and Postgres
     *    cannot roll it back. The slug claim must stay atomic (that is the
     *    whole argument of `claim-slug.ts`), so the window between the two
     *    is real. What changed is that the window is now RECOVERABLE:
     *    every failure below leaves the workspace intact on its hostname
     *    and lands it in `listPendingProvisions()`.
     */
    const pending: string[] = [];

    const ownerUserId = await resolveOwnerUserId(data.ownerEmail);

    if (!ownerUserId) {
      /*
       * ⚠️ NOT AN ERROR, AND THE WORKSPACE IS NOT ROLLED BACK. It exists,
       * holds its hostname and has its chart of accounts. What it lacks is
       * an owner, because Clerk cannot create an organisation without an
       * existing user and inventing one would mean making an Ordence
       * employee the owner of a customer's books.
       */
      pending.push(
        `${data.ownerEmail} has no Ordence account yet, so the Clerk organisation could not ` +
          `be created with them as owner. Invite them to sign up, then finish this workspace ` +
          `from the pending list. The workspace exists and holds "${data.slug}".`,
      );
    } else {
      const adopted = await createOrgForProvisionedTenant({
        tenantId,
        slug: data.slug,
        name: data.name,
        ownerUserId,
      });
      if (!adopted.ok) {
        pending.push(adopted.reason);
      }
    }

    pending.push(`Send the welcome message to ${data.ownerEmail}.`);
    if (data.customDomain) {
      pending.push(
        `Custom domain ${data.customDomain} is recorded but unverified — hand the customer the two DNS records.`,
      );
    }

    await recordPlatformAudit({
      operator,
      // Attributed to the tenant this time, not NULL. The customer should be
      // able to see, in their own audit log, that their workspace was created
      // by us and when.
      tenantId,
      action: "update",
      resourceType: "tenant",
      resourceId: tenantId,
      newValue: {
        slug: data.slug,
        name: data.name,
        planTier: data.planTier,
        industry: data.industry,
      },
      reason: data.reason,
      severity: "notice",
      metadata: { provisionedBy: operator.email, pending: pending.length },
    });

    return {
      ok: true,
      data: {
        tenantId,
        slug: data.slug,
        workspaceUrl: plan.data.workspaceUrl,
        pending,
      },
    };
  } catch (error) {
    /*
     * ⭐ THE RACE MESSAGE, NOW SOURCED FROM THE REJECTION RATHER THAN FROM
     * A SENTINEL STRING. Behaviour is unchanged for the case that used to
     * be called `slug_taken_race`: the operator is told somebody else got
     * there first and to pick another. What is new is that the three other
     * refusals the database can produce — reserved, too similar, recently
     * released — no longer collapse into "Provisioning failed. Nothing was
     * created.", which was accurate and useless.
     *
     * `operatorMessage` and not `publicMessage`: the reader is staff, so it
     * may name the constraint and the conflict. The public split exists
     * because a signup form that says "too similar to acmecorp" is a lookup
     * tool for which near-miss names are taken.
     */
    if (error instanceof SlugClaimRefused) {
      const raced = error.rejection.code === "taken" || error.rejection.code === "too_similar";
      return {
        ok: false,
        error: raced
          ? `The slug "${data.slug}" was claimed a moment ago by someone else. Pick another. ` +
            `(${error.rejection.operatorMessage})`
          : `The slug "${data.slug}" cannot be claimed. ${error.rejection.operatorMessage} Pick another.`,
      };
    }
    console.error("[provisioning] failed:", error);
    return { ok: false, error: "Provisioning failed. Nothing was created. The failure was logged." };
  }
}

/** For the industry dropdown. */
export async function listIndustryPacks(): Promise<
  Array<{ key: IndustryKey; label: string; description: string }>
> {
  return INDUSTRY_KEYS.map((key) => ({
    key,
    label: INDUSTRY_TEMPLATES[key].label,
    description: INDUSTRY_TEMPLATES[key].description ?? "",
  }));
}
