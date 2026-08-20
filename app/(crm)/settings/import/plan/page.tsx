/**
 * Ordence — ⭐⭐⭐ THE MIGRATION PLAN
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ORDER HAS ITS OWN PAGE AS WELL AS BEING STEP 1 OF THE WIZARD
 * ══════════════════════════════════════════════════════════════════════
 * The two are read at different moments by different people. Step 1 is
 * read by somebody who has a file in their hand and is about to load it.
 * This page is read a week earlier, by whoever is deciding what to export
 * out of the old system and in what order — often the customer's
 * accountant, who will never open the wizard at all, and who needs
 * something they can send to the person doing the exports.
 *
 * ⚠️ IT IS THE SAME COMPONENT AND THEREFORE THE SAME ORDER. A separate
 * "plan" written as prose would be a second copy of the graph that goes
 * stale the first time an entity is added — which is the defect this
 * whole wave is about.
 *
 * ⚠️ NO `onChoose`. Nothing here starts an import: this page is for
 * reading before there is a file. `LoadOrder` renders the choose control
 * only when it is given one, so the absence is the whole difference.
 */

import Link from "next/link";
import { ListOrdered } from "lucide-react";
import { LoadOrder } from "@/components/import/load-order";

export const dynamic = "force-static";

export default function ImportPlanPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListOrdered className="h-5 w-5" aria-hidden="true" />
          What to load, and in what order
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bringing a business across is a set of files loaded in a particular order.
          Load them in the wrong one and perfectly good files come back full of
          errors about records that simply are not in yet. This is the order, and
          every line says why.
        </p>
      </header>

      <LoadOrder />

      <p className="text-sm text-muted-foreground">
        When you have the files,{" "}
        <Link href="/settings/import" className="underline underline-offset-2">
          start with the import screen
        </Link>
        . When the loading is done,{" "}
        <Link href="/settings/import/cutover" className="underline underline-offset-2">
          check that it ties
        </Link>{" "}
        before you switch the old system off.
      </p>
    </div>
  );
}
