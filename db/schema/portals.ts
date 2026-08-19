/**
 * Ordence — External Client Portal Schema
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS TABLE ACTUALLY IS
 * ══════════════════════════════════════════════════════════════════════
 * Every row here is a BEARER CREDENTIAL. Whoever holds the token can read
 * a contract and, if permitted, legally sign it — with no account, no
 * password and no second factor.
 *
 * That is a deliberately large amount of authority to put in a URL, and it
 * is only defensible because each token is:
 *
 *   - 256 bits of cryptographically secure randomness (not guessable)
 *   - scoped to exactly ONE record (not a session)
 *   - time-bound (expires)
 *   - revocable (`is_active`)
 *   - single-use for signing (consumed on signature)
 *   - stored only as a HASH (see below)
 *
 * Remove any one of those and this becomes the weakest thing in the
 * platform, because it is the only door that opens without Clerk.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE COLUMN IS `token_hash` AND NOT `secure_token`
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design stores the token itself so it can be re-displayed and
 * re-copied later. That design means a single database leak — a stolen
 * backup, a SQL injection anywhere in the application, a rogue admin with
 * read access — hands the attacker WORKING ACCESS to every client portal
 * at once, including the ability to sign contracts as the client.
 *
 * We store SHA-256 of the token instead, for exactly the reason nobody
 * stores plaintext passwords. A leaked hash is useless: the attacker still
 * has to find a 256-bit preimage.
 *
 * WHY PLAIN SHA-256 AND NOT bcrypt/argon2:
 * Slow hashes exist to defeat brute force against LOW-entropy secrets that
 * humans chose. These tokens are 256 bits from a CSPRNG. There is no
 * dictionary, no pattern and no feasible search space — the cost of an
 * exhaustive attack is already astronomically beyond any hardware. A slow
 * KDF would add latency to every portal page load and buy nothing.
 *
 * THE COST OF THIS CHOICE, STATED PLAINLY:
 * A token is displayable exactly ONCE, at generation. It cannot be
 * recovered later, because we genuinely do not have it. Staff who need the
 * link again must regenerate — which invalidates the old one, and that is
 * the correct behaviour anyway. `token_prefix` below keeps links
 * identifiable in the UI without keeping them usable.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/** What a portal link points at. Mirrors `document_entity_type`. */
export const portalEntityTypeEnum = pgEnum("portal_entity_type", [
  "contract",
  "asset",
]);

/**
 * What the external recipient is allowed to DO.
 *
 * Separated from the link's existence on purpose. "Have a look at this"
 * and "sign this, legally, on behalf of your company" are different acts,
 * and defaulting the second one on would be a serious mistake. A link is
 * `view` unless someone deliberately chose otherwise.
 */
export const portalPermissionEnum = pgEnum("portal_permission", [
  "view",
  "view_and_sign",
]);

/* ------------------------------------------------------------------ */
/* PORTAL LINKS                                                        */
/* ------------------------------------------------------------------ */

export const portalLinks = pgTable(
  "portal_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /* --- What it points at --------------------------------------- */
    entityType: portalEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),

    /* --- The credential ------------------------------------------ */

    /**
     * SHA-256 of the token, hex-encoded (64 characters).
     *
     * UNIQUE, which does double duty: it is the lookup index for every
     * portal request, and it makes an accidental collision impossible to
     * insert rather than merely unlikely.
     */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),

    /**
     * The first 8 characters of the token, kept in the clear.
     *
     * NOT a secret and not sufficient to authenticate — 8 hex characters
     * is 32 bits, and it is never compared during authentication. It
     * exists so staff can tell two links apart in the UI ("the one ending
     * a3f2") and so a support conversation about a specific link is
     * possible without anyone pasting a live credential into a chat.
     */
    tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),

    /* --- Lifecycle ----------------------------------------------- */

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * Revocation switch. Checked on EVERY request, never cached.
     *
     * Set false by: manual revocation, or a completed signature (a signing
     * link is single-use, so a captured URL cannot be replayed to sign
     * twice).
     */
    isActive: boolean("is_active").default(true).notNull(),

    permission: portalPermissionEnum("permission").default("view").notNull(),

    /* --- Who it was issued to ------------------------------------ */

    /**
     * Recorded for the audit trail and shown on the portal so the reader
     * can tell the link was meant for them.
     *
     * NOT used for authentication. The token is the credential; requiring
     * the visitor to also type this email would be theatre, since anyone
     * holding the link can read the address off the page it renders.
     */
    recipientEmail: varchar("recipient_email", { length: 320 }),
    recipientName: varchar("recipient_name", { length: 300 }),

    /* --- Forensics ------------------------------------------------ */

    /**
     * Access counters and timestamps.
     *
     * These are what let someone answer "was this link opened before it
     * was signed, and from where?" after the fact. A signature with zero
     * prior views is worth a second look.
     */
    viewCount: integer("view_count").default(0).notNull(),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    lastViewedIp: varchar("last_viewed_ip", { length: 64 }),

    /** Set when the link is consumed by a signature. */
    signedAt: timestamp("signed_at", { withTimezone: true }),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    revokedReason: text("revoked_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * The authentication lookup. UNIQUE and therefore backed by an index —
     * a portal request is a single indexed probe, not a scan.
     */
    tokenHashUnique: uniqueIndex("portal_links_token_hash_unique").on(t.tokenHash),

    /* Tenant first in every other index; it is in every WHERE clause. */
    tenantIdx: index("portal_links_tenant_idx").on(t.tenantId),
    entityIdx: index("portal_links_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    activeIdx: index("portal_links_active_idx").on(t.tenantId, t.isActive, t.expiresAt),
  }),
);

