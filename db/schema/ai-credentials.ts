/**
 * Ordence — ⭐⭐ PER-TENANT AI PROVIDER CREDENTIALS
 * Version: v1.65.0-alpha  ·  SQL 0105
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS TABLE HOLDS NO SECRET, AND THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * There is no `api_key` column here and there must never be one. The key
 * itself goes into `vault_secrets` — AES-256-GCM, key named rather than
 * kept, blind-indexed, access-logged, erasable — under
 *
 *     owner_kind = 'ai_provider_credential'
 *     owner_id   = this row's id
 *     label      = 'api_key'
 *
 * which is the exact shape `connections` already uses. A second place
 * that holds credentials is a second set of rules about credentials, and
 * the looser one wins the moment somebody imports the wrong module.
 *
 * ⭐ SO WHAT IS THIS ROW FOR? Everything about the credential that is not
 * the credential: which provider, whether it works, when it last did,
 * and the account id Cloudflare needs alongside its token. All of it
 * safe to render, all of it needed to tell a customer something true on
 * the day their key stops working.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND IT IS THE ACCOUNTING RECORD FOR THE READ
 * ══════════════════════════════════════════════════════════════════════
 * `server/vault/secrets.ts` states the rule: a decryption with no record
 * anywhere is what the vault was built to make impossible — but 240
 * access-log rows a day from a poller would bury the handful where a
 * PERSON opened a credential, so `readForRunner` is accounted for by its
 * `sync_runs` row instead.
 *
 * ⚠️ AN AI CALL IS THE SAME ANIMAL, AND MORE SO. The assistant may make
 * a dozen provider calls in one conversation. `last_used_at`,
 * `use_count` and the `last_failure_*` triple are this credential's
 * `sync_runs` — the standing record that it is being read, how often,
 * and how it went. That is why they are columns and not a cache.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO `lane` COLUMN AND THERE MUST NOT BE
 * ══════════════════════════════════════════════════════════════════════
 * A lane column here would be a per-tenant lane — a customer's own row
 * asserting that their Groq key may see their ledger. The lane is a
 * property of the PROVIDER, it lives in `lib/ai/providers.ts`, it is
 * committed to git, and it changes only by somebody reading a written
 * commitment not to train on inputs. See `laneForCredential()` in
 * `lib/ai/credentials.ts` for the full argument.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* THE TABLE                                                           */
/* ------------------------------------------------------------------ */

export const aiProviderCredentials = pgTable(
  "ai_provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ A STRING, NOT A FOREIGN KEY AND NOT AN ENUM.
     *
     * The provider registry is `lib/ai/providers.ts`, a frozen constant
     * in the application. A Postgres enum would have to be ALTERed every
     * time a provider is added — a migration to add a row to a list that
     * is already a list — and a lookup table would be a second copy of
     * the registry that drifts. The application validates the value
     * against `PROVIDERS_BY_ID` before it writes, and an unknown id here
     * is simply skipped by the resolver rather than crashing it.
     */
    providerId: varchar("provider_id", { length: 60 }).notNull(),

    /**
     * ⭐ CLOUDFLARE'S ACCOUNT ID. NOT A SECRET, AND NOT OPTIONAL FOR THE
     * ONE PROVIDER THAT NEEDS IT.
     *
     * 🔴 `lib/ai/client.ts` interpolates this into the base URL. With a
     * token and no account id the URL carries an empty path segment,
     * every call fails, the router walks on, and NOTHING SAYS WHY. The
     * check constraint below is the last of three places that refuse the
     * pair half-entered; see `requiresAccountId()`.
     */
    accountId: varchar("account_id", { length: 120 }),

    /**
     * `active` | `disabled` | `failing`.
     *
     * ⚠️ `failing` IS SET BY THE ROUTER, NOT BY A PERSON. It is what
     * makes "your key stopped working" visible on a screen nobody was
     * looking at when it happened. It does NOT stop the key being tried:
     * a key that failed once at 3am and works now must not need a human
     * to switch it back on. `disabled` is the only state a person sets
     * and the only one that stops the key being used.
     */
    status: varchar("status", { length: 20 }).default("active").notNull(),

    /* ---- What actually happened, which is the reason for the row --- */

    /** Last time a request was successfully answered on this key. */
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /**
     * ⭐ Last time this credential was READ OUT OF THE VAULT AND USED.
     * The accounting anchor. See the file header.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * ⚠️ `bigint` because it only ever increases and an ERP tenant on
     * their own key can make a lot of calls. It is a COUNT, not money —
     * the house rule about minor units does not apply and there is no
     * `_minor` suffix, deliberately.
     */
    useCount: bigint("use_count", { mode: "number" }).default(0).notNull(),

    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    /**
     * One of `CredentialFailureKind` in `lib/ai/credentials.ts`:
     * auth | quota | rate_limited | misconfigured | unreachable | error.
     *
     * 🔴 `auth` AND `rate_limited` ARE SEPARATE VALUES BECAUSE THEY ARE
     * SEPARATE EVENTS. One clears by itself in sixty seconds; the other
     * never clears until a person re-enters a key. A screen that shows
     * them the same way tells the customer to wait for a thing that will
     * not happen.
     */
    lastFailureKind: varchar("last_failure_kind", { length: 30 }),
    /**
     * ⚠️ THE PROVIDER'S OWN WORDS, TRUNCATED. Safe by construction: it
     * is a RESPONSE body. The key travels in a request header and is
     * never in anything read back. Stored so the customer sees what
     * their provider actually said rather than our paraphrase of it.
     */
    lastFailureMessage: text("last_failure_message"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    /** ⚠️ Composite, for the tenant-scoped foreign keys elsewhere. */
    idTenantKey: uniqueIndex("ai_provider_credentials_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    /**
     * 🔴 ONE ROW PER PROVIDER PER WORKSPACE. Two rows would mean two
     * vault secrets under two owner ids and a resolver picking one of
     * them by `created_at` — which is the shape where rotating a key
     * leaves the old one live and nobody can tell which is in use.
     * Rotation supersedes the vault row; this row is updated in place.
     */
    providerKey: uniqueIndex("ai_provider_credentials_provider_key").on(
      t.tenantId,
      t.providerId,
    ),
    statusIdx: index("ai_provider_credentials_status_idx").on(
      t.tenantId,
      t.status,
    ),
    statusValid: check(
      "ai_provider_credentials_status_valid",
      sql`${t.status} IN ('active', 'disabled', 'failing')`,
    ),
    /**
     * ⭐ THE PAIR, ENFORCED IN THE DATABASE AS WELL AS IN THE ACTION.
     * The application refuses it first with a sentence a person can act
     * on; this refuses it if anything ever reaches the table another way.
     */
    cloudflareNeedsAccount: check(
      "ai_provider_credentials_cloudflare_needs_account",
      sql`${t.providerId} <> 'cloudflare_workers_ai'
          OR (${t.accountId} IS NOT NULL AND length(btrim(${t.accountId})) > 0)`,
    ),
    useCountNonNegative: check(
      "ai_provider_credentials_use_count_non_negative",
      sql`${t.useCount} >= 0`,
    ),
  }),
);

export const aiProviderCredentialsRelations = relations(
  aiProviderCredentials,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [aiProviderCredentials.tenantId],
      references: [tenants.id],
    }),
  }),
);

/** `vault_secrets.owner_kind` for a row in this table. */
export const AI_CREDENTIAL_OWNER_KIND = "ai_provider_credential" as const;
/** `vault_secrets.label` for the key itself. One secret per row. */
export const AI_CREDENTIAL_SECRET_LABEL = "api_key" as const;
