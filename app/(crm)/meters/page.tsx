/**
 * Ordence — ⭐ ENGINE 5 · THE METER REGISTER
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE LEADS WITH THE THREE THINGS A LIST OF METERS CANNOT SAY
 * ══════════════════════════════════════════════════════════════════════
 * Everything structurally dangerous is already impossible in the
 * database: a reading's dial value cannot be edited, a reading cannot be
 * deleted, a rollover cannot be subtracted naively, and a finalised
 * period's figures cannot be changed. So this screen has nothing useful
 * to add about any of them.
 *
 * What it must say is what the data knows and a sorted table does not:
 *
 *   1. ⭐ OPEN ANOMALIES — the LATEST reading on this meter departed
 *      sharply from the meter's own history. ⚠️ THESE ARE FLAGS, NEVER
 *      REJECTIONS. A 4× jump is theft, a fault, a transposed digit — and
 *      it is also a family that bought an air conditioner in April. The
 *      reading stands and somebody looks at it.
 *
 *   2. ⭐ STALE METERS — from `v_meter_status.days_since_read`. This is
 *      the list the reading round is planned from, and a meter that has
 *      never been read at all is at the top of it, because there is not
 *      even a baseline to estimate from.
 *
 *   3. ⭐ METERS ON A RUN OF ESTIMATES — from
 *      `v_meter_estimates_outstanding`. An estimated reading is a debt
 *      the system owes itself: the bill went out based on history, and
 *      the next ACTUAL reading has to reconcile against it. A run of them
 *      that nobody is tracking is how a customer receives one enormous
 *      correct bill after a year of small wrong ones — which is the bill
 *      that ends up in front of a regulator.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE BILLING PERIOD TABLE SHOWS THE BANK, IN BOTH DIRECTIONS
 * ══════════════════════════════════════════════════════════════════════
 * `units_banked_opening` and `units_banked_closing` are columns on the
 * screen, not a footnote. Net metering is NOT import minus export:
 * surplus export is banked, carried forward, and settled annually — often
 * at a different rate from the import tariff. A screen that shows only
 * the net silently hides the destruction of the bank, which happens
 * monthly, in the utility's favour, and is invisible on the invoice
 * because the invoice only shows the net.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listMeters, type MeterRow } from "@/server/actions/metering";
import { MeterActions } from "@/components/metering/meter-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Meters · Ordence" };

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

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

function when(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function day(value: string | null): string {
  if (!value) return "—";
  return value;
}

function statusTone(status: string): string {
  if (status === "removed" || status === "disconnected") return "text-muted-foreground";
  if (status === "faulty")
    return "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300";
  if (status === "replaced")
    return "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300";
  if (status === "pending_installation")
    return "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300";
  return "";
}

/** How stale, in words. Reads better than a date on an alarm panel. */
function staleness(m: MeterRow): string {
  if (m.daysSinceRead === null) return "never read";
  return `${m.daysSinceRead} days`;
}

