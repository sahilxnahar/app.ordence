/**
 * Ordence — Automations Shell
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * The four automation surfaces share a heading and a sub-navigation, and
 * nothing else — each page fetches its own data behind its own Suspense
 * boundary.
 */

import { AutomationsNav } from "./nav";

export const dynamic = "force-dynamic";

export default function AutomationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Automations</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Rules that watch for something happening and then do a short list of things.
          An automation can never do more than the person who published it.
        </p>
        <div className="mt-3">
          <AutomationsNav />
        </div>
      </div>

      {children}
    </div>
  );
}
