/**
 * Ordence — Slug Authority Schema
 * Version: v1.52.0-alpha  (mirrors SQL-FILES/0091_slug_authority.sql)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A SLUG ACTUALLY IS, AND WHY IT GETS ITS OWN FILE
 * ══════════════════════════════════════════════════════════════════════
 * A tenant slug is not a display field. It is a public DNS label, it
 * becomes a hostname under our wildcard certificate, and that certificate
 * is published in the public Certificate Transparency log within minutes
 * of issuance. Every property of a slug is therefore adversarial.
 *
 * Before 0091 the only thing the DATABASE knew about any of this was one
 * unique index on the raw `tenants.slug` column. The rest lived in two
 * TypeScript files that had silently drifted apart:
 *
 *   lib/tenant.ts:30                    decided what RESOLVES  (33 names)
 *   server/platform/provisioning.ts:80  decided what is CREATED (34 names)
 *
 * Eight names in each direction. Provisioning would mint `assets`, `ns1`,
 * `ftp`, `clerk`, `preview`, `vercel`, `logout` — and then resolution
 * refused them, so the workspace provisioned "successfully" and the
 * customer's front door was dead, with nothing anywhere reporting it.
 * The other direction was worse: `ordence.ordence.com` would have
 * RESOLVED, serving a customer's content under our own certificate.
 *
 * ⭐ THE PRINCIPLE THIS SUBSYSTEM ENFORCES, STATED ONCE:
 *
 *       The availability check is advisory.
 *       The unique index is the truth.
 *       The insert is the claim.
 *
 * 🔴 NEVER WRITE CODE THAT TRUSTS AN AVAILABILITY CHECK. "Is acme free?"
 *    → "yes" → insert is a race whose window is the user's typing speed.
 *    Two people signing up in the same second are BOTH told yes. The
 *    greyed-out button on the signup form is a MISTAKE GUARD — it stops a
 *    typo becoming a support ticket. It is not a boundary, and it must
 *    never be the only refusal. The refusal that counts is the `23505`
 *    coming back from one of the unique indexes declared here and in
 *    `core.ts`, plus the `P0091`/`P0092`/`P0093` raised by the
 *    `ordence_guard_tenant_slug()` trigger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT LIVES IN SQL AND NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * Drizzle describes tables. 0091 also installs machinery Drizzle has no
 * vocabulary for, and none of it is optional:
 *
 *   • `tenants.slug_fold` is `GENERATED ALWAYS AS (...) STORED`.
 *   • `ordence_guard_tenant_slug()`, a SECURITY DEFINER trigger with a
 *     pinned `search_path`, refusing reserved and recently-released
 *     names with distinct SQLSTATEs so the application can map them to
 *     messages without parsing English.
 *   • RLS ENABLE/FORCE and the read/write policy split on both tables.
 *   • The grants (`ordence_app` deliberately has NO DELETE on
 *     `tenant_slug_history` — retention the application can delete is
 *     retention that will be deleted the first time it is inconvenient).
 *
 * 🔴 THE SCHEMA IN THIS FILE IS A MIRROR, NOT THE SOURCE. 0091 is the
 *    source. And 🔴 NEVER run `drizzle-kit push` to reconcile them: it
 *    drops RLS policies on 275 tables, silently, and would take the
 *    trigger and the generated column with it.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants } from "./core";

/* ------------------------------------------------------------------ */
/* RESERVED SLUGS  (0091 §2)                                           */
/* ------------------------------------------------------------------ */

