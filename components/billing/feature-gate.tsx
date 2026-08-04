/**
 * Ordence — Feature Gate UI
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE: NEVER HIDE SOMEONE'S DATA
 * ══════════════════════════════════════════════════════════════════════
 * When a workspace loses a feature — a downgrade, an expired card — their
 * RECORDS ARE STILL THERE. Their contracts, their ledger, their
 * documents.
 *
 * The tempting implementation is to render nothing, or to redirect to a
 * pricing page. Both are wrong, and wrong in an expensive way: the
 * customer concludes their data has been deleted, at exactly the moment
 * we are asking them to give us money. It reads as punitive and it reads
 * as unreliable, and it converts a lapsed card into a churn event.
 *
 * So this component has two modes and the DEFAULT is the gentle one:
 *
 *   `mode="readonly"` (default) — render the children, dimmed, with the
 *                                 upgrade prompt above. You can look at
 *                                 everything. You cannot change it.
 *   `mode="replace"`            — render only the prompt. For features
 *                                 with nothing meaningful to show, like
 *                                 an AI panel that was never populated.
 *
 * ⚠️ NONE OF THIS IS A SECURITY BOUNDARY. It is presentation. Anything
 * rendered in a browser can be un-dimmed by anyone with developer tools,
 * and re-enabling a button here does nothing — the server action calls
 * `requireFeature()` and refuses regardless. This component exists so the
 * honest state is visible, not so it is enforced.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { Lock, ArrowUpRight, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { TIER_LABELS } from "@/lib/entitlements/features";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE PROMPT                                                          */
/* ------------------------------------------------------------------ */

export type UpgradePromptProps = {
  /** Plain-language name, e.g. "Trust accounting". Never a feature key. */
  featureLabel: string;
  requiredTier: PlanTier;
  /**
   * True when the workspace HAD this and lost it, rather than never
   * having had it. Completely different situations for the reader.
   */
  isLapsed?: boolean;
  className?: string;
};

export function UpgradePrompt({
  featureLabel,
  requiredTier,
  isLapsed = false,
  className,
}: UpgradePromptProps) {
  /**
   * The lapsed copy leads with reassurance about the data, because that
   * is the reader's actual first question and nothing else can be heard
   * until it is answered. The upgrade copy leads with the capability,
   * because that reader is making a purchase decision.
   */
  if (isLapsed) {
    return (
      <div
        role="status"
        className={cn(
          "rounded-lg border border-amber-300 bg-amber-50 p-4",
          "dark:border-amber-700 dark:bg-amber-950/40",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <CreditCard
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
              {featureLabel} is paused
            </p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
              Your subscription is not active at the moment.{" "}
              <strong className="font-semibold">
                Everything you have entered is safe and unchanged
              </strong>{" "}
              — you can still read it. Updating your payment details restores
              full access straight away.
            </p>
            <Link
              href="/settings/billing"
              className={cn(
                "mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5",
                "text-sm font-medium text-white",
                "bg-amber-700 hover:bg-amber-800",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                "focus-visible:outline-amber-700",
              )}
            >
              Update payment details
              <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-slate-300 bg-slate-50 p-4",
        "dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Lock
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {featureLabel} is on the {TIER_LABELS[requiredTier]} plan
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {/* Names the exact tier. Pointing someone at Enterprise for
                something Advanced includes is a good way to lose a sale. */}
            Upgrading to {TIER_LABELS[requiredTier]} switches it on
            immediately — nothing needs to be set up again.
          </p>
          <Link
            href="/settings/billing"
            className={cn(
              "mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5",
              "text-sm font-medium text-white",
              "bg-slate-900 hover:bg-slate-800",
              "dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              "focus-visible:outline-slate-900",
            )}
          >
            See plans
            <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

export type FeatureGateProps = {
  allowed: boolean;
  featureLabel: string;
  requiredTier: PlanTier;
  isLapsed?: boolean;
  /**
   * `readonly` keeps the children visible and non-interactive.
   * `replace` shows only the prompt.
   */
  mode?: "readonly" | "replace";
  children: ReactNode;
  className?: string;
};

export function FeatureGate({
  allowed,
  featureLabel,
  requiredTier,
  isLapsed = false,
  mode = "readonly",
  children,
  className,
}: FeatureGateProps) {
  if (allowed) return <>{children}</>;

  const prompt = (
    <UpgradePrompt
      featureLabel={featureLabel}
      requiredTier={requiredTier}
      isLapsed={isLapsed}
    />
  );

  if (mode === "replace") {
    return <div className={className}>{prompt}</div>;
  }

  return (
    <div className={className}>
      {prompt}

      {/*
        `inert` removes the subtree from the tab order, from hit-testing
        and from the accessibility tree in one attribute.

        Using `pointer-events-none` alone would be a trap: the content
        would still be keyboard-reachable and still announced by a screen
        reader as interactive, so a keyboard or screen-reader user would
        tab into buttons that silently do nothing. That is a worse
        experience than the mouse user gets, which is the wrong way round.

        `aria-hidden` is deliberately NOT set alongside — `inert` already
        handles the accessibility tree, and doing both is redundant.
      */}
      <div
        /*
          ⚠️ `inert={true}`, NOT `inert=""`.

          React treats an empty string as an absent value for boolean-ish
          attributes and drops it entirely, so `inert=""` renders nothing
          at all — the subtree stays fully focusable and the guarantee
          above is silently void. Caught by a test that queried for
          `[inert]` and found no element.

          There is no visible symptom: the content still looks dimmed,
          because the opacity class is unaffected. Only a keyboard or
          screen-reader user would ever have discovered it.
        */
        inert={true}
        className="mt-4 select-none opacity-50 grayscale"
      >
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* INLINE LOCK                                                         */
/* ------------------------------------------------------------------ */

/**
 * A small marker for a single locked control inside an otherwise
 * available screen — a menu item, a toolbar button.
 *
 * Renders as a real disabled button rather than a styled `div`, so it is
 * announced correctly and carries a title explaining WHY it is disabled.
 * A disabled control with no explanation is one of the most common causes
 * of a support ticket.
 */
export function LockedControl({
  featureLabel,
  requiredTier,
  className,
}: {
  featureLabel: string;
  requiredTier: PlanTier;
  className?: string;
}) {
  const reason = `${featureLabel} is available on the ${TIER_LABELS[requiredTier]} plan.`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-slate-200",
        "bg-slate-50 px-2 py-1 text-xs text-slate-500",
        "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
        className,
      )}
      title={reason}
    >
      <Lock aria-hidden="true" className="h-3 w-3" />
      {TIER_LABELS[requiredTier]}
      {/* Available to assistive technology without duplicating the visible
          badge text for sighted users. */}
      <span className="sr-only">{reason}</span>
    </span>
  );
}
