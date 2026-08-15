/**
 * Ordence — ⭐⭐⭐ THE BOOT ASSERTION
 * Version: v1.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEPLOYMENT SERVED 200s WHILE BEING NON-FUNCTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * There was no startup validation of any kind. `instrumentation.ts`
 * initialised Sentry and checked nothing. `getServerEnv()` is lazy by
 * design, so a missing variable surfaced on the first request that
 * happened to touch the database or the console — not at start.
 *
 * The one genuine hard stop was Clerk: a missing key makes the
 * middleware throw before routing, which turns into a blanket 500. Every
 * other misconfiguration produced a RUNNING SITE:
 *
 *   • no `CLERK_WEBHOOK_SIGNING_SECRET` → sign-up succeeds, the webhook
 *     500s, no tenant row is ever created, and the user lands on
 *     "your workspace is not ready yet" with nothing anywhere saying why
 *   • no `PLATFORM_ADMIN_EMAILS` → the console is unreachable by anyone
 *   • no vault keys → no integration credential can be saved
 *   • no Redis → rate limiting reduced to a per-process counter
 *
 * ⚠️ AND `/api/health` RETURNED A HARD-CODED BODY THROUGH ALL OF IT.
 * `app/api/ready/route.ts` records that this exact combination kept a
 * green healthcheck through a twelve-hour outage.
 *
 * 🔴 I PROPOSED POINTING RAILWAY'S HEALTHCHECK AT `/api/ready` INSTEAD,
 * AND THAT WAS WRONG. `tests/ui/invoicing-wiring.test.ts` already
 * asserts the opposite, with a reason better than mine: Railway
 * RESTARTS a container that fails its healthcheck, so a database-aware
 * probe turns a Neon outage into a restart loop that destroys the logs
 * explaining it — and restarting the container does not fix Neon. The
 * healthcheck stays on `/api/health`; `/api/ready` stays for an uptime
 * monitor, where a human decides what to do about a red light.
 *
 * ⭐ WHICH LEAVES THIS FILE AS THE ANSWER TO THE ORIGINAL COMPLAINT. A
 * misconfigured deployment should not reach the point of serving at
 * all, and a healthcheck is the wrong instrument for that: it runs
 * forever and answers "is the process up". This runs once and answers
 * "should it be".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not validate shapes, reach the network, or query anything. A
 * boot assertion that can fail for an interesting reason is a boot
 * assertion that will one day refuse a deploy at 2am for a reason nobody
 * can reproduce. It asks one question per name: is this set to a
 * non-empty string.
 *
 * It runs ONLY when `NODE_ENV === "production"`. A developer with half a
 * `.env.local` should get a useful error on the page they opened, not a
 * process that will not start.
 */

import "server-only";
import { readRuntimeEnv } from "./env";

/**
 * ⭐ THE SET IS THE SAME ONE `/api/diag` ALREADY CALLS REQUIRED, plus
 * the webhook secret.
 *
 * Keeping them in step matters more than either list being perfect: two
 * definitions of "required" that disagree is how
 * `CLERK_WEBHOOK_SIGNING_SECRET` came to be optional in the schema,
 * optional in the diagnostic, and named as the top deployment problem in
 * `docs/ENVIRONMENT-VARIABLES.md` at the same time.
 */
export const BOOT_REQUIRED = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_ROOT_DOMAIN",
  "NEXT_PUBLIC_ZONE_DOMAIN",
  "PLATFORM_ADMIN_EMAILS",
  /**
   * 🔴 THE ONE THAT WAS OPTIONAL AND SHOULD NEVER HAVE BEEN.
   *
   * `app/api/webhooks/clerk/route.ts` is the SOLE path that creates a
   * `tenants` row or a `users` row for a real signup. Without this
   * secret the route fails closed with a 500 — correctly, because a
   * missing secret must never mean "skip verification" — and the
   * consequence is that nobody can ever get a workspace. The product
   * does not work at all, and every health signal reads green.
   */
  "CLERK_WEBHOOK_SIGNING_SECRET",
] as const;

