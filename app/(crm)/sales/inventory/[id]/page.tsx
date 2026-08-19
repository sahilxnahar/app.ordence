/**
 * Ordence — ⭐⭐ ONE UNIT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY UNIT CODE IN THE INVENTORY GRID LINKED HERE AND THIS PAGE DID
 *    NOT EXIST
 * ══════════════════════════════════════════════════════════════════════
 * `/sales/inventory/:id` has been in the dead-link budget since the grid
 * was written. Behind it sat four actions with no caller:
 *
 *   holdUnit             put a unit on hold for a named lead
 *   releaseHold          let it go again
 *   setUnitAvailability  block it, or put it back on the market
 *   updateUnit           correct its price, area, facing, typology
 *
 * The inventory page could CREATE units and could not change one. A
 * mistyped price on a flat was permanent.
 *
 * ⚠️ THE UNIT IS FOUND BY FILTERING `listUnits` RATHER THAN BY A NEW
 * `getUnit` ACTION. `listUnits` already sweeps expired holds before
 * reading, already computes `holdHoursRemaining`, and already carries the
 * project name and the lead the unit is held for. A `getUnit` that did
 * none of that would show a lapsed hold as live , which is the one thing
 * the inventory page's own header calls the reason it is trusted.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Home } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  listUnits,
  holdUnit,
  releaseHold,
  setUnitAvailability,
  updateUnit,
} from "@/server/actions/sales-inventory";
import { listLeads } from "@/server/actions/sales-leads";
import { Badge } from "@/components/ui/badge";
import { UnitControls } from "./unit-controls";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  held: "On hold",
  booked: "Booked",
  blocked: "Blocked",
};

function formatPaise(minor: bigint | null): string {
  if (minor === null) return "—";
  const whole = minor / 100n;
  const paise = (minor % 100n).toString().padStart(2, "0");
  return `₹${new Intl.NumberFormat("en-IN").format(whole)}.${paise}`;
}

export default async function UnitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext();

  const [unitsResult, leadsResult] = await Promise.all([listUnits({}), listLeads({})]);
  if (!unitsResult.ok) notFound();

  const unit = unitsResult.data.rows.find((row) => row.id === id);
  if (!unit) notFound();

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canUpdate = can(subject, "units:update");
  const canHold = can(subject, "units:hold");
  const canBlock = can(subject, "units:block");

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/sales/inventory"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to inventory
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Home className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              {unit.code}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {unit.projectName ?? "no project"}
              {unit.tower ? ` · Tower ${unit.tower}` : ""}
              {unit.floor !== null ? ` · Floor ${unit.floor}` : ""}
            </p>
          </div>

          <Badge variant={unit.status === "available" ? "outline" : "secondary"}>
            {STATUS_LABELS[unit.status] ?? unit.status}
          </Badge>
        </div>
      </div>

      <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Price</dt>
          <dd className="font-semibold tabular-nums">{formatPaise(unit.priceMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Carpet area</dt>
          <dd className="font-semibold tabular-nums">
            {unit.carpetAreaSqft ? `${unit.carpetAreaSqft} sq ft` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Typology</dt>
          <dd className="font-semibold">{unit.typology ?? "—"}</dd>
        </div>
      </dl>

      {/*
        ⚠️ A LIVE HOLD IS STATED WITH ITS REMAINING TIME, not with a
        badge alone. `holdHoursRemaining` is computed after the expired
        holds are swept, so a hold shown here is a hold that is really
        still running.
      */}
      {unit.status === "held" && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          Held for {unit.heldForName ?? "somebody"}
          {unit.holdHoursRemaining !== null
            ? ` , ${unit.holdHoursRemaining} hour${unit.holdHoursRemaining === 1 ? "" : "s"} left.`
            : "."}
        </p>
      )}

      <UnitControls
        unitId={unit.id}
        status={unit.status}
        code={unit.code}
        tower={unit.tower ?? ""}
        floor={unit.floor}
        typology={unit.typology ?? ""}
        facing={unit.facing ?? ""}
        carpetAreaSqft={unit.carpetAreaSqft}
        builtUpAreaSqft={unit.builtUpAreaSqft}
        priceRupees={unit.priceMinor === null ? "" : (Number(unit.priceMinor) / 100).toFixed(2)}
        leads={
          leadsResult.ok
            ? leadsResult.data.rows.map((lead) => ({ id: lead.id, label: lead.name }))
            : []
        }
        canUpdate={canUpdate}
        canHold={canHold}
        canBlock={canBlock}
        update={updateUnit}
        hold={holdUnit}
        release={releaseHold}
        setAvailability={setUnitAvailability}
      />
    </main>
  );
}
