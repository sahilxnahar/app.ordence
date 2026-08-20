/**
 * Ordence — ⭐⭐ THE TAX AUDIT TRAIL INDEX: WHICH LINES CAN PROVE THEIR RATE
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS SCREEN ANSWERS
 * ══════════════════════════════════════════════════════════════════════
 * "Which of my outward-supply lines can prove where their tax came from,
 *  and which cannot?"
 *
 * SQL 0146 made the rate pin tenant-true. 0147 made it mean something.
 * 0148 backfilled it wherever pinning was IDENTIFICATION rather than
 * INFERENCE, and named every row where it was not — that naming is the
 * view `gst_rate_pin_status`, and this page is the only place a human can
 * read it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO PASS/FAIL BADGE. NO PERCENTAGE. NO THRESHOLD. NOT ANYWHERE.
 * ══════════════════════════════════════════════════════════════════════
 * This product has already shipped a coverage check written
 *
 *     CASE WHEN count(*) >= 10 THEN 'PASS' ELSE 'FAIL' END
 *
 * for a property that had to hold on 303 tables. It reported PASS at 48,
 * and it reported PASS for as long as nobody looked, because a green
 * badge is an instruction to stop reading.
 *
 * ⭐ SO THE DELIVERABLE HERE IS A NUMBER THE READER INTERPRETS. Every
 * bucket is a count of lines and a count of documents, in a fixed order,
 * with one plain sentence saying what the bucket MEANS and one saying
 * what to DO. If 12,000 lines are traceable and 4 are not, the reader can
 * see both figures and decide whether four matters — which, on the four
 * that an officer picks, it does.
 *
 * ⚠️ THE VIEW ANSWERS AS AT NOW. A line that reads
 * `unbackfillable_no_rate_in_force` today reads `pinnable` tomorrow if
 * somebody adds the rate period that was in force on the document's date.
 * That is deliberate — it is a worklist and the point of a worklist is
 * that it shrinks — but it means the counts on this page are NOT a
 * historical record and must not be quoted as one. 0148's own NOTICE
 * output is the permanent as-at-migration snapshot.
 *
 * ⚠️ READ-ONLY, ON PURPOSE. `gst_backfill_rate_pins(true)` is the thing
 * that acts on the `pinnable` bucket, it is a migration-shaped sweep over
 * every draft line in the workspace, and it has a dry run as its default
 * for a reason. Putting a button on it here would give it a caller with
 * none of that ceremony. The remedy sentence names the function; running
 * it is a deliberate act.
 */

import Link from "next/link";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import {
  RATE_PIN_VERDICTS,
  getRatePinDocumentsNeedingAttention,
  getRatePinVerdictCounts,
  type RatePinVerdictCount,
} from "./_pin-status";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tax audit trail · Ordence" };

/* ------------------------------------------------------------------ */
/* THE COPY — WHICH IS THE LOAD-BEARING PART OF THIS FILE              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EACH VERDICT GETS TWO SENTENCES: WHAT IT MEANS, AND WHAT TO DO.
 *
 * The verdict strings come out of a `CASE` expression in 0148 and read
 * like `unbackfillable_no_rate_in_force`. That is precise and it is not
 * English. A screen that renders the raw enum makes the reader guess, and
 * the guess for that particular string — "the rate is wrong" — is not
 * what it says. It says the REGISTRY has no period covering the
 * document's own date, which is a different problem with a different fix.
 *
 * ⚠️ `settled: true` MEANS "NOTHING TO DO", NOT "GOOD". `no_tax_to_trace`
 * is settled and is not a success — it is a nil-rated, exempt or
 * zero-rated line, and there is no citation to record because no tax was
 * charged. Reading it as a pass is how an exempt supply that should have
 * been taxable goes unnoticed.
 */
type VerdictCopy = {
  label: string;
  meaning: string;
  remedy: string;
  settled: boolean;
};

