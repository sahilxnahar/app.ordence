/**
 * Ordence — Portal Validation Schemas
 * Version: v0.9.0-alpha
 *
 * Shared by the portal actions, the signature engine and the manager UI.
 * Lives outside any `"use server"` file because such files may only export
 * async functions.
 */

import { z } from "zod";

export const PORTAL_ENTITY_TYPES = ["contract", "asset"] as const;
export const PORTAL_PERMISSIONS = ["view", "view_and_sign"] as const;

export type PortalEntityTypeInput = (typeof PORTAL_ENTITY_TYPES)[number];
export type PortalPermissionInput = (typeof PORTAL_PERMISSIONS)[number];

/**
 * How long a link may live.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE DEFAULT IS 14 DAYS AND THE CEILING IS 90
 * ══════════════════════════════════════════════════════════════════════
 * A portal link is a bearer credential to a legal document. Its lifetime
 * is the window in which a forwarded email, a shared screen or a browser
 * history is exploitable.
 *
 * 14 days is long enough that a client who is travelling still gets to it,
 * and short enough that a link leaked from a mailbox six months later is
 * already dead. The ceiling exists so nobody can set 3,650 in a hurry —
 * the database enforces 180 days independently via a CHECK constraint, so
 * this bound cannot be bypassed by calling the action directly.
 */
export const DEFAULT_EXPIRY_DAYS = 14;
export const MAX_EXPIRY_DAYS = 90;
export const MIN_EXPIRY_HOURS = 1;

export const createPortalLinkSchema = z.object({
  entityType: z.enum(PORTAL_ENTITY_TYPES),
  entityId: z.string().uuid("Invalid record identifier."),

  /**
   * Defaults to `view`.
   *
   * "Let them look at it" and "let them legally bind their company" are
   * different acts. Defaulting the second one on would be a serious
   * mistake, so signing is always an explicit choice.
   */
  permission: z.enum(PORTAL_PERMISSIONS).default("view"),

  expiresInDays: z.coerce
    .number()
    .int()
    .min(1, "A link must last at least a day.")
    .max(MAX_EXPIRY_DAYS, `A link cannot last longer than ${MAX_EXPIRY_DAYS} days.`)
    .default(DEFAULT_EXPIRY_DAYS),

  /**
   * Who it is for. Recorded for the audit trail and shown on the portal.
   *
   * NOT an authentication factor — the token is the credential. Requiring
   * the visitor to also type this address would be theatre, since anyone
   * holding the link can read it off the page it renders.
   */
  recipientEmail: z
    .union([
      z
        .string()
        .trim()
        .max(320)
        .regex(
          /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/,
          "Enter a valid email address.",
        ),
      z.literal(""),
    ])
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),

  recipientName: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),

  /** Send the link straight to the recipient by email on creation. */
  sendEmail: z.boolean().default(false),

  /** Optional covering note included in that email. */
  message: z.string().trim().max(2000).optional(),
});

export type CreatePortalLinkInput = z.input<typeof createPortalLinkSchema>;

export const revokePortalLinkSchema = z.object({
  linkId: z.string().uuid("Invalid identifier."),
  reason: z.string().trim().max(500).optional(),
});

export type RevokePortalLinkInput = z.input<typeof revokePortalLinkSchema>;

/* ------------------------------------------------------------------ */
/* SIGNING                                                             */
/* ------------------------------------------------------------------ */

/**
 * The exact wording an external signer accepts.
 *
 * Stored verbatim on every signature row. If this text is ever changed,
 * historical signatures still carry the words that were actually shown at
 * the time — which is the only version that matters in a dispute.
 */
export const CONSENT_STATEMENT =
  "By typing my name below and selecting “Approve & Sign”, I confirm that I " +
  "have read this document, that I agree to be bound by it, and that I am " +
  "authorised to accept it on behalf of the party I represent. I agree that " +
  "this electronic record constitutes my signature.";

export const signContractSchema = z.object({
  /** The URL token. Re-verified server-side; never trusted from the form. */
  token: z.string().regex(/^[0-9a-f]{64}$/, "Invalid link."),

  signerName: z
    .string()
    .trim()
    .min(2, "Please type your full name.")
    .max(300)
    // A name is not markup. Angle brackets in this field are either a
    // mistake or an attempt, and neither belongs in a legal record.
    .regex(/^[^<>{}\\]+$/, "Please enter your name using ordinary characters."),

  signerTitle: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),

  /**
   * Must be exactly `true`.
   *
   * `z.literal(true)` rather than `z.boolean()` — an unchecked box submits
   * `false` or nothing at all, and both must be refused rather than
   * coerced. Consent that can be absent is not consent.
   */
  consent: z.literal(true, {
    errorMap: () => ({ message: "You must accept the statement before signing." }),
  }),
});

export type SignContractInput = z.input<typeof signContractSchema>;

/* ------------------------------------------------------------------ */
/* DISPLAY HELPERS                                                     */
/* ------------------------------------------------------------------ */

/** Human-readable time remaining. `null` when already expired. */
export function describeTimeRemaining(expiresAt: string | Date): string | null {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;

  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;

  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;

  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The status a link should display as, in priority order. */
export function portalLinkStatus(link: {
  isActive: boolean;
  expiresAt: string | Date;
  signedAt?: string | Date | null;
  revokedAt?: string | Date | null;
}): "signed" | "revoked" | "expired" | "active" {
  if (link.signedAt) return "signed";
  if (link.revokedAt || !link.isActive) return "revoked";
  if (new Date(link.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}
