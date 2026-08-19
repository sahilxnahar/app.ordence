/**
 * Ordence — ⭐ COST CONTROL
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE OPENS WITH WORK THAT HAS ALREADY BEEN DONE AND NOT AGREED
 * ══════════════════════════════════════════════════════════════════════
 * A cost screen that opens with "₹42.6 cr contract value" is a screen
 * that gets screenshotted for a board pack and never opened again. The
 * order below is by what it costs to leave alone for one more month:
 *
 *   1. ⭐ OVER-MEASURED LINES. Work measured beyond the AUTHORISED
 *      quantity — original plus approved variations. It is either a
 *      variation nobody raised or a measurement error. The contractor has
 *      built it either way, so it is not a question of whether it gets
 *      paid; it is a question of whether it gets paid at the contract
 *      rate now or at a claimed rate at the final account.
 *   2. ⭐ MEASURED AND NEVER BILLED. Value recorded in a measurement
 *      book, not rejected, on no RA bill. It is a liability that appears
 *      in no bill register and in no ledger — the accrual nobody made,
 *      and it lands in one lump on whichever month somebody finally
 *      raises the bill.
 *   3. COMMITTED vs CERTIFIED, by project. Contract sum, what the
 *      engineer has certified, what is queued for certification, what has
 *      been committed to vendors, and what is being held as retention.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ QUANTITIES ARE MICRO-UNITS. 12.345 cum IS STORED AS 12345000.
 * ══════════════════════════════════════════════════════════════════════
 * `qty()` below is the ONLY place that divide happens, and it does the
 * work on the decimal string rather than through a float — 12345000 / 1e6
 * is exact today and stops being exact the moment a quantity is large.
 * A raw 12345000 rendered on this page next to "cum" is a screen nobody
 * can read, and a rounded 12.35 next to a contractor's 12.345 is an
 * argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ "BUDGET" HERE IS THE REVISED CONTRACT SUM, NOT THE APPROVED BUDGET
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS HEADER USED TO SAY `projects` HAS NO BUDGET COLUMN. SQL 0041
 * ADDED ONE (`budget_minor`), so that is no longer true and is corrected
 * here rather than left to mislead — a confidently wrong comment costs
 * more than a missing one.
 *
 * The two are still different numbers and this page still shows the
 * contract sum:
 *
 *   REVISED CONTRACT SUM  what has been COMMITTED — signed, priced, and
 *     forced to foot by a database CHECK. This is what the page compares
 *     certified and billed value against.
 *   projects.budget_minor  what the business APPROVED before any contract
 *     was let. Nullable, because "nobody set one" is a real state.
 *
 * ⚠️ THEY MUST NOT BE MERGED. Committing more than the approved budget is
 * exactly the condition worth surfacing, and it disappears the moment one
 * is defaulted into the other.
 *
 * See `server/actions/cost-control.ts` for why the project-level roll-up
 * stays coarse, and `getBillingPosition()` for the per-line view.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getCostControl } from "@/server/actions/cost-control";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Cost Control · Ordence" };

/* ------------------------------------------------------------------ */
/* FORMATTERS — decimal strings in, strings out. No floats.            */
/* ------------------------------------------------------------------ */

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/**
 * Crore/lakh shorthand for the roll-up tiles only.
 *
 * ⚠️ NEVER USED IN A TABLE CELL. A rounded figure is fine for "how big is
 * this job"; it is not fine anywhere somebody might reconcile against a
 * bill. The tables carry the exact paise.
 */
function inrShort(minorUnits: string | null | undefined): string {
  const paise = BigInt(minorUnits || "0");
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / 100n;
  const sign = negative ? "-" : "";
  if (rupees >= 10_000_000n) {
    const crore = Number(rupees / 100_000n) / 100;
    return `${sign}₹${crore.toFixed(2)} cr`;
  }
  if (rupees >= 100_000n) {
    const lakh = Number(rupees / 1_000n) / 100;
    return `${sign}₹${lakh.toFixed(2)} L`;
  }
  return inr(minorUnits);
}

/**
 * ⭐ MICRO-UNITS TO A READABLE QUANTITY, DONE ON THE STRING.
 *
 * 12345000 → "12.345". Trailing zeroes are trimmed because "12.345000
 * cum" reads like a false precision the measurement never had.
 */
