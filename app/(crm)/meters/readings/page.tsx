/**
 * Ordence — ⭐ ENGINE 5 · READING ENTRY AND HISTORY
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM ASKS WHAT THE DIAL SAID. THERE IS NO CONSUMPTION FIELD.
 * ══════════════════════════════════════════════════════════════════════
 * Consumption is the DIFFERENCE between two readings on the same meter,
 * and it is derived by trigger — rollover-aware, multiplier-applied,
 * re-derived when a backdated reading lands underneath it. Storing what
 * somebody typed as "units used" would throw away the only thing that can
 * ever verify it, so when a customer disputes July you would have your own
 * arithmetic and nothing to check it against.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE IS NO EDIT AND NO DELETE ON THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * Not as a policy — as a fact about the database. A trigger refuses any
 * change to `reading_value`, `read_at` or `meter_id`, and the application
 * role holds no DELETE privilege on `meter_readings` at all; the grant was
 * REVOKEd explicitly in SQL-FILES/0035. Both absences are load-bearing:
 *
 *   EDITING IN PLACE means last month's bill was computed from a figure
 *   that now exists nowhere, and the customer's PDF becomes the only
 *   surviving record of what the system actually did.
 *
 *   DELETING silently re-chains everything after it — the next reading's
 *   baseline jumps back past the gap, that period's consumption doubles,
 *   and the invoice already in the customer's hands stops matching
 *   anything here.
 *
 * So the correction offered is SUPERSEDING: mark the old row superseded,
 * record the new one beside it, keep both.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ANOMALIES ARE SHOWN, NOT HIDDEN, AND THE NOTE IS VERBATIM
 * ══════════════════════════════════════════════════════════════════════
 * `anomaly_note` is written by the trigger for a person to read — "this
 * reading is LOWER than the previous one and was treated as a dial
 * rollover, but the resulting consumption is far above this meter's recent
 * average… do not bill this period until it is confirmed". Paraphrasing it
 * into "check this reading" throws away the only part that says what to
 * do. It is printed exactly as written.
 *
 * ⚠️ AND EVERY FLAGGED READING ON THIS SCREEN WAS ACCEPTED. A 4× jump is a
 * bypass, a stopped dial, a transposed digit — and an air conditioner
 * bought in April. Nothing on this page refuses a reading for looking
 * wrong.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  listMeterReadings,
  type MeterReadingRow,
} from "@/server/actions/metering";
import { ReadingActions } from "@/components/metering/reading-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Meter readings · Ordence" };

function humanise(value: string): string {
  return value.replace(/_/g, " ");
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

function statusTone(status: string): string {
  if (status === "rejected") return "text-muted-foreground line-through";
  if (status === "superseded") return "text-muted-foreground";
  if (status === "disputed")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (status === "validated")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  return "";
}

/** The label a reading carries in a picker: which meter, which dial, when. */
function readingLabel(r: MeterReadingRow): string {
  return `${r.meterSerialNumber} · ${r.readingValue} · ${when(r.readAt)}${
    r.isAnomaly ? " · flagged" : ""
  }${r.status === "superseded" ? " · superseded" : ""}`;
}

