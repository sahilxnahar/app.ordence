/**
 * Ordence — Platform Console · ⭐⭐⭐ ACCESS REVIEW
 * Version: v1.52.0-alpha (Batch 130)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE MONTHLY PASS OVER EVERY GRANT AND EVERY IMPERSONATION
 * ══════════════════════════════════════════════════════════════════════
 * `/platform/staff` answers "who holds access today" and
 * `/platform/sessions` answers "who went inside, ever". Neither answers
 * the question an auditor actually asks, which is bounded by a PERIOD and
 * closed by a SIGNATURE: "for the month of July, who could see my books,
 * why, and who from your side checked?"
 *
 * ⚠️ THE DEFAULT PERIOD IS THE LAST COMPLETE CALENDAR MONTH, in IST — see
 * `previousCalendarMonthIST()`. Not "the last thirty days": a review is a
 * sign-off on a closed period, and a rolling window can never be signed
 * off because it never closes.
 *
 * ⚠️ NO POLLING. The period under review is normally finished, and a
 * console tab re-querying every grant on a timer costs the database more
 * than it tells anybody. `<DataTable>`'s `refreshMs` is deliberately unset.
 */

import { Suspense } from "react";

import {
  bulkRevokeAccess,
  listAccessReview,
  markAccessReviewed,
} from "@/server/platform/access-review";
import { getPlatformOperator } from "@/server/platform/guard";
import { AccessReviewConsole } from "@/components/platform/access-review-console";
import { onConsoleHost } from "@/lib/platform/console-href";
import { readDataTableParams } from "@/lib/platform/data-table-params";
import { recentMonthKeys } from "@/lib/platform/access-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * 🔴 EVERY EXPORT OF A `"use server"` BOUNDARY IS A PUBLIC HTTP ENDPOINT.
 * These two are one hop from the guarded implementations in
 * `@/server/platform/access-review`, which call `requireCapability()`
 * before touching anything. Nothing is decided here.
 */
async function revoke(input: { itemIds: string[]; reason: string }) {
  "use server";
  const result = await bulkRevokeAccess(input);
  return result.ok
    ? ({ ok: true, data: result.data } as const)
    : ({ ok: false, error: result.error } as const);
}

async function markReviewed(input: {
  itemIds: string[];
  periodKey: string;
  note: string;
}) {
  "use server";
  const result = await markAccessReviewed(input);
  return result.ok
    ? ({ ok: true, data: result.data } as const)
    : ({ ok: false, error: result.error } as const);
}

export default async function AccessReviewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const month = typeof params.month === "string" ? params.month : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Access review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every standing grant that stood, and every time one of us went inside a
          customer&rsquo;s workspace, in one calendar month. Who, into which workspace,
          when, for how long, under what stated reason, and whether it is still open.
          Marking a row reviewed writes your name and the time into the action register.
        </p>
      </div>

      <Suspense key={month ?? "default"} fallback={<Skeleton />}>
        <Review params={params} />
      </Suspense>
    </div>
  );
}

async function Review({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const month = typeof params.month === "string" ? params.month : undefined;

  /**
   * 🔴 THE SELECTION IS READ OUT OF THE QUERY STRING, ON THE SERVER, AND
   * IS STILL NOT TRUSTED. `?ar_sel=` is written by `<DataTable>` so a
   * narrowed batch survives a refresh and can be pasted into a ticket —
   * which also means anybody can type any uuid into it. It is passed down
   * ONLY so the table arrives with the same rows ticked. Every id is
   * re-parsed, re-fetched by id and re-authorised inside the transaction
   * in `bulkRevokeAccess()` before a single row is written.
   */
  const table = readDataTableParams("ar", params, {
    sortKeys: ["kind", "who", "workspace", "startedAt", "minutes", "state", "reviewed"],
    pageSize: 50,
    maxSelected: 200,
  });

  const [result, operator, isConsole] = await Promise.all([
    listAccessReview({ month }),
    getPlatformOperator(),
    onConsoleHost(),
  ]);

  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {result.error}
      </p>
    );
  }

  const page = result.data;
  // ⚠️ A COURTESY, NOT A CONTROL. `bulkRevokeAccess()` demands
  // `staff:manage` for itself; hiding the button only spares an operator
  // a refusal they could not have predicted.
  const canRevoke = operator?.capabilities.includes("staff:manage") ?? false;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Access with no stated reason</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {page.findingCount}
            {/* ⭐ First card on the page, because this is the finding an
                auditor is looking for: access nobody justified in writing. */}
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
              listed first in the table below
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Still active</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {page.activeCount}
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
              grants and sessions open right now
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Not yet reviewed</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {page.unreviewedCount}
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
              of {page.rows.length} in {page.periodLabel}
            </span>
          </CardContent>
        </Card>
      </div>

      <AccessReviewConsole
        rows={page.rows}
        isConsoleHost={isConsole}
        periodKey={page.periodKey}
        periodLabel={page.periodLabel}
        monthKeys={recentMonthKeys(new Date(), 15)}
        initialSelectedIds={table.selectedIds}
        canRevoke={canRevoke}
        truncated={page.truncated}
        onBulkRevoke={revoke}
        onMarkReviewed={markReviewed}
      />

      <p className="text-xs text-muted-foreground">
        &ldquo;Reviewed&rdquo; is not a column in any table — there is no access-review
        table and this console does not create one. It is derived by reading the action
        register back for entries of type <code className="font-mono">
        platform_access_review</code> against each row&rsquo;s id. That costs three
        things, stated rather than hidden: there is no unique constraint, so reviewing a
        row twice writes two entries; the read therefore takes the LATEST entry per row;
        and the register is append-only, so a review recorded in error can only be
        superseded, never removed.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
