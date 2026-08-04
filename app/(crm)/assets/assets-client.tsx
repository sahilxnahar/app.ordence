"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  VirtualGrid,
  buildVirtualColumns,
  SafeValue,
  type VirtualGridRow,
  type DynamicFieldSpec,
  type CellEditPayload,
} from "@/components/crm/virtual-grid";
import { useTerm } from "@/components/layout/industry-provider";
import { updateAssetCell } from "@/server/actions/grid";
import { formatCurrency, formatNumber } from "@/lib/safe-render";

export type AssetRow = VirtualGridRow & {
  name: string;
  code: string | null;
  assetType: string;
  status: string;
  valueAmount: string | null;
  currency: string;
  areaValue: string | null;
  areaUnit: string | null;
  locality: string | null;
  dynamicAttributes: Record<string, unknown>;
};

/** Dynamic columns sourced from the asset's JSONB attributes. */
const DYNAMIC_FIELDS: DynamicFieldSpec[] = [
  { fieldName: "floor", label: "Floor", fieldType: "number", width: 90 },
  { fieldName: "configuration", label: "Config", fieldType: "text", width: 110 },
  { fieldName: "carpetAreaSqft", label: "Carpet (sqft)", fieldType: "number", width: 130 },
  { fieldName: "facing", label: "Facing", fieldType: "text", width: 120, editable: true },
  { fieldName: "pricing.allInPrice", label: "All-in Price", fieldType: "currency", width: 160, validation: { currencyCode: "INR" } },
];

export function AssetsClient({ rows }: { rows: AssetRow[] }) {
  const t = useTerm();

  /**
   * SEC-009 RESOLVED (v0.4.0).
   * Persists to the database via a tenant-scoped server action.
   * Throwing on failure is deliberate — it is what triggers the grid's
   * optimistic rollback, so a rejected save visibly reverts instead of
   * appearing to have worked.
   */
  const handleCellEdit = React.useCallback(async (payload: CellEditPayload) => {
    const result = await updateAssetCell({
      rowId: payload.rowId,
      columnId: payload.columnId,
      value: payload.value as string | number | boolean | null,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data;
  }, []);

  const columns = React.useMemo<ColumnDef<AssetRow, unknown>[]>(() => {
    const base: ColumnDef<AssetRow, unknown>[] = [
      {
        id: "name",
        header: t("asset.singular", "Asset"),
        accessorKey: "name",
        size: 260,
        cell: ({ getValue }) => (
          <span className="truncate font-medium">{String(getValue() ?? "")}</span>
        ),
      },
      { id: "code", header: "Code", accessorKey: "code", size: 170,
        cell: ({ getValue }) => (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {String(getValue() ?? "—")}
          </span>
        ) },
      { id: "status", header: "Status", accessorKey: "status", size: 130,
        cell: ({ getValue }) => (
          <SafeValue value={getValue()} spec={{ fieldName: "status", label: "Status", fieldType: "text" }} />
        ) },
      { id: "valueAmount", header: "Value", accessorKey: "valueAmount", size: 150,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.valueAmount
              ? formatCurrency(row.original.valueAmount, row.original.currency)
              : "—"}
          </span>
        ) },
      { id: "areaValue", header: "Area", accessorKey: "areaValue", size: 120,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.areaValue
              ? `${formatNumber(row.original.areaValue)} ${row.original.areaUnit ?? ""}`
              : "—"}
          </span>
        ) },
    ];

    return [...base, ...buildVirtualColumns<AssetRow>(DYNAMIC_FIELDS, "dynamicAttributes", handleCellEdit)];
  }, [t, handleCellEdit]);

  const [selected, setSelected] = React.useState<string[]>([]);

  return (
    <>
      <VirtualGrid
        columns={columns}
        data={rows}
        rowHeight={40}
        height={620}
        enableSelection
        onSelectionChange={setSelected}
        onCellEdit={handleCellEdit}
        queryKey={["assets"]}
        ariaLabel={t("asset.plural", "Assets")}
        emptyMessage={`No ${t("asset.plural", "assets").toLowerCase()} yet. Run the seed script to populate demo data.`}
      />
      {selected.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Bulk actions available for {selected.length} selected.
        </p>
      )}
    </>
  );
}
