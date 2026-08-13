/**
 * Ordence — ⭐ CRM SETUP
 * Version: v1.21.0-alpha
 *
 * 🔴 `lead_sources` and `pipeline_stages` were created by 0061 in
 * v1.10.0 and nothing has referenced either table since. This is the
 * screen that batch 3 was missing.
 */

import {
  createLeadSource,
  createPipelineStage,
  getCrmSetup,
} from "@/server/actions/crm-setup";
import { CrmSetupPanel } from "@/components/crm-setup/crm-setup-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "CRM setup · Ordence" };

export default async function CrmSetupPage() {
  const result = await getCrmSetup();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">CRM setup</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">CRM setup</h1>
        <p className="text-sm text-muted-foreground">
          Where enquiries come from, and the stages they move through. Both drive
          every report about your pipeline, and neither can be answered until they
          exist.
        </p>
      </div>

      <CrmSetupPanel
        sources={result.data.sources}
        stages={result.data.stages}
        leadsWithNoSource={result.data.leadsWithNoSource}
        createSourceAction={createLeadSource}
        createStageAction={createPipelineStage}
      />
    </main>
  );
}