function qty(scaled: string | null | undefined): string {
  if (scaled === null || scaled === undefined) return "0";
  const raw = String(scaled);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(7, "0");
  const whole = digits.slice(0, -6) || "0";
  const frac = digits.slice(-6).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function ageInDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/**
 * Certified as a percentage of the revised contract sum, in integer
 * arithmetic. Returns null when there is no contract to compare against —
 * a project billed with no issued BOQ is a real state and "∞%" is not a
 * useful thing to print.
 */
function pctOf(part: string, whole: string): number | null {
  try {
    const w = BigInt(whole || "0");
    if (w <= 0n) return null;
    return Number((BigInt(part || "0") * 1000n) / w) / 10;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* BODY                                                                */
/* ------------------------------------------------------------------ */

async function CostBody() {
  const result = await getCostControl();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost control unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    overMeasured,
    unbilled,
    projects,
    totalRevisedMinor,
    totalCertifiedMinor,
    totalCommittedMinor,
    totalUnbilledMinor,
  } = result.data;

  const overMeasuredValue = overMeasured.reduce(
    (t, l) => t + BigInt(l.excessValueMinor || "0"),
    0n,
  );

  /* Nothing to say at all — a workspace with no construction. */
  if (projects.length === 0 && overMeasured.length === 0 && unbilled.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing has been priced or measured yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            This screen compares what a project was CONTRACTED to cost against
            what has actually been measured, certified and committed. It fills
            in on its own as three things happen:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              A <strong>bill of quantities</strong> is issued against a project
              — that is the budget, and it is the only one on this page.
              Original plus approved variations is what the contract is worth
              today.
            </li>
            <li>
              Work is <strong>measured</strong> into a measurement book against
              those BOQ lines. Anything measured beyond the authorised quantity
              appears at the top of this page the same day.
            </li>
            <li>
              <strong>RA bills</strong> are certified, and{" "}
              <strong>vendor invoices</strong> are booked to the project. Those
              two are the certified and the committed side of the comparison.
            </li>
          </ul>
          <p>
            No budget is typed anywhere for this to work — a budget somebody
            keys into a settings field is a fourth number that agrees with
            nothing and is defended by nobody.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── 1 · OVER-MEASURED. The most expensive thing on the page. ─ */}
      {overMeasured.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {overMeasured.length} BOQ line
              {overMeasured.length === 1 ? " has" : "s have"} been measured
              beyond the authorised quantity — {inr(overMeasuredValue.toString())}{" "}
              at contract rates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 font-medium">Project</th>
                    <th className="px-2 py-2 font-medium">Contractor</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Authorised
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Measured</th>
                    <th className="px-2 py-2 text-right font-medium">Excess</th>
                    <th className="px-2 py-2 text-right font-medium">
                      At contract rate
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {overMeasured.map((l) => (
                    <tr key={l.boqItemId}>
                      <td className="px-2 py-2">
                        <span className="font-mono text-xs">{l.itemCode}</span>
                        <div className="max-w-md truncate text-xs text-muted-foreground">
                          {l.description}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {l.boqCode} · {l.workPackage}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-xs">
                        {l.projectName ?? "—"}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {l.contractorName ?? "not awarded"}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {qty(l.authorisedScaled)}{" "}
                        <span className="text-[10px] text-muted-foreground">
                          {l.uom}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {qty(l.measuredScaled)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-red-700 dark:text-red-300">
                        +{qty(l.excessScaled)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">
                        {inr(l.excessValueMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground">
              ⚠️ &quot;Authorised&quot; is the contract quantity PLUS every
              approved variation, so a line here is not a line that was simply
              varied — it is work with no authority behind it. Each one is
              either a variation nobody raised or a measurement error, and the
              contractor has done the work either way. Raised as a variation
              now, it is priced at the contract rate. Left until the final
              account, it is a claim priced by whoever is arguing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · MEASURED, NEVER BILLED. The accrual nobody made. ───── */}
      {unbilled.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {inr(totalUnbilledMinor)} of measured work is on no RA bill
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {unbilled.map((u) => {
                const age = ageInDays(u.oldestMeasuredOn);
                return (
                  <li
                    key={u.projectId ?? "unassigned"}
                    className="flex flex-wrap items-baseline gap-3"
                  >
                    <span className="font-medium">
                      {u.projectName ?? "No project"}
                    </span>
                    <span className="tabular-nums">{inr(u.valueMinor)}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.entries} entr{u.entries === 1 ? "y" : "ies"}
                    </span>
                    <span
                      className={
                        age !== null && age > 60
                          ? "text-xs text-red-700 dark:text-red-300"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      oldest {day(u.oldestMeasuredOn)}
                      {age !== null ? ` · ${age} days` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground">
              This is work that has been done, recorded in a measurement book
              and not rejected — it will be paid. Until somebody raises the
              bill it appears in no bill register and in no ledger, so the cost
              of the job looks lower than it is and the month it finally lands
              in takes the whole hit. The older the oldest entry, the more
              likely it is that whoever measured it has left the site.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The roll-up. ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Contract value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inrShort(totalRevisedMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Original plus approved variations, issued BOQs only.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Certified
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inrShort(totalCertifiedMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {pctOf(totalCertifiedMinor, totalRevisedMinor) ?? "—"}% of contract
              value. Certified, not paid.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Vendor commitment
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inrShort(totalCommittedMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Purchase invoices booked to a project, drafts excluded.
            </p>
          </CardContent>
        </Card>
        <Card
          className={
            BigInt(totalUnbilledMinor || "0") > 0n
              ? "border-amber-300 dark:border-amber-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Measured, unbilled
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inrShort(totalUnbilledMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Owed on work already done. In no register.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 4 · By project. ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Cost against contract, by project</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {projects.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No project has an issued BOQ, an RA bill or a vendor invoice
                against it yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                Projects with nothing costed against them are left out on
                purpose rather than shown as rows of zeroes — a sales workspace
                has forty projects and no construction, and forty empty rows
                teach the reader that this page has nothing to say.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Project</th>
                    <th className="px-3 py-2 text-right font-medium">Original</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Variations
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Contract</th>
                    <th className="px-3 py-2 text-right font-medium">Certified</th>
                    <th className="px-3 py-2 text-right font-medium">
                      In the queue
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Vendor spend
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Retention held
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Unbilled</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {projects.map((p) => {
                    const certifiedPct = pctOf(p.certifiedMinor, p.revisedMinor);
                    const overCommitted =
                      certifiedPct !== null && certifiedPct > 100;
                    return (
                      <tr
                        key={p.projectId}
                        className={
                          overCommitted
                            ? "bg-red-50/60 dark:bg-red-950/20"
                            : p.isActive
                              ? "hover:bg-muted/40"
                              : "opacity-60"
                        }
                      >
                        <td className="px-3 py-2">
                          <span className="font-medium">{p.name}</span>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {p.code}
                            {p.boqCount > 0
                              ? ` · ${p.boqCount} BOQ${p.boqCount === 1 ? "" : "s"}`
                              : " · no issued BOQ"}
                          </div>
                          {p.overMeasuredLines > 0 && (
                            <Badge
                              variant="outline"
                              className="mt-1 border-red-400 text-[10px] text-red-700 dark:border-red-800 dark:text-red-300"
                            >
                              {p.overMeasuredLines} line
                              {p.overMeasuredLines === 1 ? "" : "s"} over
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {inr(p.originalMinor)}
                        </td>
                        {/* ⚠️ SIGNED. An omission takes scope OUT of the
                            contract and is negative — a variations column
                            that can only add reports a contract sum that is
                            permanently overstated. */}
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {p.variationMinor.startsWith("-") ? "" : "+"}
                          {inr(p.variationMinor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {inr(p.revisedMinor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {inr(p.certifiedMinor)}
                          {certifiedPct !== null && (
                            <div
                              className={
                                overCommitted
                                  ? "text-[10px] text-red-700 dark:text-red-300"
                                  : "text-[10px] text-muted-foreground"
                              }
                            >
                              {certifiedPct}% of contract
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {inr(p.pendingMinor)}
                          {p.pendingBills > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              {p.pendingBills} bill
                              {p.pendingBills === 1 ? "" : "s"} uncertified
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {inr(p.committedPurchaseMinor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {inr(p.retentionHeldMinor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {inr(p.unbilledMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          ⚠️ Every figure rolls up to the PROJECT, and no row here claims that
          a particular RA bill belongs to a particular BOQ. There is no foreign
          key between them — `boqs.contract_ref` is text somebody typed and
          `ra_bills.contract_id` points at a works contract — so the project is
          the only key both sides agree on. A per-contract variance built on a
          text match would look authoritative and be wrong on the first
          contract whose reference was typed with a different separator.
        </p>
        <p>
          Certified means the ENGINEER has certified the work, which is the
          moment the money is owed. Payment is a separate treasury event and is
          shown only in the bill register. Retention is netted against anything
          already released — gross retention on a job where half has gone back
          is leverage somebody thinks they still hold.
        </p>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-56 animate-pulse rounded-lg border bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function CostControlPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Cost Control</h1>
          <p className="text-sm text-muted-foreground">
            What each job was contracted to cost, and what it has actually
            committed.
          </p>
        </div>
        <Link
          href="/purchases"
          className="text-sm text-muted-foreground hover:underline"
        >
          Vendor bills
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <CostBody />
      </Suspense>
    </div>
  );
}
