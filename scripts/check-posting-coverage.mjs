#!/usr/bin/env node
/**
 * Ordence — ⭐ check:posting — THE SEVENTH GATE
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * The sales invoice subsystem was built across Phases 49–57 and posted
 * NOTHING to `journal_entries`. Every invoice was absent from the P&L,
 * the balance sheet, the trial balance and the Tally export — which reads
 * the ledger and only the ledger.
 *
 * Nothing crashed. No test failed. The module registry said `live`.
 * It was found by reading the exporter's header comment, months later.
 *
 * ⚠️ A RULE THAT ONLY LIVES IN SOMEBODY'S ATTENTION IS A RULE THAT
 * LAPSES THE WEEK THEY LOOK SOMEWHERE ELSE. So it becomes a gate, in the
 * shape of `check:sql` — which is what caught the four unprotected
 * tables in 0046.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT ASSERTS
 * ══════════════════════════════════════════════════════════════════════
 * An action module that writes a FINANCIAL DOCUMENT must have a path to
 * the ledger — it imports a posting helper, or it is on the declared
 * backlog below with a reason.
 *
 * ⚠️ THE BACKLOG IS EXPLICIT AND DATED, NOT A PATTERN THAT QUIETLY
 * MATCHES EVERYTHING. A gate whose exemption list is a wildcard is a gate
 * that passes forever. Each entry names the subsystem and why it has not
 * been done, so the list can only shrink by someone deciding to shrink it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ACTIONS_DIR = join(process.cwd(), "server", "actions");

/**
 * Modules that create documents with an economic effect. Each one either
 * posts, or appears in KNOWN_UNPOSTED with a reason.
 */
const FINANCIAL_MODULES = [
  "sales-invoices",
  "purchases",
  "receivables",
  "ra-bills",
  /**
   * ⭐⭐⭐ `labour` REPLACED BY `payroll` IN v1.23.0-alpha, AND IT IS A
   * DECISION RATHER THAN A RELABELLING.
   *
   * 🔴 `labour` WAS NEVER THE MODULE WITH THE ECONOMIC EFFECT, and the
   * note that used to sit in KNOWN_UNPOSTED said so: attendance, piece
   * rates and rosters are INPUTS to a wage calculation. There is no
   * document to post, and asking `labour.ts` to post would mean
   * inventing a journal for an event that has none.
   *
   * ⭐ THE DOCUMENT IS THE PAYROLL RUN, and it now exists. It posts the
   * gross to Salaries and Wages, the employer's own contributions as
   * separate expenses, and five statutory liabilities — which is where
   * the cost of employing people actually reaches the ledger.
   *
   * ⚠️ SITE LABOUR REMAINS UNPOSTED AND CORRECTLY SO. Contract workers
   * are paid through their contractor's RA bill, and `ra-bills` is on
   * this list and posts.
   */
  "payroll",
  "metering",
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐⭐ `billing` REMOVED FROM THIS LIST IN v1.28.0-alpha, AND IT IS
   *        A CATEGORY CORRECTION RATHER THAN A COMPLETION
   * ══════════════════════════════════════════════════════════════════
   * Its excuse read: "Subscription invoices are OUR revenue rather than
   * a tenant's. Different chart of accounts, different owner."
   *
   * 🔴 THAT IS NOT A REASON IT HAS NOT POSTED YET. IT IS A REASON IT
   * NEVER WILL. `server/actions/billing.ts` handles a tenant's
   * subscription to ORDENCE — what they owe us. It belongs in Ordence's
   * own books, which are not in this database and are not a tenant
   * ledger. There is no correct journal for it to write here.
   *
   * ⚠️ AND A DEBT LIST THAT CONTAINS SOMETHING THAT CAN NEVER BE PAID
   * OFF STOPS BEING A DEBT LIST. It can never reach zero, so "8 of 10"
   * reads as unfinished work forever and nobody looks at the remaining
   * entry closely enough to notice it is not work at all.
   *
   * ⭐ Same decision as `labour` → `payroll` and `tds` →
   * `vendor-payments` before it: the list is corrected, not padded.
   */
  "sales-bookings",
  /**
   * ⭐ ADDED IN v1.25.0-alpha, AND ADDING IT IS THE POINT.
   *
   * Brokerage is the largest single selling cost a developer has, and
   * it carries a TDS liability the department charges interest on. A
   * module that moves that much money belongs on this list whether or
   * not it posts — putting it here is what makes the answer checkable
   * instead of assumed.
   */
  "sales-brokerage",
  /**
   * ⭐⭐ RENAMED FROM `tds` IN v1.11.0, AND IT IS A CORRECTION RATHER
   *     THAN A RELABELLING.
   *
   * 🔴 `tds` was never the module with the economic effect. Tax is
   *    deducted when the money MOVES, so the document that posts is the
   *    VENDOR PAYMENT, and a `tds_deductions` row is a record of a
   *    withholding that happened inside one.
   *
   * ⚠️ The same reasoning already applied to `labour` below: attendance
   * and piece rates are INPUTS to a wage calculation, not economic
   * events. A TDS deduction is an input to a payment in exactly the
   * same way, and asking `tds.ts` to post would mean inventing a
   * journal for an event that has none.
   *
   * ⭐ The payment posts three legs — the creditor cleared in full, the
   * bank credited with the net, and TDS payable credited with the
   * withholding. That is where the tax reaches the ledger.
   */
  "vendor-payments",
];

