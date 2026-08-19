/**
 * Ordence — Onboarding / workspace resolution
 * Version: v0.67.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS PAGE HAS TWO STATES AND USED TO HAVE ONE
 * ══════════════════════════════════════════════════════════════════════
 * It rendered `<CreateOrganization>` unconditionally. That is right for
 * exactly one visitor: somebody who has signed in and has no organisation.
 *
 * The other visitor — and, until Session 4, the far more common one — has
 * a Clerk organisation and no `tenants` row behind it. Provisioning
 * inserted `plan_tier` values (`starter`, `growth`) that the database enum
 * has never contained, so the INSERT failed with
 *
 *     invalid input value for enum plan_tier: "starter"
 *
 * and the Clerk org was created regardless. Those users were sent here by
 * the layout and shown a form asking them to create the organisation they
 * already have. Submitting it creates a SECOND org and reproduces the same
 * failure. There is no path out of that screen.
 *
 * ⚠️ THIS IS THE MOST IMPORTANT SCREEN IN THE PRODUCT TO GET HONEST,
 * because it is the only one a broken account can reach. A dead end here
 * is not a bad page — it is a customer who cannot use anything they paid
 * for and cannot tell anyone why.
 *
 * So: if the organisation exists but the workspace does not, say exactly
 * that, name the organisation so support can find it in one query, and
 * give them a way to reach a human. Never re-offer the form.
 */

import { auth } from "@clerk/nextjs/server";
import { CreateOrganization } from "@clerk/nextjs";
import { ClaimWorkspace } from "@/components/signup/claim-workspace";
import { and, eq, isNull } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import { db, withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { orgId, orgSlug } = await auth();

  /*
   * ⚠️ THE LOOKUP IS WRAPPED. A database outage must not turn this page —
   * the one place a stuck user can still reach — into a digest screen.
   * On failure it falls through to the create-organisation form, which is
   * the state that was rendered unconditionally before and is no worse.
   */
  let workspaceMissing = false;

  if (orgId) {
    try {
      /**
       * ⭐ PLATFORM SCOPE, LIKE `requireTenantContext`. This asks
       * "does a workspace exist for this Clerk organisation" BEFORE any
       * workspace is known, which is by definition a question no single
       * workspace can answer. Unscoped it returned nothing under a
       * correct role, so this page would have told every user their
       * workspace was missing — on the one screen whose entire job is
       * to say whether it is.
       */
      const row = await withPlatformScope(
        `Onboarding: check whether a workspace exists for this organisation`,
        (tx) =>
          tx.query.tenants.findFirst({
            where: and(eq(tenants.clerkOrgId, orgId), isNull(tenants.deletedAt)),
            columns: { id: true },
          }),
      );
      workspaceMissing = !row;
    } catch (err) {
      console.error("[onboarding] could not resolve tenant for org", orgId, err);
    }
  }

  if (workspaceMissing) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
        <div className="w-full max-w-lg rounded-md border border-amber-500/40 bg-amber-500/5 p-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Your workspace is not ready yet
          </p>

          <p className="mt-3 text-sm text-muted-foreground">
            Your organisation exists, but the workspace behind it has not
            finished being set up. This is not something you can fix from
            here, and creating another organisation will not help.
          </p>

          <p className="mt-3 text-sm text-muted-foreground">
            Send us the reference below and we will finish it — usually within
            a few minutes.
          </p>

          {/*
            The org id, shown deliberately. It is not a secret — it is in
            the user's own session — and it is the single value that turns
            "a customer says it is broken" into one indexed lookup. Without
            it, support has to guess from an email address that may not
            match anything.
          */}
          <dl className="mt-4 space-y-1 rounded border border-border bg-background p-3 text-xs">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Reference</dt>
              <dd className="break-all font-mono">{orgId}</dd>
            </div>
            {orgSlug && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Organisation</dt>
                <dd className="break-all font-mono">{orgSlug}</dd>
              </div>
            )}
          </dl>

          <a
            className="mt-5 inline-block rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
            href="mailto:support@ordence.com?subject=Workspace%20not%20provisioned"
          >
            Email support
          </a>
        </div>
      </main>
    );
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * ⭐ NO ORGANISATION AT ALL — THE SELF-SERVE FUNNEL OWNS THIS SCREEN
   * ══════════════════════════════════════════════════════════════════
   * `middleware.ts` sends every session without an active organisation
   * here, so this is where a brand-new customer lands after signing up.
   * It used to render Clerk's `<CreateOrganization>`, which asks for a
   * company name and NEVER ASKS FOR AN ADDRESS — provisioning then
   * derived one from the name, and the product's central promise, "your
   * own subdomain", was something the customer was never offered.
   *
   * ⚠️ RENDERED, NOT REDIRECTED TO `/claim`, AND THE DIFFERENCE MATTERS.
   *    A redirect from the one destination middleware sends no-org
   *    sessions to is a loop waiting for its first bad day: anything that
   *    bounces the visitor back here — an expired `setActive`, a stale
   *    tab — bounces them straight out again. Rendering the same
   *    component keeps `/claim` and `/onboarding` as two doors into one
   *    room, with no cycle between them.
   *
   * ⚠️ `<ClaimWorkspace>` RESUMES RATHER THAN DUPLICATES. If this person
   *    already created an organisation and only failed to activate it,
   *    the component finds the membership and carries on, instead of
   *    offering to make a second workspace with a second trial and a
   *    second hostname.
   */
  if (!orgId) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Create your workspace</h1>
          <p className="text-sm text-muted-foreground">
            Every company gets its own isolated workspace at its own web address.
          </p>
        </header>
        <ClaimWorkspace />
      </main>
    );
  }

  /*
   * ⚠️ AN ORGANISATION EXISTS AND SO DOES ITS WORKSPACE — this is somebody
   *    deliberately adding a SECOND one. Clerk's own form is right here:
   *    the address for it is derived by the webhook exactly as it always
   *    was, and the self-serve address step is a first-workspace flow.
   */
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Create another workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every company gets its own isolated workspace.
        </p>
      </div>
      <CreateOrganization afterCreateOrganizationUrl="/dashboard" />
    </main>
  );
}
