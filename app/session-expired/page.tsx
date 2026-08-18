"use client";

/**
 * Ordence — The idle session, ENDED
 * Version: v1.36.0-alpha (Batch 136)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A REFUSAL THAT LEAVES THE SESSION ALIVE IS A REDIRECT LOOP
 * ══════════════════════════════════════════════════════════════════════
 * `sessionIdleMinutes` is enforced in the middleware, which can refuse a
 * request but cannot end a Clerk session. Sending an idle session to
 * `/sign-in` while Clerk still considers it valid bounces it straight back
 * to the app, where the same gate refuses it again — forever.
 *
 * ⭐ SO THIS PAGE SIGNS THE USER OUT. That is the act that makes the next
 * sign-in a real one, with a fresh factor verification, which is the only
 * thing that clears the condition. The path is named in
 * `SESSION_POLICY_EXEMPT_PATHS` for the same reason the enrolment page is:
 * a gate must never block its own remedy.
 */

import * as React from "react";
import { useClerk } from "@clerk/nextjs";

export default function SessionExpiredPage() {
  const { signOut } = useClerk();
  const [state, setState] = React.useState<"signing-out" | "signed-out">("signing-out");

  React.useEffect(() => {
    let cancelled = false;
    void signOut().then(
      () => {
        if (!cancelled) setState("signed-out");
      },
      () => {
        /* ⚠️ A FAILED SIGN-OUT STILL SHOWS THE BUTTON. The person must be
         * able to finish this by hand rather than stare at a spinner that
         * has silently given up. */
        if (!cancelled) setState("signed-out");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      {/* ⭐ THE STATE IS A WORD. Never a coloured dot on its own. */}
      <h1 className="text-3xl font-bold">SESSION EXPIRED</h1>
      <p className="max-w-md text-muted-foreground">
        This workspace ends sessions after a period without a fresh sign-in.
        {state === "signing-out"
          ? " Signing you out…"
          : " You have been signed out. Sign in again to carry on where you left off."}
      </p>
      <a href="/sign-in" className="text-sm font-medium text-primary underline">
        Sign in again
      </a>
    </main>
  );
}
