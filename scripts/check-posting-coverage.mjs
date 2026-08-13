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
  "labour",
  "metering",
  "billing",
  "sales-bookings",
  "tds",
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
   * ⚠️ CORRECTED IN v1.0.0-rc.2. I previously wrote that labour needed
   * "five legs with statutory due dates". That was wrong about the
   * blocker: `server/actions/labour.ts` has no payroll run at all.
   * Attendance, piece-rate entries and rosters are INPUTS to a wage
   * calculation, not economic events — there is no document to post.
   * The payroll run has to be built before posting is even a question.
   */
  labour:
    "No payroll run exists. Attendance and piece-rate entries are inputs, not documents — there is nothing to post yet. Needs a payroll run first. Session 10b.",
  metering: "Consumption billing produces revenue and has no posting path yet. Session 12.",
  billing:
    "Subscription invoices are OUR revenue rather than a tenant's. Different chart of accounts, different owner. Session 12.",
  /**
   * ⚠️ CORRECTED IN v1.0.0-rc.3. The blocker was never the design
   * decision — that is settled (the counterparty is the BOOKING). A
   * booking by itself moves no money: it reserves a unit. The economic
   * events are the demand notice, the receipt and possession, and all
   * three now post from `receivables`.
   *
   * What remains is genuinely separate: FORFEITURE on cancellation and
   * BROKERAGE payable to a channel partner. Both are real journals with
   * no action behind them yet.
   */
  "sales-bookings":
    "A booking reserves a unit and moves no money. What is missing is cancellation forfeiture and channel-partner brokerage — neither has an action yet. Session 11b.",
  tds: "TDS is deducted at PAYMENT, and vendor payment posting is not built yet. Session 10.",
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
