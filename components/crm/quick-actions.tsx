/**
 * Ordence — Quick Actions
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SERVER COMPONENT WITH LINKS, NOT A CLIENT WIDGET
 * ══════════════════════════════════════════════════════════════════════
 * Every action here is "go to a page that already exists and does this
 * properly". Nothing needs client state, so nothing needs to ship as
 * JavaScript.
 *
 * The tempting alternative — a modal that posts a journal entry from the
 * dashboard — would mean a second implementation of the balance gate, the
 * period-close check and the permission check. Two implementations of a
 * financial control is one more than is safe, and the second one is always
 * the one that drifts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY UNAVAILABLE ACTIONS ARE SHOWN, NOT HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * An action the user lacks permission for renders disabled, with the
 * reason, rather than disappearing.
 *
 * A vanishing button teaches nothing: the user concludes the feature does
 * not exist, and eventually asks support why the product cannot do
 * something it visibly can. A greyed control that says "requires contract
 * approval" tells them precisely what to ask their administrator for.
 *
 * This is a courtesy, not a control. Every destination re-checks the
 * permission server-side, so a user who navigates directly is refused
 * there — as they would be regardless of what this widget rendered.
 */

import Link from "next/link";
import {
  BookPlus,
  FileUp,
  Link2,
  UserPlus,
  Building2,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type QuickAction = {
  key: string;
  label: string;
  description: string;
  href: string;
  icon: "journal" | "upload" | "portal" | "contact" | "company";
  available: boolean;
  /** Shown when `available` is false. Required in that case. */
  unavailableReason?: string;
};

const ICONS = {
  journal: BookPlus,
  upload: FileUp,
  portal: Link2,
  contact: UserPlus,
  company: Building2,
} as const;

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <section className="space-y-3" aria-labelledby="quick-actions-heading">
      <div>
        <h3 id="quick-actions-heading" className="text-sm font-semibold">
          Quick actions
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The things you are most likely to want next.
        </p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {actions.map((action) => {
          const Icon = ICONS[action.icon];

          if (!action.available) {
            return (
              <li key={action.key}>
                {/*
                  A <div>, not a disabled <a>. A disabled anchor is not a
                  real thing in HTML — `aria-disabled` on a link that still
                  navigates is worse than useless, because a screen reader
                  announces it as unavailable and it works anyway.
                */}
                <div
                  className="flex cursor-not-allowed items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 opacity-70"
                  aria-disabled="true"
                >
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {action.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {action.unavailableReason ?? "Not available."}
                    </p>
                  </div>
                </div>
              </li>
            );
          }

          return (
            <li key={action.key}>
              <Link
                href={action.href}
                className={cn(
                  "group flex items-start gap-3 rounded-md border border-border px-3 py-2.5",
                  "transition-colors hover:border-primary/40 hover:bg-accent/50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <Icon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{action.label}</p>
                  <p className="text-xs text-muted-foreground">{action.description}</p>
                </div>

                <ArrowRight
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* ACTION BUILDER                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the action list from what this user may actually do.
 *
 * Pure, so it is testable without a database or a session — and so the
 * permission-to-action mapping is one readable list rather than five
 * conditionals scattered through JSX.
 *
 * "Generate portal link" points at the contracts LIST rather than at a
 * generator. A portal link only means something attached to a specific
 * contract, so the honest one-click destination is "choose which one".
 * A button that opened a form with an empty contract picker would be one
 * click shorter and one step more confusing.
 */
export function buildQuickActions(permissions: {
  canPostTransactions: boolean;
  canUpdateContracts: boolean;
  canApproveContracts: boolean;
  canCreateContacts: boolean;
}): QuickAction[] {
  return [
    {
      key: "journal",
      label: "New journal entry",
      description: "Post a balanced double-entry transaction.",
      href: "/accounting",
      icon: "journal",
      available: permissions.canPostTransactions,
      unavailableReason: "Your role does not include posting transactions.",
    },
    {
      key: "upload",
      label: "Upload a contract document",
      description: "Attach a signed copy or annexure to a contract.",
      href: "/contracts",
      icon: "upload",
      available: permissions.canUpdateContracts,
      unavailableReason: "Your role does not include editing contracts.",
    },
    {
      key: "portal",
      label: "Generate a client link",
      description: "Share a contract with someone outside the workspace.",
      href: "/contracts",
      icon: "portal",
      available: permissions.canUpdateContracts,
      unavailableReason: "Your role does not include sharing contracts.",
    },
    {
      key: "contact",
      label: "Add a contact",
      description: "Record a new person in the CRM.",
      href: "/contacts/new",
      icon: "contact",
      available: permissions.canCreateContacts,
      unavailableReason: "Your role does not include creating contacts.",
    },
    {
      key: "company",
      label: "Add a company",
      description: "Record a new organisation.",
      href: "/companies/new",
      icon: "company",
      available: permissions.canCreateContacts,
      unavailableReason: "Your role does not include creating companies.",
    },
  ];
}
