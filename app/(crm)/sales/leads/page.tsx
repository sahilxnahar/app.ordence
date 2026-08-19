/**
 * Ordence — Sales Pipeline
 * Version: v0.22.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE BOARD IS THE DEFAULT VIEW AND THE LIST IS THE ALTERNATIVE
 * ══════════════════════════════════════════════════════════════════════
 * A sales executive opens this page to answer one question: who do I
 * call today? A board answers it at a glance; a table of 400 rows sorted
 * by creation date does not.
 *
 * The list still exists — a manager reconciling numbers wants rows, and
 * a board cannot be sorted by budget. Both read the same data through
 * the same tenant-scoped actions.
 */

import Link from "next/link";
import { Suspense } from "react";
import { Plus, LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPipelineBoard, listLeads } from "@/server/actions/sales-leads";
import { PipelineBoard, type BoardData } from "@/components/sales/pipeline-board";
import { LeadTable } from "@/components/sales/lead-table";
import { SavedViewsShell } from "@/components/views/saved-views-shell";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string; overdue?: string }>;
}) {
  const params = await searchParams;
  const view = params.view === "list" ? "list" : "board";

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Pipeline</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Leads, follow-ups and where every buyer stands.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="View">
            <Button
              asChild
              variant={view === "board" ? "secondary" : "ghost"}
              className="h-8 px-2.5"
            >
              <Link href="/sales/leads?view=board" aria-current={view === "board"}>
                <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                <span className="ml-1.5 text-xs">Board</span>
              </Link>
            </Button>
            <Button
              asChild
              variant={view === "list" ? "secondary" : "ghost"}
              className="h-8 px-2.5"
            >
              <Link href="/sales/leads?view=list" aria-current={view === "list"}>
                <List className="h-4 w-4" aria-hidden="true" />
                <span className="ml-1.5 text-xs">List</span>
              </Link>
            </Button>
          </div>

          <Button asChild>
            <Link href="/sales/leads/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New lead
            </Link>
          </Button>
        </div>
      </div>

      {/*
        ⚠️ Streamed. The board runs six counted queries; putting it
        behind a boundary means the page shell and the navigation paint
        immediately rather than the whole route waiting on the slowest
        column.
      */}
      <Suspense fallback={<BoardSkeleton />}>
        {/*
          ══════════════════════════════════════════════════════════════
          ⭐ PHASE 28 — THE SAVED-VIEW LAYER, WRAPPED AROUND WHAT WAS
             ALREADY HERE
          ══════════════════════════════════════════════════════════════
          ⚠️ `PipelineBoard` IS STILL THE DEFAULT AND IS NOT DEPRECATED.
          The generic board does not supersede it: `pipeline-board.tsx`
          knows that `won` is reached by registering a booking and must
          not be offered as a drop target, that a lead with a live
          booking cannot move backwards, and what a stale follow-up looks
          like. Those are Phase 22 rules in `lib/sales/pipeline.ts`, and
          a generic board that expressed them would need a rules engine
          per object — the exact thing `components/views/generic-kanban.tsx`
          says in its own header it will not grow.

          So the engine is ADDITIVE. Until somebody picks a saved view or
          changes a filter, this page is byte-for-byte the page it was.
        */}
        <SavedViewsShell objectKey="lead" hrefPattern="/sales/leads/{id}">
          {view === "board" ? <BoardView /> : <ListView status={params.status} />}
        </SavedViewsShell>
      </Suspense>
    </div>
  );
}

async function BoardView() {
  const result = await getPipelineBoard({});

  if (!result.ok) {
    return <Refusal message={result.error} />;
  }

  const columns: BoardData[] = result.data.columns.map((column) => ({
    status: column.status,
    total: column.total,
    shown: column.shown,
    truncated: column.truncated,
    leads: column.leads.map((lead) => ({
      id: lead.id,
      reference: lead.reference,
      name: lead.name,
      status: lead.status,
      temperature: lead.temperature,
      source: lead.source,
      score: lead.score,
      locality: lead.locality,
      isNri: lead.isNri,
      urgency: lead.urgency,
      // The board reads `booked` as the signal. The server re-checks
      // against the bookings table before allowing any move — this is
      // only what the client uses to avoid offering an obvious refusal.
      hasLiveBooking: lead.status === "booked" || lead.status === "won",
    })),
  }));

  return <PipelineBoard columns={columns} />;
}

async function ListView({ status }: { status?: string }) {
  const result = await listLeads(status ? { status: [status] } : {});

  if (!result.ok) {
    return <Refusal message={result.error} />;
  }

  return (
    <LeadTable
      rows={result.data.rows.map((lead) => ({
        id: lead.id,
        reference: lead.reference,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        status: lead.status,
        temperature: lead.temperature,
        source: lead.source,
        score: lead.score,
        locality: lead.locality,
        isNri: lead.isNri,
        timezone: lead.timezone,
        urgency: lead.urgency,
        activityCount: lead.activityCount,
        partnerFirmName: lead.partnerFirmName,
        nextFollowUpAt: lead.nextFollowUpAt ? lead.nextFollowUpAt.toISOString() : null,
      }))}
      total={result.data.total}
    />
  );
}

/**
 * ⚠️ A refusal is rendered as a message, not thrown.
 *
 * The three gates in front of every sales write return sentences aimed
 * at different people — "upgrade", "ask your admin", "your workspace is
 * read-only". Throwing would replace all three with a generic error
 * page and lose the distinction that makes them useful.
 */
function Refusal({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/settings/billing">View plan</Link>
      </Button>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="h-64 w-72 shrink-0 animate-pulse rounded-lg border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}
