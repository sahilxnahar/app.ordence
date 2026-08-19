/**
 * Ordence — "Choose your address" (self-serve signup, step 1)
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS NO LONGER A PLACEHOLDER. Continue creates the workspace.
 * ══════════════════════════════════════════════════════════════════════
 * The flow, end to end:
 *
 *   /sign-up  →  Clerk creates the person
 *   /claim    →  the person chooses an address, and the CLERK ORGANISATION
 *                IS CREATED CARRYING IT as its slug
 *   webhook   →  `organization.created` provisions the `tenants` row with
 *                that address (or the next one the database will grant)
 *   redirect  →  `https://<slug>.ordence.com/dashboard`
 *
 * 🔴 THE ADDRESS IS CHOSEN BEFORE THE ORGANISATION EXISTS, NOT AFTER, and
 *    the argument is written out in `server/actions/claim.ts`. In one
 *    sentence: the webhook is the sole writer and it is delivered
 *    asynchronously, so an address chosen afterwards is a RENAME of a
 *    thirty-second-old workspace — which races the writer and spends 365
 *    days of 0091's retention on a name nobody ever used.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A SERVER COMPONENT MAY NOT CALL A CLIENT HOOK.
 * ══════════════════════════════════════════════════════════════════════
 * This file still has no `"use client"`, and that has not changed because
 * the problem has not changed: a function declared in a server module is
 * server code wherever the hook it calls lives, and it cannot be handed
 * `onContinue` either, because a function prop is not serialisable across
 * the boundary. That is why the button was inert.
 *
 * ⭐ THE FIX IS A SEPARATE FILE, NOT A MOVED ONE.
 *    `components/signup/claim-workspace.tsx` carries the `"use client"`
 *    directive, owns the hooks and the server-action calls, and renders
 *    `<ClaimSubdomain>` with a real `onContinue`. This page composes it.
 *    `scripts/check-client-hooks.mjs` is the cheap static check that the
 *    boundary stayed where it is.
 *
 * ⚠️ NOT ON `isPublicRoute` IN `middleware.ts`, AND THAT IS DELIBERATE.
 *    The Clerk organisation is created for a specific person, so this step
 *    needs a session. A signed-out visitor is sent to `/sign-in` with
 *    `redirect_url=/claim` and arrives back here afterwards.
 */

import type { Metadata } from "next";

import { ClaimWorkspace } from "@/components/signup/claim-workspace";

export const metadata: Metadata = {
  title: "Choose your Ordence address",
  /**
   * ⚠️ NOINDEX, matching the root layout. A signup step behind a session
   * has nothing to offer a search result, and an indexed one is a support
   * ticket from somebody who found it and could not use it.
   */
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ClaimPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">Ordence</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Choose your workspace address
        </h1>
        <p className="text-sm text-muted-foreground">
          This is the web address your team, your customers and your invoices will use. Pick
          something short — you can print it on a board.
        </p>
      </header>

      <ClaimWorkspace />
    </main>
  );
}
