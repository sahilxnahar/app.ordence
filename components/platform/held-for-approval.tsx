"use client";

/**
 * Ordence — ⭐⭐ "NOTHING HAPPENED YET", ON THE SCREEN THAT TRIED
 * Version: v1.58.0-alpha (Batch 43)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE BUG THIS EXISTS TO STOP HAS ALREADY SHIPPED ONCE HERE
 * ══════════════════════════════════════════════════════════════════════
 * `requestSuspend` returned `ok: true` with a note beginning "Nothing has
 * happened yet", and `TenantActions.run()` threw the note away and raised
 * `toast.success("Done.")`. The operator then believed a live workspace
 * was locked, told the customer so, and walked away from an incident they
 * thought they had contained.
 *
 * ⚠️ THREE POLICIES BECAME REAL IN BATCH 43, WHICH MEANS THREE MORE
 * SCREENS CAN NOW GET `ok: true` FOR SOMETHING THAT DID NOT HAPPEN. Every
 * one of them renders this instead of a success toast.
 *
 * ⭐ IT IS NOT A TOAST, AND THAT IS THE WHOLE DESIGN. A notification that
 * fades in four seconds loses the argument to a row on the page that
 * still shows the old value — the operator reads the stale row as the
 * truth and clicks again. This stays until the page is left.
 *
 * ⚠️ THE STATE CARRIES A WORD, NOT A COLOUR. Roughly one in twelve Indian
 * men is colour-blind; an amber border that means "waiting" and a green
 * one that means "done" are the same border to them. The word "Waiting
 * for approval" is the state, and the border is decoration on top of it.
 */

import Link from "next/link";
/*
 * ⚠️ `console-paths`, NOT `console-href`. The latter reads `headers()`
 * and carries `import "server-only"`; a `"use client"` file importing it
 * fails the webpack build and `scripts/check-server-boundaries.mjs`. The
 * pure mapping was split out for exactly this reason and there is still
 * one implementation of it.
 */
import { consoleHref } from "@/lib/platform/console-paths";

export function HeldForApproval({
  note,
  isConsoleHost,
  testId = "held-for-approval",
}: {
  /** ⚠️ THE SERVER'S OWN SENTENCE. See below. */
  note: string;
  /**
   * ⚠️ The console answers on TWO base paths — `/platform/x` on the app
   * host and `/x` on the console host — so a hard-coded `/platform/...`
   * is a 404 for half the people who see it. `consoleHref` is the only
   * thing allowed to build a link inside `app/platform/**`.
   */
  isConsoleHost: boolean;
  testId?: string;
}) {
  return (
    <div
      className="space-y-1 rounded-md border border-amber-500 p-3 text-xs"
      data-testid={testId}
      role="status"
    >
      <p className="font-medium">Waiting for approval — nothing has been changed.</p>
      {/*
        ⭐ THE SERVER'S SENTENCE, NOT A SUMMARY OF IT. A version written
        here would drift from the server's and would drop the expiry,
        which is the part that matters when somebody comes back to this at
        two in the morning and finds the request gone.
      */}
      <p className="text-muted-foreground">{note}</p>
      <p>
        <Link
          className="underline"
          href={consoleHref("/platform/approvals", isConsoleHost)}
        >
          Open the approvals queue
        </Link>
      </p>
    </div>
  );
}