async function ReadingsBody({ meterId }: { meterId: string | null }) {
  const result = await listMeterReadings(meterId ? { meterId } : undefined);

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reading history unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { readings, anomalies, rollovers, meters, counters } = result.data;

  const readingOptions = readings.map((r) => ({
    id: r.id,
    label: readingLabel(r),
    meterId: r.meterId,
    status: r.status,
  }));

  const focus = meterId ? meters.find((m) => m.id === meterId) : null;

  return (
    <div className="space-y-6">
      <ReadingActions meters={meters} readings={readingOptions} />

      {focus && (
        <div className="flex flex-wrap items-baseline gap-3 text-sm">
          <span className="text-muted-foreground">Showing</span>
          <span className="font-mono">{focus.serialNumber}</span>
          <span className="text-muted-foreground">
            {humanise(focus.kind)} · {focus.digitCount} digits · {focus.unit}
          </span>
          <Link href="/meters/readings" className="text-xs underline">
            every meter
          </Link>
        </div>
      )}

      {/* ── 1 · ⭐ FLAGGED READINGS. Accepted, and put in front of a person. */}
      {anomalies.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {anomalies.length} flagged reading{anomalies.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-3">
              {anomalies.slice(0, 12).map((r) => (
                <li key={r.id} className="space-y-1">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-xs">{r.meterSerialNumber}</span>
                    <span className="tabular-nums font-medium">
                      dial {r.readingValue}
                    </span>
                    <span className="tabular-nums">
                      {r.consumption ?? "—"} {r.meterUnit}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {when(r.readAt)} · {humanise(r.source)}
                    </span>
                    {r.isRollover && (
                      <Badge variant="outline" className="text-[10px]">
                        rollover
                      </Badge>
                    )}
                    <Badge variant="outline" className={statusTone(r.status)}>
                      {humanise(r.status)}
                    </Badge>
                  </div>
                  {/* ⭐ VERBATIM. The trigger wrote this for a human, and it
                      says what to do next. */}
                  {r.anomalyNote && (
                    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                      {r.anomalyNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Every one of these was accepted and every one of them stands. A
              reading three times the meter&rsquo;s own recent average is theft,
              a fault or a transposed digit — and it is also a family that bought
              an air conditioner in April. Refusing it would make an honest bill
              impossible and push the number into somebody&rsquo;s notebook; not
              noticing it at all is how meter tampering runs for two years. If
              one is genuinely wrong, supersede it: the original stays, because
              the invoice computed from it needs something to point at.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · ROLLOVERS. The arithmetic the whole engine turns on. ── */}
      {rollovers.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-300">
              {rollovers.length} reading{rollovers.length === 1 ? "" : "s"} treated
              as a dial rollover
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {rollovers.slice(0, 12).map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{r.meterSerialNumber}</span>
                  <span className="tabular-nums">
                    {r.previousValue ?? "—"} → {r.readingValue}
                  </span>
                  <span className="tabular-nums font-medium text-blue-700 dark:text-blue-300">
                    {r.consumption ?? "—"} {r.meterUnit}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.meterDigitCount}-digit dial · {when(r.readAt)}
                  </span>
                  {r.isAnomaly && (
                    <Badge variant="outline" className="text-[10px]">
                      also flagged
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The reading went DOWN and was read as the dial wrapping past its
              maximum. A 5-digit meter passing 99999 and showing 00042 consumed
              43 units; naive subtraction says minus 99,957 and issues a credit
              note for roughly a year of free supply, automatically, to whoever
              happens to be on that meter. Where a wrap produces consumption far
              above the meter&rsquo;s own average it is flagged as well — that
              pattern is a misread digit or an unrecorded meter replacement far
              more often than it is a genuine wrap.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Readings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counters.total}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counters.superseded} superseded, none deleted.
            </p>
          </CardContent>
        </Card>
        <Card
          className={
            counters.anomalies > 0 ? "border-amber-300 dark:border-amber-800" : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Flagged
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.anomalies}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              All accepted. None refused.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Estimated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.estimated}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Each one owes a reconciliation to the next actual reading.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Disputed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.disputed}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The number is unchanged. The disagreement is on the row.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 4 · The history. ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Reading history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {readings.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">No readings yet.</p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                A reading is what the dial said at a moment — the cumulative
                total on the face of the meter, never the units used since last
                time. Consumption is worked out from the difference between two
                readings on the same meter, so the number you record here is the
                one thing that can ever verify a bill. Record the first one and
                the history builds itself.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Meter</th>
                    <th className="px-4 py-2 font-medium">Read at</th>
                    <th className="px-4 py-2 text-right font-medium">Previous</th>
                    <th className="px-4 py-2 text-right font-medium">Dial</th>
                    <th className="px-4 py-2 text-right font-medium">Consumed</th>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Who</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {readings.slice(0, 300).map((r) => (
                    <tr
                      key={r.id}
                      className={
                        r.isAnomaly && r.status !== "rejected"
                          ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                          : r.status === "superseded" || r.status === "rejected"
                            ? "opacity-70 hover:bg-muted/40"
                            : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2">
                        <Link
                          href={`/meters/readings?meter=${r.meterId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {r.meterSerialNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-xs tabular-nums">
                        {when(r.readAt)}
                        {/* ⚠️ The gap between when the dial was looked at and
                            when the row arrived is the only way to spot a
                            round filled in afterwards from a desk. */}
                        {r.createdAt.slice(0, 10) !== r.readAt.slice(0, 10) && (
                          <div className="text-[11px] text-muted-foreground">
                            entered {when(r.createdAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {r.previousValue ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {r.readingValue}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.consumption ?? "—"}
                        {r.isRollover && (
                          <div className="text-[11px] text-blue-700 dark:text-blue-300">
                            rollover
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {humanise(r.source)}
                        {r.source === "estimated" && (
                          <div className="text-[11px] text-red-700 dark:text-red-300">
                            owes a reconciliation
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={statusTone(r.status)}>
                          {humanise(r.status)}
                        </Badge>
                        {r.isAnomaly && (
                          <div className="mt-1 max-w-[26rem] text-[11px] text-amber-700 dark:text-amber-300">
                            {/* ⭐ Verbatim, again, on the row itself. */}
                            {r.anomalyNote ?? "flagged"}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {r.readByName ?? "—"}
                        {r.notes && (
                          <div className="max-w-[16rem] truncate">{r.notes}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* ⚠️ NO EDIT AND NO DELETE ANYWHERE ON THIS TABLE, and that is the
              whole value of it. */}
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Append-only in the ways that matter. The dial value, the instant and
            the meter cannot be changed — a trigger refuses all three — and there
            is no delete here or in the database, because the application role
            holds no DELETE privilege on this table at all. A wrong reading is
            superseded: the original stays, marked, beside its replacement. That
            is why an invoice raised six months ago can still be shown the
            arithmetic it came from.
          </p>
        </CardContent>
      </Card>
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

export default async function MeterReadingsPage({
  searchParams,
}: {
  searchParams: Promise<{ meter?: string }>;
}) {
  const params = await searchParams;
  /**
   * ⚠️ SHAPE-CHECKED HERE, not trusted into the action. A malformed value
   * would be rejected by the Zod parse inside `listMeterReadings` anyway —
   * which silently drops the filter and shows every meter. Checking here
   * means the link either filters or does not exist.
   */
  const meterId =
    params.meter &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      params.meter,
    )
      ? params.meter
      : null;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Meter readings</h1>
          <p className="text-sm text-muted-foreground">
            What the dial said, and what the database made of it.
          </p>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/meters" className="hover:underline">
            Meter register
          </Link>
        </div>
      </header>

      <Suspense fallback={<Skeleton />}>
        <ReadingsBody meterId={meterId} />
      </Suspense>
    </div>
  );
}
