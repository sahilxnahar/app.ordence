/**
 * Ordence — Settings ▸ Branding
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * The first screen in this product that READS `tenants.branding`. Three
 * code paths have written that column since 0091 — the seed script,
 * `claim-slug.ts` and the Clerk webhook — and until this wave nothing
 * rendered any of it. Built-and-unreachable is this codebase's
 * characteristic defect; this is one instance of it closed.
 *
 * ⚠️ THE SAME SCREEN SERVES THE FIRST RUN. `?first-run=1` changes the
 * copy and offers "Skip for now"; it does not change what the screen
 * does. A separate onboarding page would be a second implementation of
 * the same form, and the second one is the one that stops matching.
 */

import { requirePageContext } from "@/server/tenant-context";
import { parseBranding } from "@/lib/branding/schema";
import { BrandingForm } from "@/components/branding/branding-form";

export const dynamic = "force-dynamic";

export default async function BrandingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requirePageContext();
  const params = await searchParams;
  const firstRun = params["first-run"] === "1";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Branding</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your logo and colour, used in the sidebar, on your sign-in page at your own
          address, and on the invoices you send.
        </p>
      </div>

      <BrandingForm
        tenantId={ctx.tenant.id}
        tenantName={ctx.tenant.name}
        branding={parseBranding(ctx.tenant.branding)}
        firstRun={firstRun}
      />
    </div>
  );
}
