/**
 * Ordence — Site labour
 * Version: v0.73.0-alpha
 *
 * ⭐ THE NUMBER AT THE TOP OF THIS SCREEN IS "HOW MANY PEOPLE CANNOT
 * WORK TOMORROW MORNING".
 *
 * Everything else here — attendance, site logs, piece rates — is a
 * record. That one figure is an action. A supervisor opening this page
 * at 6pm needs to know how many UANs have to be sorted before the gate
 * opens, because at 7am with forty people waiting nobody reads a table.
 */

import { Suspense } from "react";
import { HardHat } from "lucide-react";
import { getSiteLabourOverview } from "@/server/actions/labour";
import {
  RegisterWorkerForm,
  WorkerRowActions,
  DailySiteLogForm,
  PieceRateForm,
} from "@/components/construction/labour-actions";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Site labour · Ordence" };

function inr(decimal: string | null | undefined): string {
  if (!decimal) return "₹0.00";
  const raw = String(decimal);
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [wholeRaw = "0", fracRaw = "00"] = body.split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  const lastThree = wholeRaw.slice(-3);
  const rest = wholeRaw.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function uanTone(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "valid") return "default";
  if (status === "invalid") return "destructive";
  if (status === "not_applicable") return "outline";
  return "secondary";
}

function PanelSkeleton() {
  return <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />;
}

async function LabourPanels() {
  const result = await getSiteLabourOverview();

  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-sm font-semibold text-destructive">
          Could not load the labour register
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{result.error}</p>
      </div>
    );
  }

  const d = result.data;

  return (
    <div className="space-y-8">
      {/* ---- the four numbers ---- */}
      <section className="grid gap-3 sm:grid-cols-4" aria-label="Labour position">
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">On the register</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{d.counts.total}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Admissible to site</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{d.counts.admissible}</p>
        </div>
        <div
          className={`rounded-md border p-3 ${
            d.counts.blocked > 0
              ? "border-destructive/40 bg-destructive/5"
              : "border-border"
          }`}
        >
          <p className="text-xs text-muted-foreground">⚠️ Cannot work tomorrow</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{d.counts.blocked}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Unbilled piece work</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{inr(d.unbilledTotal)}</p>
        </div>
      </section>

      {/* ---- the register ---- */}
      <section className="space-y-3" aria-labelledby="worker-register">
        <h2 id="worker-register" className="text-sm font-semibold">
          Worker register
        </h2>

        {d.workers.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Nobody on the register yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Registered site workers</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Worker</th>
                  <th scope="col" className="px-3 py-2 font-medium">Trade</th>
                  <th scope="col" className="px-3 py-2 font-medium">UAN</th>
                  <th scope="col" className="px-3 py-2 font-medium">Admissible</th>
                  <th scope="col" className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {d.workers.map((w) => (
                  <tr key={w.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{w.workerName}</span>
                      {w.exitedOn && (
                        <div className="text-xs text-muted-foreground">
                          left site {w.exitedOn}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{w.trade ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={uanTone(w.uanStatus)}>{w.uanStatus}</Badge>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {w.uan ?? "no number"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {w.isAdmissible ? (
                        <Badge variant="default">Yes</Badge>
                      ) : (
                        <>
                          <Badge variant="destructive">No</Badge>
                          {w.blockedReason && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {w.blockedReason}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <WorkerRowActions worker={w} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <RegisterWorkerForm
          projects={d.options.projects}
          vendors={d.options.vendors}
        />
      </section>

      {/* ---- attendance ---- */}
      <section className="space-y-3" aria-labelledby="recent-attendance">
        <h2 id="recent-attendance" className="text-sm font-semibold">
          Recent attendance
        </h2>
        {d.recentAttendance.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No attendance recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {d.recentAttendance.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-3 py-2">
                <span>{a.workerName}</span>
                <span className="text-xs text-muted-foreground">
                  {a.kind === "check_in" ? "in" : "out"} ·{" "}
                  {new Date(a.occurredAt).toLocaleString("en-IN")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- site logs ---- */}
      <section className="space-y-3" aria-labelledby="site-logs">
        <h2 id="site-logs" className="text-sm font-semibold">
          Daily site logs
        </h2>
        {d.recentLogs.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Recent daily site logs</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">Weather</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Rain (mm)</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Hours lost</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Labour</th>
                  <th scope="col" className="px-3 py-2 font-medium">Issues</th>
                </tr>
              </thead>
              <tbody>
                {d.recentLogs.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{l.logDate}</td>
                    <td className="px-3 py-2 text-xs">{l.weather ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.rainfallMm ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.hoursLost ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.labourCount}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {l.issues ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DailySiteLogForm projects={d.options.projects} />
      </section>

      {/* ---- piece rates ---- */}
      <section className="space-y-3" aria-labelledby="piece-rates">
        <h2 id="piece-rates" className="text-sm font-semibold">
          Unbilled piece work
        </h2>
        {d.unbilledPieceRates.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Measured piece work not yet billed</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Work item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Measured</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                  <th scope="col" className="px-3 py-2 font-medium">Witness</th>
                </tr>
              </thead>
              <tbody>
                {d.unbilledPieceRates.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{p.workItem}</td>
                    <td className="px-3 py-2 text-xs">{p.measuredOn}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.quantity} {p.unit}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(p.rate)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {inr(p.amount)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {p.witnessedByName ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PieceRateForm projects={d.options.projects} vendors={d.options.vendors} />
      </section>
    </div>
  );
}

export default function SiteLabourPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <HardHat className="h-5 w-5" aria-hidden="true" />
          Site labour
        </h1>
        <p className="text-sm text-muted-foreground">
          Who is on the register, who may work, what was done, and what has not been billed.
        </p>
      </header>

      <Suspense fallback={<PanelSkeleton />}>
        <LabourPanels />
      </Suspense>
    </div>
  );
}
