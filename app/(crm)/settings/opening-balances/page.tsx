/**
 * Ordence — ⭐⭐ Opening Balances
 * Version: v1.58.0-alpha (Batch 58)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY NEW CUSTOMER NEEDS THIS ON DAY ONE, AND THERE WAS NO WAY TO
 *    DO IT
 * ══════════════════════════════════════════════════════════════════════
 * A business that moves to Ordence in July arrives carrying a position: a
 * trial balance, invoices customers have not paid, bills it has not paid,
 * and stock on the shelf. Until this screen existed there was nowhere to
 * put any of it, so the first balance sheet Ordence produced said the
 * company had no bank balance, no debtors, no creditors and no capital.
 *
 * ⚠️ AND IT SAID SO FOREVER. An opening position is not a number that can
 * be corrected later: every report between the switch-over and the
 * correction was computed from the wrong base, and restating them means
 * restating a year. The first statement a new customer runs is the one
 * that decides whether they believe the software, and until now it was
 * guaranteed to be wrong.
 *
 * ⚠️ IT IS A SEPARATE SCREEN FROM `Settings → Import`, DELIBERATELY.
 * That screen loads LISTS — contacts, companies, parties — which can go
 * in any order on any day. This is one moment described by four files
 * that have an order, and the order is the difference between a balance
 * sheet that agrees with its own ageing report and one that does not.
 * Folding these four in as four more radio buttons would present them as
 * interchangeable with a contact list, and the sequence would be
 * invisible at exactly the moment it matters.
 *
 * ⚠️ SERVER COMPONENT HANDING THE ACTIONS DOWN AS PROPS, the same shape
 * `app/(crm)/settings/import/page.tsx` uses: the wizard needs `useState`,
 * and passing the actions as props keeps `server/actions/import.ts` out
 * of the client module graph.
 */

import Link from "next/link";
import { Scale } from "lucide-react";
import { OpeningBalanceWizard } from "@/components/import/opening-balance-wizard";
import { commitImport, previewImport } from "@/server/actions/import";

export const dynamic = "force-dynamic";

export default function OpeningBalancesPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Scale className="h-5 w-5" aria-hidden="true" />
          Opening balances
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The position you are carrying over from your old system, as at the day you
          switch. Nothing is written until you have seen a dry run of exactly what
          will happen.
        </p>
      </header>

      {/*
        ⭐ THE THREE PROMISES, ABOVE THE FORM, BECAUSE THEY ARE WHAT MAKES
        SOMEBODY WILLING TO POST A JOURNAL ENTRY THEY CANNOT UNDO FROM A
        SPREADSHEET THEY HAVE NOT CHECKED.

        Each is a real property of the implementation rather than
        reassurance: the dry run is the same code path as the import, the
        balance rule is in `lib/import/opening.ts`, and the re-run key is
        a unique index in the database rather than a check somebody could
        forget.
      */}
      <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
        <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
          Three things worth knowing before you start.
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-emerald-900/90 dark:text-emerald-100/90">
          <li>
            <strong>Your opening position becomes a real journal entry.</strong> Not
            a number stored beside the ledger — one balanced entry, dated the day you
            say, which appears in your trial balance, your balance sheet, every
            account statement it touches and your Tally export without any of them
            being told about it.
          </li>
          <li>
            <strong>A trial balance that does not balance is refused.</strong> No
            suspense account is invented for you. The dry run tells you the
            difference in rupees and which side is short, while you still have the
            file open and can find it.
          </li>
          <li>
            <strong>Running the same file twice cannot double your books.</strong>{" "}
            The opening entry is keyed on the date it is as at, and the database
            holds that key unique — a second upload is recognised and posts nothing.
          </li>
        </ul>
      </section>

      <p className="text-sm text-muted-foreground">
        Customers, vendors, stock items and your chart of accounts are not created
        here — a row that names one you do not have is reported rather than guessed
        at. Load those first from{" "}
        <Link href="/settings/import" className="underline underline-offset-2">
          Settings → Import
        </Link>
        , then come back.
      </p>

      <OpeningBalanceWizard preview={previewImport} commit={commitImport} />
    </div>
  );
}