/* ------------------------------------------------------------------ */
/* SIGNATURES                                                          */
/* ------------------------------------------------------------------ */

/**
 * The signature record itself.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE, APPEND-ONLY TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `contracts.signed_at` records THAT a contract was signed. It does not
 * record who typed the name, from which address, at what moment, against
 * which exact content, or under which link. Those are the facts a dispute
 * turns on, and a nullable column on a mutable row is the wrong place for
 * evidence.
 *
 * This table is protected by the same append-only triggers as
 * `audit_logs` and `contract_versions`: UPDATE and DELETE are refused by
 * the database, not merely avoided by the application.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND IS NOT, LEGALLY
 * ══════════════════════════════════════════════════════════════════════
 * This is an ELECTRONIC RECORD of assent: a typed name, bound to a
 * time-limited single-use credential sent to a known address, with the
 * IP, user agent and a hash of the exact content presented.
 *
 * It is NOT a digital signature in the cryptographic sense — there is no
 * PKI certificate and no signer-held private key. Under India's IT Act
 * 2000 that distinction matters, and it is stated here rather than in a
 * marketing sentence so nobody discovers it during a dispute.
 */
export const contractSignatures = pgTable(
  "contract_signatures",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    /** The contract that was signed. */
    contractId: uuid("contract_id").notNull(),

    /**
     * Which link was used.
     *
     * `ON DELETE RESTRICT` — a portal link that produced a signature can
     * never be deleted, because deleting it would orphan the evidence of
     * how the signature was obtained.
     */
    portalLinkId: uuid("portal_link_id")
      .notNull()
      .references(() => portalLinks.id, { onDelete: "restrict" }),

    /* --- Who signed ---------------------------------------------- */

    /** The name the signer typed. Their assertion, recorded verbatim. */
    signerName: varchar("signer_name", { length: 300 }).notNull(),

    /** The address the link was sent to — ours, not theirs to change. */
    signerEmail: varchar("signer_email", { length: 320 }).notNull(),

    /** Optional self-declared capacity, e.g. "Managing Director". */
    signerTitle: varchar("signer_title", { length: 200 }),

    /* --- Evidence ------------------------------------------------- */

    signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),

    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    country: varchar("country", { length: 2 }),

    /**
     * SHA-256 of the contract content as it was rendered to the signer.
     *
     * This is the difference between "they signed something" and "they
     * signed THIS". If the contract is later edited, the stored hash stops
     * matching the current content and the discrepancy is detectable
     * rather than arguable.
     */
    contentHash: varchar("content_hash", { length: 64 }),

    /** The contract version number in force at signature. */
    contractVersion: integer("contract_version"),

    /** The exact wording of the consent statement the signer accepted. */
    consentStatement: text("consent_statement").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("contract_signatures_tenant_idx").on(t.tenantId),
    contractIdx: index("contract_signatures_contract_idx").on(t.tenantId, t.contractId),

    /**
     * One signature per link, enforced by the database.
     *
     * The application also deactivates a link the moment it is used, but
     * that is a sequence of statements and this is a constraint. Two
     * concurrent submissions of the same link — a double-clicked button on
     * a slow connection — race past the application check and are stopped
     * here.
     */
    oneSignaturePerLink: uniqueIndex("contract_signatures_link_unique").on(t.portalLinkId),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const portalLinksRelations = relations(portalLinks, ({ one, many }) => ({
  tenant: one(tenants, { fields: [portalLinks.tenantId], references: [tenants.id] }),
  creator: one(users, { fields: [portalLinks.createdBy], references: [users.id] }),
  signatures: many(contractSignatures),
}));

export const contractSignaturesRelations = relations(contractSignatures, ({ one }) => ({
  tenant: one(tenants, { fields: [contractSignatures.tenantId], references: [tenants.id] }),
  portalLink: one(portalLinks, {
    fields: [contractSignatures.portalLinkId],
    references: [portalLinks.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type PortalLink = typeof portalLinks.$inferSelect;
export type NewPortalLink = typeof portalLinks.$inferInsert;
export type PortalEntityType = (typeof portalEntityTypeEnum.enumValues)[number];
export type PortalPermission = (typeof portalPermissionEnum.enumValues)[number];

export type ContractSignature = typeof contractSignatures.$inferSelect;
export type NewContractSignature = typeof contractSignatures.$inferInsert;
