/**
 * Ordence — ⭐⭐ THE CONSOLE'S LINK TABLE, SAFE TO IMPORT FROM A BROWSER
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AND `console-href.ts` COULD NOT BE USED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/platform/console-href.ts` declares `import "server-only"`, because
 * `onConsoleHost()` reads `headers()`. That guard is correct and must
 * stay. But it makes the WHOLE MODULE unimportable from a `"use client"`
 * file — `scripts/check-server-boundaries.mjs` fails the build on it, and
 * so does webpack:
 *
 *     x You're importing a component that needs "server-only".
 *
 * The command palette is a client component and still has to build the
 * same two-base-path links. So the two halves are split by what they
 * need, not by what they are about:
 *
 *   • `consoleHref()` is PURE — a string in, a string out. It lives here,
 *     and `console-href.ts` re-exports it so every existing call site
 *     keeps working unchanged.
 *   • `onConsoleHost()` reads the request. It stays server-only.
 *
 * ⚠️ A CLIENT COMPONENT CANNOT DECIDE `isConsoleHost` FOR ITSELF. It has
 * no `Host` header. It must be handed the boolean as a prop by a server
 * component that called `onConsoleHost()`. Reading `window.location` in
 * the browser would work in the browser and be wrong during SSR, which is
 * the hydration mismatch that produces a link that changes under the
 * cursor.
 */

/** One console destination, written in the canonical on-disk path. */
export type ConsoleNavItem = {
  /** Always `/platform/...`, the path that exists on disk. */
  readonly href: string;
  readonly label: string;
  /**
   * Extra words the command palette matches on, for the destinations
   * whose label is not what an operator would type. Nobody searches
   * "Action register" for "audit log", and the person who wants the audit
   * log at 3am should not have to learn our vocabulary first.
   */
  readonly keywords?: string;
};

/**
 * ⚠️ THIS LIST IS NOT AN ACCESS CONTROL — see the long note in
 * `app/platform/layout.tsx`, which renders it. Every page behind these
 * links guards itself with `requireCapability()`, and every action behind
 * those pages guards itself again. Hiding a link is a courtesy.
 *
 * ⭐ IT LIVES HERE, NOT IN THE LAYOUT, SO THERE IS EXACTLY ONE COPY. The
 * layout renders it and the command palette jumps to it; a second
 * hand-maintained copy in the palette is a list that silently stops
 * matching the nav bar the first time somebody adds a screen.
 */
export const CONSOLE_NAV: readonly ConsoleNavItem[] = [
  { href: "/platform", label: "Workspaces", keywords: "tenants customers directory home" },
  { href: "/platform/users", label: "Users", keywords: "people accounts staff members" },
  // Sits beside the directory rather than inside it: the directory
  // answers "find me Acme", this answers "who needs me today?" — see the
  // header of `app/platform/tenants/page.tsx`.
  { href: "/platform/tenants", label: "Needs attention", keywords: "risk churn triage" },
  // ⭐ Health sits beside "Needs attention" and answers a different
  // question: that page recomputes a score, this one lists the problems
  // somebody still owes an answer for.
  { href: "/platform/health", label: "Health", keywords: "score alarms problems" },
  { href: "/platform/observatory", label: "Observatory", keywords: "metrics revenue growth churn" },
  // ⚠️ Approvals is high in the list on purpose. A queue nobody passes
  // is a queue that expires, and an expired request is a customer
  // waiting for something that quietly did not happen.
  { href: "/platform/approvals", label: "Approvals", keywords: "queue four eyes pending requests" },
  { href: "/platform/incidents", label: "Incidents", keywords: "outage postmortem oncall" },
  // ⭐ The isolation canary. Linked rather than left as a URL somebody
  // has to know, because the screen exists to be opened by whoever was
  // just paged by `/api/cron/canary` — and a person being paged at 3am
  // does not remember paths.
  { href: "/platform/canary", label: "Canary", keywords: "isolation rls leak test" },
  { href: "/platform/provision", label: "Provision", keywords: "new workspace onboard create tenant" },
  // ⭐ Directly under Provision, because it is the other half of the same
  // job: that screen creates a workspace, this one says which of the
  // workspaces we created never finished setting itself up. A stall is
  // only rescuable while somebody still remembers signing up.
  {
    href: "/platform/onboarding",
    label: "Onboarding progress",
    keywords: "stalled setup wizard steps stuck new workspace rescue churn",
  },
  // ⭐ Third of the same family, and last of it: Provision creates a
  // workspace, Onboarding progress says which one is stuck today, this
  // one says whether the months are getting better or worse. A snapshot
  // of the currently-stuck has no memory and cannot answer that.
  {
    href: "/platform/cohorts",
    label: "Cohorts",
    keywords: "signup month activation retention funnel trend onboarding median",
  },
  { href: "/platform/sessions", label: "Sessions", keywords: "impersonation live inside customer" },
  { href: "/platform/search", label: "Search", keywords: "cross tenant lookup find record" },
  { href: "/platform/log", label: "Action register", keywords: "audit log history who did what" },
  { href: "/platform/staff", label: "Staff access", keywords: "grant revoke platform admin allowlist" },
  // ⭐ Immediately after Staff access, because it is the same subject
  // asked as a question with a date on it: that screen says who holds
  // access NOW, this one says who held it during a month, why, and who
  // from our side checked. An auditor asks the second question.
  {
    href: "/platform/access-review",
    label: "Access review",
    keywords: "audit monthly grants impersonation who had access reviewed sign off attestation",
  },
  // ⭐ Beside Staff access, because it answers the same shape of
  // question about the platform itself rather than about a customer:
  // which of our own credentials is old. It shows no value, no prefix
  // and no length — only metadata. See the page header.
  {
    href: "/platform/secrets",
    label: "Secret rotation",
    keywords: "keys credentials env variables rotate age railway vault api key",
  },
  // ⭐ Last, and reached deliberately rather than wandered into: the two
  // controls on it stop the whole product accepting writes.
  {
    href: "/platform/maintenance",
    label: "Maintenance",
    keywords: "read only freeze window deploy version commit migration release",
  },
] as const;

/**
 * Turn a canonical `/platform/...` path into the right link for THIS host.
 *
 *   on app.    `/platform/tenants` → `/platform/tenants`
 *   on admin.  `/platform/tenants` → `/tenants`
 *   on admin.  `/platform`         → `/`
 *
 * ⚠️ TAKES THE CANONICAL PATH, ALWAYS. Call sites keep writing
 * `/platform/...` — the path that exists on disk — so a reader can find
 * the file. This function is the only place that knows about the other
 * form.
 *
 * ⚠️ A query string survives the mapping: `/platform/sessions?live=1`
 * becomes `/sessions?live=1`, because the prefix is stripped by length
 * and nothing else is touched.
 */
export function consoleHref(canonical: string, isConsoleHost: boolean): string {
  if (!isConsoleHost) return canonical;
  if (canonical === "/platform") return "/";
  if (canonical.startsWith("/platform/")) return canonical.slice("/platform".length);
  if (canonical.startsWith("/platform?")) return "/" + canonical.slice("/platform".length);
  return canonical;
}
