/**
 * Ordence — ⭐⭐⭐ THE WORKING PAPER FOR ONE SALES INVOICE
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE PAGE A CHARTERED ACCOUNTANT OPENS TO ASK "WHY THIS NUMBER"
 * ══════════════════════════════════════════════════════════════════════
 * The invoice itself already answers "what". `sales_invoice_lines` says
 * `tax_rate_bps = 1800` and `igst_minor = 18000`, and the header says
 * `place_of_supply_code = '29'`. Between them that is internally honest
 * and an accountant asked to defend it still cannot, because none of it
 * says WHY 29 and not 27, which notification put that HSN at 18% on that
 * date, or whether reverse charge was considered and rejected.
 *
 * ⭐ SO THE STATUTORY REFERENCE AND THE EXPLANATION ARE THE POINT, NOT
 * THE MONEY. The money is on the invoice, on the print view, in GSTR-1
 * and in the ledger. It is repeated here only so that the reasoning and
 * the figure it produced can be read in one glance — which is what makes
 * this a working paper rather than a second copy of the invoice.
 *
 * ⚠️ NOTHING ON THIS PAGE IS COMPUTED. Every value is read back from
 * `tax_decisions` exactly as it was written at the time the document was
 * raised. Re-deriving any of it from today's rate registry would produce
 * a page that looks identical and proves nothing: master data moves, and
 * the whole reason the decision log exists is that what was decided THEN
 * cannot be recovered from what is true NOW. If a rate period is closed
 * next year, this page must keep saying what it says today.
 *
 * ⚠️ `sales_invoice_lines` ONLY. `tax_decisions.document_table` spans
 * five tables and this route resolves its header through the sales
 * invoice reader, so a credit-note or purchase-invoice id lands on "not
 * found". That is honest and narrow; widening it means a `?table=`
 * parameter and five header readers, and is not this route's job today.
 */

import Link from "next/link";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getInvoiceDetail } from "@/server/actions/sales-invoices";
import {
  getTaxDecisionsForDocument,
  type TaxDecisionView,
} from "@/server/tax/audit";
import { placeOfSupplyName } from "@/lib/gst/constants";
import { toBigIntAmount } from "@/lib/billing/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tax working paper · Ordence" };

/* ------------------------------------------------------------------ */
/* FORMATTING                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ PAISE TO RUPEES FOR DISPLAY ONLY. The arithmetic never leaves
 * `bigint` — `server/tax/audit.ts` reads every money column as text and
 * casts it, precisely so that a figure above 2^53 does not lose precision
 * through `Number` on the way to a screen.
 */
