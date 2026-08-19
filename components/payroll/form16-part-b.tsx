/**
 * Ordence — ⭐⭐ RENDERING PART B WITHOUT LOOKING LIKE A WHOLE FORM 16
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE RENDERING RULE, AND IT IS NOT ABOUT LAYOUT
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING ON THIS SCREEN MAY READ AS PART A. The heading says Part B, the
 * banner says Part A comes from TRACES, and the quarterly table is titled
 * as inputs for reconciliation with the words "not a certificate" in the
 * heading itself. An employee who prints this must not be able to hand it
 * to anybody as a complete Form 16, because a complete Form 16 that the
 * employer generated is not a Form 16 at all.
 *
 * ⚠️ NO CLIENT COMPONENT, NO STATE, NO EFFECT — the same position
 * `components/registers/register-view.tsx` takes and for the same reason.
 * A certificate is a document. Making it interactive would ship one
 * employee's entire salary and tax position to the browser as serialised
 * props in exchange for nothing.
 *
 * ⭐ A `null` CELL PRINTS THE WORDS "not recorded". Inherited deliberately
 * from the register renderer: an empty cell in the challan column reads
 * as "no challan needed", which is the opposite of what it means.
 */

import type { RegisterCell, RegisterRow } from "@/lib/registers/document";
import type { RegisterColumn } from "@/lib/registers/spec";
import type { Form16Document, Form16DocumentRefusal } from "@/lib/payroll/form16-document";

function Blank() {
  return <span className="text-muted-foreground italic">not recorded</span>;
}

function Cell({ value }: { value: RegisterCell }) {
  return value === null ? <Blank /> : <>{value}</>;
}

function Table({
  columns,
  rows,
}: {
  columns: readonly RegisterColumn[];
  rows: readonly RegisterRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                className={`border-b px-2 py-1 font-semibold ${
                  c.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {columns.map((c) => (
                <td
                  key={c.id}
                  className={`border-b px-2 py-1 align-top ${
                    c.align === "right" ? "text-right tabular-nums" : "text-left"
                  }`}
                >
                  <Cell value={row.cells[c.id] ?? null} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 🔴 THE BANNER IS NOT DISMISSIBLE AND IS NOT BELOW THE FOLD. It is the
 * first thing on the page because it is the one sentence that decides
 * whether the employer's obligation under s.203 has actually been met.
 */
function TracesBanner({ notice }: { notice: string }) {
  return (
    <div className="rounded border border-destructive bg-destructive/5 p-3">
      <p className="text-sm font-semibold">Part A is not produced here</p>
      <p className="mt-1 text-sm">{notice}</p>
      <p className="mt-1 text-sm">
        Give the employee the TRACES-signed Part A together with this Part B. Part B on its own is
        not a Form 16.
      </p>
    </div>
  );
}

export function Form16PartBView({ document }: { document: Form16Document }) {
  return (
    <section className="space-y-4">
      <TracesBanner notice={document.partANotice} />

      <header className="space-y-2 rounded border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{document.title}</h2>
          <span
            className={
              document.status === "final"
                ? "rounded border px-2 py-0.5 text-xs font-semibold"
                : "rounded border border-destructive px-2 py-0.5 text-xs font-semibold text-destructive"
            }
          >
            {document.status === "final" ? "Final" : "Provisional"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{document.statusReason}</p>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Employee: </dt>
            <dd className="inline">
              {document.employeeName} · PAN {document.employeePan}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">Employer: </dt>
            <dd className="inline">
              {document.employerName} ·{" "}
              {document.employerTan === null ? <Blank /> : `TAN ${document.employerTan}`}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">Financial year: </dt>
            <dd className="inline">
              {document.financialYear} (AY {document.assessmentYear})
            </dd>
          </div>
          {/*
            ⭐ THE REGIME AND THE DATE IT WAS ELECTED, ON THE FACE. An
            employee querying their tax a year later asks "which regime
            was I on", and the honest answer includes when they said so.
          */}
          <div>
            <dt className="inline font-medium">Regime elected for this year: </dt>
            <dd className="inline">
              {document.regime === "old" ? "Old" : "New (s.115BAC)"} · declared{" "}
              {document.regimeDeclaredOn}
            </dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          Content digest {document.digest} · generated {document.generatedOn}
        </p>
      </header>

      <Table columns={document.columns} rows={document.rows} />

      {document.warnings.length > 0 && (
        <section className="rounded border border-destructive p-4">
          <h3 className="text-sm font-semibold">Read before issuing</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {document.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {/*
        🔴 A SEPARATE BORDERED BLOCK WITH ITS OWN HEADING, DELIBERATELY
        NOT CONTIGUOUS WITH THE PART B TABLE. Two tables running together
        under one title is how a screenshot of this page becomes something
        an employee believes is a full certificate.
      */}
      <section className="rounded border-2 border-dashed p-4">
        <h3 className="text-sm font-semibold">{document.partAHeading}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Hold these figures next to the Part A you download from TRACES. TRACES certifies what was
          deposited and matched in OLTAS, not what was deducted, so any quarter showing an
          undeposited balance will appear short on the employee&rsquo;s Form 26AS.
        </p>
        <div className="mt-3">
          <Table columns={document.partAColumns} rows={document.partARows} />
        </div>
      </section>

      <section className="rounded border p-4">
        <h3 className="text-sm font-semibold">What this was built from</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {document.basis.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </section>

      {document.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {document.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * ⭐ THE REFUSAL IS A FIRST-CLASS SCREEN, NOT AN ERROR TOAST. It carries
 * the evidence, because "we cannot issue this" is a far weaker statement
 * than "we cannot issue this, no regime election is on file for 2024-25,
 * and here are the two years that do have one".
 */
export function Form16RefusalView({ refusal }: { refusal: Form16DocumentRefusal }) {
  return (
    <section className="space-y-4">
      <TracesBanner notice={refusal.partANotice} />
      <div className="rounded border border-destructive p-4">
        <h2 className="text-lg font-semibold">{refusal.title}</h2>
        <p className="mt-2 text-sm">{refusal.reason}</p>
        {refusal.evidence.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {refusal.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Checked {refusal.generatedOn}</p>
      </div>
    </section>
  );
}
