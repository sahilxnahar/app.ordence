/**
 * Ordence — Outbound Request Policy
 * Version: v0.23.0-alpha
 *
 * Pure. Decides whether an `http_request` step may be sent, and says why
 * not in language the person who wrote the workflow can act on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SERVER-SIDE REQUEST FORGERY, WHICH IS WHAT THIS ACTION IS
 * ══════════════════════════════════════════════════════════════════════
 * "Call an external service" is a feature. It is also a text box in which
 * a tenant administrator types a URL that OUR SERVER fetches, from INSIDE
 * our network, with whatever ambient credentials that network implies.
 * That is the definition of SSRF; the only question is whether it is
 * constrained.
 *
 * The targets that matter, in rough order of how bad they are:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *       The cloud instance metadata service. On an unhardened host this
 *       returns credentials for the role the application runs as. One
 *       workflow step, and the response is written into the run context
 *       where the author can read it.
 *
 *   http://127.0.0.1:5432/  ·  http://localhost:6379/
 *       The database and Redis. Not speaking HTTP is not protection —
 *       a crafted POST body is a protocol-confusion attack, and Redis in
 *       particular has been driven this way for years.
 *
 *   http://10.0.0.0/8, 172.16/12, 192.168/16, fd00::/8
 *       Everything else inside the VPC: internal admin panels, other
 *       tenants' services, the metrics endpoint.
 *
 * ⚠️ THIS FILE IS NECESSARY AND NOT SUFFICIENT, AND PRETENDING OTHERWISE
 * IS THE USUAL MISTAKE. Blocking literal private addresses does not stop
 * DNS rebinding: `evil.example.com` resolves to a public address when
 * this function checks it and to 169.254.169.254 when `fetch` connects a
 * millisecond later. Closing that needs resolution and connection to
 * happen together — a custom agent that checks the resolved address at
 * socket level. The comment in `server/workflows/effects.ts` records that
 * as the remaining gap rather than leaving somebody to assume it is
 * handled here.
 */

/* ------------------------------------------------------------------ */
/* POLICY                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ HTTPS ONLY, WITH NO "internal use" ESCAPE HATCH.
 *
 * Plain HTTP would carry the run context — buyer names, phone numbers,
 * agreement values — across the internet in clear text, and every request
 * for an exception is "just for our internal server", which is precisely
 * the address range that is blocked anyway.
 */
const ALLOWED_PROTOCOLS = Object.freeze(["https:"]);

/**
 * Ports. 443 is the point; the others are the common "our API is on
 * 8443" cases. Anything else is far more likely to be a port scan of the
 * internal network than an integration.
 */
const ALLOWED_PORTS = Object.freeze([443, 8443]);

const BLOCKED_HOSTNAMES = Object.freeze([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // ⚠️ Cloud metadata by name as well as by address. Several providers
  // publish a hostname for it, and blocking only the IP misses them.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** `.internal`, `.local` and friends never point outside the estate. */
const BLOCKED_SUFFIXES = Object.freeze([
  ".internal",
  ".local",
  ".localdomain",
  ".cluster.local",
  ".svc",
  ".onion",
]);

export type HttpPolicyVerdict =
  | { allowed: true; url: URL }
  | { allowed: false; reason: string; remedy: string };

export function checkOutboundUrl(rawUrl: string): HttpPolicyVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      reason: "That is not a valid URL.",
      remedy: "Use a full address, including https://.",
    };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      allowed: false,
      reason: `${url.protocol.replace(":", "")} is not allowed.`,
      remedy:
        "Only https is permitted. Plain http would send workspace data across " +
        "the internet unencrypted.",
    };
  }

  // ⚠️ Credentials in the URL are refused rather than stripped. A
  // workflow definition is readable by everybody with `workflows:read`,
  // so `https://user:password@host/` is a password published to the
  // workspace — and silently removing it would send a request that fails
  // in a way nobody can explain.
  if (url.username || url.password) {
    return {
      allowed: false,
      reason: "The URL contains a username or password.",
      remedy:
        "Credentials in a URL are visible to everyone who can read this " +
        "workflow. Put the secret in a header instead.",
    };
  }

  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.includes(port)) {
    return {
      allowed: false,
      reason: `Port ${port} is not allowed.`,
      remedy: `Only ${ALLOWED_PORTS.join(" and ")} are permitted.`,
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (hostname.length === 0) {
    return { allowed: false, reason: "The URL has no host.", remedy: "Add a hostname." };
  }

  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return blockedInternal(hostname);
  }

  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return blockedInternal(hostname);
  }

  // A bare hostname with no dot is a machine on the local network by
  // definition — `http://intranet/` resolves through the search domain.
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return blockedInternal(hostname);
  }

  if (isPrivateAddressLiteral(hostname)) {
    return blockedInternal(hostname);
  }

  return { allowed: true, url };
}

