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
/**
 * ⭐⭐⭐ `createProject` AND `createUnit` ADDED AS CALLERS — wave two.
 *
 * 🔴 They are the only inserts into `projects` and `units`, and nothing
 * called either. Forty-three reachable actions read one of those two
 * tables: bookings, payment plans, cost control, RA bills, BOQ, meters,
 * rate cards, the cost-centre P&L, credit notes, timesheets. The whole
 * real-estate vertical read two tables that could not receive a row.
 */
import {
  listUnits,
  listProjects,
  releaseExpiredHolds,
  createProject,
  createUnit,
  /** ⭐ Wave 10 — see `components/sales/project-unit-forms.tsx`. */
  updateProject,
} from "@/server/actions/sales-inventory";
import { ProjectUnitForms } from "@/components/sales/project-unit-forms";
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
        {/*
          ⭐ WAVE 10 — THIS POINTED AT `/sales/inventory/new`, WHICH DOES
          NOT EXIST AND NEVER DID. It has been in `check:links`' dead-link
          budget since the page was written.

          ⚠️ FIXED BY REMOVING THE SECOND SURFACE, NOT BY BUILDING ONE.
          The forms that create a project and a unit are already on this
          page, below the header. A separate `/new` route would be a
          second place for the same eleven fields to drift, and this
          codebase has paid for that shape of duplication before.
        */}
        <Button asChild>
          <a href="#add-units">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add units
          </a>
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

  /**
   * ⚠️ WAVE 10 — MORE COLUMNS THAN BEFORE, AND STILL NOT THE WHOLE ROW.
   * The edit form needs the six fields it can change; `ProjectRow` also
   * carries counts, timestamps and dates that nothing on the client
   * reads, and passing a whole database row into a client component is
   * how a column added later silently reaches the browser.
   */
  const projectOptions = projectsResult.ok
    ? projectsResult.data.rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        addressLine: p.addressLine,
        city: p.city,
        state: p.state,
        reraNumber: p.reraNumber,
      }))
    : [];

  return (
    <div className="space-y-4">
      <div id="add-units" className="scroll-mt-6">
        <ProjectUnitForms
          projects={projectOptions}
          createProjectAction={createProject}
          createUnitAction={createUnit}
          updateProjectAction={updateProject}
        />
      </div>
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
    </div>
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
