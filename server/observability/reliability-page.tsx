import "server-only";

/**
 * Ordence — Platform Console · ⭐⭐⭐ RELIABILITY (SLOs, budgets, evidence)
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE PAGE BODY IS IN `server/` AND NOT IN `app/`
 * ══════════════════════════════════════════════════════════════════════
 * Track B's brief assigns `app/(platform)/admin/health/**` and asks for a
 * status surface "at admin/health". That block CANNOT LEGALLY CONTAIN A
 * SINGLE FILE, and this was established by running the suite rather than
 * by reading anything:
 *
 *     tests/security/route-audit.test.ts
 *     › no page or route file under any forbidden URL segment
 *     AssertionError: expected [ 'admin' ] to deeply equal []
 *
 * That Wave-7 test walks every directory under `app/` — **including
 * inside route groups, which it says so in its own comment** — and fails
 * on any segment named `admin`, `debug`, `console` or `test`. Its header
 * states the reason: "Ordence has ONE cross-tenant surface — the platform
 * console under `/platform`, gated by the middleware's platform-staff
 * matcher — and any addition must go through that gate deliberately."
 *
 * Three further facts make the assigned path wrong rather than merely
 * awkward:
 *
 *   • There is no `(platform)` route group in this repository. The
 *     console is a plain segment at `app/platform/`, and on `admin.<zone>`
 *     the middleware rewrites `/x` → `/platform/x`.
 *   • `app/platform/health/page.tsx` ALREADY EXISTS and is a different
 *     screen — account-health events per workspace. It must not be
 *     replaced by an SLO page.
 *   • A page at `/admin/health` would inherit the ROOT layout, which
 *     guards nothing, and would be linked from nowhere. Built and
 *     unreachable: this codebase's signature defect, produced by
 *     following the brief exactly.
 *
 * ⭐ SO THE WHOLE SURFACE LIVES HERE, IN A DIRECTORY TRACK B DOES OWN,
 * and `PATCH-REQUEST-B.md` carries three three-line files that mount it
 * at `/platform/reliability` plus one line of console navigation. Every
 * runbook in this track already points at `/platform/reliability`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT GUARDS ITSELF, WHEREVER IT IS MOUNTED
 * ══════════════════════════════════════════════════════════════════════
 * `app/platform/layout.tsx` refuses non-staff with `notFound()`, and its
 * own header argues that a page relying on its parent's check is the one
 * piece not re-checking. It is right, so this calls
 * `requireCapability("observatory:read")` itself and fails closed.
 *
 * ⚠️ `notFound()`, NOT `redirect("/access-denied")`. A 404 tells a prober
 * nothing about whether this console exists; a bespoke denial page
 * confirms it does and that they were close.
 */

import { notFound } from "next/navigation";

import { requireCapability } from "@/server/platform/guard";
import { getHealthSnapshot } from "@/server/observability/health";
import { getCostReport } from "@/server/observability/cost";
import { sweepObservability } from "@/server/observability/runtime";
import { summariseStream } from "@/server/security/siem";
import { acknowledgeAlertAction, commitSiemExportAction } from "./reliability-actions";
import { HealthView } from "./reliability-view";

/**
 * ⚠️ `dynamic` AND `metadata` ARE EXPORTED FROM THE ROUTE FILE, NOT FROM
 * HERE. Next.js reads those two only from a file it recognises as a
 * segment; exported from a module the route imports, they are inert — and
 * an inert `force-dynamic` on a page that reads across every workspace
 * would be a cached cross-tenant aggregate. The route file in
 * PATCH-REQUEST-B.md carries both, and says so.
 */

/**
 * ⚠️ THIN WRAPPERS THAT RETURN `void`.
 *
 * A `<form action={fn}>` in the App Router requires `(formData) => void |
 * Promise<void>`; the guarded implementations in `./actions` return a
 * result envelope because they are also callable directly. Nothing is
 * decided here — both re-authorise themselves — and the result is
 * deliberately discarded rather than surfaced, because the page
 * re-renders from the database immediately afterwards and a stale
 * in-memory success message is a message that can disagree with the row
 * it claims to describe.
 */
async function acknowledge(formData: FormData): Promise<void> {
  "use server";
  await acknowledgeAlertAction(formData);
}

async function commitExport(formData: FormData): Promise<void> {
  "use server";
  await commitSiemExportAction(formData);
}

export async function ReliabilityPage() {
  /**
   * ⚠️ FIRST STATEMENT IN THE FUNCTION. Every read below is
   * platform-scoped and crosses every workspace; a guard placed after a
   * fetch is a guard that runs after the data has been read.
   */
  try {
    await requireCapability("observatory:read");
  } catch {
    notFound();
  }

  /**
   * ⭐ THE SWEEP RUNS ON READ, AND `app/platform/health/page.tsx` ALREADY
   * ARGUES WHY: "A cron would be tidier and would also leave this screen
   * silently empty on the morning the scheduler is the thing that broke."
   *
   * There is a second reason here. Until Track A's scheduler lands, a
   * sweep only a cron could call would be a function with no callers —
   * which is the defect this entire track was commissioned to fix.
   *
   * ⚠️ IT IS SAFE TO CALL ON EVERY RENDER. The per-key window in
   * `observability_alerts` means ten operators opening this page in the
   * same minute produce one message, not ten, and the suppressed raises
   * are counted rather than dropped.
   */
  const sweep = await sweepObservability();

  /**
   * ⚠️ SEQUENTIAL, NOT `Promise.all`. Each of these opens its own
   * transaction on the shared pool; four at once on a Neon Free plan
   * spends four of a very small connection budget to save a few hundred
   * milliseconds on an operator screen. `app/platform/access-review`
   * parallelises because its three reads are small; these are aggregates
   * over the largest table in the product.
   */
  const snapshot = await getHealthSnapshot({ windowDays: 30 });
  const cost = await getCostReport({ windowDays: 30 });
  const stream = await summariseStream(30);

  return (
    <HealthView
      snapshot={snapshot}
      cost={cost}
      stream={stream}
      sweep={sweep}
      onAcknowledge={acknowledge}
      onCommitExport={commitExport}
    />
  );
}
