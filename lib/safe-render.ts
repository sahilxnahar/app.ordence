/**
 * Ordence — Safe Value Rendering
 * Version: v0.3.0-alpha
 *
 * XSS DEFENSE FOR UNTRUSTED JSONB.
 *
 * `dynamic_attributes` and `custom_fields` hold whatever a tenant typed. React
 * escapes text children automatically, so `{value}` is safe. The dangerous paths
 * are the ones React does NOT escape:
 *
 *   1. `dangerouslySetInnerHTML`  — never used anywhere in this codebase
 *   2. `href` / `src` attributes  — `javascript:` and `data:` URLs execute on click
 *   3. Objects rendered directly  — React throws; must be stringified first
 *
 * This module handles 2 and 3. Rule 1 is enforced by a grep in the security run.
 */

/** URL schemes that can execute script or smuggle content. */
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file|blob):/i;

/**
 * Control characters browsers silently ignore inside URLs.
 * `java\tscript:` and `java\nscript:` both execute — stripping these first is
 * what makes the scheme check above meaningful.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const CONTROL_AND_SPACE = /[\u0000-\u001F\u007F-\u009F\s]/g;

/**
 * Return a URL only if it is safe to place in an `href`.
 * Anything else returns null, and the caller renders plain text instead.
 *
 * Note the leading-whitespace and control-character handling: `javascript:`
 * and ` javascript:` both bypass a naive `startsWith("javascript:")` check.
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  // Strip control characters that browsers ignore but naive filters do not.
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;
  if (DANGEROUS_SCHEME.test(cleaned)) return null;

  try {
    const url = new URL(cleaned);
    return url.protocol === "http:" || url.protocol === "https:" ? cleaned : null;
  } catch {
    // Relative URLs are fine as long as they are not protocol-relative (`//evil.com`)
    // and not an attempt at a scheme.
    if (cleaned.startsWith("/") && !cleaned.startsWith("//")) return cleaned;
    return null;
  }
}

/**
 * Strict address shape for `mailto:` links.
 *
 * A permissive `[^\s@]+@[^\s@]+` check is NOT enough: `<script>@evil.com` and
 * `"><img src=x onerror=1>@evil.com` both satisfy it, because neither contains
 * whitespace or a second `@`. React escapes attribute values so those would not
 * execute — but they would still produce a malformed mailto and, in some mail
 * clients, a header-injection vector. An allowlist of the characters RFC 5322
 * actually permits in a dot-atom address closes it properly.
 */
const SAFE_EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Return a mailto-safe address, or null. */
export function safeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length > 320) return null;
  if (!SAFE_EMAIL.test(cleaned)) return null;
  if (DANGEROUS_SCHEME.test(cleaned)) return null;
  return cleaned;
}

/**
 * Convert any JSONB value into a string React can render.
 *
 * Objects and arrays are JSON-stringified rather than passed through — React
 * throws on plain objects as children, and `String({})` yields the useless
 * "[object Object]".
 */
export function toDisplayString(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined) return "";

  const primitive =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
        ? String(value)
        : null;

  if (primitive !== null) {
    return primitive.length > maxLength ? `${primitive.slice(0, maxLength)}…` : primitive;
  }

  if (value instanceof Date) return value.toISOString();

  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    // Circular structures reach here.
    return "[unserialisable]";
  }
}

/** Read a possibly-nested key like `costAnalysis.total` out of a JSONB object. */
export function readPath(source: unknown, path: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  if (!path.includes(".")) return (source as Record<string, unknown>)[path];

  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    // Block prototype-pollution style lookups.
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Format a numeric value as currency without throwing on a bad code. */
export function formatCurrency(
  value: unknown,
  currency = "INR",
  locale = "en-IN",
): string {
  const num = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(num)) return toDisplayString(value);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${currency} ${num.toLocaleString()}`;
  }
}

/** Format a number, or fall back to a safe string. */
export function formatNumber(value: unknown, locale = "en-IN"): string {
  const num = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(num)) return toDisplayString(value);
  return num.toLocaleString(locale);
}

/** Format an ISO date, or fall back to a safe string. */
export function formatDate(value: unknown, withTime = false): string {
  if (value === null || value === undefined || value === "") return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return toDisplayString(value);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}
