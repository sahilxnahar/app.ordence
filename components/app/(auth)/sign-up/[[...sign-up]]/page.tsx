/**
 * Ordence — Sign up
 *
 * ⭐ `fallbackRedirectUrl` POINTS AT THE ADDRESS STEP — v1.65.0-alpha.
 *
 * Signing up produces a PERSON. It does not produce a workspace, and the
 * next thing this product has to ask for is the address that workspace
 * will live at. Without this prop Clerk sends the new account to `/`, and
 * `middleware.ts` then bounces it to `/onboarding` — which works, and
 * costs a redirect on the single most abandonment-sensitive screen in the
 * funnel.
 *
 * ⚠️ `fallbackRedirectUrl`, NOT `forceRedirectUrl`. The fallback yields to
 *    an explicit `redirect_url`, which is what `middleware.ts` attaches
 *    when it sends somebody to sign in from a page they were trying to
 *    reach. Forcing it would silently discard that destination and land
 *    every returning visitor on the workspace-creation step instead.
 */
import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <SignUp fallbackRedirectUrl="/claim" />
    </main>
  );
}