const VERDICT_COPY: Record<string, VerdictCopy> = {
  already_pinned: {
    label: "Rate traced to a registry period",
    meaning:
      "The line names the HSN/SAC rate row it was taxed from. Open the document " +
      "and the working paper can cite the notification and the dates that rate " +
      "was in force.",
    remedy: "Nothing to do. This is the state every other bucket is trying to reach.",
    settled: true,
  },
  no_tax_to_trace: {
    label: "No tax charged, so nothing to trace",
    meaning:
      "The line carries no tax and names no rate. Exempt, nil-rated and " +
      "zero-rated supplies land here, and so does a line somebody forgot to tax.",
    remedy:
      "Nothing to trace — but this is not a pass. If any of these should have " +
      "carried tax, no rate pin will ever tell you: check the classification.",
    settled: true,
  },
  pinnable: {
    label: "Traceable, and not yet recorded",
    meaning:
      "The registry has a period covering this document's own date, that " +
      "period's rate and cess equal exactly what the line already charged, and " +
      "the document is still a draft, so the row can still be written to.",
    remedy:
      "Run gst_backfill_rate_pins(true). It records which registry row produced " +
      "the figure that is already there; no money moves and no figure changes.",
    settled: false,
  },
  unbackfillable_no_classification: {
    label: "No HSN/SAC on the line",
    meaning:
      "The line names no classification, so there is no registry entry it could " +
      "point at. The rate charged came from somewhere the document does not say.",
    remedy:
      "Classify the item on the source record. On a document that has left " +
      "draft the line is frozen and cannot be corrected — the answer there is a " +
      "working paper explaining the classification, not an edit.",
    settled: false,
  },
  unbackfillable_no_rate_in_force: {
    label: "No rate period covering the document's date",
    meaning:
      "The line IS classified, and the rate registry has no period for that " +
      "classification covering the date on the document. The rate charged may be " +
      "perfectly correct; the registry simply cannot corroborate it.",
    remedy:
      "Add the period that was actually in force on that date — not today's " +
      "rate. Recomputing history at current rates is the classic way an ERP " +
      "silently restates a return that has already been filed.",
    settled: false,
  },
  unbackfillable_rate_disagrees: {
    label: "Registry and line disagree on the rate",
    meaning:
      "A rate period exists for this classification on this date, and its rate " +
      "or cess is not what the line charged. One of the two is wrong.",
    remedy:
      "Reconcile it by hand, and decide which is wrong before touching either. " +
      "Pinning would attach a citation that contradicts the figure it cites, " +
      "which is worse than no citation at all.",
    settled: false,
  },
  unbackfillable_document_frozen: {
    label: "Everything agrees, but the document is frozen",
    meaning:
      "The registry agrees with the line to the basis point. The document has " +
      "left draft, and an issued document's lines cannot be written to at all — " +
      "that freeze is a control, not an obstacle.",
    remedy:
      "Leave the row alone. The rate IS defensible from the registry; cite the " +
      "period in the working paper. Weakening the freeze guard to write a " +
      "convenience column would be the wrong trade by a long way.",
    settled: false,
  },
};

function describeVerdict(verdict: string): VerdictCopy {
  return (
    VERDICT_COPY[verdict] ?? {
      label: verdict.replace(/_/g, " "),
      meaning:
        "This verdict is produced by SQL 0148 and has no description on this " +
        "screen yet, which means the view has grown an arm the page does not " +
        "know about. The count is still correct.",
      remedy: "Add it to VERDICT_COPY in app/(finance)/tax/page.tsx.",
      settled: false,
    }
  );
}

