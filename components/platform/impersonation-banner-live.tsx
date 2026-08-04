"use client";

/**
 * Ordence — The Live Impersonation Banner
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS THIN WRAPPER EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `ImpersonationBanner` is deliberately dumb: props in, pixels out, no
 * fetching, no privilege, trivially testable. The console still needs an
 * END SESSION button in the bar itself, and wiring a server action to it
 * requires a client boundary somewhere. This is that boundary and nothing
 * else lives in it.
 *
 * ⭐ WHY THE BUTTON HAS TO BE IN THE BAR. Before this, ending a session
 * meant navigating back to the workspace page and finding a control. The
 * moment an operator most needs to leave — they have realised they are in
 * the wrong tab — is the moment they should not have to navigate
 * anywhere. Distance from "I should stop" to "I have stopped" is a safety
 * property.
 *
 * ⚠️ THE BUTTON IS NOT WHAT ENDS THE SESSION. `expires_at` does, checked
 * on every single request. This makes leaving early one click instead of
 * a wait; it does not make the bar load-bearing. Deleting this component
 * from the DOM with developer tools extends nobody's access by a second.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImpersonationBanner } from "./impersonation-banner";

type ActionResult = { ok: true } | { ok: false; error: string };

export function LiveImpersonationBanner({
  sessionId,
  tenantName,
  tenantSlug,
  scope,
  mode,
  minutesLeft,
  expiresAt,
  onEnd,
}: {
  sessionId: string;
  tenantName: string;
  tenantSlug: string;
  scope: string;
  mode: string;
  minutesLeft: number;
  expiresAt: string;
  onEnd: (input: { sessionId: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ImpersonationBanner
      tenantName={tenantName}
      tenantSlug={tenantSlug}
      scope={scope}
      mode={mode}
      minutesLeft={minutesLeft}
      expiresAt={expiresAt}
      ending={pending}
      onEnd={() =>
        startTransition(async () => {
          const result = await onEnd({ sessionId });
          if (result.ok) {
            toast.success("Session ended. You are yourself again.");
          } else {
            // Refreshing anyway: the usual cause of "no session to end" is
            // that it already expired, and the operator's view should stop
            // claiming otherwise.
            toast.error(result.error);
          }
          router.refresh();
        })
      }
    />
  );
}
