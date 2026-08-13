/**
 * Ordence — ⭐⭐⭐ A READ IS A WRITE
 * Version: v1.12.0-alpha
 *
 * ⚠️ NODE RUNTIME ONLY (via `./crypto`).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONLY DOOR INTO THE VAULT
 * ══════════════════════════════════════════════════════════════════════
 * `openSecret()` in `./crypto` can decrypt. Nothing outside this file
 * should ever call it, because a decryption with no access-log row is
 * precisely what 0037 was built to make impossible:
 *
 *   > No policy stops a person entitled to read one record from reading
 *   > four thousand; only a log makes it visible the next morning.
 *
 * ⭐ SO EVERY PATH THAT RETURNS A PLAINTEXT FROM HERE WRITES A ROW
 * FIRST, and writes it in the same transaction, so a read that is not
 * logged is a read that did not happen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND WHAT IS DELIBERATELY NOT LOGGED
 * ══════════════════════════════════════════════════════════════════════
 * A connection polling every six minutes reads its key 240 times a day.
 * Writing 240 rows a day per connection would bury the handful where a
 * PERSON opened a credential, and 0037 makes exactly that argument about
 * masked display: the log would drown in noise, which is the same as
 * having no log.
 *
 * 🔴 THE RUNNER'S READ IS ACCOUNTED FOR BY ITS `sync_runs` ROW, which
 * already records what ran, when, against which connection and with what
 * result. `readForRunner` therefore takes a run id and does NOT write to
 * the access log; `readForPerson` takes a user and always does.
 *
 * ⚠️ A runner read with no run id is not permitted. That is the case
 * where nothing else would record it.
 */

import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { vaultSecrets, vaultAccessLog } from "@/db/schema/vault";
import {
  blindIndexMatches,
  openSecret,
  sealSecret,
  vaultReadiness,
} from "./crypto";
import type { VaultKind } from "@/db/schema/vault";

/**
 * The Drizzle transaction handle from `withTenant`. Typed loosely on
 * purpose: this module must not import the pool, or a client bundle that
 * touches it drags a database driver in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/** `vault_secrets.owner_kind` for an integration connection. */
export const CONNECTION_OWNER_KIND = "connection" as const;

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

export interface PutSecretInput {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  /** `vault_kind`. `api_credential` for everything in this session. */
  readonly kind: "api_credential" | "portal_password" | "gstin_credential";
  /** Which secret this is: `api_key`, `access_token`, `app_secret`. */
  readonly label: string;
  readonly plaintext: string;
  readonly userId: string | null;
  readonly userEmail: string | null;
  /**
   * ⚠️ Only used to pick the masking rule, which is the vault's own
   * shared table. Defaults to the `kind`.
   */
  readonly maskKind?: VaultKind;
  /** For a token that expires. Stored in the vault's own metadata. */
  readonly expiresAt?: Date | null;
  /**
   * ⚠️ WHEN THIS MUST BE DESTROYED. 0037 wants it set at write time
   * rather than decided at deletion time, because a retention policy
   * that lives in a document is a retention policy nobody executes.
   *
   * Null is legitimate for a live credential: it is retained while the
   * connection exists and erased when the connection is removed.
   */
  readonly retainUntil?: Date | null;
}

