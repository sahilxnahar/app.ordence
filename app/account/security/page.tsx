/**
 * Ordence — Two-step verification, for a workspace that requires it
 * Version: v1.36.0-alpha (Batch 136)
 *
 * ⭐ THIS PAGE IS THE CURE THE GATE MUST NEVER BLOCK.
 *
 * When a workspace turns on `requireMfa`, `lib/security/session-policy.ts`
 * refuses every request from a session without a second factor and sends
 * it here — so this path is named, by hand, in
 * `SESSION_POLICY_EXEMPT_PATHS`. Without that exemption the refusal would
 * point at a page the refusal itself forbids, and every user of the
 * workspace would be locked out permanently by one ticked checkbox.
 *
 * ⚠️ IT LIVES OUTSIDE `app/(crm)` ON PURPOSE. The CRM layout runs the same
 * policy against the database as a Node-runtime backstop, and a layout
 * cannot see the path it is rendering. Keeping this page out of that group
 * is what makes "the enrolment page is exempt" true in both runtimes
 * instead of only in the one that can read a URL.
 */
import Link from "next/link";
import { UserProfile } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; redirect_url?: string }>;
}) {
  const { reason, redirect_url: redirectUrl } = await searchParams;
  const refused = reason === "mfa_required";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Two-step verification</h1>
        {refused ? (
          /*
           * ⭐ THE STATE CARRIES A WORD, NOT A COLOUR. One in twelve Indian
           * men is colour-blind, and "why can I not get in" is exactly the
           * question a red border alone cannot answer.
           */
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <strong className="font-semibold">MFA REQUIRED — </strong>
            this workspace requires a second factor before you can continue.
            Add one below, then return to your work.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add a second factor so a stolen password on its own is not enough
            to reach this workspace.
          </p>
        )}
      </header>

      {/* Clerk owns enrolment; hash routing keeps it on this one exempt path. */}
      <UserProfile routing="hash" />

      <Link
        href={redirectUrl && redirectUrl.startsWith("/") ? redirectUrl : "/dashboard"}
        className="text-sm font-medium text-primary underline"
      >
        Continue to your workspace
      </Link>
    </main>
  );
}
