#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ RAILWAY-VARIABLES-PASTE.txt, GENERATED
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `RAILWAY-VARIABLES-PASTE.txt` was hand-maintained beside a catalogue
 * that is the source of truth, which is the same defect as the catalogue
 * drift one level up. By v1.65.0-alpha it omitted ALL FOUR `S3_*` names
 * and EVERY AI key. An operator who followed it verbatim — which is what
 * a file called PASTE is for — got a deployment with no document storage
 * and no AI assistant, and nothing anywhere said so.
 *
 * So the sheet is now emitted from `lib/platform/env-catalog.ts`, and
 * `scripts/check-env-catalogue.mjs` fails the build if a catalogued name
 * is missing from it. Editing the .txt by hand is now a thing the gate
 * notices.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PROSE IS DATA HERE, AND THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * The old sheet's value was never the list of names — it was the
 * warnings. "Use `ordence_app`, NOT `neondb_owner`" has saved this
 * project from silently disabling row-level security on every table.
 * Generating a bare `NAME=` list would have thrown that away and called
 * it an improvement.
 *
 * So every warning that was in the file is in `NOTES` below, keyed by
 * name, and the generator refuses to run if a name it has a note for has
 * left the catalogue. A note attached to a setting nobody sets any more
 * is a warning about a thing that cannot happen, and those are how a
 * document stops being read.
 *
 * ⚠️ NO VALUE IN HERE IS A SECRET. Three secrets were once printed as
 * literals in a committed document under "copy these exactly", so anybody
 * with repository read access held the worker bearer token, the cron
 * secret and the upload-ticket HMAC key. `PREFILLED` below carries only
 * hostnames, booleans and switches. `assertNoSecrets()` refuses to write
 * the file if that ever stops being true.
 *
 * Run: node scripts/generate-railway-variables.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "RAILWAY-VARIABLES-PASTE.txt");

/* ------------------------------------------------------------------ */
/* THE CATALOGUE, PARSED FROM SOURCE                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Same dumb parse as the gate, and for the same reason: a `.mjs`
 * script cannot import a `.ts` module without a build step, and a clever
 * parse that silently matched nothing would emit an empty sheet and
 * report success.
 */
