/**
 * Ordence — ⭐⭐ NEW LEAD
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 35)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FIRST CLICK OF A TRIAL WAS A 404
 * ══════════════════════════════════════════════════════════════════════
 * `/sales/leads` has had a "New lead" button since Phase 22. It pointed
 * here, and this route did not exist. Somebody evaluating the product
 * opened the pipeline, pressed the one obvious button and got a 404 —
 * while `createLead` sat complete underneath it, scoring the lead,
 * opening the channel-partner protection window and writing the first
 * entry of an append-only history.
 */

import Link from "next/link";
import { createLead, getSalesEntitlements } from "@/server/actions/sales-leads";
import { listLeadFormOptions } from "@/server/actions/sales-leads-form";
import { LeadForm, BLANK_LEAD } from "@/components/sales/lead-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "New lead · Ordence" };

export default async function NewLeadPage() {
  /**
   * ⚠️ THE ENTITLEMENT IS READ WITH THE NON-THROWING CHECK.
   *
   * `getSalesEntitlements` exists precisely so a page can decide what to
   * render. The throwing variant guards the write inside `createLead`; a
   * page that threw on it would show an error page instead of the upgrade
   * prompt, to the one person in the workspace who can act on it.
   */
  const [entitlements, options] = await Promise.all([
    getSalesEntitlements(),
    listLeadFormOptions(),
  ]);

  if (!entitlements.ok) {
    /**
     * ⚠️ A REFUSAL IS NOT AN EMPTY PAGE. "You do not have permission to
     * read leads" and "something went wrong" send the reader to two
     * different people, and only one of those two people can help.
     */
    return <Refusal message={entitlements.error} />;
  }

  if (!options.ok) return <Refusal message={options.error} />;

  const licensed = entitlements.data["sales.pipeline"] === true;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <Link href="/sales/leads" className="text-sm text-muted-foreground hover:underline">
          ← Pipeline
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New lead</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This files the enquiry and starts its history. The score, the
          reference and the first entry in the timeline are worked out here —
          you only record what the buyer told you.
        </p>
      </div>

      {licensed ? (
        <LeadForm
          action={createLead}
          mode="create"
          initial={BLANK_LEAD}
          projects={options.data.projects}
          partners={options.data.partners}
          owners={options.data.owners}
          withheld={options.data.withheld}
        />
      ) : (
        /*
          ⚠️ THE FORM IS NOT RENDERED AT ALL WHEN THE FEATURE IS UNPAID.
          `createLead` runs `guardSalesWrite` with `sales.pipeline`, so a
          rendered form would collect twenty fields and then throw all of
          them away behind a refusal. That is a worse experience than an
          honest sentence and a link to the plan.
        */
        <div className="rounded-lg border bg-muted/30 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Your plan does not include the sales pipeline, so new leads cannot
            be filed. Everything already recorded stays readable.
          </p>
          <Link href="/settings/billing" className="mt-3 inline-block text-sm underline">
            View plan
          </Link>
        </div>
      )}
    </main>
  );
}

function Refusal({ message }: { message: string }) {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <Link href="/sales/leads" className="text-sm text-muted-foreground hover:underline">
        ← Pipeline
      </Link>
      <p className="text-sm text-destructive">{message}</p>
    </main>
  );
}
