/**
 * Ordence — ⭐⭐ ONE LAND PARCEL, AND ITS TITLE CHAIN
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY PARCEL IN THE LAND REGISTER LINKED HERE AND THIS PAGE DID NOT
 *    EXIST
 * ══════════════════════════════════════════════════════════════════════
 * Three actions had no caller: `saveLandParcel`, `dropLandParcel` and ,
 * most importantly , `auditTitleChain`.
 *
 * The chain audit is the reason this module exists. A developer buying
 * agricultural land in India is buying a CHAIN of transfers, and the
 * defects that matter are in the joins: one link's seller who is not the
 * previous link's buyer, a link nobody has verified against the
 * sub-registrar's record, an encumbrance certificate about to expire.
 * The engine that finds those was written and there was no screen that
 * could ask it a question.
 *
 * ⚠️ THE FINDINGS ARE QUESTIONS, NOT REFUSALS, AND THE PAGE SAYS SO.
 * `auditTitleChain`'s own note explains why: a gap is legitimate at a
 * partition, a will, a court decree or a mutation, and a defect
 * everywhere else. Presenting them as errors would train somebody to
 * dismiss the one that mattered.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, LandPlot, TriangleAlert } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  auditTitleChain,
  dropLandParcel,
  listLandParcels,
  saveLandParcel,
} from "@/server/actions/land";
import { Badge } from "@/components/ui/badge";
import { ParcelControls } from "./parcel-controls";

export const dynamic = "force-dynamic";

function inr(minor: string | null): string {
  if (!minor) return "—";
  const value = BigInt(minor);
  const whole = value / 100n;
  return `₹${new Intl.NumberFormat("en-IN").format(whole)}`;
}

const SEVERITY_LABEL: Record<string, string> = {
  gap: "A break in the chain",
  unverified: "Not verified against the record",
  expiring: "Expiring",
};

export default async function LandParcelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext();

  const [listResult, chainResult] = await Promise.all([
    listLandParcels(),
    auditTitleChain(id),
  ]);

  if (!listResult.ok) notFound();
  const parcel = listResult.data.parcels.find((row) => row.id === id);
  if (!parcel) notFound();

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canManage = can(subject, "land.parcels.manage");

  const chain = chainResult.ok ? chainResult.data : null;
  const dropped = parcel.droppedReason !== null;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/land"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to the land register
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <LandPlot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              {parcel.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[parcel.surveyNumber, parcel.village, parcel.district]
                .filter(Boolean)
                .join(" · ") || "no location recorded"}
            </p>
          </div>
          <Badge variant={dropped ? "destructive" : "outline"}>
            {dropped ? "Dropped" : parcel.stage}
          </Badge>
        </div>
      </div>

      {dropped && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span className="font-medium">Dropped: </span>
          {parcel.droppedReason}
        </p>
      )}

      <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Extent</dt>
          <dd className="font-semibold tabular-nums">
            {parcel.extentAcre ?? "—"} acre {parcel.extentGuntha ?? "0"} guntha
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Consideration</dt>
          <dd className="font-semibold tabular-nums">{inr(parcel.considerationMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Advance paid</dt>
          <dd className="font-semibold tabular-nums">{inr(parcel.advancePaidMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Chain</dt>
          <dd className="font-semibold tabular-nums">
            {parcel.chainLength} link{parcel.chainLength === 1 ? "" : "s"}
            {parcel.unverifiedLinks > 0 && (
              <span className="ml-1 text-xs font-normal text-amber-700 dark:text-amber-400">
                {parcel.unverifiedLinks} unverified
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/* ── THE CHAIN ─────────────────────────────────────────────── */}
      <section aria-labelledby="chain-heading" className="space-y-3">
        <h2 id="chain-heading" className="text-lg font-semibold">
          Title chain
        </h2>

        {!chain ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {chainResult.ok ? "" : chainResult.error}
          </p>
        ) : chain.links.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No chain recorded. A parcel with no chain has no evidence of who may sell it.
          </p>
        ) : (
          <>
            {chain.findings.length > 0 && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                  {chain.findings.length} thing
                  {chain.findings.length === 1 ? "" : "s"} to ask about
                </p>
                {/*
                  ⚠️ "ASK ABOUT", NOT "ERRORS". A gap is legitimate at a
                  partition, a will, a court decree or a mutation. Calling
                  it an error teaches people to dismiss the list.
                */}
                <ul className="space-y-1 text-sm">
                  {chain.findings.map((finding, i) => (
                    <li key={`${finding.position}-${i}`}>
                      <span className="font-medium">
                        Link {finding.position} , {SEVERITY_LABEL[finding.severity] ?? finding.severity}:
                      </span>{" "}
                      {finding.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <ol className="divide-y rounded-md border">
              {chain.links.map((link) => (
                <li key={link.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">
                      {link.position}. {link.title}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {link.kind}
                    </span>
                    {!link.isVerified && (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        not verified
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {link.fromParty ?? "—"} → {link.toParty ?? "—"}
                    {link.registeredOn ? ` · registered ${link.registeredOn}` : ""}
                    {link.expiresOn ? ` · expires ${link.expiresOn}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {canManage && !dropped && (
        <ParcelControls
          parcel={{
            id: parcel.id,
            name: parcel.name,
            surveyNumber: parcel.surveyNumber,
            village: parcel.village,
            district: parcel.district,
            extentAcre: parcel.extentAcre,
            extentGuntha: parcel.extentGuntha,
          }}
          save={saveLandParcel}
          drop={dropLandParcel}
        />
      )}
    </main>
  );
}
