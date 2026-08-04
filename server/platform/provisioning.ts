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
import type { PlatformResult } from "@/lib/platform/schemas";
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
/* SLUG RULES                                                          */
/* ------------------------------------------------------------------ */

/**
 * A slug becomes `<slug>.app.ordence.com`. It is therefore a DNS label and
 * a tenant identifier at the same time, and the DNS side is the stricter
 * of the two: 63 characters, lowercase alphanumeric and hyphens, no leading
 * or trailing hyphen.
 *
 * ⚠️ RESERVED WORDS ARE A SECURITY CONTROL, NOT TIDINESS. A tenant that
 * managed to claim the slug `admin` would own `admin.app.ordence.com` — a
 * hostname that looks like ours, serves their content, and carries a valid
 * certificate we issued. Phishing does not get easier than that.
 */
const RESERVED_SLUGS = new Set([
  "admin", "administrator", "api", "app", "apps", "auth", "billing", "blog",
  "cdn", "console", "dashboard", "dev", "docs", "help", "internal", "login",
  "mail", "ordence", "platform", "portal", "root", "secure", "signin",
  "signup", "smtp", "staff", "staging", "static", "status", "support",
  "system", "test", "www",
]);

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "At least 3 characters.")
  .max(63, "DNS labels stop at 63 characters.")
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Lowercase letters, numbers and hyphens only, and it cannot start or end with a hyphen.",
  )
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: "That name is reserved — it would produce a hostname that impersonates Ordence.",
  });

const provisionSchema = z.object({
  name: z.string().trim().min(2, "Give the workspace a name.").max(120),
  legalName: z.string().trim().max(200).optional(),
  slug: slugSchema,
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
 * Two database reads, both of them existence checks — is the slug taken, is
 * the custom domain taken. Everything else is derived.
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
    const conflicts = await withPlatformScope(
      "Provisioning dry-run: checking slug and custom-domain uniqueness across all tenants.",
      async (tx) => {
        const rows = await tx.execute(sql`
          SELECT
            EXISTS (SELECT 1 FROM tenants WHERE slug = ${data.slug})            AS slug_taken,
            ${data.customDomain ?? null}::text IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM tenants WHERE custom_domain = ${data.customDomain ?? null}
              )                                                                  AS domain_taken
        `);
        return (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
      },
    );

    const blockers: string[] = [];
    const warnings: string[] = [];

    if (conflicts.slug_taken === true) {
      blockers.push(`The slug "${data.slug}" is already in use by another workspace.`);
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
         * ⚠️ ONE STATEMENT, AND IT RELIES ON THE UNIQUE INDEX.
         *
         * `ON CONFLICT (slug) DO NOTHING` is what actually prevents a
         * duplicate, not the existence check in the plan. Two operators
         * clicking at the same instant both pass the check and both reach
         * here; the database decides, and the loser gets zero rows back and
         * a clear message rather than a second workspace on the same
         * hostname.
         */
        /*
         * ⚠️ `clerk_org_id` IS A PLACEHOLDER, AND THE INSERT DID NOT WORK
         * WITHOUT ONE.
         *
         * `tenants.clerk_org_id` is NOT NULL with no default and was simply
         * missing from this statement, so every provision failed on a
         * null-violation that the catch block reported as "Provisioning
         * failed. Nothing was created." — accurate, and useless for working
         * out why.
         *
         * The real organisation is created AFTER the transaction commits
         * (an external call cannot be rolled back with it), so there is no
         * true value available at this moment. The placeholder is
         * deterministic from the slug and carries a "pending:" marker, so
         * an unfinished provision is greppable —
         *   SELECT slug FROM tenants WHERE clerk_org_id LIKE 'pending:%'
         * is the list of workspaces whose Clerk organisation still needs
         * creating. It is also unique, which the column's unique index
         * requires.
         *
         * ⚠️ NO BACKTICKS ANYWHERE INSIDE THE sql`` TEMPLATE BELOW. One
         * backtick in a comment terminates the template literal and the
         * file stops parsing — which is how this note ended up out here.
         */
        const rows = await tx.execute(sql`
          INSERT INTO tenants (
            clerk_org_id,
            slug, name, legal_name, plan_tier, status,
            seat_limit, storage_limit_mb, trial_ends_at,
            custom_domain, settings, branding
          ) VALUES (
            -- See the note above this statement.
            ${`pending:${data.slug}`},
            ${data.slug},
            ${data.name},
            ${data.legalName ?? null},
            ${data.planTier},
            'active',
            ${data.seatLimit},
            ${data.storageLimitMb},
            ${trialEndsAt},
            ${data.customDomain ?? null},
            ${JSON.stringify({ industry: data.industry, provisionedBy: operator.email })}::jsonb,
            /*
             * ⚠️ Branding is left EMPTY on purpose, not defaulted to the
             * industry's colour. Per-tenant theming derives from a single
             * accent token the customer sets; writing a guess here would make
             * every workspace in a vertical look identical on day one and
             * teach the customer that the theming control does nothing.
             * Absent means "not chosen yet", which is true.
             */
            ${JSON.stringify({})}::jsonb
          )
          ON CONFLICT (slug) DO NOTHING
          RETURNING id
        `);

        const row = (rows as unknown as Array<Record<string, unknown>>)[0];
        if (!row?.id) {
          throw new Error("slug_taken_race");
        }
        return String(row.id);
      },
    );

    /*
     * What is deliberately NOT done inside the transaction, and is therefore
     * still outstanding. Returned rather than hidden: a provision that
     * half-happened must be visible, or it becomes an orphan nobody knows
     * to finish.
     */
    const pending: string[] = [
      `Create the Clerk organisation and invite ${data.ownerEmail} as owner, then replace ` +
        `the placeholder clerk_org_id "pending:${data.slug}".`,
      `Send the welcome message to ${data.ownerEmail}.`,
    ];
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
    if (error instanceof Error && error.message === "slug_taken_race") {
      return {
        ok: false,
        error: `The slug "${data.slug}" was claimed a moment ago by someone else. Pick another.`,
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
