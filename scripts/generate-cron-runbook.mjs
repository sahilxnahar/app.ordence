#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ THE CRON RUNBOOK, GENERATED
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY IT IS GENERATED
 * ══════════════════════════════════════════════════════════════════════
 * A runbook that names six jobs while the code registers seven is a
 * runbook that guarantees the seventh never runs, and nothing would ever
 * say so — which is the whole shape of the defect this batch exists to
 * fix, reproduced in a markdown file.
 *
 * `server/scheduling/registry.ts` carries the id, the schedule, the
 * consequence and the idempotency argument for each job as DATA. This
 * script turns that data into `docs/current/CRON-RUNBOOK.md`, and
 * `tests/ui/scheduled-jobs.test.ts` fails when the committed document no
 * longer matches what this would emit.
 *
 * ⚠️ THE PROSE SECTIONS ARE NOT GENERATED. Everything a scheduler cannot
 * know — how to attach a scheduler to Railway at all, what "red" means,
 * why the canary is allowed to be red — is written by hand below and
 * carried through verbatim. The generated part is the table of jobs and
 * the exact call for each.
 *
 * ⚠️ NO EM-DASHES. House rule for owner-facing documents. Enforced by the
 * final substitution rather than by remembering.
 *
 * Run: node scripts/generate-cron-runbook.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "docs", "current", "CRON-RUNBOOK.md");

/* ------------------------------------------------------------------ */
/* THE REGISTRY, PARSED FROM SOURCE                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Parsed, not imported, for the same reason as the catalogue gate: a
 * `.mjs` script cannot import a `.ts` module. The parse is deliberately
 * strict about the fields it needs and LOUD when a job is missing one,
 * because a job whose `consequenceWhenStopped` is blank produces a
 * runbook row that says nothing, and a row that says nothing is a row
 * nobody acts on.
 */
