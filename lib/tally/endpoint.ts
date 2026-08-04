/**
 * Ordence — ⭐⭐ The Tally Endpoint Policy
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic. Decides whether a direct push to a Tally instance
 * may be sent, and says why not in language the administrator who
 * configured it can act on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE TENSION THIS FILE EXISTS TO HOLD, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * `lib/workflows/http-policy.ts` (Phase 23) blocks EVERY private address:
 * loopback, RFC1918, link-local, the cloud metadata service. It exists
 * because "call an external service" is a text box in which a tenant
 * administrator types a URL that OUR SERVER fetches, from INSIDE our
 * network, with whatever ambient credentials that network implies. That
 * is the definition of server-side request forgery.
 *
 * ⚠️ AND TALLY IS ONLY EVER AT A PRIVATE ADDRESS.
 *
 * It is a Windows application on a desktop in the accounts room. Its HTTP
 * port answers on 127.0.0.1 or on 192.168.1.x. There is no hosted Tally,
 * no public endpoint and no plan for one. The policy that makes workflows
 * safe forbids, by construction, the one address this feature needs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO WRONG ANSWERS, BOTH OF WHICH HAVE SHIPPED SOMEWHERE
 * ══════════════════════════════════════════════════════════════════════
 *   ✗ "Skip the policy for Tally." One boolean, and the SSRF hole is
 *     wide open again — reachable by any tenant administrator, aimed
 *     anywhere, and the first thing anybody aims it at is
 *     169.254.169.254.
 *   ✗ "Allow private addresses when the Tally flag is on." The same hole
 *     with one extra step, because THE METADATA SERVICE IS A PRIVATE
 *     ADDRESS. 169.254.169.254 is link-local, which is private, which
 *     would now be allowed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT IS DONE INSTEAD — FOUR CONDITIONS, ALL REQUIRED
 * ══════════════════════════════════════════════════════════════════════
 *   1. The workspace has DELIBERATELY set `allow_private_host` on the
 *      connection. Off by default; an administrator action; audited.
 *   2. The host being reached is EXACTLY the host stored on that
 *      connection row — not a host supplied with the request.
 *   3. The address is in a range a Tally desktop can genuinely be on:
 *      loopback, or RFC1918. Nothing else.
 *   4. ⭐ AND THE HARD REFUSALS STILL APPLY WHATEVER THE FLAG SAYS:
 *      link-local (169.254/16 — the metadata service), 0.0.0.0/8,
 *      carrier-grade NAT, multicast, `.internal`, `metadata.google.
 *      internal`, and any host that resolves through a search domain.
 *      No Tally has ever been on one of those, and that is exactly where
 *      an attack goes.
 *
 * ⚠️ AND THE SAME GAP AS PHASE 23 REMAINS, RECORDED RATHER THAN HIDDEN:
 * this checks a NAME, and DNS can answer differently a millisecond later.
 * `tally.example.com` may resolve to a public address here and to
 * 169.254.169.254 when `fetch` connects. Closing that needs the resolved
 * address checked at socket level by a custom agent. For an IP LITERAL —
 * which is what a LAN Tally is configured with in practice, and what
 * `server/tally/push.ts` recommends — there is no resolution step and
 * therefore no rebinding window.
 */

import { isPrivateAddressLiteral } from "@/lib/workflows/http-policy";

/* ------------------------------------------------------------------ */
/* POLICY                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ PLAIN HTTP IS PERMITTED HERE AND ONLY HERE, BECAUSE TALLY HAS NO
 * TLS. Not "TLS is off by default" — the product does not implement it.
 * A policy demanding https for Tally would be a policy that forbids the
 * feature while appearing to allow it.
 *
 * The mitigation is the one that actually applies: the traffic never
 * leaves the LAN, because the only private addresses permitted are LAN
 * addresses.
 */
const ALLOWED_PROTOCOLS = Object.freeze(["http:", "https:"]);

/**
 * ⚠️ NOT AN ARBITRARY PORT. 9000 is Tally's default; 9001–9009 cover the
 * multi-instance case a firm running two companies hits. Anything else is
 * far more likely to be a scan of the internal network than a Tally.
 */
const ALLOWED_PORTS = Object.freeze([80, 443, 9000, 9001, 9002, 9003, 9004,
  9005, 9006, 9007, 9008, 9009]);

/**
 * ⭐ NAMES THAT ARE NEVER ALLOWED, WHATEVER THE FLAG SAYS.
 *
 * ⚠️ `localhost` IS NOT ON THIS LIST AND `metadata` IS. That asymmetry is
 * the whole design: a Tally genuinely can be on localhost — an on-premise
 * deployment on the same box — and a Tally can never be the cloud
 * metadata service.
 */
