"use client";

/**
 * Ordence — Inventory Grid
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY STATUS IS NOT COMMUNICATED BY COLOUR ALONE
 * ══════════════════════════════════════════════════════════════════════
 * Around one man in twelve has some form of colour vision deficiency,
 * and this is a screen used mostly by men in a sales office. A
 * red/green availability board is a board a meaningful fraction of the
 * team cannot read.
 *
 * So every cell carries the status as TEXT as well. The colour is
 * reinforcement, never the message — which is also what makes the grid
 * legible in a printout, which is how it gets taken to a site meeting.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { UNIT_STATUS_LABELS, UNIT_STATUS_DESCRIPTIONS } from "@/lib/sales/inventory";
import type { UnitStatus } from "@/db/schema/sales";

export type InventoryUnit = {
  id: string;
  code: string;
  tower: string | null;
  floor: number | null;
  typology: string | null;
  facing: string | null;
  carpetAreaSqft: number | null;
  status: UnitStatus;
  /** Paise, as a string — bigint does not survive the server boundary. */
  priceMinor: string | null;
  projectName: string | null;
  heldForName: string | null;
  holdHoursRemaining: number | null;
};

export type InventoryProject = {
  id: string;
  name: string;
  code: string;
  unitCount: number;
  availableCount: number;
  reraNumber: string | null;
};

export type InventorySummary = {
  total: number;
  available: number;
  held: number;
  booked: number;
  sold: number;
  blocked: number;
  absorptionPct: number;
};

const STATUS_STYLES: Record<UnitStatus, string> = {
  available: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  held: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  booked: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  sold: "bg-slate-500/15 text-slate-700 border-slate-500/30",
  blocked: "bg-red-500/10 text-red-700 border-red-500/30",
};

/**
 * ⚠️ Lakh and crore, not thousands and millions.
 *
 * "₹85,00,000" is how the number is spoken, written and negotiated in
 * this market. "₹8,500,000" is the same value in a grouping that makes
 * an Indian reader stop and count digits.
 */
function formatPaise(minor: string | null): string {
  if (!minor) return "—";
  const rupees = BigInt(minor) / 100n;
  return `₹${new Intl.NumberFormat("en-IN").format(rupees)}`;
}

export function InventoryGrid({
  rows,
  projects,
  summary,
  total,
  selectedProjectId,
}: {
  rows: InventoryUnit[];
  projects: InventoryProject[];
  summary: InventorySummary;
  total: number;
  selectedProjectId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<UnitStatus | "all">("all");

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter((unit) => {
      if (statusFilter !== "all" && unit.status !== statusFilter) return false;
      if (!term) return true;
      return (
        unit.code.toLowerCase().includes(term) ||
        (unit.tower ?? "").toLowerCase().includes(term) ||
        (unit.typology ?? "").toLowerCase().includes(term) ||
        (unit.facing ?? "").toLowerCase().includes(term)
      );
    });
  }, [rows, query, statusFilter]);

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- Summary ---------------- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Units" value={summary.total} />
        <SummaryTile label="Available" value={summary.available} tone="emerald" />
        <SummaryTile label="Held" value={summary.held} tone="amber" />
        <SummaryTile label="Booked" value={summary.booked} tone="blue" />
        <SummaryTile label="Sold" value={summary.sold} tone="slate" />
        <SummaryTile
          label="Absorption"
          value={`${summary.absorptionPct}%`}
          hint="Excludes blocked units — they were never on the market."
        />
      </div>

      {/* ---------------- Projects ---------------- */}
      {projects.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Link
            href="/sales/inventory"
            className={`rounded-md border px-2.5 py-1 text-xs ${
              selectedProjectId ? "border-border" : "border-primary bg-primary/10"
            }`}
          >
            All projects
          </Link>
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/sales/inventory?project=${project.id}`}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                selectedProjectId === project.id
                  ? "border-primary bg-primary/10"
                  : "border-border"
              }`}
            >
              {project.name}
              <span className="ml-1.5 text-muted-foreground">
                {project.availableCount}/{project.unitCount}
              </span>
              {/*
                ⚠️ A project with no RERA number is flagged HERE, where
                somebody is about to quote from it. Advertising an
                unregistered project is an offence, and the warning is
                useless on a settings page nobody opens.
              */}
              {!project.reraNumber ? (
                <span className="ml-1.5 text-destructive" title="No RERA number recorded">
                  ⚠
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      {/* ---------------- Filters ---------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Unit number, tower, typology, facing…"
          className="h-9 max-w-xs"
          aria-label="Search units"
        />
        <label className="flex items-center gap-1.5 text-xs">
          Status
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as UnitStatus | "all")}
            className="rounded border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            {(Object.keys(UNIT_STATUS_LABELS) as UnitStatus[]).map((status) => (
              <option key={status} value={status}>
                {UNIT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ---------------- Grid ---------------- */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {visible.length} of {total} units
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Unit</th>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Carpet</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((unit) => (
              <tr key={unit.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link
                    href={`/sales/inventory/${unit.id}`}
                    className="font-medium hover:underline"
                  >
                    {unit.code}
                  </Link>
                  <div className="text-[11px] text-muted-foreground">
                    {unit.projectName ?? "—"}
                    {unit.tower ? ` · ${unit.tower}` : ""}
                    {unit.floor !== null ? ` · Floor ${unit.floor}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {unit.typology ?? "—"}
                  {unit.facing ? (
                    <span className="text-muted-foreground"> · {unit.facing}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums">
                  {unit.carpetAreaSqft
                    ? `${unit.carpetAreaSqft.toLocaleString("en-IN")} sq ft`
                    : "—"}
                </td>
                <td className="px-3 py-2">
                  {/*
                    ⚠️ TEXT plus colour. See the note at the top of this
                    file — colour alone excludes a real fraction of the
                    people who read this board.
                  */}
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLES[unit.status]}`}
                    title={UNIT_STATUS_DESCRIPTIONS[unit.status]}
                  >
                    {UNIT_STATUS_LABELS[unit.status]}
                  </span>
                  {unit.status === "held" && unit.heldForName ? (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      For {unit.heldForName}
                      {unit.holdHoursRemaining !== null && unit.holdHoursRemaining >= 0
                        ? ` · ${unit.holdHoursRemaining}h left`
                        : " · expired"}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatPaise(unit.priceMinor)}
                </td>
              </tr>
            ))}

            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? "No units yet." : "No units match those filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {visible.length.toLocaleString("en-IN")} of{" "}
        {total.toLocaleString("en-IN")} units. The summary above counts every
        unit matching the current project filter, not just this page.
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone?: "emerald" | "amber" | "blue" | "slate";
  hint?: string;
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "blue"
          ? "text-blue-700"
          : tone === "slate"
            ? "text-slate-700"
            : "";

  return (
    <div className="rounded-lg border border-border bg-card p-3" title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${toneClass}`}>
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
