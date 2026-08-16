/**
 * Ordence — ⭐⭐ RENDERING A REGISTER WITHOUT LYING IN THE GAPS
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE RENDERING RULE
 * ══════════════════════════════════════════════════════════════════════
 * A `null` cell is printed as "not recorded", in words, in a muted
 * style — never as an empty cell and never as a dash. An empty cell in a
 * money column reads as zero to every reader, and a dash reads as "nil"
 * to an inspector. The document's whole claim is that it distinguishes
 * "we do not know" from "it is nothing", and that claim lives or dies in
 * this component.
 *
 * ⚠️ NO CLIENT COMPONENT, NO STATE, NO EFFECT. A register is a document.
 * It renders on the server, it prints, and it has nothing to interact
 * with. Making it a client component would ship every employee's salary
 * to the browser as serialised props for no reason at all.
 *
 * ⭐ THE HEADER IS AS IMPORTANT AS THE TABLE. Form number (or its
 * stated absence), rule set, period, status, digest and the list of
 * columns that are blank — an inspector reads all six before the rows,
 * and every one of them is generated from the document rather than typed
 * here, so they cannot drift apart from what was actually built.
 */

import type { RegisterDocument, RegisterRefusal } from "@/lib/registers/document";
import { ATTENDANCE_MARK_LEGEND } from "@/lib/registers/build";

const STATUS_WORDS: Record<RegisterDocument["status"], string> = {
  final: "Final",
  provisional: "Provisional",
  snapshot: "Snapshot",
};

/** ⚠️ Words, not a dash. See the block comment. */
function Blank() {
  return <span className="text-muted-foreground italic">not recorded</span>;
}

