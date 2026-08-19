/**
 * Ordence — Record Types
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SCREEN PHASE 24 DID NOT HAVE
 * ══════════════════════════════════════════════════════════════════════
 * The runtime-DDL engine has been complete and tested since Phase 24 and
 * no customer could reach any of it, because there was nothing to click.
 * This is the front door.
 *
 * ⚠️ THE RECORD COUNTS ARE ONE QUERY PER RECORD TYPE, and that is a
 * deliberate, bounded cost: `MAX_OBJECTS_PER_TENANT` is 50, so this page
 * issues at most fifty `count(*)`s, each against a table of the tenant's
 * own. The alternative — a single join over `dynamic_objects` — cannot be
 * written, because the rows live in fifty different tables whose names are
 * only known at runtime. The counts matter enough to pay for: the number
 * shown here is the number the drop dialog demands typed back.
 */

import { Suspense } from "react";
import { listDynamicObjects } from "@/server/actions/dynamic-objects";
import { ObjectList } from "@/components/dynamic/object-list";
import { liveRecordCount, toObjectSummary } from "./mapping";
import { Refusal } from "./refusal";

export const dynamic = "force-dynamic";

export default function ObjectsPage() {
  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Record types</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track something this product does not ship. Each record type you define gets
          its own table, with typed columns, real indexes and real foreign keys.
        </p>
      </div>

      <Suspense fallback={<ListSkeleton />}>
        <ObjectsView />
      </Suspense>
    </div>
  );
}

async function ObjectsView() {
  const result = await listDynamicObjects();
  if (!result.ok) return <Refusal message={result.error} />;

  const objects = await Promise.all(
    result.data.rows.map(async (object) =>
      toObjectSummary(
        object as Parameters<typeof toObjectSummary>[0],
        await liveRecordCount(object.id),
      ),
    ),
  );

  return <ObjectList objects={objects} />;
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/30" />
      <div className="h-72 animate-pulse rounded-lg border border-border bg-muted/30" />
    </div>
  );
}
