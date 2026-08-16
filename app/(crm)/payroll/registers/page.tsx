/**
 * Ordence — ⭐⭐⭐ STATUTORY REGISTERS
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN AN INSPECTION ACTUALLY NEEDS
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has held the employees, the payslips, the attendance and the
 * leave ledger for several batches, and the only way to answer "show me
 * your wage register" was to export a spreadsheet and reformat it by
 * hand — which is how a register acquires figures that no payslip
 * supports. This screen generates the registers from the same rows the
 * payroll ran on.
 *
 * ⚠️ THE GUARD IS ON THE ACTIONS, NOT ON THIS ROUTE. A server action is
 * a POST to whatever URL the browser happens to be on, so rendering or
 * not rendering a table decides nothing. `listRegisterCatalogue` and
 * `generateRegister` each check permissions themselves, and the leave
 * and attendance registers additionally require `leave.read`.
 *
 * ⭐ THE URL IS THE DOCUMENT. Every choice is a query parameter, so a
 * register can be linked, bookmarked and reopened. See the picker.
 */

import Link from "next/link";
import {
  generateRegister,
  listRegisterCatalogue,
} from "@/server/actions/registers";
import { DEFAULT_RULE_SET_ID, isRegisterKind } from "@/lib/registers/forms";
import { RegisterPicker } from "@/components/registers/register-picker";
import { RegisterRefusalView, RegisterView } from "@/components/registers/register-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Statutory registers · Ordence" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function StatutoryRegistersPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    from?: string;
    to?: string;
    ruleSet?: string;
    state?: string;
  }>;
}) {
  const params = await searchParams;
  const catalogue = await listRegisterCatalogue();

  if (!catalogue.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Statutory registers</h1>
        <p className="text-sm text-destructive">{catalogue.error}</p>
      </main>
    );
  }

  const data = catalogue.data;

  /**
   * ⚠️ THE URL IS UNTRUSTED AND IS NARROWED HERE ONLY SO THE FORM CAN
   * RE-RENDER WITH THE CHOICE SELECTED. The action validates its own
   * input with zod and does not trust any of this.
   */
  const kind = isRegisterKind(params.kind) ? params.kind : "employee_register";
  const from = ISO.test(params.from ?? "") ? params.from! : data.defaultFrom;
  const to = ISO.test(params.to ?? "") ? params.to! : data.defaultTo;
  const ruleSetId = data.ruleSets.some((r) => r.id === params.ruleSet)
    ? params.ruleSet!
    : DEFAULT_RULE_SET_ID;
  const stateCode = data.states.includes((params.state ?? "").toUpperCase())
    ? (params.state ?? "").toUpperCase()
    : "";

  const result = await generateRegister({
    kind,
    from,
    to,
    ruleSetId,
    stateCode: stateCode === "" ? undefined : stateCode,
  });

  const chosen = data.ruleSets.find((r) => r.id === ruleSetId);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          Payroll
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Statutory registers</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The registers a labour inspector asks to see, generated from the same rows payroll ran
          on rather than typed. Nothing here is stored: a register is produced when you ask for
          it, and carries a content digest so you can tell whether a later copy is the same
          document.
        </p>
      </div>

      {/*
        🔴 THE SENTENCE THE WHOLE BATCH IS ABOUT, SAID BEFORE ANYTHING IS
        GENERATED. Somebody arriving here is about to hand a document to
        somebody with statutory powers, and the single most useful thing
        we can tell them is which parts of it we are not the source of.
      */}
      <div className="rounded border p-3 text-xs">
        <p className="font-semibold">A blank is not a nil.</p>
        <p className="mt-1 text-muted-foreground">
          Where a statutory column has no data behind it in Ordence, the column is printed with
          its heading and left blank, and the reason is listed above the table. Nothing is filled
          in with a plausible zero — a register handed to an inspector with a confident wrong
          figure is worse than one with a stated gap.
        </p>
        <p className="mt-1 text-muted-foreground">
          The register of loans and advances is not generated at all, because every column it
          requires is unsourced. Choosing it shows you what we can see instead, which is not the
          same thing as the register.
        </p>
        <p className="mt-1 text-muted-foreground">
          Form numbering differs by State and has been renumbered again by the Code on Wages and
          the OSH Code. Ordence prints a form number only where it carries one, and otherwise says
          so rather than borrowing another State&apos;s.
        </p>
      </div>

      <RegisterPicker
        registers={data.registers}
        ruleSets={data.ruleSets}
        states={data.states}
        selected={{ kind, from, to, ruleSetId, stateCode }}
      />

      {chosen !== undefined ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{chosen.label}</span> — {chosen.note}
        </p>
      ) : null}

      {!result.ok ? (
        <p className="text-sm text-destructive">{result.error}</p>
      ) : result.data.generated ? (
        <RegisterView document={result.data.document} />
      ) : (
        <RegisterRefusalView refusal={result.data.refusal} />
      )}

      {data.runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No payroll runs exist yet, so the wage register has nothing to draw on. It will report an
          empty period rather than an empty establishment.
        </p>
      ) : null}
    </main>
  );
}
