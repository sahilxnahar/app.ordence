/**
 * Ordence — ⭐ ENGINE 6 · SENSITIVE-DATA VAULT
 * Version: v0.66.0-alpha  ·  Session 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ENGINE THAT EXISTS SO THE OTHER FIVE CAN BE CARELESS
 * ══════════════════════════════════════════════════════════════════════
 * A hospital holds patient identifiers. A finance customer holds PAN and
 * bank details for KYC. A CA firm holds its clients' credentials. An HR
 * module holds salary. Ordence will hold all of it.
 *
 * ⚠️ IT IS NOT ENOUGH FOR THIS DATA TO BE PROTECTED BY RLS.
 *
 * RLS answers "which tenant may read this row". It does not answer
 * "should a plaintext PAN exist in a database backup at all", and those
 * are different questions with different consequences. A leaked backup,
 * a mis-scoped read replica, a support engineer with a psql prompt, an
 * LLM prompt built by concatenating a table — none of these are stopped
 * by a row-level policy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE DATABASE NEVER HOLDS THE PLAINTEXT, AND NEVER HOLDS THE KEY
 * ══════════════════════════════════════════════════════════════════════
 * Values arrive already encrypted. The column is `ciphertext`, the key
 * lives in Cloudflare, and this table stores only the NAME of the key
 * that was used.
 *
 * ⚠️ THE TEMPTATION IS pgcrypto, AND IT IS A TRAP. `pgp_sym_encrypt(x,
 * 'key')` puts the key in the SQL statement — which lands in
 * pg_stat_statements, in the slow-query log, and in every backup of
 * those. The data would be encrypted at rest and the key would be
 * sitting beside it in the logs. Encryption whose key travels with the
 * ciphertext is theatre.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND YOU STILL HAVE TO BE ABLE TO SEARCH IT
 * ══════════════════════════════════════════════════════════════════════
 * "Find the customer with PAN ABCDE1234F" is a real requirement and
 * encrypted columns cannot answer it. The standard answer is a hash
 * column — and a plain SHA-256 of a PAN is BROKEN, because the entire
 * PAN space is about 10^9 values and a laptop enumerates that in minutes.
 * The hash IS the PAN, to anyone who gets the column.
 *
 * So the searchable column is an HMAC under a server-side pepper that is
 * never in the database. Same lookup, and an attacker with the whole
 * table cannot enumerate anything without also stealing a secret that
 * lives somewhere else entirely.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND A READ IS A WRITE
 * ══════════════════════════════════════════════════════════════════════
 * Every decryption appends an access-log row naming who, what and WHY.
 * Under the DPDPA 2023 a data fiduciary must be able to account for
 * processing; "our staff can see it and we do not track when they do" is
 * not an answer. It is also the only control that ever catches the
 * insider — no policy stops a person entitled to read one record from
 * reading four thousand, but a log makes it visible the next morning.
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
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * What KIND of sensitive thing this is.
 *
 * ⚠️ NOT COSMETIC. The kind decides the retention clock, the masking
 * rule, and whether the value may be stored at all — `aadhaar` is
 * governed differently from `pan`, which is governed differently from a
 * bank account. One generic "secret" type would make every one of those
 * rules a matter of application discipline, which is another way of
 * saying it would make them optional.
 */
export const vaultKindEnum = pgEnum("vault_kind", [
  "pan",
  "aadhaar",
  "passport",
  "driving_licence",
  "voter_id",
  "bank_account",
  "ifsc_pair",
  "gstin_credential",
  "portal_password",
  "api_credential",
  "health_identifier",
  "salary",
  "other",
]);

export const vaultStatusEnum = pgEnum("vault_status", [
  "active",
  "superseded",
  "expired",
  "erased",
]);

/**
 * ⭐ WHY SOMEBODY LOOKED.
 *
 * ⚠️ REQUIRED, AND FROM A FIXED LIST. A free-text reason box gets "work"
 * typed into it four thousand times and answers nothing. A fixed list is
 * the difference between a log that can be audited and a log that merely
 * exists — and it is what makes "who read 300 records under
 * `bulk_export` last Tuesday" a query rather than an investigation.
 */
export const vaultAccessPurposeEnum = pgEnum("vault_access_purpose", [
  "kyc_verification",
  "payment_processing",
  "statutory_filing",
  "customer_request",
  "clinical_care",
  "dispute_resolution",
  "audit",
  "bulk_export",
  "support_troubleshooting",
  "migration",
]);

/* ------------------------------------------------------------------ */
/* 1 · THE VAULT                                                       */
/* ------------------------------------------------------------------ */