function jobs() {
  const source = readFileSync(
    join(ROOT, "server", "scheduling", "registry.ts"),
    "utf8",
  );
  const body = source.slice(source.indexOf("export const SCHEDULED_JOBS"));

  /**
   * ⚠️ SPLIT ON THE `id:` LINE, NOT ON `{`. An object-brace split breaks
   * the first time somebody nests an object literal in a job, which is
   * exactly the kind of silent-by-refactor failure this file is meant to
   * prevent. Every job has exactly one `    id: "…"` line at that indent.
   */
  const marker = /\n    id:\s*"([a-z0-9_]+)",/g;
  const starts = [];
  let m;
  while ((m = marker.exec(body)) !== null) {
    starts.push({ id: m[1], at: m.index });
  }

  return starts.map((start, i) => {
    const block = body.slice(start.at, starts[i + 1]?.at ?? body.length);
    /**
     * ⚠️ MULTI-LINE STRING LITERALS. `consequenceWhenStopped` is a
     * paragraph and Prettier puts it on its own line under the key, so the
     * value may begin on the line after the colon.
     */
    const str = (field) => {
      const re = new RegExp(`\\n\\s*${field}:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const hit = re.exec(block);
      return hit ? hit[1].replace(/\\"/g, '"').replace(/\\n/g, " ") : null;
    };
    const featureHit = /\n\s*feature:\s*(null|"[^"]*")/.exec(block);
    return {
      id: start.id,
      scope: str("scope"),
      label: str("label"),
      feature:
        featureHit && featureHit[1] !== "null" ? featureHit[1].slice(1, -1) : null,
      ungatedBecause: str("ungatedBecause"),
      consequenceWhenStopped: str("consequenceWhenStopped"),
      cronUtc: str("cronUtc"),
      cadenceInIst: str("cadenceInIst"),
      idempotency: str("idempotency"),
    };
  });
}

const REQUIRED_FIELDS = [
  "scope",
  "label",
  "consequenceWhenStopped",
  "cronUtc",
  "cadenceInIst",
  "idempotency",
];

export function buildRunbook() {
  const list = jobs();

  if (list.length === 0) {
    throw new Error(
      "Parsed zero jobs out of server/scheduling/registry.ts. The parse has broken; " +
        "refusing to emit a runbook that says this deployment has no scheduled work.",
    );
  }

  for (const job of list) {
    /**
     * 🔴 AN UNGATED PER-TENANT JOB MUST SAY WHY. Without this the runbook
     * would print a blank entitlement column, and "none" reads as an
     * oversight rather than as a decision somebody made.
     */
    if (job.scope === "per-tenant" && !job.feature && !job.ungatedBecause) {
      throw new Error(
        `Job "${job.id}" is per-tenant with no entitlement key and no ungatedBecause. ` +
          `A scheduled job delivering a paid capability to a workspace that has not paid ` +
          `for it is invisible: no screen shows what a cron did.`,
      );
    }
    for (const field of REQUIRED_FIELDS) {
      if (!job[field]) {
        throw new Error(
          `Job "${job.id}" has no ${field}. Every registered job must say when it runs, ` +
            `what stops working when it does not, and why running it twice is safe. ` +
            `A runbook row with a blank consequence is a red tick nobody gets out of bed for.`,
        );
      }
    }
  }

  const L = [];
  L.push("# Ordence, the scheduled work and how to make it run");
  L.push("");
  L.push("**Repo: `app.ordence`. No SQL. Code push only, in any order.**");
  L.push("");
  L.push("GENERATED from `server/scheduling/registry.ts` by");
  L.push("`scripts/generate-cron-runbook.mjs`. Do not edit by hand;");
  L.push("`npx vitest run --project=ui` compares the two.");
  L.push("");
  L.push("## The thing to understand first");
  L.push("");
  L.push("Railway runs ONE service for Ordence and that service has no");
  L.push("scheduler attached to it. Until something calls the endpoints");
  L.push("below on a clock, every job in this document does not run, and");
  L.push("nothing in the product says so: the screens keep working, the");
  L.push("collections board keeps showing what it showed yesterday, and the");
  L.push("customer keeps not receiving the reminder.");
  L.push("");
  L.push("Railway's own cron feature RESTARTS A SERVICE on a schedule. That");
  L.push("is the wrong shape for a web service that never exits, so do not");
  L.push("attach it to `app.ordence` itself. Two options that work:");
  L.push("");
  L.push("**Option A, a second Railway service.** Same repository, same");
  L.push("project, a Cron Schedule set on it, and a start command that");
  L.push("POSTs and exits. It shares the project's variables, so");
  L.push("`WORKER_API_SECRET` is already there.");
  L.push("");
  L.push("**Option B, an external scheduler.** cron-job.org, GitHub Actions,");
  L.push("Upstash QStash. `/api/workers` already verifies a QStash signature");
  L.push("if you would rather not hold a bearer token in a third party.");
  L.push("");
  L.push("Option A keeps the secret inside Railway and is the recommendation.");
  L.push("");
  L.push("## Before any of it works");
  L.push("");
  L.push("`WORKER_API_SECRET` must be set in Railway. Generate it on your own");
  L.push("machine and paste only into Railway:");
  L.push("");
  L.push("```");
  L.push("openssl rand -hex 32");
  L.push("```");
  L.push("");
  L.push("With no secret configured `/api/workers` answers **503** and");
  L.push("refuses to run anything. That is deliberate. An unauthenticated");
  L.push("worker endpoint is worse than no worker endpoint: it would let a");
  L.push("stranger drive background work against any workspace.");
  L.push("");
  L.push("Check what the deployment thinks it has:");
  L.push("");
  L.push("```bash");
  L.push('curl -fsS -H "Authorization: Bearer $WORKER_API_SECRET" \\');
  L.push("  https://app.ordence.com/api/workers");
  L.push("```");
  L.push("");
  L.push("That lists every job below, straight out of the running code. If");
  L.push("this document and that response ever disagree, the response is");
  L.push("right.");
  L.push("");
  L.push("## The jobs");
  L.push("");
  L.push("Every call is the same shape. Only `jobId` changes.");
  L.push("");
  L.push("```bash");
  L.push("curl -fsS -X POST https://app.ordence.com/api/workers \\");
  L.push('  -H "Authorization: Bearer $WORKER_API_SECRET" \\');
  L.push('  -H "Content-Type: application/json" \\');
  L.push('  -d \'{"mode":"scheduled","jobId":"dunning_sweep"}\'');
  L.push("```");
  L.push("");
  L.push("**`-f` is not optional.** Without it `curl` exits 0 on an HTTP 500,");
  L.push("so a run in which every workspace failed reports green to whatever");
  L.push("is watching. With it, a partial failure is a non-zero exit and a");
  L.push("red tick.");
  L.push("");
  L.push("| Job id | Runs | Cron (UTC) | In IST | Entitlement |");
  L.push("|---|---|---|---|---|");
  for (const job of list) {
    const entitlement = job.feature
      ? `\`${job.feature}\``
      : job.scope === "platform"
        ? "platform, not a customer plan"
        : "none, deliberately";
    L.push(
      `| \`${job.id}\` | ${job.label} | \`${job.cronUtc}\` | ${job.cadenceInIst} | ${entitlement} |`,
    );
  }
  L.push("");
  L.push("Cron expressions are UTC because every scheduler is. India is");
  L.push("UTC+5:30, so `30 19 * * *` is 01:00 the next morning in Bengaluru.");
  L.push("");

  for (const job of list) {
    L.push(`### \`${job.id}\`, ${job.label}`);
    L.push("");
    L.push(`Scope: ${job.scope === "platform" ? "the whole platform, one run" : "every entitled workspace"}.`);
    L.push("");
    L.push("```bash");
    L.push("curl -fsS -X POST https://app.ordence.com/api/workers \\");
    L.push('  -H "Authorization: Bearer $WORKER_API_SECRET" \\');
    L.push('  -H "Content-Type: application/json" \\');
    L.push(`  -d '{"mode":"scheduled","jobId":"${job.id}"}'`);
    L.push("```");
    L.push("");
    L.push(`**Schedule:** \`${job.cronUtc}\` UTC, which is ${job.cadenceInIst}.`);
    L.push("");
    L.push("**What a red tick means:** " + job.consequenceWhenStopped);
    L.push("");
    L.push("**Why running it twice is safe:** " + job.idempotency);
    L.push("");
    if (!job.feature && job.scope !== "platform") {
      L.push("**Runs for every workspace regardless of plan:** " + job.ungatedBecause);
      L.push("");
    }
  }

  L.push("## Reading a response");
  L.push("");
  L.push("```json");
  L.push("{");
  L.push('  "ok": true,');
  L.push('  "jobId": "dunning_sweep",');
  L.push('  "tenantsConsidered": 12,');
  L.push('  "tenantsRun": 9,');
  L.push('  "tenantsSkipped": 3,');
  L.push('  "tenantsFailed": 0,');
  L.push('  "notReached": 0');
  L.push("}");
  L.push("```");
  L.push("");
  L.push("`tenantsSkipped` is not a failure. A workspace whose plan does not");
  L.push("include the capability is skipped on purpose, and each skipped row");
  L.push("says which entitlement it was.");
  L.push("");
  L.push("`notReached` is the one to watch. The endpoint runs at most 500");
  L.push("workspaces per call. If there are more, the extra ones are counted");
  L.push("here and `ok` is **false**, so the run goes red rather than");
  L.push("reporting that it swept everything. When that number stops being");
  L.push("zero, either raise `MAX_TENANTS_PER_JOB` or split the schedule.");
  L.push("");
  L.push("`tenantsFailed` above zero also makes `ok` false, and each failed");
  L.push("row carries its own error. One broken workspace does not stop the");
  L.push("others: the loop carries on and reports.");
  L.push("");
  L.push("## Re-running one workspace");
  L.push("");
  L.push("```bash");
  L.push("curl -fsS -X POST https://app.ordence.com/api/workers \\");
  L.push('  -H "Authorization: Bearer $WORKER_API_SECRET" \\');
  L.push('  -H "Content-Type: application/json" \\');
  L.push('  -d \'{"mode":"scheduled","jobId":"dunning_sweep","tenantId":"<uuid>"}\'');
  L.push("```");
  L.push("");
  L.push("Safe at any time. Every job in the table is idempotent, and the");
  L.push("reason is written against each one above.");
  L.push("");
  L.push("## The two endpoints that were already there");
  L.push("");
  L.push("### `/api/workers` with `{\"mode\":\"cron\"}`");
  L.push("");
  L.push("The original nightly sweep. It enqueues a contract-expiry scan per");
  L.push("workspace and drains the mail outbox. Keep it if you are already");
  L.push("running it; the `mail_drain` job above does the outbox half on its");
  L.push("own hourly schedule, and running both is harmless because the");
  L.push("outbox claim is atomic.");
  L.push("");
  L.push("### `/api/cron/canary`, the isolation probe");
  L.push("");
  L.push("```bash");
  L.push("curl -fsS -X POST https://app.ordence.com/api/cron/canary \\");
  L.push('  -H "Authorization: Bearer $CRON_SECRET"');
  L.push("```");
  L.push("");
  L.push("Suggested schedule: `0 * * * *`, hourly.");
  L.push("");
  L.push("**This one uses `CRON_SECRET`, not `WORKER_API_SECRET`.** It is a");
  L.push("different secret on purpose: the canary's response names real");
  L.push("workspace ids, and it should not be reachable with the token that");
  L.push("a cron runner holds for everything else.");
  L.push("");
  L.push("Three answers, and only one of them is green:");
  L.push("");
  L.push("- **200** a real cross-tenant read was attempted and returned");
  L.push("  nothing, on a connection that could not have bypassed row-level");
  L.push("  security. This is the expected answer today: production connects");
  L.push("  as `ordence_app` with `rolbypassrls = f`.");
  L.push("- **500** it returned something. This is a P0. Every workspace can");
  L.push("  potentially read every other workspace's data.");
  L.push("- **503** the probe could not put itself in a position to prove");
  L.push("  anything. **This is not green.** It is what you get when the");
  L.push("  database role bypasses row-level security, and the fix is the");
  L.push("  role in `DATABASE_URL`, never a setting that downgrades this to");
  L.push("  a 200.");
  L.push("");
  L.push("A green tick from a connection that bypasses row-level security is");
  L.push("the worst outcome available here. It is believed, and it is");
  L.push("evidence of nothing.");
  L.push("");
  L.push("## What is still not wired");
  L.push("");
  L.push("`sendDunningNotice` in `server/actions/receivables.ts` sends one");
  L.push("rung of a RERA statutory demand ladder, and nothing calls it. It is");
  L.push("deliberately NOT on a schedule: the permission depends on the rung,");
  L.push("and a cancellation warning needs a key the accountant who does");
  L.push("every other collections task does not hold, because that letter");
  L.push("precedes terminating an allotment and forfeiting what a family has");
  L.push("paid towards a home. A cron holds no permission at all, so putting");
  L.push("it on a clock would not be running it as somebody with the right;");
  L.push("it would be removing the right from the design.");
  L.push("");
  L.push("The `rera_dunning_plan` job above reports which notices have come");
  L.push("due. Acting on that report needs a screen, and that screen does not");
  L.push("exist yet.");
  L.push("");

  /**
   * ⚠️ EM-DASHES OUT, last. House rule for owner-facing documents.
   */
  return L.join("\n").replace(/\s*—\s*/g, ", ").replace(/,\s*,/g, ",") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = buildRunbook();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, "utf8");
  console.log(`✅ Wrote docs/current/CRON-RUNBOOK.md — ${jobs().length} jobs.`);
}
