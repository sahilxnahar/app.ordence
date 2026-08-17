/**
 * Ordence — "Choose your address" (PLACEHOLDER HOST)
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS PAGE IS A HOST, NOT A SIGNUP FLOW.
 * ══════════════════════════════════════════════════════════════════════
 * The real self-serve funnel does not exist yet. Signup today is Clerk's
 * `<SignUp />` at `/sign-up`, and workspace creation is Clerk's
 * `<CreateOrganization>` at `/onboarding`; neither of them asks for a
 * subdomain, because provisioning currently derives one. This page exists
 * so that `ClaimSubdomain` is mounted, reachable and testable in a real
 * browser at a real URL rather than only in somebody's head.
 *
 * 🔴 THE CONTINUE BUTTON HAS NO DESTINATION YET, AND THAT IS STATED ON
 *    SCREEN RATHER THAN HIDDEN. A button that silently does nothing is
 *    how a placeholder becomes a bug report. When the funnel lands, the
 *    step that owns it should render `<ClaimSubdomain>` with `onContinue`
 *    (or its own client wrapper around a server action) and pass the
 *    claim path's refusal back in through `serverRejection` — see the
 *    `ClaimRejection` type, which deliberately carries the slug it is
 *    about so the banner can never accuse a different name.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A SERVER COMPONENT MAY NOT CALL A CLIENT HOOK.
 * ══════════════════════════════════════════════════════════════════════
 * This file has no `"use client"`, so it may render `<ClaimSubdomain>`
 * but may not define a wrapper that calls anything the component uses.
 * A function declared in a server module is server code wherever the hook
 * it calls lives — that mistake in `app/layout.tsx` returned 500 for
 * every route in the product while the build and every gate stayed green.
 * `scripts/check-client-hooks.mjs` is the cheap static check for it.
 *
 * It also cannot pass `onContinue`: a function prop is not serialisable
 * across the server/client boundary. That is the other reason the button
 * is inert here rather than wired to a stub.
 */

import type { Metadata } from "next";

import { ClaimSubdomain } from "@/components/signup/claim-subdomain";

export const metadata: Metadata = {
  title: "Choose your Ordence address",
  /**
   * ⚠️ NOINDEX, matching the root layout. This is an unfinished surface,
   * and an indexed placeholder is a support ticket from somebody who
   * found it in a search result.
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

      <ClaimSubdomain />

      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        Placeholder screen. Continue is not wired to anything yet — the self-serve signup flow
        that owns this step has not shipped.
      </p>
    </main>
  );
}