function categories() {
  const source = readFileSync(join(ROOT, "lib", "platform", "env-catalog.ts"), "utf8");
  const body = source.slice(source.indexOf("export const ENV_CATEGORIES"));
  const out = [];
  const blockRe = /name:\s*"([^"]+)"[\s\S]*?description:\s*([\s\S]*?),\s*required:\s*\[([\s\S]*?)\][\s\S]*?optional:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = blockRe.exec(body)) !== null) {
    const names = (chunk) => [...chunk.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
    out.push({
      name: m[1],
      description: [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(""),
      required: names(m[3]),
      optional: names(m[4]),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* THE VALUES THIS DEPLOYMENT ALREADY KNOWS                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ HOSTNAMES, BOOLEANS AND SWITCHES ONLY. Never a credential.
 */
const PREFILLED = {
  NEXT_PUBLIC_APP_URL: "https://appordence-production.up.railway.app",
  NEXT_PUBLIC_ROOT_DOMAIN: "ordence.com",
  NEXT_PUBLIC_ZONE_DOMAIN: "ordence.com",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  ORDENCE_INLINE_JOBS: "true",
  CSP_ENFORCE: "false",
  SEED_ALLOW_PROD: "false",
  DATABASE_URL: "PASTE_HERE",
  CLERK_SECRET_KEY: "PASTE_HERE",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "PASTE_HERE",
};

/** Names that must be emitted even though the catalogue does not carry them. */
const EXTRA = [
  {
    category: "Runtime",
    description: "Set explicitly rather than relied upon.",
    name: "NODE_ENV",
    value: "production",
    note: "Railway usually sets this. Pinning it means a misconfigured service cannot silently run in development mode with development-mode error pages.",
  },
];

/**
 * The warnings. Keyed by name; every one of these was in the hand-written
 * sheet and none of them may be lost.
 */
const NOTES = {
  DATABASE_URL: `!! WHICH ROLE MATTERS AS MUCH AS WHICH DATABASE !!

Use \`ordence_app\`, NOT \`neondb_owner\`.

\`neondb_owner\` carries the BYPASSRLS attribute, which overrides even
FORCE ROW LEVEL SECURITY. Connected as that role, every row-level
policy on all 319 tenant tables is skipped - the app works perfectly
and one forgotten WHERE clause returns another tenant's data.

\`ordence_app\` is NOSUPERUSER + NOBYPASSRLS, so the policies apply.
Verify before switching:
  SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
   WHERE rolname = 'ordence_app';
  -- want: can_login = t, bypasses_rls = f

If the password contains @ : / ? # or &, URL-encode it, or the
connection string parser will split the URL in the wrong place.`,

  PLATFORM_HOST: `🔴 LEAVE THIS BLANK UNTIL THE CONSOLE HAS ITS OWN HOSTNAME.

It used to be set to the same value as NEXT_PUBLIC_APP_URL, and that
combination makes the customer application unreachable: every request
to the canonical URL classifies as the platform host, and the
middleware rewrites /dashboard and /sign-in into /platform/*, which
404. /api/* keeps working, so /api/health stays green while nothing
else does.

When app.ordence.com is connected, set this to admin.ordence.com.`,

  NEXT_PUBLIC_APP_URL: `Clerk builds its sign-in redirects from this. A mismatch sends users
to a domain that does not resolve and the login loop never completes.
When app.ordence.com is connected, change this and update the Clerk
webhook endpoint to match.`,

  VAULT_ENCRYPTION_KEY: `Generate LOCALLY and paste only into Railway:  openssl rand -hex 32

ROTATING THIS ORPHANS EVERY EXISTING ROW. There is no key registry.
Set it once, keep it, and treat losing it as losing every stored
credential.`,

  VAULT_BLIND_INDEX_PEPPER: `Generate LOCALLY:  openssl rand -hex 32

Rotating this makes every blind index in the database unsearchable at
once. Same rule as the key above: set it once, keep it.`,

  RESEND_WEBHOOK_SECRET: `Signing secret from the Resend dashboard's webhook page (Svix format,
whsec_...). Without it /api/webhooks/resend returns 503 and refuses
every delivery, so bounces and spam complaints are NOT suppressed
automatically. That is deliberate: an unauthenticated endpoint that
can suppress an address is a denial of service on a customer's mail,
so it fails closed rather than open.`,

  WORKER_API_SECRET: `Any long random text:  openssl rand -hex 32

🔴 EVERY SCHEDULED JOB IS INERT WITHOUT THIS. /api/workers refuses
with 503 when no authentication method is configured, so the dunning
sweep, the mail drain, workflow maintenance, the rhythm recompute and
storage reconciliation all stop. See docs/current/CRON-RUNBOOK.md.`,

  CRON_SECRET: `Any long random text:  openssl rand -hex 32

The RLS canary at /api/cron/canary refuses to run without it, and an
isolation probe that never runs is indistinguishable from one that
always passes.`,

  UPLOAD_TICKET_SECRET: `Any long random text:  openssl rand -hex 32
Document uploads are inert without it.`,

  CSP_ENFORCE: `Turn on once you confirm nothing is blocked. Set CSP_REPORT_URI
first, or the report-only phase collects nothing and can never end.`,

  SEED_ALLOW_PROD: `NEVER set this to true.`,

  CLERK_ENCRYPTION_KEY: `Read by the Clerk SDK rather than by Ordence's own code. Ordence
never references it, and the deployment still needs it for handshake
encryption.`,

  CLERK_PUBLISHABLE_KEY: `The un-prefixed alias. Only needed if you would rather not maintain a
build-variable list; NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY above is the
normal answer.`,

  SENTRY_AUTH_TOKEN: `🔴 BUILD-TIME, NOT RUNTIME. next.config.ts reads it on the build
machine to upload source maps. Setting it only at runtime uploads
nothing and every stack trace stays minified.`,

  APP_HOST: `Read by lib/security/csrf.ts to decide which Origin headers a
state-changing request may carry. Set it to the customer-facing
hostname without the scheme.`,

  ORDENCE_PLATFORM_HOST: `The staff console hostname, for the same CSRF check as APP_HOST.`,

  EDGE_LIMIT_MODE: `Set to \`observe\` to count rate-limit trips without refusing
anything. Anything else enforces.`,

  EDGE_LIMIT_PLATFORM_FAIL_OPEN: `\`true\` lets platform traffic through when the rate limiter itself is
unavailable. A deliberate door; leave it shut unless you are opening
it on purpose.`,

  S3_ENDPOINT: `🔴 ALL FOUR S3_ NAMES OR NONE. These four were missing from this
file entirely until v1.66.0-alpha, so a deployment made by pasting it
had NO DOCUMENT STORAGE and nothing said so. Cloudflare R2 over the
S3 API; the endpoint looks like
https://<account>.r2.cloudflarestorage.com`,

  BLOB_READ_WRITE_TOKEN: `Legacy Vercel Blob. No live code path reads it. Kept only for the
Cloudflare rollback; leave blank.`,

  FINANCE_ALERT_EMAILS: `Read by nothing in the running application. Listed so a deployment
that already sets it is not told it does not exist.`,

  DATABASE_URL_UNPOOLED: `Neon direct (non-pooled) string, for migrations. The running
application never reads it.`,

  NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS: `How many days before a trial ends the customer is warned. Blank uses
the built-in default. The same number is printed to the customer, so
it is NEXT_PUBLIC_.`,
};

/* ------------------------------------------------------------------ */
/* THE WRITE                                                           */
/* ------------------------------------------------------------------ */

function assertNoSecrets(text) {
  /**
   * ⚠️ A generated file is exactly as committable as a hand-written one,
   * so the check that no credential reached it has to run here rather
   * than in somebody's head. `PASTE_HERE` and the two hostnames are the
   * only assignments with a value long enough to look like a key.
   */
  const allowed = new Set(Object.values(PREFILLED).concat(EXTRA.map((e) => e.value)));
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2].trim();
    if (allowed.has(value)) continue;
    if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
      throw new Error(
        `Refusing to write: ${m[1]} has a value that looks like a credential. ` +
          `Three secrets were once committed to this repository as literals. Never again.`,
      );
    }
  }
}

function wrap(prefix, body) {
  return body
    .split("\n")
    .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

const cats = categories();
if (cats.length < 5) {
  console.error(
    `Parsed only ${cats.length} categories out of lib/platform/env-catalog.ts. ` +
      "The parse has broken; refusing to overwrite the paste sheet with a stub.",
  );
  process.exit(1);
}

const allNames = new Set(cats.flatMap((c) => [...c.required, ...c.optional]));
const orphanNotes = Object.keys(NOTES).filter(
  (n) => !allNames.has(n) && !EXTRA.some((e) => e.name === n),
);
if (orphanNotes.length > 0) {
  console.error(
    `These names have a warning in this generator and are no longer in the catalogue: ` +
      `${orphanNotes.join(", ")}. Delete the note or restore the name — a warning about a ` +
      `setting nobody sets is how a document stops being read.`,
  );
  process.exit(1);
}

const lines = [];
lines.push("# ============================================================");
lines.push("# ORDENCE - Railway variables for the app.ordence service");
lines.push("# ============================================================");
lines.push("# GENERATED FROM lib/platform/env-catalog.ts.");
lines.push("# Do not edit by hand - `npm run check:env-catalogue` will notice.");
lines.push("# Regenerate: node scripts/generate-railway-variables.mjs");
lines.push("#");
lines.push("# Paste this WHOLE block into Railway > Variables > Raw Editor.");
lines.push("# Then replace every PASTE_HERE with the real value.");
lines.push("#");
lines.push("# Lines starting with # are notes. Railway ignores them.");
lines.push("# A line with nothing after the = is fine - that feature is");
lines.push("# simply switched off until you fill it in.");
lines.push("#");
lines.push("# !! NEVER put these values in a file you push to GitHub. !!");
lines.push("# ============================================================");

const seen = new Set();

for (const extra of EXTRA) {
  lines.push("");
  lines.push(`# ---- ${extra.category.toUpperCase()} ${"-".repeat(Math.max(0, 44 - extra.category.length))}`);
  lines.push(`# ${extra.description}`);
  lines.push(wrap("# ", extra.note));
  lines.push(`${extra.name}=${extra.value}`);
  seen.add(extra.name);
}

for (const cat of cats) {
  const names = [...cat.required, ...cat.optional].filter((n) => !seen.has(n));
  if (names.length === 0) continue;

  lines.push("");
  lines.push(`# ---- ${cat.name.toUpperCase()} ${"-".repeat(Math.max(0, 44 - cat.name.length))}`);
  if (cat.description) lines.push(wrap("# ", cat.description));

  for (const name of names) {
    seen.add(name);
    const required = cat.required.includes(name);
    if (NOTES[name]) {
      lines.push("#");
      lines.push(wrap("# ", NOTES[name]));
    }
    if (required && !NOTES[name]) lines.push("# REQUIRED");
    else if (required) lines.push("# REQUIRED");
    lines.push(`${name}=${PREFILLED[name] ?? ""}`);
  }
}

lines.push("");
lines.push("# ---- SCHEDULED WORK ------------------------------------------");
lines.push("# Setting WORKER_API_SECRET above is only half of it. Nothing in");
lines.push("# this deployment has a scheduler attached, so the dunning sweep,");
lines.push("# the mail drain, workflow maintenance, the rhythm recompute and");
lines.push("# storage reconciliation do not run until something calls");
lines.push("# /api/workers on a schedule.");
lines.push("#");
lines.push("# docs/current/CRON-RUNBOOK.md has the exact calls.");
lines.push("");

/**
 * ⚠️ EM-DASHES OUT. House rule for owner-facing documents, and this one
 * is pasted into a web form: the character survives the round trip fine,
 * but the rule exists so every document the founder reads looks like it
 * came from the same place. The catalogue's own descriptions carry them,
 * so the strip happens here rather than upstream.
 */
const text = lines.join("\n").replace(/\s*\u2014\s*/g, ", ").replace(/,\s*,/g, ",");
assertNoSecrets(text);
writeFileSync(OUT, text, "utf8");

console.log(`✅ Wrote RAILWAY-VARIABLES-PASTE.txt — ${seen.size} names, generated from the catalogue.`);