/**
 * Slugs no tenant may hold.
 *
 * ⭐ WHY THIS IS A TABLE AND NOT A CHECK CONSTRAINT WITH A LITERAL ARRAY.
 * The list grows, and growing it must be an INSERT an operator can run at
 * 2am when somebody reports a lookalike — not a migration plus a deploy
 * plus a build. A control that can only be tightened on a release cycle
 * is a control that will be left loose.
 *
 * 🔴 THIS IS A SECURITY CONTROL, NOT TIDINESS. Four categories, in
 * descending severity:
 *
 *   `certificate` — `postmaster`, `hostmaster`, `webmaster`, `abuse` are
 *     addresses a CERTIFICATE AUTHORITY accepts as proof of domain
 *     control. A tenant holding one of those subdomains, with mail on it,
 *     can have a certificate issued for a name under our domain. That is
 *     not a phishing risk, it is a delegation of our identity.
 *   `mail` — `mx`, `smtp`, `imap`, `pop`, `autodiscover`, `dmarc`, `spf`,
 *     `webmail`, `email`, `_domainkey`: a tenant owning one can influence
 *     how mail for the zone is discovered and handled.
 *   `impersonate` — `ordence`, `admin`, `console`, `support`, `security`:
 *     a real padlock on a name that claims to be us.
 *   `money`, `identity`, `infra`, `marketing` — the rest.
 *
 * ⚠️ THE CONTENTS ARE MIRRORED IN `lib/slug.ts` AND A TEST ASSERTS THE
 * TWO ARE EQUAL. That test is the whole reason the mirror is safe; the
 * two-list drift described in this file's header is exactly what happens
 * without it.
 *
 * ⚠️ NOT TENANT-SCOPED, ON PURPOSE. It has no `tenantId`, it holds no
 * customer data, and its RLS read policy is `USING (true)` — its contents
 * are shipped to every browser inside `lib/slug.ts` anyway, and hiding it
 * would break the guard trigger while achieving nothing. WRITES require
 * `app_platform_scope()` via a SEPARATE policy, so the two can never
 * widen each other. (See the note in 0091 §2: this is NOT the mistake
 * 0089 fixed on `login_lockouts`.)
 */
export const reservedSlugs = pgTable(
  "reserved_slugs",
  {
    /**
     * ⚠️ THE PRIMARY KEY IS THE SLUG ITSELF. No surrogate id: the natural
     * key is the entire content of the row, and a surrogate would allow
     * the same reserved word to be inserted twice with two reasons.
     * `varchar(63)` matches `tenants.slug` — 63 is the DNS label limit.
     */
    slug: varchar("slug", { length: 63 }).primaryKey(),

    /** One of: certificate, mail, impersonate, money, identity, infra, marketing. */
    category: varchar("category", { length: 32 }).notNull(),

    /**
     * ⭐ NOT NULL, AND THAT IS THE POINT OF THE COLUMN. This string is
     * surfaced to the operator who is about to add or remove a row. A
     * reserved word with no stated reason gets deleted by the next person
     * who does not know why it is there.
     */
    reason: text("reason").notNull(),

    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Who added it. Defaults to the migration that seeded the list so the
     * 71 rows 0091 inserts are distinguishable from anything added later
     * by a human at 2am.
     */
    addedBy: text("added_by").default("migration:0091").notNull(),
  },
  (t) => ({
    /**
     * ⚠️ MIRRORS 0091's CHECK. `tenants.slug` is forced lowercase by its
     * own constraint, and the guard trigger compares this table's `slug`
     * to it byte-for-byte — so an upper-case row here is a reserved word
     * that silently reserves nothing.
     */
    lowercase: check("reserved_slugs_lowercase", sql`${t.slug} = lower(${t.slug})`),
  }),
);

/* ------------------------------------------------------------------ */
/* TENANT SLUG HISTORY  (0091 §4)                                      */
/* ------------------------------------------------------------------ */

/**
 * Every slug a tenant has ever held. A row is written on claim and closed
 * on rename.
 *
 * 🔴 A RELEASED SLUG IS A LIVE HOSTNAME. It sits in every bookmark, every
 * emailed invoice link, every WhatsApp message a site engineer sent,
 * every `From:` header, and permanently in the public CT log. Re-issuing
 * it to a different company hands that company someone else's inbound
 * traffic — and, if mail is ever attached to tenant subdomains, someone
 * else's mail.
 *
 * Retention is 365 days, enforced in `ordence_guard_tenant_slug()`. That
 * is the SHORTEST defensible figure, not a generous one: annual business
 * cycles mean a link sent last March is opened this March.
 *
 * ⚠️ THE APPLICATION HAS NO DELETE GRANT ON THIS TABLE. Rows leave only
 * by `ON DELETE CASCADE` when the tenant itself is removed. Do not add a
 * "cleanup" job; retention that the app can delete is not retention.
 *
 * ⚠️ WRITES REQUIRE PLATFORM SCOPE (`WITH CHECK (app_platform_scope())`,
 * and the table is the ninth entry in `OPT_IN_PLATFORM_WRITE`). A rename
 * is a PLATFORM act performed inside `withPlatformScope(reason, cb)` on
 * behalf of a tenant. The tenant's own session must never write its own
 * slug history, because that record is the evidence of what the platform
 * did. The tenant may READ it.
 */