function inr(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/**
 * ⭐ BASIS POINTS ARE SHOWN AS BOTH, AND BOTH ARE NEEDED.
 *
 * "18%" is what a human checks. `1800` is what the row stores, what the
 * recompute constraint in 0147 arithmetic uses, and what somebody will
 * quote in a bug report. Showing only the percentage hides a 1801 that
 * rounds to 18.01% and reads as a typo; showing only the basis points
 * makes every reader do the division.
 */
function rateLabel(bps: number): string {
  const percent = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
  return `${percent}% (${bps.toLocaleString("en-IN")} bps)`;
}

/** Which pair of taxes applied. UTGST is a different Act from SGST. */
function taxKindLabel(kind: string): string {
  if (kind === "igst") return "IGST — inter-state";
  if (kind === "cgst_sgst") return "CGST + SGST — intra-state";
  if (kind === "cgst_utgst") return "CGST + UTGST — union territory";
  return kind.replace(/_/g, " ");
}

/**
 * The place-of-supply basis, in the words of the provision it comes from.
 *
 * ⚠️ THE STORED VALUE IS THE AUTHORITY AND THIS IS ONLY A GLOSS. An
 * unrecognised basis is rendered as its raw string rather than dropped —
 * a working paper that silently omits the limb it relied on is the exact
 * gap this table was created to close.
 */
const BASIS_LABEL: Record<string, string> = {
  immovable_property_location: "Location of the immovable property",
  recipient_registration: "The recipient's registered state",
  recipient_address: "The address on record for an unregistered buyer",
  delivery_location: "Where movement of the goods terminates",
  supplier_location: "Our own location — nothing on record for the recipient",
  sez_deemed_interstate: "SEZ supply, deemed inter-state wherever it sits",
  outside_india: "Export — place of supply outside India",
};

function basisLabel(basis: string | null): string {
  if (!basis) return "not recorded";
  return BASIS_LABEL[basis] ?? basis.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* THE PAGE                                                            */
/* ------------------------------------------------------------------ */

export default async function TaxWorkingPaperPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  const ctx = await requirePageContext();

  /**
   * ⚠️ `gst:read` — AN EXISTING PERMISSION. The catalogue entry is "View
   * GST registrations, counterparties and rate masters"; a decision row
   * quotes the rate master and the notification behind it, so this is the
   * same disclosure. Inventing `tax:audit_trail` would mean editing
   * `db/schema/auth.ts`, which is outside Track E's block, and would ship
   * a key no role template grants.
   *
   * ⚠️ AND IT IS THE SECOND GATE, NOT THE ONLY ONE. `getInvoiceDetail`
   * enforces `sales.invoices.read` on its own and records the denial.
   * Both are required: the tax reasoning for an invoice you may not read
   * is still that invoice's commercial terms.
   */
  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  if (!can(subject, "gst:read")) {
    return (
      <Frame>
        <p className="text-sm text-destructive">
          You do not have permission to view GST rate masters, so the tax reasoning
          behind this document is not shown. Ask an owner or the accountant for{" "}
          <code>gst:read</code>.
        </p>
      </Frame>
    );
  }

  /**
   * ⚠️ THE HEADER AND THE TRAIL ARE READ TOGETHER AND JUDGED SEPARATELY.
   * "That invoice does not exist" and "that invoice exists and nobody
   * ever recorded why it was taxed the way it was" are different answers
   * with different remedies, and collapsing them into one empty state
   * sends the reader looking for a document that is right there.
   */
  const [invoiceResult, decisions] = await Promise.all([
    getInvoiceDetail({ invoiceId: documentId }),
    // ⚠️ Tenant-scoped reader. `withTenant` inside; the page opens no
    // connection and writes no SQL.
    getTaxDecisionsForDocument(ctx.tenant.id, {
      documentTable: "sales_invoice_lines",
      documentId,
    }),
  ]);

  if (!invoiceResult.ok) {
    /**
     * ⚠️ A REFUSAL IS NOT A 404. The action's own message distinguishes
     * "no longer exists" from a permission denial, and it is rendered
     * verbatim rather than replaced with a friendlier sentence that would
     * lose the distinction.
     */
    return (
      <Frame>
        <p className="text-sm text-destructive">{invoiceResult.error}</p>
        <p className="text-sm text-muted-foreground">
          This route resolves sales invoices only. A credit note, purchase invoice
          or sales order id will land here even though a decision trail may exist
          for it under a different <code>document_table</code>.
        </p>
      </Frame>
    );
  }

  const { invoice } = invoiceResult.data;

  const totals = decisions.reduce(
    (acc, d) => ({
      taxable: acc.taxable + d.money.taxableValueMinor,
      cgst: acc.cgst + d.money.cgstMinor,
      sgst: acc.sgst + d.money.sgstMinor,
      igst: acc.igst + d.money.igstMinor,
      cess: acc.cess + d.money.cessMinor,
    }),
    { taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, cess: 0n },
  );

  return (
    <Frame>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {invoice.invoiceNumber}
          </h1>
          <Badge variant="outline">{invoice.status.replace(/_/g, " ")}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Tax working paper · {invoice.invoiceDate}
          {invoice.customerLegalName ? ` · ${invoice.customerLegalName}` : ""}
          {invoice.customerGstin ? ` · ${invoice.customerGstin}` : " · unregistered"}
        </p>
        <p className="text-sm text-muted-foreground">
          Why each line was taxed the way it was, as recorded at the time the
          document was raised. Nothing here is recomputed from today&apos;s rate
          registry.
        </p>
      </header>

      {decisions.length === 0 ? (
        <NoDecisionsRecorded invoiceId={documentId} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {decisions.length.toLocaleString("en-IN")}{" "}
            {decisions.length === 1 ? "line" : "lines"} · decided by{" "}
            {decisions[0]?.decidedBy ?? "an unrecorded actor"} · engine{" "}
            {decisions[0]?.engineVersion || "unrecorded"}
          </p>

          <div className="space-y-4">
            {decisions.map((d) => (
              <DecisionLine key={d.id} decision={d} />
            ))}
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Totals across the recorded lines
              </CardTitle>
              {/*
                ⚠️ THIS IS THE TRAIL'S OWN SUM, NOT THE INVOICE HEADER'S.
                They are shown side by side deliberately: if the decision
                log does not add up to the document it explains, the log is
                incomplete or the document has moved, and either way the
                reader must be told rather than shown one reassuring
                figure. `tax_decisions` has NO row for a line whose id was
                never handed to `recordTaxDecisions`, and 0150 §3 refuses a
                line carrying a specific (per-unit) cess outright.
              */}
              <p className="text-xs text-muted-foreground">
                From <code>tax_decisions</code>, not from the invoice header. If the
                two disagree, some lines have no decision recorded — the difference
                is the gap, and it is not rounding.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Source</th>
                    <th className="p-3 text-right font-medium">Taxable</th>
                    <th className="p-3 text-right font-medium">CGST</th>
                    <th className="p-3 text-right font-medium">SGST / UTGST</th>
                    <th className="p-3 text-right font-medium">IGST</th>
                    <th className="p-3 text-right font-medium">Cess</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="p-3">Decision trail</td>
                    <td className="p-3 text-right tabular-nums">{inr(totals.taxable)}</td>
                    <td className="p-3 text-right tabular-nums">{inr(totals.cgst)}</td>
                    <td className="p-3 text-right tabular-nums">{inr(totals.sgst)}</td>
                    <td className="p-3 text-right tabular-nums">{inr(totals.igst)}</td>
                    <td className="p-3 text-right tabular-nums">{inr(totals.cess)}</td>
                  </tr>
                  <tr className="text-muted-foreground">
                    <td className="p-3">Invoice header</td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(toBigIntAmount(invoice.taxableValueMinor))}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(toBigIntAmount(invoice.cgstMinor))}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(toBigIntAmount(invoice.sgstMinor))}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(toBigIntAmount(invoice.igstMinor))}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {inr(toBigIntAmount(invoice.cessMinor))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* ONE LINE'S REASONING                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE BLOCK PER LINE, NOT ONE TABLE ROW PER LINE — and the shape is
 * the argument.
 *
 * `place_of_supply_explanation` is a SENTENCE. `statutory_ref` is a
 * citation. Neither survives being squeezed into a table cell next to
 * five money columns: the column would be twenty characters wide, the
 * prose would wrap to six lines, and the reader would stop reading it —
 * at which point the page has the same information as the invoice and
 * none of the value. The money is still in a table, at the bottom of each
 * block, because columns are what money is for.
 */
function DecisionLine({ decision }: { decision: TaxDecisionView }) {
  const { rate, placeOfSupply, treatment, money } = decision;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <CardTitle className="text-base">
            Line {decision.lineNo ?? "—"}
            {rate.hsnSacCode ? (
              <span className="ml-2 font-mono text-sm font-normal">
                HSN/SAC {rate.hsnSacCode}
              </span>
            ) : (
              <span className="ml-2 text-sm font-normal text-destructive">
                no HSN/SAC recorded
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {taxKindLabel(treatment.taxKind)}
            </Badge>
            {treatment.isReverseCharge && (
              <Badge variant="outline" className="text-[10px]">
                reverse charge
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── WHICH RATE, FROM WHERE ─────────────────────────────── */}
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Rate, and the period it was resolved from
          </h3>
          <p className="text-sm tabular-nums">
            {rateLabel(rate.rateBps)}
            {rate.cessRateBps > 0 ? ` · cess ${rateLabel(rate.cessRateBps)}` : ""}
          </p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {/*
              ⚠️ A NULL `effectiveTo` MEANS "STILL IN FORCE", NEVER
              "UNKNOWN". Rendering it as a blank or a dash would leave the
              reader unable to tell an open period from a missing one, and
              those carry opposite conclusions.
            */}
            In force {rate.effectiveFrom ?? "— start not recorded —"} →{" "}
            {rate.effectiveTo ?? "still current"}
          </p>
          <p className="text-sm">
            {rate.notificationRef ? (
              rate.notificationRef
            ) : (
              <span className="text-destructive">
                No notification reference recorded. The rate is stated; the
                instrument that set it is not, and that is the sentence an officer
                asks for first.
              </span>
            )}
          </p>
        </section>

        {/* ── WHICH PLACE OF SUPPLY, AND UNDER WHICH SUB-SECTION ── */}
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Place of supply
          </h3>
          <p className="text-sm tabular-nums">
            {placeOfSupply.code ? (
              <>
                {placeOfSupply.code} · {placeOfSupplyName(placeOfSupply.code)}
              </>
            ) : (
              <span className="text-destructive">not recorded</span>
            )}
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Basis: </span>
            {basisLabel(placeOfSupply.basis)}
            {placeOfSupply.statutoryRef ? (
              <span className="text-muted-foreground"> · {placeOfSupply.statutoryRef}</span>
            ) : (
              <span className="text-destructive"> · no provision cited</span>
            )}
          </p>
          {/*
            ⭐ THE PROSE IS THE DELIVERABLE. It is the facts that made the
            rule apply, in the workspace's own words, written at the time.
            Everything else on this card can be re-derived from master
            data; this cannot.
          */}
          {placeOfSupply.explanation ? (
            <p className="rounded-md border-l-2 border-border bg-muted/30 p-3 text-sm">
              {placeOfSupply.explanation}
            </p>
          ) : (
            <p className="text-sm text-destructive">
              No explanation recorded. The code and the provision are here; the
              facts that made that provision apply to this supply are not.
            </p>
          )}
        </section>

        {/* ── HOW IT WAS TREATED ─────────────────────────────────── */}
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reverse charge
          </h3>
          {treatment.isReverseCharge ? (
            <p className="text-sm">
              Yes —{" "}
              {treatment.reverseChargeBasis ? (
                <span className="font-mono text-xs">
                  {treatment.reverseChargeBasis}
                </span>
              ) : (
                <span className="text-destructive">
                  on no recorded basis. Reverse charge always applies under a
                  specific limb of s.9(3) or s.9(4); &quot;yes&quot; with no limb
                  cannot be defended.
                </span>
              )}
            </p>
          ) : (
            /*
              ⚠️ "NO" HERE MEANS CONSIDERED AND REJECTED, NOT NEVER
              CONSIDERED. A row exists in `tax_decisions` only because the
              engine ran and wrote one; that is what makes the negative
              worth showing rather than leaving the section out.
            */
            <p className="text-sm">
              No. The supplier accounts for this tax; reverse charge was considered
              and did not apply.
            </p>
          )}
        </section>

        {/* ── THE MONEY ──────────────────────────────────────────── */}
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Money
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Taxable value</th>
                  {/*
                    ⭐ FOUR TAX HEADS, ALWAYS ALL FOUR, INCLUDING THE ONES
                    THAT ARE ZERO. A supply has one place of supply, so it
                    is inter-state or intra-state and never both — which
                    means two of these columns are always empty. Hiding
                    them would make an IGST line and a CGST+SGST line look
                    structurally different and remove the reader's ability
                    to see at a glance that the wrong pair is populated.
                    That specific fault — IGST on an intra-state supply —
                    is refused by `validateTaxDecisions`, and this layout
                    is what lets a human catch the version of it that gets
                    past a validator.
                  */}
                  <th className="py-2 pr-3 text-right font-medium">CGST</th>
                  <th className="py-2 pr-3 text-right font-medium">SGST / UTGST</th>
                  <th className="py-2 pr-3 text-right font-medium">IGST</th>
                  <th className="py-2 text-right font-medium">Cess</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-2 pr-3 tabular-nums">
                    {inr(money.taxableValueMinor)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(money.cgstMinor)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(money.sgstMinor)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(money.igstMinor)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {inr(money.cessMinor)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            Total tax {inr(money.totalTaxMinor)} · decided {decision.decidedAt || "—"}
            {decision.decidedBy ? ` by ${decision.decidedBy}` : ""} · engine{" "}
            {decision.engineVersion || "unrecorded"}
          </p>
        </section>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* ⭐ THE HONEST EMPTY STATE                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THIS IS NOT A SPINNER AND IT IS NOT "COMING SOON".
 *
 * The invoice exists and `tax_decisions` has no row for it. The reader
 * needs to know two things: that the absence is real, and what would put
 * a row there. Both are stated, by name, including the fact that the call
 * site does not exist yet — because the alternative is an accountant
 * concluding that this particular invoice was skipped by a mechanism that
 * has in fact never run for any invoice.
 *
 * ⚠️ WHEN THE CALL SITES IN PATCH-REQUEST-E.md LAND, EDIT THIS COPY. A
 * page that still says "no call site exists" after one does is a page
 * that teaches its reader to ignore it.
 */
function NoDecisionsRecorded({ invoiceId }: { invoiceId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No tax decision was recorded for this invoice</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          The invoice exists and its figures are on the invoice itself. What does
          not exist is the record of WHY those figures are what they are — which
          notification set the rate, which sub-section fixed the place of supply,
          and whether reverse charge was considered.
        </p>
        <p>
          <span className="font-medium text-foreground">What would record one: </span>
          a decision batch is built by{" "}
          <code>buildTaxDecisionsForSalesInvoice()</code> in{" "}
          <code>server/tax/apply.ts</code> and written by{" "}
          <code>recordTaxDecisions()</code> in <code>server/tax/audit.ts</code>,
          inside the same transaction that writes the invoice lines — it needs the
          line ids, which do not exist until that INSERT returns.
        </p>
        <p>
          <span className="font-medium text-foreground">Why this one has none: </span>
          that call site has not been added to{" "}
          <code>server/actions/sales-invoices.ts</code> yet. It is listed by name in
          PATCH-REQUEST-E.md. Until it lands, every invoice reads this way — so
          this page saying nothing was recorded is not a statement about this
          particular invoice.
        </p>
        <p className="text-xs">
          One case is refused rather than missing: a line carrying a SPECIFIC
          (per-unit) cess cannot be represented, because <code>tax_decisions</code>{" "}
          mirrors the line tables and they hold only an ad-valorem cess rate.
          Recording the ad-valorem part alone would be a trail that disagrees with
          the document it explains, so it is refused loudly. See SQL 0147 §A and
          0150 §6.
        </p>
        <p className="font-mono text-xs">
          document_table = sales_invoice_lines · document_id = {invoiceId}
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/** The page frame, so every exit path keeps the breadcrumb. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <Link href="/tax" className="text-sm text-muted-foreground hover:underline">
        ← Tax audit trail
      </Link>
      {children}
    </main>
  );
}
