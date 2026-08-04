/**
 * Ordence — Platform Console · Health & Revenue Observatory
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE VIEW CLOUDFLARE CANNOT GIVE YOU
 * ══════════════════════════════════════════════════════════════════════
 * Cloudflare's dashboard reports on a Worker. One Worker serves every
 * tenant, so its graphs answer "is the platform up" and stop there. They
 * cannot say which tenant is producing the errors, which one is eating
 * the shared request budget, or which one has gone quiet — because
 * Cloudflare does not know tenants exist.
 *
 * This page answers those three, from rows the application already writes.
 *
 * ⚠️ AGGREGATES ONLY. Counts, sums, timestamps, percentages. Not one
 * customer record reaches this screen. Seeing anything a customer typed
 * still requires an impersonation session: consented, time-limited,
 * bannered and audited. "Just show me the deal that errored" is a
 * reasonable-sounding request and the answer is still no.
 *
 * Streamed, because the cross-tenant aggregate is the slowest query in
 * the product and a blank page is not a loading state.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getObservatory } from "@/server/platform/observatory";
import {
  ObservatoryTotalsRow,
  NeedsAttention,
  FleetVitals,
  AdoptionHeatmap,
  CohortTable,
} from "@/components/platform/observatory-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Observatory · Ordence Platform",
  robots: { index: false, follow: false },
};

async function ObservatoryBody() {
  const result = await getObservatory();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Observatory unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{result.error}</p>
          <p>
            {/*
              Deliberately vague to the reader, precise in the log. This
              screen reads across every tenant; a raw Postgres message here
              could carry a slug, a column name or a value.
            */}
            The details are in the platform error log with a correlation id.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { totals, vitals, adoption, cohorts, needsAttention, generatedAt } = result.data;

  return (
    <div className="space-y-6">
      <ObservatoryTotalsRow totals={totals} />

      {/* Alarms first. See the comment on NeedsAttention for why. */}
      <NeedsAttention rows={needsAttention} />

      <FleetVitals rows={vitals} currency={totals.currency} />

      <div className="grid gap-6 lg:grid-cols-2">
        <AdoptionHeatmap rows={adoption} />
        <CohortTable rows={cohorts} />
      </div>

      <p className="text-xs text-muted-foreground">
        Generated {new Date(generatedAt).toLocaleString()}. Every figure on this
        page comes from one transaction, so the totals and the table agree with
        each other.
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
      <div className="h-48 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function ObservatoryPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <nav className="text-sm text-muted-foreground">
          <Link href="/platform" className="hover:underline">
            Platform
          </Link>
          <span className="px-2">/</span>
          <span>Observatory</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">
          Health &amp; Revenue Observatory
        </h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant health, revenue and quota burn-down. Aggregates only — no
          customer records appear on this page.
        </p>
      </header>

      <Suspense fallback={<Skeleton />}>
        <ObservatoryBody />
      </Suspense>
    </div>
  );
}