/**
 * ⚠️ REMOVED FROM THE FINANCIAL LIST IN v1.0.0-rc.2, DELIBERATELY.
 *
 * `variations` was on it because a variation changes a contract value —
 * but approving one moves no money on its own. The cost arrives when the
 * RA bill that carries the varied work is certified, and that now posts.
 * Leaving it listed would make the gate demand a posting for an event
 * that has no economic effect, and the only way to satisfy that demand is
 * to invent a journal.
 *
 * ⚠️ A LIST THAT NEVER SHRINKS BY DECISION ONLY SHRINKS BY NEGLECT.
 */

/**
 * ⚠️ EVERY ENTRY IS A DEBT, NOT AN EXEMPTION. Written down so it is
 * countable, and so removing one is a deliberate act.
 */
const KNOWN_UNPOSTED = {

  /**
   * ⭐⭐⭐ `metering` REMOVED IN v1.28.0-alpha, AFTER TWENTY-SIX
   *       SESSIONS ON THIS LIST.
   *
   * It read: "Consumption billing produces revenue and has no posting
   * path yet. Session 12." That was accurate for the whole of that
   * time — `closeMeterPeriod` computed an energy charge, a fixed
   * charge, electricity duty and a net-metering export credit, stamped
   * a total, and the money went nowhere.
   *
   * `postMeterBill` now books it: the recovery to income, the duty to a
   * LIABILITY because it is collected for the State, and the export
   * credit as contra-revenue — with a payable rather than a negative
   * debtor when a solar month comes out negative.
   *
   * ⚠️ AND `billing` LEFT THE MODULE LIST ENTIRELY, above, because it
   * was never debt. With both gone this list is EMPTY, which is the
   * first time it has been — and an empty list is only meaningful
   * because the entries left it one at a time, by decision, each with
   * the reasoning written down.
   */
  /**
   * ⭐⭐⭐ `sales-bookings` REMOVED IN v1.25.0-alpha, AFTER ELEVEN
   *       SESSIONS ON THIS LIST.
   *
   * It read: "A booking reserves a unit and moves no money. What is
   * missing is cancellation forfeiture and channel-partner brokerage —
   * neither has an action yet."
   *
   * Both now exist. `postBookingCancellation` clears the advance, the
   * unpaid demands and the output tax in one entry, posting the
   * forfeiture as income and the refund as a liability. And
   * `sales-brokerage.ts` books the expense, the 194H deduction and the
   * payable.
   *
   * ⚠️ THE ENTRY IS DELETED RATHER THAN REWORDED. A list that never
   * shrinks by decision only shrinks by neglect.
   */
  /**
   * ⭐⭐ `tds` REMOVED FROM THIS LIST IN v1.11.0, BY DECISION.
   *
   * It read: "TDS is deducted at PAYMENT, and vendor payment posting is
   * not built yet." That was the correct diagnosis for twenty sessions.
   * `server/actions/vendor-payments.ts` now creates the payment and
   * posts it, crediting TDS payable as one of its legs, so the entry has
   * been removed rather than reworded.
   *
   * ⚠️ A list that never shrinks by decision only shrinks by neglect.
   */
};

/** Any of these means the module has a path to the ledger. */
const POSTING_MARKERS = [
  "@/server/accounting/post-sales",
  "journalEntries",
  "postSalesInvoice",
  "postPurchaseInvoice",
];

let failures = 0;
const posting = [];
const declared = [];

for (const name of FINANCIAL_MODULES) {
  const file = join(ACTIONS_DIR, `${name}.ts`);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.error(`❌ ${name}.ts is listed as financial and does not exist.`);
    failures += 1;
    continue;
  }

  const posts = POSTING_MARKERS.some((m) => source.includes(m));
  const excused = Object.prototype.hasOwnProperty.call(KNOWN_UNPOSTED, name);

  if (posts && excused) {
    /**
     * ⚠️ THIS IS A FAILURE, NOT A PASS. A module that now posts while
     * still sitting on the debt list means the list is lying — and the
     * next person reads it as "nine subsystems to do" when it is eight.
     */
    console.error(
      `❌ ${name}.ts posts to the ledger AND is still on KNOWN_UNPOSTED. Remove the entry.`,
    );
    failures += 1;
  } else if (posts) {
    posting.push(name);
  } else if (excused) {
    declared.push(name);
  } else {
    console.error(
      `❌ ${name}.ts writes financial documents and has no path to journal_entries.\n` +
        `   Either import a posting helper, or add it to KNOWN_UNPOSTED with a reason.`,
    );
    failures += 1;
  }
}

/** ⚠️ An entry naming a module that is not financial is dead weight. */
for (const name of Object.keys(KNOWN_UNPOSTED)) {
  if (!FINANCIAL_MODULES.includes(name)) {
    console.error(`❌ KNOWN_UNPOSTED names "${name}", which is not in FINANCIAL_MODULES.`);
    failures += 1;
  }
}

const all = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts")).length;

if (failures > 0) {
  console.error(
    `\n❌ check:posting FAILED — ${failures} problem${failures === 1 ? "" : "s"}.\n`,
  );
  process.exit(1);
}

console.log(
  `\n✅ Posting coverage declared — ${posting.length} of ${FINANCIAL_MODULES.length} ` +
    `financial modules reach the ledger, ${declared.length} declared outstanding ` +
    `(${all} action modules scanned).`,
);
if (declared.length > 0) {
  console.log(`   Outstanding: ${declared.join(", ")}`);
}
