import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "sonner";
import { Providers } from "./providers";
import "./globals.css";
import { WebVitalsReporter } from "@/components/telemetry/web-vitals-reporter";
import { getClerkPublishableKey, getClerkPaths } from "@/lib/env";

export const metadata: Metadata = {
  title: "Ordence",
  description: "Enterprise multi-tenant CRM platform.",
  robots: { index: false, follow: false },
};

/**
 * ⚠️ EVERY ROUTE IS RENDERED PER-REQUEST. Do not remove this.
 *
 * Next.js otherwise tries to prerender a handful of pages into static HTML
 * during the build — `/_not-found` and the sign-in shells among them. Those
 * pages still sit inside `<ClerkProvider>`, so prerendering means running
 * Clerk on a build machine that has no keys, and the build dies with:
 *
 *     @clerk/clerk-react: Missing publishableKey
 *
 * The alternative would be handing the build machine a copy of every secret,
 * which is a worse trade for a CRM: there is nothing here worth prerendering.
 * Every page is specific to one signed-in user of one tenant, so a cached
 * static copy would be either useless or a data leak. Rendering per request
 * is what this application wants regardless of the build.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * ⚠️ PASSED EXPLICITLY, NOT LEFT TO CLERK'S OWN ENV LOOKUP.
   *
   * `<ClerkProvider>` with no props reads NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
   * from the bundle — a value frozen in place when the code was compiled.
   * On Cloudflare Workers the build machine and the running Worker have
   * separate environments, so a key configured on the Worker alone is
   * invisible at compile time and the frozen value is `undefined`.
   *
   * `getClerkPublishableKey()` reads it when the request arrives instead.
   * This layout is a Server Component, so the resolved key travels to the
   * browser as an ordinary prop. Result: the key only has to be set ONCE,
   * on the Worker, rather than duplicated into a build-variable list.
   *
   * It is the PUBLISHABLE key — designed to be seen by browsers. Nothing
   * secret crosses this boundary. CLERK_SECRET_KEY stays server-side and
   * is never referenced here.
   */
  const publishableKey = getClerkPublishableKey();

  /*
   * ⭐ THE ACCOUNT PORTAL IS TURNED OFF HERE — added v0.50.0.
   *
   * ══════════════════════════════════════════════════════════════════════
   * WHAT WENT WRONG WITHOUT THESE FOUR PROPS
   * ══════════════════════════════════════════════════════════════════════
   * Clicking "Sign in" on app.ordence.com sent the user to
   *
   *     https://pretty-shrew-42.accounts.dev/sign-up
   *
   * — Clerk's own HOSTED sign-up page, on Clerk's domain, wearing Clerk's
   * branding and stamped "Development mode". Not this application at all.
   *
   * That is Clerk's Account Portal, and it is the DEFAULT. Clerk only
   * routes to the sign-in page we built if it is told that page exists.
   * It normally learns that from NEXT_PUBLIC_CLERK_SIGN_IN_URL — but that
   * is a NEXT_PUBLIC_ variable, which Next.js resolves by substituting the
   * literal text into the browser bundle AT BUILD TIME.
   *
   * Cloudflare Workers Builds runs the build with "Build variables: None".
   * So the substitution happened against an empty environment, `undefined`
   * was frozen into the bundle, Clerk concluded the app has no sign-in
   * page of its own, and fell back to the portal. Setting the variable on
   * the WORKER cannot fix it: by the time the Worker runs, the browser
   * bundle is already compiled.
   *
   * Passing them as props is the fix, and it is the same manoeuvre as
   * `publishableKey` above: this is a Server Component, so the values are
   * resolved when the request arrives and travel to the browser as
   * ordinary props. Nothing needs to be duplicated into a build-variable
   * list, and a future deploy cannot silently lose them.
   *
   * ⚠️ THE PORTAL IS NOT A COSMETIC PROBLEM. A user who signs up there is
   * created on the Clerk instance but never passes through OUR sign-up
   * route, so none of our post-sign-up handling runs. And the page says
   * "Development mode" to every visitor.
   *
   * The two FALLBACK urls answer a different question — "signed in
   * successfully, now where?" — and are needed because Clerk's own default
   * for that is the Account Portal as well.
   */
  const { signInUrl, signUpUrl } = getClerkPaths();

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl={signInUrl}
      signUpUrl={signUpUrl}
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      afterSignOutUrl="/"
    >
      <html lang="en" suppressHydrationWarning>
        <body>
          <Providers>{children}</Providers>

          {/*
            Every form in the application reports success and failure through
            `toast()`. Without this component mounted once at the root, those
            calls succeed silently and the user gets no feedback at all —
            a failure mode that looks exactly like "the button does nothing".

            `richColors` gives success and error visually distinct treatments
            rather than relying on the wording alone.
          */}
          <Toaster
            position="top-right"
            richColors
            closeButton
            toastOptions={{ duration: 5000 }}
          />
          {/*
            Mounted ONCE, here, at the root.

            It has a module-level guard against a second mount, but two
            mounts in two layouts would double-count every metric — and a
            performance dashboard reporting twice the real traffic is
            worse than no dashboard, because it looks authoritative.

            Failure is silent by design: if the beacon cannot be sent, the
            page is unaffected. Monitoring that can take the application
            down is not monitoring.
          */}
          <WebVitalsReporter />
        </body>
      </html>
    </ClerkProvider>
  );
}