function blockedInternal(hostname: string): HttpPolicyVerdict {
  return {
    allowed: false,
    reason: `${hostname} is inside the private network.`,
    remedy:
      "Workflows may only call services on the public internet. Reaching " +
      "internal addresses from a tenant-authored request is how a workflow " +
      "reads the server's own credentials.",
  };
}

/* ------------------------------------------------------------------ */
/* ADDRESS LITERALS                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE OCTAL AND DECIMAL FORMS ARE THE ONES PEOPLE FORGET.
 *
 * `http://2130706433/` and `http://0177.0.0.1/` are both 127.0.0.1 to a
 * resolver, and a check that only looks for the dotted-quad string waves
 * them through. `URL` does normalise some of these, but not all of them
 * on every runtime, so the numeric forms are handled explicitly.
 */
export function isPrivateAddressLiteral(hostname: string): boolean {
  const stripped = hostname.replace(/^\[|\]$/g, "");

  if (stripped.includes(":")) return isPrivateIpv6(stripped);

  // A bare integer: 2130706433 === 127.0.0.1
  if (/^\d+$/.test(stripped)) {
    const asNumber = Number(stripped);
    if (Number.isSafeInteger(asNumber) && asNumber <= 0xffffffff) {
      return isPrivateIpv4([
        (asNumber >>> 24) & 0xff,
        (asNumber >>> 16) & 0xff,
        (asNumber >>> 8) & 0xff,
        asNumber & 0xff,
      ]);
    }
    return true; // Numeric and not addressable — refuse rather than guess.
  }

  const parts = stripped.split(".");
  if (parts.length !== 4) return false;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fx]+$/i.test(part)) return false;
    // Octal (leading zero) and hex (0x) both parse here.
    const value = part.startsWith("0x") || part.startsWith("0X")
      ? Number.parseInt(part, 16)
      : /^0\d+$/.test(part)
        ? Number.parseInt(part, 8)
        : Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return false;
    octets.push(value);
  }

  return isPrivateIpv4(octets);
}

function isPrivateIpv4(octets: number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // ⭐ link-local: metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0) return true;             // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                         // multicast and reserved
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "::1" || lowered === "::") return true;
  if (lowered.startsWith("fe80")) return true;                 // link-local
  if (lowered.startsWith("fc") || lowered.startsWith("fd")) return true; // unique local

  // ::ffff:127.0.0.1 — an IPv4 address wearing an IPv6 costume.
  const mappedDotted = lowered.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateAddressLiteral(mappedDotted[1] ?? "");

  /**
   * ⚠️ AND THE SAME ADDRESS AFTER `URL` HAS NORMALISED IT.
   *
   * This branch was missing, and a test caught it. `new URL()` rewrites
   * `https://[::ffff:169.254.169.254]/` to a hostname of
   * `[::ffff:a9fe:a9fe]` — the dotted quad becomes two hex groups. The
   * check above then matched nothing, `isPrivateIpv6` returned false, and
   * a request to the cloud metadata service was ALLOWED.
   *
   * The general lesson is worth more than the fix: a policy that inspects
   * a value AFTER a parser has normalised it must be written against the
   * NORMALISED form, not the form a person types. Every check in this file
   * runs on `url.hostname`, so every one of them sees the parser's output.
   */
  const mappedHex = lowered.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? "0", 16);
    const low = Number.parseInt(mappedHex[2] ?? "0", 16);
    return isPrivateIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* HEADERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Headers a workflow may not set.
 *
 * `host` is the one that matters: setting it turns an allowed public URL
 * into a request routed by a proxy to something else entirely. The rest
 * are headers whose forgery would misrepresent where the request came
 * from.
 */
const BLOCKED_HEADERS = Object.freeze([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cookie",
]);

export function filterHeaders(
  headers: Record<string, string> | undefined,
): { headers: Record<string, string>; refused: string[] } {
  const safe: Record<string, string> = {};
  const refused: string[] = [];

  for (const [key, value] of Object.entries(headers ?? {})) {
    const lowered = key.toLowerCase().trim();
    if (BLOCKED_HEADERS.includes(lowered) || lowered.startsWith(":")) {
      refused.push(key);
      continue;
    }
    // Header injection: a newline in a value splits it into two headers.
    if (/[\r\n]/.test(value)) {
      refused.push(key);
      continue;
    }
    safe[lowered] = value;
  }

  return { headers: safe, refused };
}
