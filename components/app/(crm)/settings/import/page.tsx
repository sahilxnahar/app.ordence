/**
 * Ordence — Import
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 UNTIL THIS PAGE EXISTED, THE ONLY WAY DATA GOT INTO ORDENCE WAS BY
 *    SOMEBODY TYPING IT
 * ══════════════════════════════════════════════════════════════════════
 * Every workspace started empty. A firm evaluating this product with 800
 * counterparties on file was being asked to re-key 800 counterparties
 * before the software did anything for them, and that is not a cost
 * anybody pays to try something out. It is the single largest obstacle
 * between a demo and a first paying customer, and nothing else on the
 * roadmap moves until it is gone.
 *
 * ⚠️ IT LIVES UNDER SETTINGS AND NOT ON EACH LIST PAGE, DELIBERATELY.
 * A per-entity "Import" button on `/companies` would be discoverable at
 * the moment of need, which is genuinely better — and it would also be N
 * screens, each free to drift. One screen with an entity picker is what
 * makes "add an entity" a table entry in `lib/import/entities.ts` rather
 * than a page. The list pages can link here later, pre-selecting an
 * entity, without any of this changing.
 *
 * ⚠️ THE PAGE IS A SERVER COMPONENT THAT HANDS THE ACTIONS DOWN AS PROPS.
 * The wizard needs `useState`, so it is a client component; passing the
 * two server actions as props keeps `server/actions/import.ts` out of the
 * client module graph while still letting the wizard call them. It is the
 * same shape `app/(crm)/orders/new/page.tsx` uses.
 */

import Link from "next/link";
import { UploadCloud } from "lucide-react";
import { ImportWizard } from "@/components/settings/import-wizard";
import { ImportRunsPanel } from "./import-runs-panel";
import {
  beginImportRun,
  commitImport,
  endImportRun,
  getImportRuns,
  previewImport,
  proposeImportMapping,
  recordMappingDecision,
} from "@/server/actions/import";

export const dynamic = "force-dynamic";

/**
 * ⚠️ ITS OWN COMPONENT SO A FAILURE TO READ THE RUNS DOES NOT TAKE THE
 * IMPORT SCREEN DOWN WITH IT. Somebody who cannot see their history can
 * still run an import; somebody who cannot run an import because the
 * history query failed has been given a worse product for no reason.
 */
async function PastRuns() {
  const result = await getImportRuns();
  if (!result.ok) return null;
  if (result.data.length === 0) return null;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">Imports so far</h2>
      <ImportRunsPanel runs={result.data} />
    </section>
  );
}

export default function ImportPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <UploadCloud className="h-5 w-5" aria-hidden="true" />
          Import from a spreadsheet
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring your existing records in from a CSV. Nothing is written until you
          have seen a dry run of exactly what will happen.
        </p>
      </header>

      {/*
        ⭐ THE TWO PROMISES, ABOVE THE FORM, BECAUSE THEY ARE WHAT MAKES
        SOMEBODY WILLING TO UPLOAD THEIR CUSTOMER LIST TO SOFTWARE THEY
        HAVE NOT BOUGHT YET.

        Both are real properties of the implementation rather than
        reassurance: the dry run is the same code path as the import
        (`lib/import/plan.ts`), and the de-duplication is matched on a
        natural key per entity (`lib/import/entities.ts`).
      */}
      <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
        <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
          Two things worth knowing before you start.
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-emerald-900/90 dark:text-emerald-100/90">
          <li>
            <strong>A dry run tells you the truth.</strong> The check and the import
            run the same code, so &ldquo;982 will be created, 18 will fail&rdquo;
            means exactly that.
          </li>
          <li>
            <strong>Running the same file twice will not double your data.</strong>{" "}
            Rows are matched against what you already have, and you choose what
            happens to a match before anything runs.
          </li>
        </ul>
      </section>

      {/*
        Not all-or-nothing, and said before rather than discovered after.
        A customer whose first import reports failures will otherwise
        assume nothing worked and start again — and starting again is the
        moment duplicate handling stops being theoretical.
      */}
      <p className="text-sm text-muted-foreground">
        Rows that fail do not stop the ones that work. If 18 rows out of 1,000 have
        a problem, the other 982 are imported and those 18 come back as a file you
        can fix and upload again.
      </p>

      {/*
        ⭐⭐ BATCH 58 — THE ONE IMPORT THAT IS NOT A LIST, LINKED FROM
        WHERE PEOPLE LOOK FOR IT.

        ⚠️ SOMEBODY MIGRATING WILL COME HERE FIRST, because "import" is
        the word they have in mind, and they will find companies and GST
        parties and conclude their opening balances cannot be entered.
        That conclusion is the exact defect Batch 58 fixed, so the pointer
        has to be on this page rather than only in the settings tabs.
      */}
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">
          Moving across mid-year?
        </strong>{" "}
        Your opening trial balance, unpaid customer invoices, unpaid vendor bills
        and stock on hand go in through{" "}
        <Link href="/settings/opening-balances" className="underline underline-offset-2">
          Opening balances
        </Link>
        . They describe one moment rather than four lists, they have an order, and
        that screen explains it.
      </p>

      {/*
        ⭐⭐ WAVE 6 — WHICH OF MY UPLOADS DID NOT FINISH.
        ⚠️ ABOVE THE WIZARD, not below it. Somebody coming back to this
        page after a migration that stopped is not here to start a new
        one, and a list at the bottom of a long form is a list nobody
        scrolls to.
      */}
      <PastRuns />

      <ImportWizard
        preview={previewImport}
        commit={commitImport}
        /*
          ⭐ WAVE 6 — the two actions that turn an upload into a
          migration. Passed as props rather than imported inside the
          wizard for the same reason `preview` and `commit` are: the
          component stays a pure function of what it is given, and the
          tests can drive it without a server.
        */
        beginRun={beginImportRun}
        endRun={endImportRun}
        /*
          ⭐ WAVE 6 — the mapping proposal. `propose` reads the headers
          and a sample of values and says what it thinks each column is,
          with a reason; `decide` records what the person did with that,
          including what they CHANGED, which is the only honest record of
          where the matcher is wrong.
        */
        propose={proposeImportMapping}
        decide={recordMappingDecision}
      />
    </div>
  );
}
