/**
 * Ordence — ⭐⭐⭐ THE ARM ENGINE 6 WAS BUILT WITHOUT
 * Version: v1.12.0-alpha
 *
 * ⚠️ NODE RUNTIME ONLY (`node:crypto`).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 `vault_secrets` HAS EXISTED SINCE 0037 AND NOTHING HAS EVER
 *    WRITTEN TO IT
 * ══════════════════════════════════════════════════════════════════════
 * The table is complete: ciphertext-only storage, a key named rather
 * than kept, an HMAC blind index, a masked display column, a retention
 * date set at write time, an erasure function that actually zeroes the
 * value, and an append-only access log no application role may delete.
 * It is policied, granted, trigger-protected and tested at the SQL
 * level.
 *
 * ⚠️ IT HAS NEVER BEEN CALLED, because the encryption was specified to
 * happen "in the Worker" and the Worker went away when Ordence moved to
 * Railway. The table survived the move; the arm that fills it did not
 * exist to move. This file is that arm.
 *
 * ⭐ WHICH IS WHY THE INTEGRATION SESSION IS WHERE IT LANDS. Integration
 * credentials are the first values Ordence holds that open OTHER
 * PEOPLE'S systems, so they are the first values for which "encrypted at
 * rest, key elsewhere" is not a nicety.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SHAPE IS DICTATED BY 0037, NOT CHOSEN HERE
 * ══════════════════════════════════════════════════════════════════════
 * `vault_secrets` has `ciphertext text`, `iv varchar(64)` and NO
 * separate tag column, because it was written for WebCrypto, which
 * APPENDS the 16-byte GCM tag to the ciphertext. Node's `getAuthTag()`
 * hands it back separately.
 *
 * 🔴 SO THE TAG IS APPENDED HERE, DELIBERATELY, to produce a byte string
 * identical to what WebCrypto would have produced. Anything sealed by
 * this file can be opened by a Worker and the reverse, which is the
 * whole reason not to invent a third format.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE IV IS NEVER REUSED
 * ══════════════════════════════════════════════════════════════════════
 * Two messages under one key with one IV is the single failure that
 * breaks GCM completely, recovering the keystream from the pair.
 * `randomBytes(12)` every time. No counters, no derivation from the row
 * id, no exceptions.
 */

import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ⭐ THE MASKING RULE ALREADY EXISTS AND IS SHARED WITH EVERY OTHER KIND
// THE VAULT HOLDS.
//
// ⚠️ Writing a second one here would have been the same mistake as a
// second secrets table, one layer down: two answers to "how much of this
// may appear on a screen", and the looser one wins the moment somebody
// imports the wrong module.
import { maskForDisplay, type VaultKind } from "@/db/schema/vault";

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

/** AES-256. 32 bytes, supplied as 64 hex characters. */
const KEY_BYTES = 32;
/** 🔴 GCM's IV is 12 bytes. */
const IV_BYTES = 12;
/** 🔴 GCM's tag is 16 bytes, and is appended to the ciphertext. */
const TAG_BYTES = 16;

/** Matches `vault_secrets.algorithm`'s default, set in 0037. */
export const VAULT_ALGORITHM = "AES-GCM-256" as const;

/**
 * ⭐ THE NAME OF THE KEY, WHICH IS WHAT GOES IN THE ROW.
 *
 * ⚠️ Versioned in the name itself. When the key is rotated the constant
 * becomes `…:v2`, new rows say v2, old rows still say v1, and nothing
 * has to guess which key a row needs.
 */
export const CURRENT_KEY_REF = "env:VAULT_ENCRYPTION_KEY:v1";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

export class VaultNotConfiguredError extends Error {
  readonly missing: string;
  constructor(missing: string) {
    super(
      `${missing} is not set, so nothing can be stored in the vault. Generate one with: openssl rand -hex 32`,
    );
    this.name = "VaultNotConfiguredError";
    this.missing = missing;
  }
}

export class VaultKeyInvalidError extends Error {
  constructor(name: string, detail: string) {
    super(`${name} is not usable: ${detail}`);
    this.name = "VaultKeyInvalidError";
  }
}

export class VaultDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultDecryptionError";
  }
}