export type PutSecretResult =
  | { readonly ok: true; readonly secretId: string; readonly rotated: boolean; readonly unchanged: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * ⭐ STORE OR ROTATE A SECRET.
 *
 * 🔴 A REPLACEMENT SUPERSEDES; IT DOES NOT OVERWRITE. The old row is
 * erased through the vault's own function, which zeroes the ciphertext
 * and keeps the row as the receipt, and the new row points back at it.
 *
 * ⚠️ Overwriting in place would destroy the answer to "when did this key
 * change", which is the first question anybody asks when an integration
 * stops working.
 */
export async function putSecret(
  input: PutSecretInput,
): Promise<PutSecretResult> {
  const readiness = vaultReadiness();
  if (!readiness.ready) {
    // ⚠️ Refuse BEFORE the value is touched. Never a partial save that
    // leaves a credential somewhere it was not meant to be.
    return { ok: false, error: readiness.message ?? "The vault is not configured." };
  }
  if (input.plaintext.trim().length === 0) {
    return { ok: false, error: "Refusing to store an empty value." };
  }

  const existing = await input.tx
    .select({
      id: vaultSecrets.id,
      blindIndex: vaultSecrets.blindIndex,
    })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.tenantId, input.tenantId),
        eq(vaultSecrets.ownerKind, input.ownerKind),
        eq(vaultSecrets.ownerId, input.ownerId),
        eq(vaultSecrets.label, input.label),
        eq(vaultSecrets.status, "active"),
      ),
    )
    .limit(1);

  const previous = existing[0] ?? null;

  // ⭐ THE SAME VALUE, SAVED AGAIN, IS NOT A ROTATION.
  //
  // ⚠️ Somebody who opens the settings screen, glances at it and presses
  // save should not move the rotation date. A date that moves when
  // nothing changed is a date nobody can rely on.
  if (previous?.blindIndex && blindIndexMatches(input.plaintext, previous.blindIndex)) {
    return { ok: true, secretId: previous.id, rotated: false, unchanged: true };
  }

  const sealed = sealSecret(input.plaintext, input.maskKind ?? input.kind);

  const metadata: Record<string, unknown> = {};
  if (input.expiresAt) metadata.expires_at = input.expiresAt.toISOString();

  const inserted = await input.tx
    .insert(vaultSecrets)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      status: "active" as const,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      label: input.label,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      keyRef: sealed.keyRef,
      algorithm: sealed.algorithm,
      blindIndex: sealed.blindIndex,
      maskedDisplay: sealed.maskedDisplay,
      retainUntil: input.retainUntil ?? null,
      supersedesId: previous?.id ?? null,
      createdByUserId: input.userId,
      metadata,
    })
    .returning({ id: vaultSecrets.id });

  const secretId = inserted[0]?.id as string | undefined;
  if (!secretId) return { ok: false, error: "The credential could not be stored." };

  // 🔴 THE OLD ONE IS ERASED, NOT LEFT LYING THERE.
  //
  // ⚠️ A superseded row with intact ciphertext is a working credential
  // nobody is watching. `ordence_vault_erase` zeroes it and keeps the
  // row, so the trail survives and the value does not.
  if (previous) {
    await input.tx.execute(
      sql`SELECT ordence_vault_erase(${input.tenantId}::uuid, ${previous.id}::uuid, ${"Replaced by a newer credential."})`,
    );
  }

  // ⭐ ENTERING A KEY IS EXACTLY THE EVENT THE LOG EXISTS FOR: rare,
  // deliberate, and done by a person.
  await input.tx.insert(vaultAccessLog).values({
    tenantId: input.tenantId,
    secretId,
    secretKind: input.kind,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    userId: input.userId,
    userEmail: input.userEmail,
    purpose: "integration_setup" as const,
    justification: previous
      ? `Replaced the ${input.label} for this connection.`
      : `Stored the ${input.label} for this connection.`,
    // ⚠️ FALSE. Nothing was decrypted here; a value was written.
    // Recording a write as a decryption would inflate the one count that
    // is supposed to mean something.
    wasDecrypted: false,
  });

  return { ok: true, secretId, rotated: previous !== null, unchanged: false };
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

interface SecretRow {
  readonly id: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyRef: string;
  readonly algorithm: string;
  readonly kind: string;
}

async function loadRow(
  tx: Tx,
  tenantId: string,
  ownerKind: string,
  ownerId: string,
  label: string,
): Promise<SecretRow | null> {
  const rows = await tx
    .select({
      id: vaultSecrets.id,
      ciphertext: vaultSecrets.ciphertext,
      iv: vaultSecrets.iv,
      keyRef: vaultSecrets.keyRef,
      algorithm: vaultSecrets.algorithm,
      kind: vaultSecrets.kind,
    })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.tenantId, tenantId),
        eq(vaultSecrets.ownerKind, ownerKind),
        eq(vaultSecrets.ownerId, ownerId),
        eq(vaultSecrets.label, label),
        eq(vaultSecrets.status, "active"),
      ),
    )
    .orderBy(desc(vaultSecrets.createdAt))
    .limit(1);

  return (rows[0] as SecretRow | undefined) ?? null;
}

export type ReadSecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

