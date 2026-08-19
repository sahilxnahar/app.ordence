/**
 * Ordence — ENTITLEMENT-AWARE NAVIGATION
 * Version: v0.53.0 · Section B of the client-onboarding architecture
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FIXES
 * ══════════════════════════════════════════════════════════════════════
 * Until now the sidebar was filtered by ROLE and by nothing else. A
 * workspace on the Basic plan saw every menu item in the product,
 * including the ones it had not bought, and found out by clicking.
 *
 * That is a bad experience twice over. It advertises to a paying
 * customer that they are being shown a locked door, and it buries the
 * five screens they actually use among thirty they cannot open.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ HIDE, DO NOT GREY OUT
 * ══════════════════════════════════════════════════════════════════════
 * The item is REMOVED, not disabled. A greyed-out menu is a permanent
 * advertisement sitting in the customer's peripheral vision every day
 * they use the product — it makes a workspace feel like a demo of a
 * bigger product rather than a tool that fits.
 *
 * The upsell belongs where somebody is already thinking about the
 * capability: on the pricing page, and on the locked screen if they do
 * reach it by URL. Not in the furniture.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND AN EMPTY SECTION DISAPPEARS ENTIRELY
 * ══════════════════════════════════════════════════════════════════════
 * A heading with nothing under it is worse than either state: it says
 * "there is something here" and then does not deliver. `filterNavigation
 * ByRole` already drops empty sections and this keeps that property.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A SECURITY BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * Same warning as the registry, restated because this is the file where
 * it is easiest to forget: removing a link removes a link. The route
 * still has to refuse. Every gated page calls `requireFeature()` server
 * side and that does not change.
 */

import type { NavSection } from "@/lib/industry-templates";
import { moduleForNavId } from "./registry";

/* ------------------------------------------------------------------ */

export type NavFilterOptions = {
  /**
   * Show modules whose route does not exist yet. Off by default.
   *
   * Exists for one purpose: a staging build where you want to see the
   * whole intended menu. Never true in production — seven of these
   * render a 404.
   */
  includeComingSoon?: boolean;
};

/**
 * Filter navigation down to what this workspace has actually bought.
 *
 * @param sections  Already role-filtered, from `filterNavigationByRole`.
 * @param allowed   Feature key → boolean, from `checkFeatures()`.
 *
 * ⚠️ ORDER OF THE TWO FILTERS IS DELIBERATE. Role runs first, so this
 * never even considers items the person could not see anyway — and a
 * missing entitlement can therefore never be the reason an admin-only
 * item appears to a member.
 */
export function filterNavigationByEntitlement(
  sections: readonly NavSection[],
  allowed: Readonly<Record<string, boolean>>,
  options: NavFilterOptions = {},
): NavSection[] {
  const includeComingSoon = options.includeComingSoon ?? false;

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const mod = moduleForNavId(item.id);

        /**
         * ⚠️ UNKNOWN ID → KEEP IT. FAIL OPEN, ON PURPOSE.
         *
         * This is the one place in the codebase that fails open, and the
         * reasoning is specific to it. If somebody adds a menu entry and
         * forgets the registry, the two possible failures are:
         *
         *   fail closed → the item silently vanishes from every
         *                 customer's menu, and the developer's own
         *                 testing shows nothing wrong because they were
         *                 looking at the code, not the sidebar;
         *   fail open   → the item appears for everyone, which is the
         *                 status quo before this file existed, and the
         *                 route's own `requireFeature()` still refuses.
         *
         * The second is strictly less bad. And it is not the real
         * defence: `tests/ui/module-registry.test.tsx` fails the build
         * when a nav id is missing from the registry, so this branch
         * should be unreachable in a shipped build.
         */
        if (!mod) return true;

        // Named, but there is nothing behind the link yet.
        if (mod.status !== "live" && !includeComingSoon) return false;

        // Part of what a workspace is, rather than something sold.
        if (mod.feature === null) return true;

        /**
         * ⚠️ `=== true`, not truthiness.
         *
         * `allowed` comes from `checkFeatures()` over the keys the
         * registry asked for. A key missing from that record yields
         * `undefined`, which means "nobody asked about this" — not
         * "granted". Treating undefined as allowed would hand out any
         * feature whose key was mistyped in the registry.
         */
        return allowed[mod.feature] === true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * What the filter removed, and why.
 *
 * Not used to render anything. It exists because "the customer says a
 * menu item is missing" is a support question that otherwise requires
 * reading three files and guessing, and because a per-tenant view of it
 * belongs in the admin console (Section C).
 */
export function explainHiddenNavItems(
  sections: readonly NavSection[],
  allowed: Readonly<Record<string, boolean>>,
): Array<{ navId: string; label: string; reason: string }> {
  const hidden: Array<{ navId: string; label: string; reason: string }> = [];

  for (const section of sections) {
    for (const item of section.items) {
      const mod = moduleForNavId(item.id);

      if (!mod) {
        hidden.push({
          navId: item.id,
          label: item.label,
          reason: "not in the module registry — shown by default",
        });
        continue;
      }
      if (mod.status !== "live") {
        hidden.push({
          navId: item.id,
          label: item.label,
          reason: `not built yet (${mod.status}) — ${mod.href} does not exist`,
        });
        continue;
      }
      if (mod.feature && allowed[mod.feature] !== true) {
        hidden.push({
          navId: item.id,
          label: item.label,
          reason: `plan does not include "${mod.feature}"`,
        });
      }
    }
  }

  return hidden;
}