/* ------------------------------------------------------------------ */
/* THE KEY                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read at CALL TIME, not at module load.
 *
 * ⚠️ A module-level read runs during `next build`, when secrets are
 * legitimately absent, and fails the build. It also freezes the value
 * for the process lifetime, which breaks rotation.
 */
function readKey(): Buffer {
  const raw = process.env.VAULT_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new VaultNotConfiguredError("VAULT_ENCRYPTION_KEY");
  }
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new VaultKeyInvalidError(
      "VAULT_ENCRYPTION_KEY",
      "it must be hexadecimal. Generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    // ⚠️ The LENGTH is reported. The value is not, and must never be.
    throw new VaultKeyInvalidError(
      "VAULT_ENCRYPTION_KEY",
      `it must be exactly ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters); this one is ${key.length}`,
    );
  }
  return key;
}

function readPepper(): Buffer {
  const raw = process.env.VAULT_BLIND_INDEX_PEPPER;
  if (!raw || raw.trim().length < 32) {
    throw new VaultNotConfiguredError("VAULT_BLIND_INDEX_PEPPER");
  }
  return Buffer.from(raw.trim(), "utf8");
}

export interface VaultReadiness {
  readonly ready: boolean;
  /** Which variables are missing, by name. ⚠️ Names only. Never values. */
  readonly missing: readonly string[];
  readonly message: string | null;
}

/**
 * ⭐ WHETHER THE VAULT CAN BE USED, WITHOUT THROWING.
 *
 * ⚠️ Screens call this so they can say "the encryption key is not set"
 * before somebody types a credential into a form that is going to refuse
 * it. A save that fails after the value has been typed is a value that
 * has been typed into a browser, which is one autofill store and one
 * screenshot away from being somewhere else.
 */
export function vaultReadiness(): VaultReadiness {
  const missing: string[] = [];
  try {
    readKey();
  } catch (e) {
    missing.push(
      e instanceof VaultKeyInvalidError
        ? "VAULT_ENCRYPTION_KEY (set, but not usable)"
        : "VAULT_ENCRYPTION_KEY",
    );
  }
  try {
    readPepper();
  } catch {
    missing.push("VAULT_BLIND_INDEX_PEPPER");
  }

  if (missing.length === 0) {
    return { ready: true, missing: [], message: null };
  }
  return {
    ready: false,
    missing,
    message: `The vault is not configured, so no credential can be saved. Missing: ${missing.join(", ")}. Generate each with: openssl rand -hex 32`,
  };
}

/* ------------------------------------------------------------------ */
/* SEAL                                                                */
/* ------------------------------------------------------------------ */

/** Exactly the columns 0037 expects. Nothing else, and no plaintext. */
export interface SealedSecret {
  /** Base64 of ciphertext WITH the 16-byte GCM tag appended. */
  readonly ciphertext: string;
  /** Base64 of the 12-byte IV. */
  readonly iv: string;
  readonly keyRef: string;
  readonly algorithm: typeof VAULT_ALGORITHM;
  /** 64 hex characters. 0037's trigger refuses anything else. */
  readonly blindIndex: string;
  /**
   * What may appear on a screen, from the vault's own shared rule.
   *
   * 🔴 For `api_credential` that is now NOTHING. See
   * `MASK_VISIBLE_SUFFIX` in `db/schema/vault.ts`.
   */
  readonly maskedDisplay: string;
}

export function sealSecret(
  plaintext: string,
  kind: VaultKind = "api_credential",
): SealedSecret {
  if (plaintext.length === 0) {
    throw new Error("Refusing to vault an empty value.");
  }
  const key = readKey();

  // 🔴 A FRESH IV, EVERY TIME. See the header.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  // ⭐ Tag appended, WebCrypto-compatible. See the header.
  const withTag = Buffer.concat([body, cipher.getAuthTag()]);

  return {
    ciphertext: withTag.toString("base64"),
    iv: iv.toString("base64"),
    keyRef: CURRENT_KEY_REF,
    algorithm: VAULT_ALGORITHM,
    blindIndex: blindIndexOf(plaintext),
    maskedDisplay: maskForDisplay(plaintext, kind),
  };
}

/* ------------------------------------------------------------------ */
/* OPEN                                                                */
/* ------------------------------------------------------------------ */

