/**
 * Ordence — Platform Console · Cross-Tenant Search
 * Version: v0.14.0-alpha
 *
 * The page is deliberately plain. The interesting parts are the line
 * drawn in `lib/platform/search-scopes.ts` (platform records yes,
 * customer content never) and the enforcement in
 * `server/platform/search.ts` (hand-written queries, mandatory
 * justification written BEFORE results are returned, hard cap, hourly
 * budget).
 *
 * The operator's own access log is shown underneath the box, on purpose.
 * Making somebody's access log visible to them is the cheapest way to
 * make the logging real — a log nobody reads is a log nobody notices is
 * broken.
 */

import { Suspense } from "react";
import { platformSearchAction } from "@/server/platform/actions";
import { getRecentPlatformActions } from "@/server/platform/search";
import { PlatformSearchClient } from "@/components/platform/search-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function PlatformSearchPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Search across workspaces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace and billing records only. Customer content — contacts, documents,
          contracts — is not searchable from here, at any grade. Seeing a record means
          impersonation, with the customer&rsquo;s consent.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4">
          <PlatformSearchClient onSearch={platformSearchAction} />
        </CardContent>
      </Card>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-md bg-muted" />}>
        <AccessLog />
      </Suspense>
    </div>
  );
}

async function AccessLog() {
  const result = await getRecentPlatformActions(25);
  if (!result.ok) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent cross-tenant access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {result.data.length === 0 ? (
          <p className="text-muted-foreground">Nothing yet.</p>
        ) : (
          result.data.map((row) => (
            <div key={row.id} className="border-b border-border pb-2 last:border-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{row.actorEmail}</span>
                <span className="font-mono">{row.resourceType}</span>
                <span className="text-muted-foreground">
                  {row.resultCount ?? 0} result{row.resultCount === 1 ? "" : "s"}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {row.createdAt.slice(0, 16).replace("T", " ")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{row.justification}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
