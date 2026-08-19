"use client";

/**
 * Ordence — Self-serve signup, the step that owns the address
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AT ALL — IT IS THE MISSING CLIENT BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * `app/(marketing)/claim/page.tsx` has no `"use client"`, so it may
 * RENDER `<ClaimSubdomain>` but may not pass it `onContinue`: a function
 * prop is not serialisable across the server/client boundary, and a
 * wrapper declared in a server module is server code wherever the hook it
 * calls lives. That mistake in `app/layout.tsx` once returned 500 for
 * every route in the product while the build and every gate stayed green.
 *
 * ⭐ SO THE BOUNDARY IS A FILE, NOT A FUNCTION. This module is the client
 *    half; the page stays a server component and renders it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FIVE STATES, AND WHY THERE ARE FIVE
 * ══════════════════════════════════════════════════════════════════════
 *   resuming      the browser is asking Clerk what this person already has
 *   choosing      the form is shown
 *   creating      `claimWorkspaceAddress` is in flight
 *   provisioning  the organisation exists; the webhook has not landed yet
 *   failed        something we cannot fix from here
 *
 * 🔴 `resuming` IS NOT POLISH. IT IS WHAT MAKES THE FLOW SURVIVE A
 *    REFRESH. The organisation is created by a server action and the
 *    session's ACTIVE organisation is set separately afterwards; between
 *    those two, a closed laptop or a failed `setActive` leaves a person
 *    who HAS an organisation and appears not to. Without this state they
 *    would be shown the form again, type the same address again, and be
 *    told it is already in use — by their own workspace, thirty seconds
 *    old. So the first thing this component does is ask Clerk whether
 *    there is already a membership to resume, and resume it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE REDIRECT TARGET COMES FROM THE SERVER
 * ══════════════════════════════════════════════════════════════════════
 * The workspace host is built from `NEXT_PUBLIC_ZONE_DOMAIN`, and Next.js
 * inlines every literal `process.env.NEXT_PUBLIC_*` at BUILD time. The
 * Railway build machine has no application variables, so a browser
 * computing the host would compute `https://acme.undefined/`. The status
 * action returns a finished URL built with `tenantUrl()` at request time.
 *
 * ⚠️ AND WHY IT IS A FULL PAGE LOAD RATHER THAN A ROUTER PUSH. The target
 *    is a DIFFERENT HOST. `router.push` is a client-side navigation within
 *    one origin; it cannot cross to `acme.ordence.com`.
 */

import * as React from "react";
import { useOrganizationList } from "@clerk/nextjs";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  ClaimSubdomain,
  type ClaimRejection,
} from "@/components/signup/claim-subdomain";
import {
  claimWorkspaceAddress,
  workspaceProvisioningStatus,
} from "@/server/actions/claim";

/**
 * ⚠️ HOW LONG WE ARE WILLING TO WAIT FOR SOMEBODY ELSE'S DELIVERY.
 *
 * Svix normally delivers `organization.created` in well under a second.
 * Sixty seconds is generous enough that a slow delivery is not shown as a
 * failure, and short enough that a genuinely stuck signup gets a sentence
 * with a reference in it rather than a spinner nobody ever leaves.
 */
const PROVISION_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

type Phase =
  | { kind: "resuming" }
  | { kind: "choosing" }
  | { kind: "creating" }
  | { kind: "provisioning" }
  /**
   * ⭐⭐ THE ADDRESS THEY GOT IS NOT THE ADDRESS THEY TYPED.
   *
   * `claimSlugWithFallback()` walks a candidate ladder when the database
   * refuses the requested name, so a company called Support asks for
   * `support` and is granted `support-india`. The workspace is correct and
   * reachable — and silently landing somebody on a hostname they did not
   * choose is the same failure this batch's A3 answer is about, one screen
   * earlier: nobody was told.
   *
   * ⚠️ SO THIS IS A STOP, NOT A TOAST. They read the address, and they
   *    press the button. It is the one they will print on a board.
   */
  | { kind: "diverted"; requested: string; granted: string; url: string }
  | { kind: "failed"; message: string };

