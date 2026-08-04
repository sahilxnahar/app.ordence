/**
 * Ordence — New Asset
 * Version: v0.7.0-alpha
 *
 * A server component whose only real job is to resolve two things and hand
 * them to the client form:
 *
 *   1. The tenant's dynamic field definitions, which decide what the
 *      "Details" section contains.
 *   2. The asset types this industry actually uses, so a law firm is not
 *      offered "warehouse" and a developer is not offered "policy".
 *
 * Both come from the tenant record. Neither is hard-coded per customer, and
 * neither requires a separate build.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/server/tenant-context";
import { resolveIndustryTemplate } from "@/lib/industry-templates";
import { getAssetFieldSpecs } from "@/server/actions/assets";
import { AssetForm } from "./asset-form";
import type { SelectOption } from "@/components/forms/form-fields";

export const dynamic = "force-dynamic";

/** "in_progress" → "In progress". Enum values are not display strings. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default async function NewAssetPage() {
  const ctx = await requirePageContext();

  const settings = (ctx.tenant.settings ?? {}) as Record<string, unknown>;
  const template = resolveIndustryTemplate(settings.industry);

  const specsResult = await getAssetFieldSpecs();
  const fields = specsResult.ok ? specsResult.data : [];

  const assetTypeOptions: SelectOption[] = template.assetTypes.map((t) => ({
    value: t,
    label: humanise(t),
  }));

  // The vocabulary shifts with the industry — "Asset" for a generic tenant,
  // "Unit" for a developer, "Matter" for a firm.
  const noun = template.terminology.asset ?? "Asset";

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Link
          href="/assets"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to {template.terminology.assets ?? "assets"}
        </Link>

        <h1 className="mt-2 text-2xl font-bold">New {noun.toLowerCase()}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {fields.length > 0 ? (
            <>
              The <strong>Details</strong> section below is generated from your
              workspace&rsquo;s field definitions — {fields.length} field
              {fields.length === 1 ? "" : "s"} across{" "}
              {new Set(fields.map((f) => f.fieldType)).size} input types.
            </>
          ) : (
            "No custom fields are defined for this workspace yet."
          )}
        </p>
      </div>

      {!specsResult.ok && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {specsResult.error} You can still fill in the standard fields below.
        </p>
      )}

      <AssetForm fields={fields} assetTypeOptions={assetTypeOptions} />
    </main>
  );
}