export function RegisterView({ document }: { document: RegisterDocument }) {
  const dayColumns = document.columns.filter((c) => c.id.startsWith("d:"));

  return (
    <section className="space-y-4">
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
            {STATUS_WORDS[document.status]}
          </span>
        </div>

        {/*
          🔴 THE FORM NUMBER, OR THE SENTENCE THAT SAYS WE WILL NOT GUESS
          ONE. Never a placeholder, never "Form —".
        */}
        <p className="text-sm">
          {document.formNumber === null ? (
            <span className="text-muted-foreground">{document.citationLine}</span>
          ) : (
            <>
              <strong>{document.formNumber}</strong>{" "}
              <span className="text-muted-foreground">— {document.citationLine}</span>
            </>
          )}
        </p>

        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Period</dt>
            <dd>
              {document.periodFrom === null || document.periodTo === null
                ? "As at the generation date"
                : `${document.periodFrom} to ${document.periodTo}`}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Generated</dt>
            <dd>{document.generatedOn} (Asia/Kolkata)</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Rules</dt>
            <dd>{document.ruleSetLabel}</dd>
          </div>
          {/*
            ⭐ THE DIGEST, ON THE FACE OF THE DOCUMENT. Two printouts of
            the same register carry the same sixteen characters. Two that
            differ cannot. It is how somebody holding last quarter's copy
            settles in five seconds whether it is still the same
            document — and it is not a cryptographic seal, which the
            caption says out loud.
          */}
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Content digest</dt>
            <dd className="font-mono">{document.digest}</dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">{document.statusReason}</p>
      </header>

      {document.warnings.length > 0 ? (
        <div className="space-y-2 rounded border border-destructive p-3 text-xs">
          {document.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}

      {/*
        🔴 THE GAP LIST SITS ABOVE THE TABLE, NOT IN A FOOTNOTE.
        Somebody about to print this needs to know which columns they
        will be filling in by hand BEFORE they read the rows, not after.
      */}
      {document.gaps.length > 0 ? (
        <div className="rounded border p-3 text-xs">
          <p className="font-semibold">
            {document.gaps.length} column{document.gaps.length === 1 ? "" : "s"} on this form
            {document.gaps.length === 1 ? " is" : " are"} not sourced from Ordence.
          </p>
          <p className="mt-1 text-muted-foreground">
            They are printed with their headings and left blank. A blank means the fact is not
            recorded anywhere in this system. It does not mean nil, and nothing here fills one in
            with a plausible zero.
          </p>
          <ul className="mt-2 space-y-1">
            {document.gaps.map((gap) => (
              <li key={gap.columnId}>
                <span className="font-medium">{gap.label}</span>{" "}
                <span className="text-muted-foreground">— {gap.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-muted/40">
              {document.columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={`whitespace-nowrap px-2 py-2 font-semibold ${
                    column.align === "right" ? "text-right" : "text-left"
                  } ${column.sourcing.kind === "unsourced" ? "text-muted-foreground" : ""}`}
                  title={
                    column.sourcing.kind === "sourced"
                      ? `Source: ${column.sourcing.from}`
                      : `Not sourced: ${column.sourcing.why}`
                  }
                >
                  {column.label}
                  {column.sourcing.kind === "unsourced" ? (
                    <span className="ml-1 font-normal">(blank)</span>
                  ) : null}
                  {!column.statutory ? (
                    <span className="ml-1 font-normal text-muted-foreground">†</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {document.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, document.columns.length)}
                  className="px-2 py-6 text-center text-muted-foreground"
                >
                  No rows. That is an absence of records for this period, not a statement that
                  nothing happened.
                </td>
              </tr>
            ) : (
              document.rows.map((row) => (
                <tr key={row.key} className="border-b last:border-b-0">
                  {document.columns.map((column) => {
                    const value = row.cells[column.id] ?? null;
                    return (
                      <td
                        key={column.id}
                        className={`whitespace-nowrap px-2 py-1.5 ${
                          column.align === "right" ? "text-right tabular-nums" : "text-left"
                        }`}
                      >
                        {value === null ? <Blank /> : value}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        † Columns marked with a dagger are Ordence&apos;s own, not required by the form. They are
        included because they make the register checkable against the payroll it came from.
      </p>

      {dayColumns.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Day marks:{" "}
          {ATTENDANCE_MARK_LEGEND.map((m) => `${m.mark} = ${m.meaning}`).join(" · ")}. A day with
          no entry shows &ldquo;not recorded&rdquo; and is never treated as present.
        </p>
      ) : null}

      <div className="rounded border p-3 text-xs">
        <p className="font-semibold">What this document was built from</p>
        <ul className="mt-1 space-y-1 text-muted-foreground">
          {document.basis.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          The content digest above covers the columns and every cell, and deliberately excludes the
          generation date — so reprinting an unchanged register reproduces the same digest. It is a
          change detector for a human comparing two copies, not a cryptographic seal, and Ordence
          does not yet store the registers it has issued.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * 🔴 THE REFUSAL IS RENDERED AS PROMINENTLY AS A DOCUMENT WOULD BE.
 *
 * ⚠️ NOT AS AN ERROR TOAST. "Could not generate" in a red banner reads
 * as a bug and gets retried. This is not a failure — it is the correct
 * and permanent answer for this register given what Ordence records, and
 * the reader needs to leave understanding that they must maintain it
 * elsewhere.
 */
export function RegisterRefusalView({ refusal }: { refusal: RegisterRefusal }) {
  return (
    <section className="space-y-4">
      <header className="space-y-2 rounded border border-destructive p-4">
        <h2 className="text-lg font-semibold">{refusal.title}</h2>
        <p className="text-sm font-semibold text-destructive">Not generated.</p>
        <p className="text-sm text-muted-foreground">{refusal.reason}</p>
      </header>

      <div className="rounded border p-3 text-xs">
        <p className="font-semibold">What we can see, which is not the same as the register</p>
        <ul className="mt-1 space-y-1 text-muted-foreground">
          {refusal.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="rounded border p-3 text-xs">
        <p className="font-semibold">
          Every column this form requires, and why none of them can be filled
        </p>
        <ul className="mt-2 space-y-1">
          {refusal.gaps.map((gap) => (
            <li key={gap.columnId}>
              <span className="font-medium">{gap.label}</span>{" "}
              <span className="text-muted-foreground">— {gap.why}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
