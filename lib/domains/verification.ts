/**
 * Ordence — Custom domain ownership
 * Version: v1.94.0-alpha (Wave 3B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * `tenants.custom_domain` and `tenants.custom_domain_verified_at` have
 * existed since 0091, with a partial unique index on the first. NOTHING
 * IN THE PRODUCT WROTE EITHER COLUMN, and middleware did not route on
 * them. `resolveTenantFromHost` already classified an unknown host as
 * `{ kind: "custom-domain" }`, and the deployment answers on
 * `*.ordence.com` with a wildcard certificate.
 *
 * The consequence was not a data leak , RLS still scopes every query to
 * the session's own workspace. It was an IMPERSONATION SURFACE: anyone
 * who pointed a hostname they control at Ordence got Ordence serving
 * their own workspace at that name, under a valid certificate, with no
 * check that the name had anything to do with them. That is a phishing
 * page the product hosts on request.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CHALLENGE IS DERIVED, NOT STORED
 * ══════════════════════════════════════════════════════════════════════
 * An HMAC over `<tenant id>:<domain>` under a server secret. Two
 * consequences worth stating:
 *
 *   · There is no `custom_domain_verification_token` column, so there is
 *     no third column that nothing writes. The defect this wave exists
 *     to close is not re-introduced by the fix for it.
 *   · The token is bound to BOTH the workspace and the name. A token
 *     published for one tenant's domain proves nothing about another's,
 *     and moving the domain to a different workspace changes the value
 *     the DNS must carry.
 *
 * ⚠️ THE SECRET IS OPTIONAL IN THE ENV SCHEMA AND THE ACTION REFUSES
 * WITHOUT IT. Absent secret means no verification is possible; it must
 * never mean verification passes. See `deriveDomainChallenge`.
 */

import { createHmac } from "node:crypto";
import { normaliseHostname } from "@/lib/tenant";

/** The TXT record's owner name, one label under the domain being claimed. */
export const DOMAIN_CHALLENGE_PREFIX = "_ordence-challenge";

export class DomainVerificationUnavailableError extends Error {
  constructor() {
    super(
      "Domain verification is not configured on this deployment. " +
        "Set CUSTOM_DOMAIN_VERIFICATION_SECRET and try again.",
    );
    this.name = "DomainVerificationUnavailableError";
  }
}

/**
 * ⚠️ THROWS RATHER THAN RETURNING NULL. A caller that forgot to handle a
 * null would fall through to "no token expected", and a verification
 * that expects nothing succeeds against a domain that carries nothing.
 */
export function deriveDomainChallenge(tenantId: string, domain: string): string {
  const secret = process.env.CUSTOM_DOMAIN_VERIFICATION_SECRET;
  if (!secret || secret.length < 16) throw new DomainVerificationUnavailableError();

  const digest = createHmac("sha256", secret)
    .update(`${tenantId}:${normaliseHostname(domain)}`, "utf8")
    .digest("base64url");

  // 32 characters is 192 bits of the digest — far past guessable, and
  // short enough that a person can compare it to a DNS panel by eye.
  return `ordence-domain-verification=${digest.slice(0, 32)}`;
}

/** The record a customer must publish, ready to paste into a DNS panel. */
export function domainChallengeRecord(
  tenantId: string,
  domain: string,
): { name: string; type: "TXT"; value: string } {
  return {
    name: `${DOMAIN_CHALLENGE_PREFIX}.${normaliseHostname(domain)}`,
    type: "TXT",
    value: deriveDomainChallenge(tenantId, domain),
  };
}

/**
 * A hostname a customer may claim.
 *
 * ⚠️ THE ZONE AND ROOT DOMAINS ARE REFUSED HERE, not left to the unique
 * index. A tenant that "verified" `app.ordence.com` as a custom domain
 * would be claiming the product's own front door, and the resolver
 * classifies that host as root long before this column is consulted —
 * so the row would be accepted, be unreachable, and read as broken.
 */
export function validateClaimableDomain(
  raw: string,
  opts: { rootDomain: string; zoneDomain?: string | undefined },
): { ok: true; domain: string } | { ok: false; error: string } {
  const domain = normaliseHostname(raw);

  if (!domain) return { ok: false, error: "Enter a domain." };
  if (domain.length > 253) return { ok: false, error: "That domain is too long." };
  if (domain.includes("/") || domain.includes(":") || domain.includes(" ")) {
    return { ok: false, error: "Enter the hostname only, with no protocol or path." };
  }
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return { ok: false, error: "That is not a valid hostname." };
  }
  if (domain.split(".").length < 2) {
    return { ok: false, error: "Use a fully qualified domain, such as erp.example.com." };
  }

  const reservedZones = [opts.rootDomain, opts.zoneDomain]
    .filter((z): z is string => Boolean(z))
    .map(normaliseHostname);

  for (const zone of reservedZones) {
    if (domain === zone || domain.endsWith(`.${zone}`)) {
      return {
        ok: false,
        error: `Addresses under ${zone} are issued by Ordence, not verified as custom domains.`,
      };
    }
  }

  if (domain.startsWith(`${DOMAIN_CHALLENGE_PREFIX}.`)) {
    return { ok: false, error: "That name is reserved for the verification record." };
  }

  return { ok: true, domain };
}

/**
 * Look up the challenge record and report whether it carries the token.
 *
 * ⚠️ NODE RUNTIME ONLY. `node:dns` does not exist on the Edge, which is
 * one more reason this check lives in a server action and not in
 * middleware — see the header of `middleware.ts` on why a per-request
 * database or network lookup on the hostname path takes every tenant
 * offline when it is slow.
 */
export async function checkDomainChallenge(
  tenantId: string,
  domain: string,
): Promise<
  | { ok: true; domain: string }
  | { ok: false; reason: "no_record" | "mismatch" | "lookup_failed"; detail: string }
> {
  const expected = deriveDomainChallenge(tenantId, domain);
  const name = `${DOMAIN_CHALLENGE_PREFIX}.${normaliseHostname(domain)}`;

  let records: string[][];
  try {
    const { resolveTxt } = await import("node:dns/promises");
    records = await resolveTxt(name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        ok: false,
        reason: "no_record",
        detail: `No TXT record found at ${name}. DNS changes can take a few minutes to appear.`,
      };
    }
    return { ok: false, reason: "lookup_failed", detail: `Could not look up ${name}.` };
  }

  // A TXT record arrives as an array of string CHUNKS, and a value longer
  // than 255 bytes is split across them. Joining is not a nicety: a
  // record split by the DNS provider would otherwise never match.
  const values = records.map((chunks) => chunks.join("").trim());

  if (values.length === 0) {
    return { ok: false, reason: "no_record", detail: `No TXT record found at ${name}.` };
  }
  if (!values.includes(expected)) {
    return {
      ok: false,
      reason: "mismatch",
      detail: `The TXT record at ${name} does not carry this workspace's token.`,
    };
  }

  return { ok: true, domain: normaliseHostname(domain) };
}