/** `sales_invoice_lines` → something a person says out loud. */
function describeDocumentTable(table: string): string {
  if (table === "sales_invoice_lines") return "Sales invoices";
  if (table === "sales_order_lines") return "Sales orders";
  return table.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* THE PAGE                                                            */
/* ------------------------------------------------------------------ */

export default async function TaxAuditTrailPage() {
  const ctx = await requirePageContext();

  /**
   * ⚠️ `gst:read` — AN EXISTING PERMISSION, NOT A NEW ONE. Its catalogue
   * entry is "View GST registrations, counterparties and rate masters",
   * and this page is a read of the rate master's coverage over the
   * workspace's own documents. Inventing `tax:audit_trail` would have
   * meant a change to `db/schema/auth.ts`, which is outside Track E's
   * block, and would have shipped a permission that no role template
   * grants — a screen nobody can open.
   *
   * ⚠️ A REFUSAL IS NOT AN EMPTY PAGE. Rendering zeros to somebody who is
   * not allowed to see the numbers says "you have no problems", which is
   * a lie the reader has no way to detect.
   */
  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  if (!can(subject, "gst:read")) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tax audit trail</h1>
        <p className="text-sm text-destructive">
          You do not have permission to view GST registrations, counterparties and
          rate masters, so this workspace&apos;s rate-pin coverage is not shown.
          Ask an owner or the accountant for <code>gst:read</code>.
        </p>
      </main>
    );
  }

  /**
   * ⚠️ BOTH READS GO THROUGH THE TENANT-SCOPED READER IN `_pin-status.ts`,
   * which goes through `withTenant()`. This page opens no connection and
   * writes no SQL. See that module's header for why it is not yet in
   * `server/tax/`.
   */
  const [counts, documents] = await Promise.all([
    getRatePinVerdictCounts(ctx.tenant.id),
    getRatePinDocumentsNeedingAttention(ctx.tenant.id, { limit: 200 }),
  ]);

  const totalLines = counts.reduce((acc, row) => acc + row.lines, 0);

  /**
   * ⚠️ ORDERED BY THE DECLARED LIST AND THEN BY WHATEVER THE VIEW
   * PRODUCED, so an arm added to 0148's `CASE` and not to `VERDICT_COPY`
   * still appears — at the end, with its raw string and its real count.
   * A screen that quietly drops a verdict it does not recognise
   * understates the worklist, and understating a worklist is the one
   * thing a worklist may not do.
   */
  const byVerdict = new Map<string, RatePinVerdictCount[]>();
  for (const row of counts) {
    const bucket = byVerdict.get(row.verdict);
    if (bucket) bucket.push(row);
    else byVerdict.set(row.verdict, [row]);
  }

  const known = RATE_PIN_VERDICTS.filter((v) => byVerdict.has(v));
  const unknown = [...byVerdict.keys()].filter(
    (v) => !(RATE_PIN_VERDICTS as readonly string[]).includes(v),
  );
  const ordered = [...known, ...unknown];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Tax audit trail</h1>
        <p className="text-sm text-muted-foreground">
          Which outward-supply lines can prove where their tax rate came from, and
          which cannot. One row per line of every sales invoice and sales order in
          this workspace, bucketed by what the rate registry can corroborate.
        </p>
      </header>

      {totalLines === 0 ? (
        /**
         * ⭐ THE HONEST EMPTY STATE. Zero rows in the view means there are
         * no outward-supply lines at all — not that everything is fine.
         * Those two readings are opposite and the sentence has to pick.
         */
        <Card>
          <CardHeader>
            <CardTitle>No outward-supply lines yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <code>gst_rate_pin_status</code> has one row for every line of every
              sales invoice and sales order in this workspace, and it currently has
              none. That means nothing has been billed yet — it does not mean the
              tax data is clean.
            </p>
            <p>
              Raise a sales invoice and this page will start reporting what can and
              cannot be traced back to a rate period.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Outward-supply lines examined
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-3xl font-semibold tabular-nums">
                {totalLines.toLocaleString("en-IN")}
              </p>
              {/*
                ⚠️ NO RATIO, NO SCORE, NO BADGE. The buckets below are the
                answer. Anybody who wants a fraction can divide two numbers
                they can see, and will then own the interpretation — which
                is the correct place for it to live.
              */}
              <p className="text-xs text-muted-foreground">
                Counted as at this page load. The view re-derives its verdicts every
                time it is read, so a line moves between buckets the moment the rate
                registry changes. These figures are a worklist, not a record of what
                was true on any earlier date.
              </p>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {ordered.map((verdict) => {
              const rows = byVerdict.get(verdict) ?? [];
              const copy = describeVerdict(verdict);
              const lines = rows.reduce((acc, r) => acc + r.lines, 0);
              const docs = rows.reduce((acc, r) => acc + r.documents, 0);

              return (
                <Card key={verdict}>
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <CardTitle className="text-base">{copy.label}</CardTitle>
                      <p className="text-2xl font-semibold tabular-nums">
                        {lines.toLocaleString("en-IN")}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {lines === 1 ? "line" : "lines"} across{" "}
                          {docs.toLocaleString("en-IN")}{" "}
                          {docs === 1 ? "document" : "documents"}
                        </span>
                      </p>
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {verdict}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm">{copy.meaning}</p>
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {copy.settled ? "Nothing to do: " : "What to do: "}
                      </span>
                      {copy.remedy}
                    </p>

                    {/* The same verdict lands differently on a draft order
                        and an issued invoice, so the split is shown rather
                        than summed away. */}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {rows.map((r) => (
                        <span
                          key={`${verdict}-${r.documentTable}`}
                          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground tabular-nums"
                        >
                          {describeDocumentTable(r.documentTable)} ·{" "}
                          {r.lines.toLocaleString("en-IN")}{" "}
                          {r.lines === 1 ? "line" : "lines"} ·{" "}
                          {r.documents.toLocaleString("en-IN")}{" "}
                          {r.documents === 1 ? "document" : "documents"}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <DocumentWorklist documents={documents} />
        </>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What this page is not</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            It is not a filing check and it does not say whether any rate is
            correct. It says whether the rate a line charged can be traced back to a
            period in this workspace&apos;s own rate registry. A line that traces
            perfectly to a rate somebody typed in wrongly is still wrong.
          </p>
          <p>
            The separate question — which notification, which sub-section of the
            place-of-supply rules, and whether reverse charge was considered — is
            recorded per line in the decision trail and shown on each
            document&apos;s working paper.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* THE WORKLIST                                                        */
/* ------------------------------------------------------------------ */

/**
 * The documents behind the unsettled buckets, newest first.
 *
 * ⚠️ ONLY SALES INVOICES GET A LINK, AND THE ABSENCE OF ONE IS NOT AN
 * OVERSIGHT. The working paper at `/tax/[documentId]` reads
 * `tax_decisions` for `document_table = 'sales_invoice_lines'` and
 * resolves the header through the sales-invoice reader. A sales ORDER id
 * would resolve to nothing there, and a link that lands on "not found" is
 * worse than a row that plainly is not a link — the first sends somebody
 * looking for a record they think they have lost.
 */
function DocumentWorklist({
  documents,
}: {
  documents: readonly {
    documentTable: string;
    documentId: string;
    documentNumber: string | null;
    documentDate: string;
    verdict: string;
    lines: number;
  }[];
}) {
  if (documents.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Nothing on the worklist</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Every line either names its registry rate period already or carries no
            tax to trace. Note that the second of those is not a success — see the
            bucket above.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Documents with lines that cannot cite a rate period{" "}
          <span className="font-normal text-muted-foreground">
            ({documents.length.toLocaleString("en-IN")})
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          One row per document and verdict — a single invoice can appear more than
          once when its lines fail for different reasons, because those are
          different pieces of work. Newest first, capped at 200 rows.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Document</th>
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Kind</th>
              <th className="p-3 font-medium">Verdict</th>
              <th className="p-3 text-right font-medium">Lines</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {documents.map((d) => {
              const copy = describeVerdict(d.verdict);
              const label = d.documentNumber ?? "— no number —";
              const isInvoice = d.documentTable === "sales_invoice_lines";

              return (
                <tr
                  key={`${d.documentTable}-${d.documentId}-${d.verdict}`}
                  className="hover:bg-muted/30"
                >
                  <td className="p-3 font-mono text-xs">
                    {isInvoice ? (
                      <Link
                        href={`/tax/${d.documentId}`}
                        className="hover:underline"
                        title="Open the working paper for this invoice"
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="p-3 tabular-nums">{d.documentDate}</td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {describeDocumentTable(d.documentTable)}
                  </td>
                  <td className="p-3">
                    <Badge variant="outline" className="text-[10px]">
                      {copy.label}
                    </Badge>
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {d.lines.toLocaleString("en-IN")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
