/**
 * Ordence — Land, title and approvals
 * Version: v0.42.0-alpha  ·  PORT WAVE A
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE LEADS WITH WHAT CAN STOP A PROJECT, NOT WHAT IT OWNS
 * ══════════════════════════════════════════════════════════════════════
 * A land screen that opens with a count of parcels and their total area
 * is a screen nobody looks at twice. The things that actually stop a
 * developer are: a title chain with a break in it, a khata a bank will
 * not lend against, and a building that is over its sanctioned FAR and
 * therefore may never get an occupancy certificate.
 *
 * ⭐ THE OC RISK IS FIRST BECAUSE IT IS THE MOST EXPENSIVE.
 * Without an occupancy certificate a finished tower cannot lawfully be
 * occupied, buyers cannot register their flats, and lenders will not
 * disburse against them. The building is complete and worthless. Every
 * other number on this page can wait a week; that one cannot.
 *
 * ⚠️ UNVERIFIED LINKS ARE SHOWN AS A COUNT, NOT HIDDEN BEHIND A TICK.
 * A chain of six documents of which two have never been checked against a
 * certified copy is a chain that proves four things. Rendering it as "6
 * documents" is the reassuring lie this page exists to avoid.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listLandParcels } from "@/server/actions/land";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Land & title · Ordence" };

function inr(minorUnits: string | bigint | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
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
 * ⭐ EXTENT IS SHOWN THE WAY THE DEED WRITES IT: acres and guntha.
 * Converting to a single decimal acre figure makes every comparison
 * against the document a mental conversion somebody gets wrong. 1 acre is
 * 40 guntha, not 100 — which is the conversion people get wrong.
 */
function extent(acre: string | null, guntha: string | null): string {
  const a = acre ? Number(acre) : 0;
  const g = guntha ? Number(guntha) : 0;
  if (a === 0 && g === 0) return "—";
  const parts: string[] = [];
  if (a > 0) parts.push(`${a % 1 === 0 ? a : a.toFixed(2)} ac`);
  if (g > 0) parts.push(`${g % 1 === 0 ? g : g.toFixed(2)} gu`);
  return parts.join(" ");
}

const STAGE_LABEL: Record<string, string> = {
  identified: "Identified",
  under_negotiation: "Negotiating",
  agreed: "Agreed",
  due_diligence: "Due diligence",
  registered: "Registered",
  dropped: "Dropped",
};

async function LandBody() {
  const result = await listLandParcels();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Land records unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { parcels, jdaCount, unloanable, pendingSanctions, expiringDiligence, ocRisk } =
    result.data;

  const live = parcels.filter((p) => p.stage !== "dropped");
  const brokenChains = live.filter((p) => p.unverifiedLinks > 0);
  const noChain = live.filter((p) => p.chainLength === 0);
  const committed = live.reduce((acc, p) => acc + BigInt(p.considerationMinor), 0n);

  return (
    <div className="space-y-6">
      {ocRisk.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {ocRisk.length} project{ocRisk.length === 1 ? "" : "s"} built over the
              sanctioned FAR
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {ocRisk.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{p.projectId.slice(0, 8)}</span>
                  <span className="font-medium tabular-nums text-red-600">
                    {(p.deviationBps / 100).toFixed(2)}% over
                  </span>
                  <span className="text-muted-foreground">
                    {p.ocReceived
                      ? "OC recorded as received — check the regularisation reference"
                      : "OC not received"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Without an occupancy certificate the building cannot be lawfully
              occupied, buyers cannot register, and banks will not disburse. A
              finished tower with no OC is a finished tower nobody can move
              into. The tolerance most authorities work to is 5%.
            </p>
          </CardContent>
        </Card>
      )}

      {unloanable.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {unloanable.length} khata record{unloanable.length === 1 ? "" : "s"} a bank
              will not lend against
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="flex flex-wrap gap-2">
              {unloanable.slice(0, 12).map((k) => (
                <li key={k.id}>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {k.khataNo ?? "no number"} · {k.khataType.replace("_", "-")}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              A B-khata property can be bought, but only for cash — which
              removes most of the market for it. Worth knowing before a price
              is quoted, not after.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={noChain.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Parcels with no title chain
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{noChain.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {live.length} live. No chain means no evidence of ownership at
              all.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unverified deeds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {brokenChains.reduce((a, p) => a + p.unverifiedLinks, 0)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Not yet checked against a certified copy.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Committed on land
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(committed)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {jdaCount} joint development agreement{jdaCount === 1 ? "" : "s"}.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Approvals in progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{pendingSanctions}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {expiringDiligence.length} due-diligence record
              {expiringDiligence.length === 1 ? "" : "s"} expiring within 60 days.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Land parcels</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {parcels.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No parcels yet. A parcel is recorded from the moment it is
              identified — long before it is a project, and including the ones
              that never become one, because the reason a parcel was dropped is
              what stops the same land being looked at again in two years.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Parcel</th>
                    <th className="px-4 py-2 font-medium">Survey / village</th>
                    <th className="px-4 py-2 font-medium">Extent</th>
                    <th className="px-4 py-2 font-medium">Stage</th>
                    <th className="px-4 py-2 font-medium">Title chain</th>
                    <th className="px-4 py-2 text-right font-medium">Consideration</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parcels.map((p) => (
                    <tr key={p.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2">
                        <Link href={`/land/${p.id}`} className="hover:underline">
                          {p.name}
                        </Link>
                        {p.droppedReason && (
                          <div className="text-xs text-muted-foreground">
                            dropped — {p.droppedReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        <span className="font-mono">{p.surveyNumber ?? "—"}</span>
                        {p.village && <div>{p.village}</div>}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {extent(p.extentAcre, p.extentGuntha)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge
                          variant="outline"
                          className={
                            p.stage === "dropped"
                              ? "text-muted-foreground"
                              : p.stage === "registered"
                                ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                                : ""
                          }
                        >
                          {STAGE_LABEL[p.stage] ?? p.stage}
                        </Badge>
                      </td>
                      {/* ⭐ The count and the unverified count, never merged. */}
                      <td className="px-4 py-2 text-xs">
                        {p.chainLength === 0 ? (
                          <span className="font-medium text-amber-700 dark:text-amber-300">
                            none recorded
                          </span>
                        ) : (
                          <>
                            <span className="tabular-nums">{p.chainLength} deeds</span>
                            {p.unverifiedLinks > 0 && (
                              <span className="ml-2 text-amber-700 dark:text-amber-300">
                                {p.unverifiedLinks} unverified
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {inr(p.considerationMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        The chain of title is stored in order, so a missing link is refused
        outright rather than sitting invisibly in a list. A break between one
        deed&apos;s buyer and the next deed&apos;s seller is reported as a
        question rather than refused — that is normal at a partition, a will or
        a court decree, and a defect everywhere else. Heir shares are exact
        fractions: three heirs of one third sum to exactly one here, and to
        99.99 in any system that stores percentages.
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

export default function LandPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Land &amp; title</h1>
          <p className="text-sm text-muted-foreground">
            Who owned it, how they came to own it, and whether it can be built
            on.
          </p>
        </div>
        <Link href="/sales" className="text-sm text-muted-foreground hover:underline">
          Projects &amp; units
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <LandBody />
      </Suspense>
    </div>
  );
}