async function MeterBody() {
  const result = await listMeters();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Meter register unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    meters,
    withAnomalies,
    stale,
    onEstimateRuns,
    periods,
    consumers,
    rateCardOptions,
    counters,
    staleDays,
    estimateRunAlarm,
  } = result.data;

  const meterOptions = meters.map((m) => ({
    id: m.id,
    serialNumber: m.serialNumber,
    kind: m.kind,
    status: m.status,
    isNetMetered: m.isNetMetered,
  }));

  const periodOptions = periods.map((p) => ({
    id: p.id,
    label: `${p.meterSerialNumber} · ${p.label} (${p.periodStart} → ${p.periodEnd})`,
    isFinalised: p.isFinalised,
  }));

  return (
    <div className="space-y-6">
      <MeterActions
        meters={meterOptions}
        periods={periodOptions}
        consumers={consumers}
        rateCardOptions={rateCardOptions}
      />

      {/* ── 1 · ⭐ OPEN ANOMALIES. Flagged, never rejected. ─────────── */}
      {withAnomalies.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {withAnomalies.length} meter{withAnomalies.length === 1 ? "" : "s"}{" "}
              with a flagged reading
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {withAnomalies.slice(0, 12).map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{m.serialNumber}</span>
                  <span className="font-medium">
                    {m.consumerName ?? m.location ?? humanise(m.kind)}
                  </span>
                  <span className="tabular-nums">
                    last reading {m.lastReadingValue ?? "—"}
                    {m.lastConsumption !== null && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {m.lastConsumption} {m.unit}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {when(m.lastReadAt)}
                  </span>
                  <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-300">
                    {m.openAnomalies} flagged
                  </span>
                  <Link
                    href={`/meters/readings?meter=${m.id}`}
                    className="text-xs underline"
                  >
                    history
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Flagged, not refused, and that is deliberate. A reading three times
              the meter&rsquo;s own recent average is a bypass, a stopped dial or
              a transposed digit — and it is also a family that bought an air
              conditioner in April. Refusing it would make an honest bill
              impossible and push the number into a notebook; not noticing it at
              all is how meter tampering runs for two years. The full note the
              database wrote for each one is on the readings screen.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · ⭐ STALE. The list the reading round is planned from. ── */}
      {stale.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {stale.length} meter{stale.length === 1 ? " has" : "s have"} not
              been read in {staleDays} days
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {stale.slice(0, 15).map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{m.serialNumber}</span>
                  <span className="font-medium">
                    {m.consumerName ?? m.location ?? humanise(m.kind)}
                  </span>
                  <span
                    className={
                      m.daysSinceRead === null
                        ? "font-semibold text-red-700 dark:text-red-300"
                        : "tabular-nums text-red-700 dark:text-red-300"
                    }
                  >
                    {staleness(m)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    last read {when(m.lastReadAt)}
                  </span>
                  {m.connectionRef && (
                    <span className="text-xs text-muted-foreground">
                      {m.connectionRef}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              &ldquo;Never read&rdquo; sorts to the top, because a meter with no
              reading at all is worse than one ninety days old: there is not even
              a baseline to estimate from, so the first bill it ever produces is
              a guess with nothing behind it. Every day a meter goes unread is a
              day of consumption that will eventually be billed in one lump, to
              somebody who has been paying estimates.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · ⭐ ESTIMATE RUNS. A debt the system owes itself. ─────── */}
      {onEstimateRuns.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {onEstimateRuns.length} meter
              {onEstimateRuns.length === 1 ? " is" : "s are"} on a run of{" "}
              {estimateRunAlarm} estimates or more
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {onEstimateRuns.slice(0, 15).map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{m.serialNumber}</span>
                  <span className="font-medium">
                    {m.consumerName ?? m.location ?? humanise(m.kind)}
                  </span>
                  <span className="tabular-nums font-semibold text-red-700 dark:text-red-300">
                    {m.consecutiveEstimates} estimates
                  </span>
                  <span className="text-xs text-muted-foreground">
                    since {when(m.estimatingSince)}
                  </span>
                  {m.estimatedUnits !== null && (
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {m.estimatedUnits} {m.unit} billed on guesswork
                    </span>
                  )}
                  <Link
                    href={`/meters/readings?meter=${m.id}`}
                    className="text-xs underline"
                  >
                    history
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              An estimate is a debt the system owes itself. Nobody could reach
              the meter, the bill went out based on history, and the next actual
              reading has to reconcile against it — crediting or charging the
              difference. One estimate is a locked gate. A run of them is a meter
              nobody has physically seen in a quarter, and the reconciliation,
              when it finally happens, arrives as one enormous correct bill after
              a year of small wrong ones. Send somebody to these.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Meters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counters.total}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counters.active} active, {counters.netMetered} net metered.
            </p>
          </CardContent>
        </Card>
        <Card
          className={counters.stale > 0 ? "border-red-300 dark:border-red-800" : ""}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Not read in {staleDays} days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counters.stale}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counters.neverRead} have never been read at all.
            </p>
          </CardContent>
        </Card>
        <Card
          className={
            counters.withOpenAnomalies > 0 ? "border-amber-300 dark:border-amber-800" : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Flagged readings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.withOpenAnomalies}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Meters to look at. None of them refused a reading.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Banked for export
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.bankedUnits}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Units carried forward, not netted away.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · The register. ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Meters</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {meters.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">No meters yet.</p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                A meter is a physical dial somewhere — an electricity supply, a
                rooftop&rsquo;s generation, a water connection, a diesel tank.
                Register it with the serial number printed on it and, above all,
                the number of digits on the face: that count is what makes a
                rollover survivable, and a 5-digit meter passing 99999 and
                showing 00042 consumed 43 units rather than minus 99,957. The
                register then leads with what is flagged, what nobody has visited
                and what is being billed on guesswork.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Meter</th>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">Consumer / where</th>
                    <th className="px-4 py-2 text-right font-medium">Digits</th>
                    <th className="px-4 py-2 text-right font-medium">Last dial</th>
                    <th className="px-4 py-2 font-medium">Last read</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {meters.slice(0, 300).map((m) => (
                    <tr
                      key={m.id}
                      className={
                        m.consecutiveEstimates >= estimateRunAlarm
                          ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20"
                          : m.lastWasAnomaly
                            ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                            : m.status === "removed" || m.status === "disconnected"
                              ? "opacity-70 hover:bg-muted/40"
                              : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2">
                        <span className="font-mono">{m.serialNumber}</span>
                        {m.connectionRef && (
                          <div className="text-xs text-muted-foreground">
                            {m.connectionRef}
                          </div>
                        )}
                        {m.replacesSerialNumber && (
                          <div className="text-[11px] text-muted-foreground">
                            replaced {m.replacesSerialNumber} on{" "}
                            {day(m.replacedOn)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {humanise(m.kind)}
                        <div>{m.unit}</div>
                        {m.isNetMetered && (
                          <Badge variant="outline" className="text-[10px]">
                            net metered
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {m.consumerName ?? "—"}
                        {m.location && (
                          <div className="max-w-[18rem] truncate text-xs text-muted-foreground">
                            {m.location}
                          </div>
                        )}
                        {m.rateCardName && (
                          <div className="text-[11px] text-muted-foreground">
                            {m.rateCardName}
                          </div>
                        )}
                      </td>
                      {/* ⭐ On the row, because it is the number a wrong
                          rollover is computed against. */}
                      <td className="px-4 py-2 text-right tabular-nums">
                        {m.digitCount}
                        {m.multiplier !== "1" && m.multiplier !== "1.0000" && (
                          <div className="text-[11px] text-muted-foreground">
                            ×{m.multiplier}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {m.lastReadingValue ?? "—"}
                        {m.lastConsumption !== null && (
                          <div className="text-[11px] text-muted-foreground">
                            {m.lastConsumption} {m.unit}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {when(m.lastReadAt)}
                        <div
                          className={
                            m.isStale
                              ? "text-red-700 dark:text-red-300"
                              : "text-muted-foreground"
                          }
                        >
                          {staleness(m)}
                          {m.lastSource ? ` · ${humanise(m.lastSource)}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={statusTone(m.status)}>
                          {humanise(m.status)}
                        </Badge>
                        {m.openAnomalies > 0 && (
                          <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                            {m.openAnomalies} flagged
                          </div>
                        )}
                        {m.consecutiveEstimates > 0 && (
                          <div className="mt-1 text-[11px] text-red-700 dark:text-red-300">
                            {m.consecutiveEstimates} estimate
                            {m.consecutiveEstimates === 1 ? "" : "s"} outstanding
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 6 · ⭐ BILLING PERIODS, WITH THE BANK IN BOTH DIRECTIONS. ── */}
      {periods.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Billing periods</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Period</th>
                    <th className="px-4 py-2 font-medium">Meter</th>
                    <th className="px-4 py-2 text-right font-medium">Consumed</th>
                    <th className="px-4 py-2 text-right font-medium">Exported</th>
                    <th className="px-4 py-2 text-right font-medium">Bank in</th>
                    <th className="px-4 py-2 text-right font-medium">Bank out</th>
                    <th className="px-4 py-2 text-right font-medium">Energy</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {periods.slice(0, 200).map((p) => (
                    <tr key={p.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2">
                        <span className="font-medium">{p.label}</span>
                        <div className="text-xs text-muted-foreground">
                          {p.periodStart} → {p.periodEnd}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {p.meterSerialNumber}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {p.unitsConsumed}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {p.unitsExported}
                      </td>
                      {/* ⭐ Both bank columns, side by side. Import minus
                          export inside the month would destroy this
                          balance quietly, every month, in the utility's
                          favour. */}
                      <td className="px-4 py-2 text-right tabular-nums text-blue-700 dark:text-blue-300">
                        {p.unitsBankedOpening}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-blue-700 dark:text-blue-300">
                        {p.unitsBankedClosing}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {inr(p.energyChargeMinor)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {inr(p.totalMinor)}
                      </td>
                      <td className="px-4 py-2">
                        {p.isFinalised ? (
                          <Badge variant="outline" className="text-[10px]">
                            finalised {when(p.finalisedAt)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">open</span>
                        )}
                        {p.closingReadingId === null && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-300">
                            no closing reading
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Export is banked, never netted off inside the month. It offsets
              import down to zero and no further; what is left opens the next
              period and is settled annually, usually at a rate different from
              the import tariff. Netting the two within a month destroys the bank
              quietly, monthly, in the utility&rsquo;s favour — and invisibly,
              because the invoice only ever shows the net. That is the kind of
              arithmetic a regulator notices.
            </p>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        A reading is an odometer, not a quantity. The consumption figures on this
        screen were all derived in the database from the difference between two
        dial readings on the same meter — rollover-aware, multiplier-applied, and
        never subtracted across a replacement, because a new meter starts at zero
        and has no arithmetic relationship to the one it replaced. Nothing here
        stores a units figure that a reading does not support.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function MetersPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Meters</h1>
          <p className="text-sm text-muted-foreground">
            What is flagged, what nobody has visited, and what is being billed on
            guesswork.
          </p>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/meters/readings" className="hover:underline">
            Readings
          </Link>
          <Link href="/rates" className="hover:underline">
            Rate cards
          </Link>
        </div>
      </header>

      <Suspense fallback={<Skeleton />}>
        <MeterBody />
      </Suspense>
    </div>
  );
}
