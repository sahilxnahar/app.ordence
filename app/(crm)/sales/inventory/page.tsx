/**
 * Ordence — Inventory
 * Version: v0.22.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE INVENTORY BOARD IS THE MOST TRUSTED SCREEN IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * A sales team quotes off it. If it says "available" for a flat that is
 * sold, somebody promises it to a buyer.
 *
 * Two consequences shaped this page:
 *
 *   1. THE COUNTS ARE OVER THE WHOLE FILTERED SET, not the page. A
 *      "12 available" that silently means "12 on this page of 50" is a
 *      number that gets quoted in a meeting and is wrong.
 *
 *   2. EXPIRED HOLDS ARE SWEPT ON LOAD. A hold whose deadline passed on
 *      Friday must not still read as held on Monday — the flat is free
 *      and somebody could be selling it.
 */

import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listUnits, listProjects, releaseExpiredHolds } from "@/server/actions/sales-inventory";
import { InventoryGrid } from "@/components/sales/inventory-grid";
import { SavedViewsShell } from "@/components/views/saved-views-shell";

export const dynamic = "force-dynamic";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Units, availability and holds across every project.
          </p>
        </div>
        <Button asChild>
          <Link href="/sales/inventory/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add units
          </Link>
        </Button>
      </div>

      <Suspense fallback={<GridSkeleton />}>
        {/*
          ⭐ PHASE 28. Additive: the grid below is untouched and is what
          renders until a view is chosen.

          ⚠️ AND THE GRID STAYS THE DEFAULT DELIBERATELY. It sweeps
          expired holds before reading and counts over the WHOLE filtered
          set rather than the page — the two properties this page's own
          header calls the reason it is the most trusted screen in the
          product. A generic table has neither.
        */}
        <SavedViewsShell objectKey="unit" hrefPattern="/sales/inventory/{id}">
          <InventoryView projectId={params.project} />
        </SavedViewsShell>
      </Suspense>
    </div>
  );
}

async function InventoryView({ projectId }: { projectId?: string }) {
  // ⚠️ Swept BEFORE reading, so the page never renders a lapsed hold.
  //
  // It is a database function, not a TypeScript predicate — two
  // definitions of "expired" drift, and the one that drifts is always
  // the one nobody is testing. Failures are ignored deliberately: a
  // sweep that cannot run must not take the inventory page down.
  await releaseExpiredHolds().catch(() => undefined);

  const [unitsResult, projectsResult] = await Promise.all([
    listUnits(projectId ? { projectId } : {}),
    listProjects(),
  ]);

  if (!unitsResult.ok) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
        <p className="text-sm text-muted-foreground">{unitsResult.error}</p>
      </div>
    );
  }

  return (
    <InventoryGrid
      summary={unitsResult.data.summary}
      total={unitsResult.data.total}
      projects={
        projectsResult.ok
          ? projectsResult.data.rows.map((p) => ({
              id: p.id,
              name: p.name,
              code: p.code,
              unitCount: p.unitCount,
              availableCount: p.availableCount,
              reraNumber: p.reraNumber,
            }))
          : []
      }
      selectedProjectId={projectId ?? null}
      rows={unitsResult.data.rows.map((unit) => ({
        id: unit.id,
        code: unit.code,
        tower: unit.tower,
        floor: unit.floor,
        typology: unit.typology,
        facing: unit.facing,
        carpetAreaSqft: unit.carpetAreaSqft,
        status: unit.status,
        priceMinor: unit.priceMinor ? unit.priceMinor.toString() : null,
        projectName: unit.projectName,
        heldForName: unit.heldForName,
        holdHoursRemaining: unit.holdHoursRemaining,
      }))}
    />
  );
}

function GridSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/30" />
      <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />
    </div>
  );
}
