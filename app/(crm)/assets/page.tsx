import Link from "next/link";
import { Plus } from "lucide-react";
import { and, eq, isNull, desc } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { requirePageContext } from "@/server/tenant-context";
import { AssetsClient, type AssetRow } from "./assets-client";

export const dynamic = "force-dynamic";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const ctx = await requirePageContext();
  const params = await searchParams;

  // Tenant predicate first, always.
  const conditions = [eq(assets.tenantId, ctx.tenant.id), isNull(assets.deletedAt)];

  // Only accept a type that exists in the enum — never interpolate raw input.
  const validTypes = new Set(assets.assetType.enumValues as readonly string[]);
  if (params.type && validTypes.has(params.type)) {
    conditions.push(eq(assets.assetType, params.type as (typeof assets.assetType.enumValues)[number]));
  }

  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      code: assets.code,
      assetType: assets.assetType,
      status: assets.status,
      valueAmount: assets.valueAmount,
      currency: assets.currency,
      areaValue: assets.areaValue,
      areaUnit: assets.areaUnit,
      locality: assets.locality,
      dynamicAttributes: assets.dynamicAttributes,
    })
    .from(assets)
    .where(and(...conditions))
    .orderBy(desc(assets.createdAt))
    .limit(1000);

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {params.type ? `${params.type.charAt(0).toUpperCase()}${params.type.slice(1)}s` : "Assets"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length.toLocaleString()} records · virtualized grid
          </p>
        </div>
        <Button asChild>
          <Link href="/assets/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New asset
          </Link>
        </Button>
      </div>
      <AssetsClient rows={rows as AssetRow[]} />
    </div>
  );
}
