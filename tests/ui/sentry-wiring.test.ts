/**
 * Sentry wiring — the invariants a type checker cannot see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const OPTIONS = read("lib/observability/sentry-options.ts");
const INSTRUMENTATION = read("instrumentation.ts");
const CLIENT = read("instrumentation-client.ts");
const NEXT_CONFIG = read("next.config.ts");
const TENANT = read("server/tenant-context.ts");
const DIAG = read("app/api/diag/route.ts");

describe("🔴 no DSN means Sentry is simply off", () => {
  it("everything is gated on SENTRY_ENABLED", () => {
    expect(code(OPTIONS)).toContain('SENTRY_ENABLED = SENTRY_DSN !== ""');
    expect(code(INSTRUMENTATION)).toContain("if (!SENTRY_ENABLED) return;");
    expect(code(CLIENT)).toContain("if (SENTRY_ENABLED)");
  });

  /** A build that fails because a vendor is unconfigured gets the vendor removed. */
  it("the build does not require an auth token", () => {
    expect(code(NEXT_CONFIG)).toContain("authToken: process.env.SENTRY_AUTH_TOKEN");
    expect(code(NEXT_CONFIG)).not.toMatch(/throw[\s\S]{0,80}SENTRY_AUTH_TOKEN/);
  });
});

describe("🔴 PII never leaves by default", () => {
  it("sendDefaultPii is off", () => {
    expect(code(OPTIONS)).toContain("sendDefaultPii: false");
  });

  it("beforeSend runs the scrubber", () => {
    expect(code(OPTIONS)).toContain("scrubEvent(");
  });

  /**
   * A monitoring tool that leaks a session cookie because its own
   * sanitiser threw is worse than one that lost an error.
   */
  it("a throwing scrubber DROPS the event rather than sending it raw", () => {
    const body = code(OPTIONS);
    const beforeSend = body.slice(body.indexOf("beforeSend"));
    expect(beforeSend).toContain("return null;");
    expect(beforeSend).not.toMatch(/catch[\s\S]{0,60}return event/);
  });

  it("session replay is disabled on both sample rates", () => {
    expect(code(CLIENT)).toContain("replaysSessionSampleRate: 0");
    expect(code(CLIENT)).toContain("replaysOnErrorSampleRate: 0");
  });

  it("the tenant scope carries an id and a role, never a name or email", () => {
    const block = code(TENANT).slice(code(TENANT).indexOf("Sentry.setTags"));
    expect(block).toContain("tenant_id: tenantRow.id");
    expect(block).not.toMatch(/tenantRow\.name|userRow\.email|tenantRow\.slug/);
  });
});

describe("🔴 monitoring never breaks the thing it watches", () => {
  it("tenant tagging swallows its own failure", () => {
    const block = code(TENANT).slice(code(TENANT).indexOf("SENTRY_ENABLED"));
    expect(block).toMatch(/\.catch\(\(\) => \{/);
  });

  it("request-error reporting swallows its own failure", () => {
    const block = code(INSTRUMENTATION).slice(code(INSTRUMENTATION).indexOf("captureRequestError"));
    expect(code(INSTRUMENTATION)).toMatch(/\.catch\(\(\) => \{/);
    expect(block.length).toBeGreaterThan(0);
  });

  /**
   * The 12 August outage was diagnosed from Railway logs. Removing them
   * when adding Sentry is the obvious tidy-up and it is wrong.
   */
  it("the console logging survives alongside Sentry", () => {
    expect(code(INSTRUMENTATION)).toContain("console.error");
    expect((code(INSTRUMENTATION).match(/console\.error/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("headers are passed empty, so they are never in the event at all", () => {
    expect(code(INSTRUMENTATION)).toContain("headers: {}");
  });
});

describe("⭐ the release is the commit", () => {
  it("falls back to RAILWAY_GIT_COMMIT_SHA with no variable to set", () => {
    expect(code(OPTIONS)).toContain("RAILWAY_GIT_COMMIT_SHA");
  });

  it("diag reports the same string, so both name one commit", () => {
    expect(code(DIAG)).toContain('readRuntimeEnv("RAILWAY_GIT_COMMIT_SHA")');
  });

  it("never reports an unnamed release", () => {
    const fn = code(OPTIONS).slice(code(OPTIONS).indexOf("export function sentryRelease"));
    expect(fn).toContain("npm_package_version");
  });
});

describe("🔴 quota discipline", () => {
  /** Tracing on a free plan burns the quota, then drops the errors. */
  it("tracing is off until Batch E says what is worth tracing", () => {
    expect(code(OPTIONS)).toContain("tracesSampleRate: 0");
  });

  it("browser noise that is not a bug is ignored", () => {
    expect(code(OPTIONS)).toContain("ResizeObserver");
    expect(code(OPTIONS)).toContain("Failed to fetch");
  });
});

describe("🔴 source maps go to Sentry, never to a browser", () => {
  it("the IP-protection flag is untouched", () => {
    expect(code(NEXT_CONFIG)).toContain("productionBrowserSourceMaps: false");
  });

  it("and uploaded maps are deleted from the output", () => {
    expect(code(NEXT_CONFIG)).toContain("deleteSourcemapsAfterUpload: true");
  });

  it("events tunnel through our own domain, past ad-blockers", () => {
    expect(code(NEXT_CONFIG)).toContain('tunnelRoute: "/monitoring"');
  });
});

describe("⭐ React render errors are not invisible", () => {
  const GLOBAL_ERROR = read("app/global-error.tsx");

  /**
   * `onRequestError` catches SERVER errors. A component throwing during
   * render on the client bypasses it entirely — the user sees a blank
   * page and nothing records why. The Sentry build warned about exactly
   * this, and the warning was right.
   */
  it("global-error.tsx exists and reports to Sentry", () => {
    expect(GLOBAL_ERROR).toContain('"use client"');
    expect(code(GLOBAL_ERROR)).toContain("Sentry.captureException(error)");
  });

  /** It replaces the root layout, so it must render its own html/body. */
  it("renders its own html and body", () => {
    expect(GLOBAL_ERROR).toContain("<html");
    expect(GLOBAL_ERROR).toContain("<body");
  });

  /**
   * `error.message` on a client render error can carry whatever the
   * component was rendering — a customer's name, an amount.
   */
  it("shows the digest, never the raw message", () => {
    expect(code(GLOBAL_ERROR)).toContain("error.digest");
    expect(code(GLOBAL_ERROR)).not.toContain("{error.message}");
  });
});
