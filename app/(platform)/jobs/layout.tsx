import { notFound } from "next/navigation";
import { getPlatformOperator } from "@/server/platform/guard";

/**
 * Ordence — 🔴 THE GATE ON THE JOBS CONSOLE, IN THE PAGE, BECAUSE
 *              MIDDLEWARE DOES NOT COVER THIS PATH
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 READ THIS BEFORE MOVING OR COPYING THIS PAGE — AND BEFORE PUTTING
 *    IT BACK WHERE THE BRIEF ASKED FOR IT
 * ══════════════════════════════════════════════════════════════════════
 * Track A's brief named `app/(platform)/admin/jobs/**` as the control
 * surface. That path cannot be used, and the repository says so itself:
 *
 *   `tests/security/route-audit.test.ts:50` —
 *       const FORBIDDEN_NAMES = new Set(["admin", "debug", "console", "test"]);
 *
 * It walks every directory under `app/` and fails if any URL segment has
 * one of those names, with a written rationale: no default admin route
 * should exist to be probed at all. A route group in parentheses is
 * invisible to that walk; a literal directory named `admin` is not. So
 * `app/(platform)/admin/jobs/` turns that test red — verified by running
 * it, not by reading it.
 *
 * This directory is therefore `app/(platform)/jobs/`, one segment away
 * from the brief's path, inside the `(platform)` group it named. The
 * deviation and its evidence are the first item in TRACK-REPORT.md
 * section 4 and in PATCH-REQUEST-A.md.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE PAGE STILL HAS TO GATE ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * A Next.js route group in parentheses is STRIPPED FROM THE URL, so this
 * file serves at `/jobs` — not under `/platform`. Three things follow,
 * all verified against `middleware.ts` at v1.81.0-alpha rather than
 * assumed:
 *
 *   1. `middleware.ts:259` gates platform routes with
 *      `createRouteMatcher(["/platform(.*)"])`. `/jobs` does not match,
 *      so the middleware-level platform gate does not apply. Without the
 *      check below this would be an ordinary authenticated route — every
 *      signed-in user of every workspace would reach it.
 *
 *   2. `middleware.ts:882` rewrites anything on the console host that
 *      does not start with `/platform` or `/api` to `/platform<path>`.
 *      So on `admin.ordence.com` this rewrites to `/platform/jobs`,
 *      which does not exist, and answers 404.
 *
 *   3. `app/platform/layout.tsx` — the console chrome, nav and second
 *      gate — does not wrap a `(platform)` route group.
 *
 * ⚠️ SO THIS LAYOUT IS THE ONLY GATE THIS PAGE HAS, and it is written to
 * be sufficient on its own rather than as a second layer. It repeats what
 * `app/platform/layout.tsx` does: `getPlatformOperator()`, which requires
 * BOTH a Clerk-verified primary email in `PLATFORM_ADMIN_EMAILS` AND an
 * active `platform_staff` row, and `notFound()` — a 404, not a redirect,
 * because a host that does not serve the console should not confirm the
 * console exists.
 *
 * `PATCH-REQUEST-A.md` item 1 asks for the three-line change that moves
 * this to `/platform/jobs` with the middleware gate, the console chrome
 * and a nav entry. Shipping it without this file would have been instance
 * twenty-four of "built and unreachable, declared and unenforced".
 */
export const dynamic = "force-dynamic";

export default async function AdminJobsLayout({ children }: { children: React.ReactNode }) {
  const operator = await getPlatformOperator();

  /**
   * 🔴 `notFound()`, NOT `redirect("/")`. A redirect tells an
   * unauthorised caller that the path is real and that they are the
   * problem. A 404 tells them nothing, which is what
   * `app/platform/layout.tsx` already decided and why.
   */
  if (!operator) notFound();

  return <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">{children}</div>;
}