export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    kind: vaultKindEnum("kind").notNull(),
    status: vaultStatusEnum("status").default("active").notNull(),

    /**
     * What this belongs to — a contact, a company, a staff record.
     * Deliberately a loose (kind, id) pair: the vault must not need a
     * foreign key to every table in the system, and adding one for each
     * new owner type would make the vault the thing that blocks every
     * other feature.
     */
    ownerKind: varchar("owner_kind", { length: 60 }).notNull(),
    ownerId: uuid("owner_id").notNull(),

    label: varchar("label", { length: 200 }),

    /* ---- The protected value --------------------------------------- */

    /**
     * ⭐ CIPHERTEXT ONLY. Base64 of AES-GCM output, produced in the
     * Worker before this row is ever built.
     *
     * ⚠️ NOTHING IN THE DATABASE CAN DECRYPT THIS, INCLUDING A SUPERUSER
     * WITH A psql PROMPT. That is the property being bought, and it is
     * the one RLS cannot provide on its own.
     */
    ciphertext: text("ciphertext").notNull(),

    /** AES-GCM nonce, base64. Unique per encryption, never reused. */
    iv: varchar("iv", { length: 64 }).notNull(),

    /**
     * ⚠️ THE NAME OF THE KEY, NOT THE KEY.
     *
     * "vault-2026-q3" names a secret in Cloudflare. Storing the key
     * itself here would make the ciphertext column decorative — anyone
     * who could read one column could read the other.
     */
    keyRef: varchar("key_ref", { length: 120 }).notNull(),

    /** Algorithm, so a future migration knows what it is looking at. */
    algorithm: varchar("algorithm", { length: 40 })
      .default("AES-GCM-256")
      .notNull(),

    /* ---- Searchable without being readable -------------------------- */

    /**
     * ⭐ HMAC-SHA256 UNDER A SERVER-SIDE PEPPER. See the file header.
     *
     * ⚠️ NOT sha256(value). The PAN space is roughly 10^9 and a laptop
     * enumerates it in minutes, so a plain hash column IS the PAN to
     * whoever obtains it. The pepper lives in Cloudflare Secrets and
     * never in this database, so the same table without it is inert.
     */
    blindIndex: varchar("blind_index", { length: 64 }),

    /**
     * ⭐ WHAT MAY BE SHOWN ON A SCREEN. "XXXXXX1234F".
     *
     * ⚠️ A REAL COLUMN, NOT A FUNCTION OVER THE PLAINTEXT. If masking
     * required decryption, then every list view — every search result,
     * every table of a hundred rows — would decrypt a hundred secrets and
     * write a hundred access-log rows to render a page nobody was even
     * reading closely. The log would drown in noise, which is the same as
     * having no log. Masked display is by far the common case and it must
     * cost nothing.
     */
    maskedDisplay: varchar("masked_display", { length: 100 }),

    /* ---- Lifecycle --------------------------------------------------- */

    /**
     * ⭐ WHEN THIS MUST BE DESTROYED.
     *
     * ⚠️ SET AT WRITE TIME, NOT DECIDED AT DELETION TIME. The DPDPA
     * requires personal data to be erased when the purpose is served, and
     * a retention policy that lives in a document is a retention policy
     * nobody executes. Stating the date on the row makes "what is overdue
     * for erasure" a query.
     */
    retainUntil: timestamp("retain_until", { withTimezone: true }),

    /**
     * ⚠️ ERASURE ZEROES THE CIPHERTEXT AND KEEPS THE ROW.
     *
     * The row is the PROOF that erasure happened, and to what. Deleting
     * it leaves nothing to show a regulator except an absence, which is
     * indistinguishable from never having recorded it — and from having
     * quietly moved it elsewhere.
     */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    erasedReason: text("erased_reason"),

    /** Rotation: this row replaces an older one. */
    supersedesId: uuid("supersedes_id"),

    /**
     * ⚠️ ACCESS COUNTERS LIVE HERE SO AN ANOMALY IS VISIBLE WITHOUT A
     * JOIN over a log table that will have millions of rows.
     */
    accessCount: integer("access_count").default(0).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),

    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("vault_secrets_tenant_idx").on(t.tenantId),
    ownerIdx: index("vault_secrets_owner_idx").on(
      t.tenantId,
      t.ownerKind,
      t.ownerId,
    ),
    kindIdx: index("vault_secrets_kind_idx").on(t.tenantId, t.kind, t.status),
    /** The whole point of the blind index — an equality lookup. */
    blindIdx: index("vault_secrets_blind_idx").on(t.tenantId, t.blindIndex),
    retentionIdx: index("vault_secrets_retention_idx").on(t.retainUntil),
    tenantScoped: uniqueIndex("vault_secrets_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    /**
     * ⚠️ THE SAME PAN MUST NOT BE VAULTED TWICE FOR ONE OWNER. Two rows
     * means two retention clocks, two erasure obligations, and an erasure
     * that succeeds while the value survives in the copy.
     */
    oneActivePerOwner: uniqueIndex("vault_secrets_owner_kind_active_key")
      .on(t.tenantId, t.ownerKind, t.ownerId, t.kind, t.blindIndex)
      .where(sql`status = 'active'`),
    /**
     * ⚠️ A ROW MUST NOT BE `erased` WITH CIPHERTEXT STILL IN IT. Without
     * this, "erased" is a label somebody set while the data stayed
     * exactly where it was — which is the worst possible outcome, because
     * it is reported as compliance.
     */
    erasureIsReal: check(
      "vault_secrets_erasure_is_real",
      sql`${t.status} <> 'erased' OR (${t.ciphertext} = '' AND ${t.erasedAt} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · ACCESS LOG — append-only, forever                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY DECRYPTION, WITH A STATED PURPOSE.
 *
 * ⚠️ NO DELETE PRIVILEGE, EVER, FOR ANY ROLE THE APPLICATION USES. An
 * access log that the application can prune is an access log that will be
 * pruned by exactly the person you built it to catch.
 *
 * ⚠️ AND IT DOES NOT CASCADE FROM THE SECRET. Deleting a vault row must
 * not delete the record of who read it — that is the one moment the log
 * matters most.
 */
export const vaultAccessLog = pgTable(
  "vault_access_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    secretId: uuid("secret_id").notNull(),

    /**
     * ⚠️ COPIED, NOT JOINED. The log must stay readable after the secret
     * row is gone — and after erasure the secret's own columns say
     * nothing about what it used to be.
     */
    secretKind: vaultKindEnum("secret_kind").notNull(),
    ownerKind: varchar("owner_kind", { length: 60 }).notNull(),
    ownerId: uuid("owner_id").notNull(),

    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Copied for the same reason: a deleted user must not erase the trail. */
    userEmail: varchar("user_email", { length: 320 }),

    purpose: vaultAccessPurposeEnum("purpose").notNull(),
    justification: text("justification"),

    /**
     * ⭐ Was it actually decrypted, or only shown masked?
     *
     * The two are completely different events and merging them makes the
     * log useless: masked views happen thousands of times a day and mean
     * nothing, decryptions happen rarely and mean everything.
     */
    wasDecrypted: boolean("was_decrypted").default(true).notNull(),

    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),

    /** True when this read came through a platform support session. */
    viaImpersonation: boolean("via_impersonation").default(false).notNull(),

    accessedAt: timestamp("accessed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("vault_access_log_tenant_idx").on(t.tenantId, t.accessedAt),
    secretIdx: index("vault_access_log_secret_idx").on(t.tenantId, t.secretId),
    userIdx: index("vault_access_log_user_idx").on(
      t.tenantId,
      t.userId,
      t.accessedAt,
    ),
    purposeIdx: index("vault_access_log_purpose_idx").on(
      t.tenantId,
      t.purpose,
      t.accessedAt,
    ),
    tenantScoped: uniqueIndex("vault_access_log_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    /**
     * ⚠️ A BULK EXPORT MUST SAY WHY, IN WORDS. It is the single purpose
     * most likely to be a person taking a customer list to a new employer,
     * and the only one where a name and a timestamp are not enough.
     */
    bulkNeedsJustification: check(
      "vault_access_log_bulk_needs_justification",
      sql`${t.purpose} <> 'bulk_export' OR (${t.justification} IS NOT NULL AND length(${t.justification}) >= 20)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · CONSENT — who agreed to what, and when they took it back        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ DPDPA 2023 CONSENT, AS A RECORD RATHER THAN A CHECKBOX.
 *
 * ⚠️ WITHDRAWAL IS A ROW, NOT A DELETE. "This person consented on 4 March
 * and withdrew on 11 September" is the thing that has to be provable —
 * both halves. Deleting the consent row on withdrawal destroys the
 * evidence that the processing between those dates was lawful, which is
 * exactly the period anybody would be asking about.
 */
export const vaultConsents = pgTable(
  "vault_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The data principal — the person the data is about. */
    subjectKind: varchar("subject_kind", { length: 60 }).notNull(),
    subjectId: uuid("subject_id").notNull(),

    purpose: varchar("purpose", { length: 200 }).notNull(),
    /** The exact wording shown. Frozen — the wording IS the consent. */
    noticeText: text("notice_text").notNull(),
    noticeVersion: varchar("notice_version", { length: 40 }).notNull(),

    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    /** How: a form, a signature, a recorded call. */
    grantedVia: varchar("granted_via", { length: 60 }).notNull(),

    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),

    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("vault_consents_tenant_idx").on(t.tenantId),
    subjectIdx: index("vault_consents_subject_idx").on(
      t.tenantId,
      t.subjectKind,
      t.subjectId,
    ),
    purposeIdx: index("vault_consents_purpose_idx").on(t.tenantId, t.purpose),
    tenantScoped: uniqueIndex("vault_consents_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    withdrawnAfterGranted: check(
      "vault_consents_withdrawn_after_granted",
      sql`${t.withdrawnAt} IS NULL OR ${t.withdrawnAt} >= ${t.grantedAt}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONSTANTS & PURE HELPERS                                            */
/* ------------------------------------------------------------------ */

export type VaultKind = (typeof vaultKindEnum.enumValues)[number];
export type VaultAccessPurpose =
  (typeof vaultAccessPurposeEnum.enumValues)[number];

/**
 * ⭐ HOW MUCH OF EACH KIND MAY EVER APPEAR ON A SCREEN.
 *
 * ⚠️ AADHAAR IS FOUR DIGITS, AND THAT IS NOT A STYLE CHOICE. UIDAI
 * guidance and the Aadhaar Act permit displaying only the last four
 * digits; showing more is a specific, named offence. Encoding it as data
 * rather than as a rule somebody remembers is what makes it hold across
 * every screen, including the ones written next year.
 */
export const MASK_VISIBLE_SUFFIX: Readonly<Record<VaultKind, number>> =
  Object.freeze({
    pan: 4,
    aadhaar: 4,
    passport: 4,
    driving_licence: 4,
    voter_id: 4,
    bank_account: 4,
    ifsc_pair: 4,
    gstin_credential: 4,
    portal_password: 0, // ⚠️ NEVER. Not one character.
    api_credential: 4,
    health_identifier: 4,
    salary: 0,
    other: 0,
  });

/**
 * Purposes that must never be exercised by a platform support session.
 *
 * ⚠️ SUPPORT EXISTS TO FIX A BROKEN SCREEN, NOT TO READ A PAN. An
 * impersonating operator troubleshooting a layout bug has no business
 * decrypting KYC — and "they would not do that" is not a control.
 */
export const PURPOSES_FORBIDDEN_DURING_IMPERSONATION: readonly VaultAccessPurpose[] =
  Object.freeze(["bulk_export", "kyc_verification", "clinical_care"]);

/**
 * ⭐ Mask a value for display, revealing only the permitted suffix.
 *
 * Mirrors the masking asserted in SQL-FILES/0037_engine6_vault.sql.
 */
export function maskForDisplay(value: string, kind: VaultKind): string {
  const visible = MASK_VISIBLE_SUFFIX[kind];
  if (visible <= 0) return "•".repeat(Math.min(12, Math.max(6, value.length)));
  if (value.length <= visible) return "•".repeat(value.length);
  return "•".repeat(value.length - visible) + value.slice(-visible);
}

/**
 * ⚠️ AADHAAR IS THE ONE WORTH A DEDICATED CHECK.
 *
 * It is the identifier Indian regulators are most specific about, the one
 * customers most casually paste into a notes field, and the one whose
 * misuse carries a named penalty. A cheap format test lets the
 * application refuse it in places that were never meant to hold it —
 * a free-text note, a job description, an address line.
 */
export function looksLikeAadhaar(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  // 12 digits, and the first is never 0 or 1 by UIDAI's own numbering.
  return /^[2-9]\d{11}$/.test(digits);
}

export function looksLikePan(value: string): boolean {
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(value.trim().toUpperCase());
}

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const vaultSecretsRelations = relations(
  vaultSecrets,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [vaultSecrets.tenantId],
      references: [tenants.id],
    }),
    createdBy: one(users, {
      fields: [vaultSecrets.createdByUserId],
      references: [users.id],
    }),
    accesses: many(vaultAccessLog),
  }),
);

export const vaultAccessLogRelations = relations(vaultAccessLog, ({ one }) => ({
  secret: one(vaultSecrets, {
    fields: [vaultAccessLog.secretId],
    references: [vaultSecrets.id],
  }),
  user: one(users, {
    fields: [vaultAccessLog.userId],
    references: [users.id],
  }),
}));

export const vaultConsentsRelations = relations(vaultConsents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [vaultConsents.tenantId],
    references: [tenants.id],
  }),
}));
