/**
 * Ordence — When to show the branding screen unasked
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS DECISION IS A PURE FUNCTION IN `lib/` AND NOT AN `if` IN A
 * LAYOUT
 * ══════════════════════════════════════════════════════════════════════
 * "Send the owner to the branding screen the first time they sign in" is
 * one sentence and four ways to trap a user in a redirect loop. Keeping
 * the rule here means it can be exercised against every combination of
 * role, stored branding and destination without a browser, and means the
 * mount point in `app/(crm)/dashboard/page.tsx` is one line that a
 * reviewer can read in full.
 *
 * 🔴 THE THREE REFUSALS, EACH OF WHICH IS A REAL FAILURE:
 *
 *   · NOT AN OWNER — a member sent to a screen they have no permission to
 *     submit is a dead end. `updateBranding` requires `settings:update`;
 *     anyone who cannot pass it must never be routed here.
 *   · ALREADY DECIDED — `setupCompletedAt` is set by saving OR by
 *     skipping. Both are decisions and both end the prompt for good.
 *   · ALREADY BRANDED — a workspace provisioned with a Clerk
 *     organisation image has a logo before anybody signs in. Prompting
 *     for one it already has reads as the product not looking.
 */

import { parseBranding } from "./schema";

/** The roles that may change the workspace's letterhead. */
const OWNER_ROLES = ["tenant_owner", "tenant_admin"] as const;

export function shouldPromptBrandingSetup(args: {
  branding: unknown;
  role: string;
}): boolean {
  if (!(OWNER_ROLES as readonly string[]).includes(args.role)) return false;

  const branding = parseBranding(args.branding);
  if (typeof branding.setupCompletedAt === "number") return false;
  if (branding.logoKey) return false;

  return true;
}

/** Where they are sent. `first-run` is what the screen reads to change its copy. */
export const BRANDING_SETUP_PATH = "/settings/branding?first-run=1";