export interface SealedInput {
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyRef?: string | null;
  readonly algorithm?: string | null;
}

/**
 * 🔴 THE RETURN VALUE OF THIS FUNCTION IS THE SECRET ITSELF.
 *
 * ⚠️ It must not be logged, must not appear in an error message, must
 * not be returned from a server action, and must not be attached to a
 * Sentry event. It goes into an Authorization header and nowhere else.
 *
 * ⭐ AND IT IS NOT THE FUNCTION THE APPLICATION SHOULD CALL. Use
 * `server/vault/secrets.ts`, which records the read. A decryption with
 * no access-log row is the one thing 0037 was built to make impossible.
 */
export function openSecret(sealed: SealedInput): string {
  const key = readKey();

  if (sealed.algorithm && sealed.algorithm !== VAULT_ALGORITHM) {
    throw new VaultDecryptionError(
      `This value was stored with ${sealed.algorithm}, which this build cannot read.`,
    );
  }
  if (sealed.keyRef && sealed.keyRef !== CURRENT_KEY_REF) {
    // ⚠️ Named, so a rotation is diagnosable rather than mysterious.
    throw new VaultDecryptionError(
      `This value was stored under key "${sealed.keyRef}" and this build holds "${CURRENT_KEY_REF}". Re-enter the credential, or restore the older key.`,
    );
  }

  const iv = Buffer.from(sealed.iv, "base64");
  if (iv.length !== IV_BYTES) {
    throw new VaultDecryptionError(
      `The stored initialisation vector is ${iv.length} bytes and should be ${IV_BYTES}.`,
    );
  }

  const all = Buffer.from(sealed.ciphertext, "base64");
  if (all.length <= TAG_BYTES) {
    throw new VaultDecryptionError(
      "The stored value is too short to contain both a ciphertext and its authentication tag.",
    );
  }
  const body = all.subarray(0, all.length - TAG_BYTES);
  const tag = all.subarray(all.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // ⚠️ ONE MESSAGE FOR EVERY FAILURE, naming the two real causes rather
    // than the cryptographic one.
    //
    // 🔴 "Unsupported state or unable to authenticate data" tells a
    // customer nothing, and tells an attacker probing the endpoint
    // whether it was the tag or the key that was wrong.
    throw new VaultDecryptionError(
      "This value could not be read. Either the encryption key has changed since it was saved, or the stored value has been altered. Enter it again.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* THE BLIND INDEX                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SEARCHABLE WITHOUT BEING READABLE.
 *
 * 🔴 HMAC UNDER A PEPPER, NOT A HASH. A plain SHA-256 of a PAN is the
 * PAN: the space is about 10^9 and a laptop enumerates it in minutes.
 * The pepper lives outside the database, so the same column is inert to
 * anyone holding only a dump.
 *
 * ⚠️ 0037's trigger refuses anything that is not 64 lowercase hex
 * characters, on exactly that reasoning.
 */
export function blindIndexOf(plaintext: string): string {
  return createHmac("sha256", readPepper())
    .update(plaintext, "utf8")
    .digest("hex");
}

/**
 * ⭐ Whether a value somebody just typed is the one already stored,
 * without decrypting anything and without either value being logged.
 *
 * ⚠️ Used so re-saving an unchanged key is not recorded as a rotation.
 * A rotation date that moves when nothing changed is a rotation date
 * nobody can use.
 */
export function blindIndexMatches(
  plaintext: string,
  storedBlindIndex: string,
): boolean {
  const computed = Buffer.from(blindIndexOf(plaintext), "utf8");
  const stored = Buffer.from(storedBlindIndex, "utf8");
  if (computed.length !== stored.length) {
    timingSafeEqual(computed, computed);
    return false;
  }
  return timingSafeEqual(computed, stored);
}

/* ------------------------------------------------------------------ */
/* PATH TOKENS                                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE UNGUESSABLE PART OF A WEBHOOK URL.
 *
 * ⚠️ For JustDial, which signs nothing, this is the ONLY thing between
 * the endpoint and the open internet. 0064 refuses anything under 32
 * characters at the database level rather than trusting this function to
 * stay correct forever.
 *
 * 48 hex characters is 24 bytes, 192 bits.
 */
export function generatePathToken(): string {
  return randomBytes(24).toString("hex");
}