/**
 * Names that are not required but whose absence changes the security
 * posture rather than merely disabling a feature. Reported, never fatal.
 *
 * ⚠️ THESE ARE WARNINGS ON PURPOSE. Refusing to boot without Redis would
 * mean a Redis outage takes the product down, which is a worse failure
 * than a degraded limiter. What must not happen is that they are absent
 * and NOBODY EVER FINDS OUT, which is the state they were in.
 */
export const BOOT_ADVISORY: ReadonlyArray<{ name: string; consequence: string }> = [
  {
    name: "UPSTASH_REDIS_REST_URL",
    consequence:
      "rate limiting falls back to a per-process counter, which the limiter's " +
      "own comment calls a speed bump rather than a control, and the webhook " +
      "policy stops limiting altogether",
  },
  {
    name: "VAULT_ENCRYPTION_KEY",
    consequence:
      "no integration credential can be stored, so every tenant-configured " +
      "webhook and connector is dark on arrival",
  },
  {
    name: "VAULT_BLIND_INDEX_PEPPER",
    consequence: "the vault refuses to store anything, same as above",
  },
  {
    name: "CSP_ENFORCE",
    consequence:
      "the content security policy is report-only, so it blocks nothing; " +
      "without CSP_REPORT_URI as well, nobody is collecting the reports the " +
      "report-only phase exists to gather",
  },
  {
    name: "PLATFORM_HOST",
    consequence:
      "the console has no hostname of its own, so /platform is reachable on " +
      "every host and the structural boundary collapses to the layout guard",
  },
] as const;

export type BootVerdict = {
  ok: boolean;
  missing: string[];
  advisory: { name: string; consequence: string }[];
  enforced: boolean;
};

/** The verdict, without the throwing. Exported so a test can read it. */
export function bootVerdict(
  read: (name: string) => string | undefined = readRuntimeEnv,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): BootVerdict {
  const present = (name: string) => {
    const value = read(name);
    return typeof value === "string" && value.trim().length > 0;
  };

  return {
    ok: BOOT_REQUIRED.every(present),
    missing: BOOT_REQUIRED.filter((name) => !present(name)),
    advisory: BOOT_ADVISORY.filter((entry) => !present(entry.name)).map((e) => ({ ...e })),
    enforced: nodeEnv === "production",
  };
}

/**
 * 🔴 CALLED FROM `instrumentation.ts`. Throws in production when a
 * required name is missing, so the deploy fails rather than serving.
 *
 * ⚠️ THE MESSAGE NAMES THE VARIABLE. An assertion that says
 * "configuration invalid" costs the same deploy cycle it was meant to
 * save.
 */
export function assertBootEnv(): BootVerdict {
  const verdict = bootVerdict();

  for (const entry of verdict.advisory) {
    console.warn(
      `⚠️  [BOOT] ${entry.name} is not set — ${entry.consequence}.`,
    );
  }

  if (verdict.ok) {
    console.log(
      `✅ [BOOT] All ${BOOT_REQUIRED.length} required settings present` +
        (verdict.advisory.length > 0
          ? `, ${verdict.advisory.length} advisory warning${verdict.advisory.length === 1 ? "" : "s"} above.`
          : "."),
    );
    return verdict;
  }

  const detail =
    `Missing required settings: ${verdict.missing.join(", ")}.\n` +
    `Set them on the deployment and redeploy. /api/diag reports the same ` +
    `list without needing a shell.`;

  if (!verdict.enforced) {
    console.warn(
      `⚠️  [BOOT] ${detail}\n` +
        `    NOT FATAL because NODE_ENV is "${process.env.NODE_ENV ?? "undefined"}". ` +
        `In production this would refuse to start.`,
    );
    return verdict;
  }

  throw new Error(`[BOOT] Refusing to start. ${detail}`);
}
