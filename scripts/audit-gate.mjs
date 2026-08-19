#!/usr/bin/env node
/**
 * Ordence — Production dependency audit gate
 * Version: v0.67.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN `npm audit --audit-level=high`
 * ══════════════════════════════════════════════════════════════════════
 * The plain command has exactly two settings: fail on everything at this
 * level, or do not run. Neither is usable here.
 *
 * Today `npm audit --omit=dev --audit-level=high` exits 1 on three
 * advisories, all of them inside dependencies that Next.js BUNDLES:
 * `postcss` (build-time only) and `sharp` (the image optimiser, which
 * this deployment does not invoke on Cloudflare). The only offered
 * remedy is `next@16`, a major upgrade.
 *
 * So the gate is red, permanently, for reasons nobody can act on this
 * week. A permanently-red gate is not a strict gate — it is a gate
 * everyone learns to skip, and the day a REAL advisory lands in a real
 * dependency it arrives on a job that was already failing. That is
 * strictly worse than no gate.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES INSTEAD
 * ══════════════════════════════════════════════════════════════════════
 * Every high or critical advisory fails the build UNLESS it appears in
 * `EXCEPTIONS` below with:
 *
 *   - the advisory id, so the exception cannot silently widen
 *   - a written reason
 *   - an EXPIRES date
 *
 * ⚠️ THE EXPIRY IS THE MECHANISM. An exception without one is a
 * permanent silence with a comment attached; nobody ever revisits it.
 * Past its date the exception stops applying and the build goes red on
 * its own, which forces the decision to be made again by someone who
 * has to look at it.
 *
 * ⚠️ EXCEPTIONS ARE MATCHED BY GHSA ID, NOT BY PACKAGE NAME. Excepting
 * "sharp" would also except the next, unrelated, genuinely exploitable
 * sharp advisory. The id is the narrowest thing that identifies the
 * risk actually accepted.
 *
 * Anything not listed — any new advisory, any severity escalation, any
 * advisory in a package we depend on directly — fails immediately.
 */

import { execFileSync } from "node:child_process";

/**
 * Accepted risks. Each entry is a decision someone made, in writing,
 * with a date it stops being valid.
 */
const EXCEPTIONS = [
  {
    id: "GHSA-qx2v-qp2m-jg93",
    package: "postcss",
    expires: "2026-12-31",
    reason:
      "postcss is bundled inside next and runs at BUILD time only. The XSS " +
      "requires attacker-controlled CSS reaching the stringifier; all CSS in " +
      "this project is authored in-repo. Fix requires next@16 (breaking).",
  },
  {
    id: "GHSA-6g55-p6wh-862q",
    package: "postcss",
    expires: "2026-12-31",
    reason: "Same bundled build-time postcss. Requires an attacker-supplied sourceMappingURL in a CSS comment; no third-party CSS is compiled.",
  },
  {
    id: "GHSA-r28c-9q8g-f849",
    package: "postcss",
    expires: "2026-12-31",
    reason: "Same bundled build-time postcss, same sourceMappingURL vector.",
  },
  {
    id: "GHSA-fxqj-rqcc-2cmp",
    package: "postcss",
    expires: "2026-12-31",
    reason: "Same bundled build-time postcss; incomplete fix of GHSA-6g55-p6wh-862q.",
  },
  {
    id: "GHSA-f88m-g3jw-g9cj",
    package: "sharp",
    // ⚠️ SHORTENED TO 2026-09-30, AND THE REASON IT WAS ACCEPTED IS GONE.
    //
    // This exception used to read: "runs on Cloudflare Workers via
    // @opennextjs/cloudflare, where the Node image optimiser is not used,
    // so libvips never processes a user image."
    //
    // That was true and is no longer. On Railway the app runs on Node,
    // `next/image` optimisation runs IN PROCESS, and libvips does process
    // images. The advisory now applies to this deployment.
    //
    // Left as an exception rather than made a hard failure only because
    // the fix is `next@16` and nothing should break a platform migration
    // that is already in flight. The date is deliberately close: this has
    // to be revisited, not inherited.
    expires: "2026-09-30",
    reason:
      "sharp is bundled inside next for the image optimiser. ⚠️ ON RAILWAY " +
      "THE NODE IMAGE OPTIMISER IS ACTIVE, so this advisory applies — it did " +
      "not on Cloudflare Workers. Mitigated for now because next/image is " +
      "used only on first-party assets, not on user uploads. Fix requires " +
      "next@16 (breaking). Revisit by the expiry, do not extend by habit.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero WHEN IT FINDS SOMETHING. That is the normal
    // path here, not an error — the JSON is still on stdout.
    if (err && typeof err.stdout === "string" && err.stdout.length > 0) {
      return err.stdout;
    }
    throw err;
  }
}

function main() {
  const report = JSON.parse(runAudit());
  const vulns = report.vulnerabilities ?? {};

  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map(EXCEPTIONS.map((e) => [e.id, e]));

  /** Advisories that must fail the build. */
  const blocking = [];
  /** Advisories silenced by a live exception. */
  const accepted = [];
  /** Exceptions whose date has passed — these fail too. */
  const stale = [];

  for (const [name, entry] of Object.entries(vulns)) {
    for (const via of entry.via ?? []) {
      // A string `via` is an indirection to another package, not an advisory.
      if (typeof via === "string") continue;
      if (!BLOCKING.has(via.severity)) continue;

      const id = ghsaFrom(via.url);
      const exception = id ? byId.get(id) : undefined;

      if (!exception) {
        blocking.push({ name, id: id ?? "(no id)", severity: via.severity, title: via.title });
        continue;
      }
      if (exception.expires < today) {
        stale.push({ ...exception, severity: via.severity, title: via.title });
        continue;
      }
      accepted.push({ ...exception, severity: via.severity, title: via.title });
    }
  }

  for (const a of dedupe(accepted)) {
    console.log(`⚠️  accepted until ${a.expires}  ${a.severity.padEnd(8)} ${a.package}  ${a.id}`);
    console.log(`    ${a.reason}`);
  }

  for (const s of dedupe(stale)) {
    console.log(`::error::EXPIRED exception ${s.id} (${s.package}) — it expired on ${s.expires}. Re-decide it or fix the dependency.`);
  }

  for (const b of dedupe(blocking)) {
    console.log(`::error::${b.severity.toUpperCase()} advisory with no accepted exception: ${b.name} ${b.id} — ${b.title}`);
  }

  const failures = dedupe(stale).length + dedupe(blocking).length;

  if (failures > 0) {
    console.error(`\n❌ ${failures} production advisory/advisories are not covered by a live exception.`);
    process.exit(1);
  }

  console.log(
    `\n✅ No unaccepted high/critical advisories in production dependencies ` +
      `(${dedupe(accepted).length} accepted, each with a written reason and an expiry).`,
  );
}

function ghsaFrom(url) {
  if (typeof url !== "string") return undefined;
  const m = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : undefined;
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.id ?? r.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

main();