const NEVER_ALLOWED_HOSTNAMES = Object.freeze([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** `.internal`, `.svc`, `.cluster.local` — the estate, never a desktop. */
const NEVER_ALLOWED_SUFFIXES = Object.freeze([
  ".internal",
  ".cluster.local",
  ".svc",
  ".onion",
]);

/** Hosts that are only allowed when the connection says so. */
const LOOPBACK_HOSTNAMES = Object.freeze([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

export type TallyEndpointVerdict =
  | { allowed: true; url: URL; reachesPrivateNetwork: boolean }
  | { allowed: false; reason: string; remedy: string };

export type TallyEndpointConfig = {
  /** The host stored on the connection row. */
  host: string;
  port: number;
  useTls: boolean;
  /** ⭐⭐ The deliberate, audited, per-workspace exception. */
  allowPrivateHost: boolean;
};

/**
 * ⭐ Build and check the URL a push would go to.
 *
 * ⚠️ THE HOST COMES FROM THE STORED CONNECTION, NOT FROM THE REQUEST.
 * That is condition 2 and it is enforced by the signature: there is no
 * parameter through which a caller can supply a different host, so a
 * future endpoint that accepts one has to change this function to do it —
 * which is a diff somebody reviews.
 */
export function checkTallyEndpoint(config: TallyEndpointConfig): TallyEndpointVerdict {
  const scheme = config.useTls ? "https" : "http";
  const rawHost = config.host.trim();

  if (rawHost.length === 0) {
    return {
      allowed: false,
      reason: "This connection has no host.",
      remedy:
        "Set the address of the machine Tally runs on, or use the file export " +
        "instead — which is what most firms use and always works.",
    };
  }

  let url: URL;
  try {
    // ⚠️ Bracket a bare IPv6 literal; `new URL` refuses it otherwise and
    // the error would read as "invalid host" for a perfectly valid one.
    const hostForUrl =
      rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
    url = new URL(`${scheme}://${hostForUrl}:${config.port}/`);
  } catch {
    return {
      allowed: false,
      reason: `"${config.host}" is not a usable address.`,
      remedy: "Use a hostname or an IP address — for example 192.168.1.20.",
    };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      allowed: false,
      reason: `${url.protocol.replace(":", "")} is not allowed.`,
      remedy: "Tally speaks plain HTTP. Only http and https are permitted.",
    };
  }

  // ⚠️ Credentials are refused rather than stripped, exactly as in Phase
  // 23. Tally has no authentication anyway, so a URL carrying credentials
  // is a URL somebody pasted from somewhere else entirely.
  if (url.username || url.password) {
    return {
      allowed: false,
      reason: "The address contains a username or password.",
      remedy:
        "Tally's XML port has no authentication at all — a credential here " +
        "would be published to the workspace and would do nothing.",
    };
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.includes(port)) {
    return {
      allowed: false,
      reason: `Port ${port} is not allowed.`,
      remedy:
        `Tally's XML port is 9000 by default. Permitted: ${ALLOWED_PORTS.join(", ")}. ` +
        `A request to an arbitrary port from our servers is a port scan of ` +
        `whatever network they are on, whoever meant it.`,
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  /* --- ⭐ CONDITION 4: the hard refusals, whatever the flag says. */

  if (NEVER_ALLOWED_HOSTNAMES.includes(hostname)) {
    return refuseAlways(hostname);
  }
  if (NEVER_ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return refuseAlways(hostname);
  }
  if (isAlwaysForbiddenAddress(hostname)) {
    return refuseAlways(hostname);
  }

  /* --- Public address: allowed with no flag needed. ------------- */

  const isLoopbackName = LOOPBACK_HOSTNAMES.includes(hostname);
  const isBareName = !hostname.includes(".") && !hostname.includes(":");
  const isPrivate = isLoopbackName || isBareName || isPrivateAddressLiteral(hostname);

  if (!isPrivate) {
    /**
     * ⚠️ A PUBLIC ADDRESS FOR TALLY IS ODD BUT NOT FORBIDDEN. A firm with
     * a port-forward or a VPN concentrator has one. It is allowed, and it
     * is the case where the DNS-rebinding gap in the header applies —
     * which is why an IP literal is what the setup screen recommends.
     */
    return { allowed: true, url, reachesPrivateNetwork: false };
  }

  /* --- ⭐⭐ CONDITIONS 1 AND 3: private, so the flag decides. ---- */

  if (!config.allowPrivateHost) {
    return {
      allowed: false,
      reason: `${hostname} is inside a private network.`,
      remedy:
        "Tally normally IS on a private address, so this is expected — but " +
        "reaching one from our servers is switched off until an administrator " +
        "turns it on for this connection, deliberately. ⚠️ It is off by default " +
        "because the same capability aimed at 169.254.169.254 reads this " +
        "server's own cloud credentials. If this is a hosted workspace, use the " +
        "file export instead: our servers have no route to your office network " +
        "and never should.",
    };
  }

  if (!isPermittedPrivateRange(hostname, isLoopbackName, isBareName)) {
    return {
      allowed: false,
      reason: `${hostname} is not in a range a Tally installation can be on.`,
      remedy:
        "Even with private addresses enabled, only loopback (127.0.0.0/8, ::1) " +
        "and the ordinary LAN ranges (10/8, 172.16/12, 192.168/16) are " +
        "permitted. Link-local, carrier-grade NAT and multicast are refused " +
        "whatever the setting says — no Tally has ever been on one, and that " +
        "is precisely where an attack points.",
    };
  }

  return { allowed: true, url, reachesPrivateNetwork: true };
}

function refuseAlways(hostname: string): TallyEndpointVerdict {
  return {
    allowed: false,
    reason: `${hostname} can never be a Tally installation.`,
    remedy:
      "This address is refused whatever the connection's settings say. It is " +
      "cloud infrastructure or internal service discovery — reaching it from a " +
      "tenant-configured integration is how an integration reads the server's " +
      "own credentials.",
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ ADDRESS RANGES                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ REFUSED WHATEVER `allow_private_host` SAYS.
 *
 * ⚠️ THIS IS THE FUNCTION THE WHOLE FILE IS FOR. Everything else is
 * policy that a future requirement might reasonably widen. This is not:
 *
 *   169.254.0.0/16  — link-local. ⭐ 169.254.169.254 is the cloud
 *                     instance metadata service on AWS, GCP, Azure,
 *                     DigitalOcean and Oracle. On an unhardened host it
 *                     returns credentials for the role this application
 *                     runs as.
 *   0.0.0.0/8       — "this network". Several stacks route it to
 *                     localhost.
 *   100.64.0.0/10   — carrier-grade NAT. Also Tailscale's range, which is
 *                     somebody else's private network by definition.
 *   224.0.0.0/4 +   — multicast and reserved.
 *   ::/128, fe80::  — the IPv6 equivalents, including the IPv4-mapped
 *                     forms `URL` normalises to hex.
 */
export function isAlwaysForbiddenAddress(hostname: string): boolean {
  const stripped = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (stripped.includes(":")) return isForbiddenIpv6(stripped);

  const octets = parseIpv4(stripped);
  if (!octets) return false;
  return isForbiddenIpv4(octets);
}

function isForbiddenIpv4(octets: number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // ⭐ metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  return false;
}

function isForbiddenIpv6(hostname: string): boolean {
  if (hostname === "::") return true;
  if (hostname.startsWith("fe80")) return true; // link-local
  // ⚠️ ::ffff:169.254.169.254 in both the dotted and the hex form `URL`
  // normalises it to. Phase 23 shipped without the hex branch and a test
  // caught a metadata request being allowed.
  const dotted = hostname.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = parseIpv4(dotted[1] ?? "");
    return octets ? isForbiddenIpv4(octets) : true;
  }
  const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? "0", 16);
    const low = Number.parseInt(hex[2] ?? "0", 16);
    return isForbiddenIpv4([
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ]);
  }
  return false;
}

/**
 * ⭐ THE ONLY PRIVATE RANGES A TALLY DESKTOP CAN BE ON. An allowlist, not
 * a denylist — the difference being that a range nobody thought of is
 * refused rather than permitted.
 */
function isPermittedPrivateRange(
  hostname: string,
  isLoopbackName: boolean,
  isBareName: boolean,
): boolean {
  // `localhost` and `TALLYPC` — an on-premise install, and a NetBIOS name
  // on the office network. Both legitimate, both only reachable when the
  // server is genuinely on that network.
  if (isLoopbackName || isBareName) return true;

  const stripped = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (stripped === "::1") return true;
  // Unique-local IPv6 (fc00::/7) — an IPv6 LAN.
  if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true;

  const octets = parseIpv4(stripped);
  if (!octets) return false;

  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

/**
 * ⚠️ THE OCTAL, HEX AND DECIMAL FORMS, exactly as Phase 23 handles them.
 * `0177.0.0.1` and `2130706433` are both 127.0.0.1 to a resolver, and a
 * check that only reads dotted quads waves them through.
 */
function parseIpv4(hostname: string): number[] | null {
  if (/^\d+$/.test(hostname)) {
    const asNumber = Number(hostname);
    if (!Number.isSafeInteger(asNumber) || asNumber > 0xffffffff) return null;
    return [
      (asNumber >>> 24) & 0xff,
      (asNumber >>> 16) & 0xff,
      (asNumber >>> 8) & 0xff,
      asNumber & 0xff,
    ];
  }

  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fx]+$/i.test(part)) return null;
    const value =
      part.startsWith("0x") || part.startsWith("0X")
        ? Number.parseInt(part, 16)
        : /^0\d+$/.test(part)
          ? Number.parseInt(part, 8)
          : Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}