/*
 * ⚠️ NO `initialValue` PROP. One was written and removed before this
 *    shipped: nothing passed it, so it was a parameter read by nobody —
 *    the same defect in miniature as a column read at zero computations.
 *    The obvious source for a prefill would be a query string, and this
 *    project's standing rule is that no user-supplied identifier goes in a
 *    URL: it lands in the access log of every hop, in the `Referer` of
 *    whatever loads next, and in browser history. See the header of
 *    `app/api/public/slug-available/route.ts`.
 */
export function ClaimWorkspace() {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });

  const [phase, setPhase] = React.useState<Phase>({ kind: "resuming" });
  const [rejection, setRejection] = React.useState<ClaimRejection | null>(null);

  /**
   * ⚠️ GUARDS AGAINST A SECOND RUN, NOT AGAINST A SECOND RENDER. React 18
   *    runs effects twice in development, and `resume()` creates nothing —
   *    but `setActive` plus a redirect fired twice is a visible flicker and
   *    a wasted round trip.
   */
  const startedRef = React.useRef(false);

  /**
   * ⭐ WHAT THIS PERSON ASKED FOR, so the granted address can be compared
   *    against it. `null` on the resume path — somebody returning to a
   *    half-finished signup never typed anything in THIS page load, and an
   *    invented comparison would announce a diversion that may not have
   *    happened.
   */
  const requestedRef = React.useRef<string | null>(null);

  /**
   * ⭐ WAIT FOR THE WEBHOOK, THEN LEAVE.
   *
   * ⚠️ POLLED RATHER THAN PUSHED, AND THE ALTERNATIVE WAS WORSE. The event
   *    that would be pushed arrives at the SERVER, from Svix. Delivering it
   *    onward to this browser needs a socket, a channel and something to
   *    hold the subscription — for a wait that is normally under a second.
   */
  const waitForWorkspace = React.useCallback(async () => {
    setPhase({ kind: "provisioning" });
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;

    for (;;) {
      let status: Awaited<ReturnType<typeof workspaceProvisioningStatus>>;
      try {
        status = await workspaceProvisioningStatus();
      } catch {
        /* A blip in one poll is not a failure of the signup. Try again. */
        status = { ready: false, reason: "pending" };
      }

      if (status.ready) {
        /*
         * 🔴 `status.slug` IS THE GRANTED ADDRESS AND IT IS COMPARED, NOT
         *    JUST DISPLAYED. The redirect uses the URL either way; this
         *    read is what decides whether the customer is told that the
         *    name they typed was not the name they got.
         */
        const requested = requestedRef.current;
        if (requested !== null && requested !== status.slug) {
          setPhase({
            kind: "diverted",
            requested,
            granted: status.slug,
            url: status.workspaceUrl,
          });
          return;
        }
        window.location.assign(status.workspaceUrl);
        return;
      }

      if (Date.now() >= deadline) {
        setPhase({
          kind: "failed",
          message:
            "Your workspace is taking longer than usual to finish setting up. " +
            "It is still being created — wait a moment and reload this page. " +
            "If it is still not ready, email support@ordence.com.",
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* RESUME                                                            */
  /* ---------------------------------------------------------------- */

  React.useEffect(() => {
    if (!isLoaded || startedRef.current) return;
    startedRef.current = true;

    const existing = userMemberships?.data?.[0];
    if (!existing) {
      setPhase({ kind: "choosing" });
      return;
    }

    /*
     * ⭐ THEY ALREADY HAVE ONE. Do not offer to make another — activate
     *    what exists and carry on to the wait. This is the branch that
     *    turns a failed `setActive`, a closed laptop or a back button into
     *    a resumed signup instead of a duplicate workspace.
     */
    void (async () => {
      try {
        await setActive?.({ organization: existing.organization.id });
      } catch {
        /*
         * ⚠️ NOT FATAL, AND NOT SILENT EITHER. The status poll reads the
         *    organisation from the SESSION, so if activation genuinely
         *    failed the poll answers `no_organization` and times out into
         *    the message above — which is a truthful outcome rather than a
         *    spinner. Failing the whole screen here would strand somebody
         *    whose workspace exists and works.
         */
      }
      await waitForWorkspace();
    })();
  }, [isLoaded, userMemberships, setActive, waitForWorkspace]);

  /* ---------------------------------------------------------------- */
  /* CLAIM                                                             */
  /* ---------------------------------------------------------------- */

  const handleContinue = React.useCallback(
    (slug: string) => {
      setRejection(null);
      requestedRef.current = slug.trim().toLowerCase();
      setPhase({ kind: "creating" });

      void (async () => {
        let result: Awaited<ReturnType<typeof claimWorkspaceAddress>>;
        try {
          result = await claimWorkspaceAddress({ slug });
        } catch (error) {
          console.error("[claim] action failed", error);
          setPhase({
            kind: "failed",
            message: "We could not reach the server. Check your connection and try again.",
          });
          return;
        }

        if (!result.ok && result.kind === "rejected") {
          /*
           * ⭐ HANDED BACK THROUGH `ClaimRejection`, WHICH CARRIES THE SLUG
           *    IT IS ABOUT. The banner therefore cannot accuse a different
           *    name — including one the user types afterwards, which the
           *    server has never seen and may well be free.
           *
           * ⚠️ THE ASSIGNMENT IS THE CHECK. `PublicRejection` in
           *    `server/actions/claim.ts` is declared separately, because a
           *    server module may not import a type from a `"use client"`
           *    file. This line is what makes the two shapes agree: if
           *    either moves, this stops compiling.
           */
          const refusal: ClaimRejection = result.rejection;
          setRejection(refusal);
          setPhase({ kind: "choosing" });
          return;
        }

        if (!result.ok) {
          setPhase({ kind: "failed", message: result.error });
          return;
        }

        try {
          await setActive?.({ organization: result.organizationId });
        } catch {
          /* See the note in the resume branch. The poll is the real test. */
        }

        await waitForWorkspace();
      })();
    },
    [setActive, waitForWorkspace],
  );

  /* ---------------------------------------------------------------- */
  /* RENDER                                                            */
  /* ---------------------------------------------------------------- */

  if (phase.kind === "failed") {
    return (
      <div
        role="alert"
        className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
      >
        <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          We could not finish setting up your workspace
        </p>
        <p className="mt-2 text-muted-foreground">{phase.message}</p>
      </div>
    );
  }

  if (phase.kind === "diverted") {
    return (
      <div className="space-y-3 rounded-md border border-border p-4 text-sm">
        <p className="font-semibold">Your workspace is ready</p>
        <p className="text-muted-foreground">
          {/*
            ⚠️ NEITHER MESSAGE NAMES A CONFLICTING WORKSPACE. "support is
            not available" is fine; "taken by Acme Pvt Ltd" is a customer
            list. `lib/slug.ts` splits the public and operator wording for
            exactly this reason, and this screen is the public one.
          */}
          <strong>{phase.requested}.ordence.com</strong> was not available, so your
          workspace is at <strong>{phase.granted}.ordence.com</strong>. This is the
          address to share and to print — the one you typed will not reach you.
        </p>
        <a
          className="inline-block rounded-md border border-border px-4 py-2 font-medium hover:bg-muted"
          href={phase.url}
        >
          Open {phase.granted}.ordence.com
        </a>
      </div>
    );
  }

  if (phase.kind === "resuming" || phase.kind === "provisioning") {
    return (
      <div
        /*
         * ⚠️ `status`, NOT `alert`. This is progress, and an assertive live
         *    region interrupts a screen reader mid-sentence to say so.
         */
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-sm"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>
          {phase.kind === "resuming"
            ? "Checking your account…"
            : "Setting up your workspace. This usually takes a few seconds."}
        </span>
      </div>
    );
  }

  return (
    <ClaimSubdomain
      serverRejection={rejection}
      onContinue={handleContinue}
      busy={phase.kind === "creating"}
      continueLabel="Create my workspace"
    />
  );
}