/**
 * 🔴 THE RUNNER'S READ. NOT LOGGED, AND THAT IS THE DESIGN.
 *
 * ⚠️ `syncRunId` IS REQUIRED. The read is accounted for by that run row;
 * without one there would be no record anywhere, which is the single
 * case this module must not allow.
 *
 * ⚠️ THE RETURN VALUE IS A CREDENTIAL. It must not be logged, must not
 * reach an error message, and must not be attached to a Sentry event. It
 * goes into an Authorization header and nowhere else.
 */
export async function readForRunner(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly label: string;
  /** The `sync_runs.id` this read belongs to. Not optional. */
  readonly syncRunId: string;
}): Promise<ReadSecretResult> {
  if (!args.syncRunId) {
    return {
      ok: false,
      error:
        "A credential may not be read outside a recorded run. Start the sync run first, so the read is accounted for.",
    };
  }

  const row = await loadRow(
    args.tx,
    args.tenantId,
    args.ownerKind,
    args.ownerId,
    args.label,
  );
  if (!row) {
    return {
      ok: false,
      error: `No ${args.label} is stored for this connection. Enter one on the connections screen.`,
    };
  }

  try {
    return { ok: true, value: openSecret(row) };
  } catch (e) {
    // ⚠️ The message from `openSecret` is already customer-safe and says
    // nothing about the value or the key.
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The credential could not be read.",
    };
  }
}

/**
 * 🔴 A PERSON READING A CREDENTIAL. ALWAYS LOGGED, IN THE SAME
 * TRANSACTION AS THE READ.
 *
 * ⚠️ There is no server action in this release that calls this, and that
 * is deliberate: no screen returns a credential. It exists for the
 * support and migration paths that will eventually need it, and it
 * exists here rather than being written ad hoc later, when the logging
 * would be the part that got left out.
 */
export async function readForPerson(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly label: string;
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly purpose: "support_troubleshooting" | "migration" | "audit";
  /** ⚠️ In words. "Debugging" is not a justification. */
  readonly justification: string;
  readonly viaImpersonation?: boolean;
}): Promise<ReadSecretResult> {
  if (args.justification.trim().length < 20) {
    return {
      ok: false,
      error:
        "Reading a stored credential needs a reason of at least twenty characters. It is recorded against your name and does not expire.",
    };
  }

  const row = await loadRow(
    args.tx,
    args.tenantId,
    args.ownerKind,
    args.ownerId,
    args.label,
  );
  if (!row) return { ok: false, error: "No such credential is stored." };

  // ⭐ THE LOG ROW GOES IN FIRST.
  //
  // 🔴 Written before the decryption is attempted, so a decryption that
  // then throws is still recorded. "It failed, so we did not log the
  // attempt" hides exactly the attempts worth seeing.
  await args.tx.insert(vaultAccessLog).values({
    tenantId: args.tenantId,
    secretId: row.id,
    secretKind: row.kind,
    ownerKind: args.ownerKind,
    ownerId: args.ownerId,
    userId: args.userId,
    userEmail: args.userEmail,
    purpose: args.purpose,
    justification: args.justification,
    wasDecrypted: true,
    viaImpersonation: args.viaImpersonation ?? false,
  });

  try {
    return { ok: true, value: openSecret(row) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The credential could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* ERASE                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ REMOVE A CREDENTIAL WITHOUT REMOVING THE RECORD THAT IT EXISTED.
 *
 * ⚠️ There is no DELETE here and there cannot be: 0037 revokes DELETE on
 * `vault_secrets` from the application role. Erasure zeroes the
 * ciphertext, drops the blind index and keeps the row as the receipt.
 */
export async function eraseSecretsFor(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly reason: string;
}): Promise<number> {
  const rows = await args.tx
    .select({ id: vaultSecrets.id })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.tenantId, args.tenantId),
        eq(vaultSecrets.ownerKind, args.ownerKind),
        eq(vaultSecrets.ownerId, args.ownerId),
        eq(vaultSecrets.status, "active"),
      ),
    );

  for (const row of rows as ReadonlyArray<{ id: string }>) {
    await args.tx.execute(
      sql`SELECT ordence_vault_erase(${args.tenantId}::uuid, ${row.id}::uuid, ${args.reason})`,
    );
  }
  return rows.length;
}