export const tenantSlugHistory = pgTable(
  "tenant_slug_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * ⚠️ CASCADE, not restrict. When a tenant is genuinely deleted its
     * hostname stops existing, so the retention record has nothing left
     * to protect. This is the one and only way a row leaves this table.
     */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The slug as claimed. Same `varchar(63)` shape as `tenants.slug`. */
    slug: varchar("slug", { length: 63 }).notNull(),

    /**
     * ⭐ THE CONFUSABLE FOLD, STORED RATHER THAN RECOMPUTED, so the
     * retention lookup can be indexed.
     *
     * 🔴 WITHOUT THIS COLUMN THE RETENTION RULE IS DEFEATED BY A HYPHEN:
     * release `acme-corp`, immediately claim `acmecorp`, and to a human
     * reading an old link it is the same hostname. The fold collapses
     * hyphens, `0`→`o`, `1`/`l`→`i`, `rn`→`m`, `vv`→`w`.
     *
     * ⚠️ NOT GENERATED HERE, unlike `tenants.slugFold`. A history row is
     * written by the rename path, which computes the fold with
     * `foldSlug()` from `lib/slug.ts` and with the identical SQL
     * expression in 0091's backfill. If those two ever disagree, the
     * retention check silently narrows — so `foldSlug()` is unit-tested
     * against the SQL expression rather than trusted.
     */
    slugFold: text("slug_fold").notNull(),

    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),

    /** NULL while the tenant still holds the slug. Set on rename. */
    releasedAt: timestamp("released_at", { withTimezone: true }),

    /**
     * ⚠️ NOT OPTIONAL ONCE `releasedAt` IS SET, and that is a CHECK rather
     * than a convention (see `reasonPresent` below). A rename with no
     * stated reason is exactly the record that turns out to be useless in
     * the incident the table exists for.
     */
    releaseReason: text("release_reason"),
  },
  (t) => ({
    tenantIdx: index("tenant_slug_history_tenant_idx").on(t.tenantId),

    /**
     * The two retention lookups. Both are hot paths inside
     * `ordence_guard_tenant_slug()`, which runs on every slug INSERT and
     * every UPDATE that actually changes the slug — including the very
     * first insert of a self-serve signup.
     */
    slugIdx: index("tenant_slug_history_slug_idx").on(t.slug, t.releasedAt),
    foldIdx: index("tenant_slug_history_fold_idx").on(t.slugFold, t.releasedAt),

    /**
     * ⚠️ ON `(tenant_id, slug, claimed_at)`, NOT `(tenant_id, slug)`.
     * A tenant that re-claims its own old slug after the retention window
     * writes a NEW row; keying on the pair alone would refuse that
     * legitimate re-claim and lose the earlier tenure.
     */
    slugUnique: uniqueIndex("tenant_slug_history_unique").on(t.tenantId, t.slug, t.claimedAt),

    /** Mirrors 0091. Same reasoning as `reserved_slugs_lowercase`. */
    lowercase: check("tenant_slug_history_lowercase", sql`${t.slug} = lower(${t.slug})`),

    /** ⚠️ A released slug with no reason is a record that explains nothing. */
    reasonPresent: check(
      "tenant_slug_history_reason_present",
      sql`${t.releasedAt} IS NULL OR ${t.releaseReason} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE-SIDED, ON PURPOSE. The inverse (`tenants.slugHistory`) would
 * have to be declared inside `core.ts`, which would make `core.ts` import
 * this file while this file imports `core.ts`. Every other satellite
 * module in this schema (`budgets`, `telemetry`, `portals`) declares the
 * `one(tenants)` side here and leaves `tenantsRelations` alone, and the
 * relational query API works fine from this direction.
 */
export const tenantSlugHistoryRelations = relations(tenantSlugHistory, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantSlugHistory.tenantId],
    references: [tenants.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type ReservedSlug = typeof reservedSlugs.$inferSelect;
export type NewReservedSlug = typeof reservedSlugs.$inferInsert;
export type TenantSlugHistory = typeof tenantSlugHistory.$inferSelect;
export type NewTenantSlugHistory = typeof tenantSlugHistory.$inferInsert;
