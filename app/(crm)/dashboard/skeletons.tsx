/**
 * Ordence — Dashboard Skeletons
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY SKELETONS AND NOT A SPINNER
 * ══════════════════════════════════════════════════════════════════════
 * A spinner says "something is happening". A skeleton says "a chart of
 * roughly this size is about to appear here", which is the more useful
 * message and — because it reserves the space — stops the page jumping
 * when the data lands.
 *
 * That layout shift is not cosmetic. On a dashboard with three panels
 * resolving at different speeds, unreserved space means the thing you were
 * about to click moves out from under the cursor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THEY ARE MARKED aria-hidden
 * ══════════════════════════════════════════════════════════════════════
 * A skeleton is a picture of nothing. Announcing its shape to a screen
 * reader is noise. The Suspense boundary's own live region carries the
 * "loading" message; these bars carry it visually, for people who can see
 * them.
 */

function Shimmer({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`animate-pulse rounded-md bg-muted ${className ?? ""}`}
      style={style}
    />
  );
}

export function StatTilesSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-md border border-border p-4">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="mt-2 h-7 w-32" />
          <Shimmer className="mt-2 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function FinancialChartSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Shimmer className="h-4 w-52" />
          <Shimmer className="mt-1.5 h-3 w-36" />
        </div>
        <Shimmer className="h-8 w-28" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border p-3">
            <Shimmer className="h-3 w-20" />
            <Shimmer className="mt-2 h-6 w-28" />
          </div>
        ))}
      </div>

      {/* Bars of varying height, so the placeholder reads as a chart
          rather than as a grey block. */}
      <div className="flex h-72 items-end gap-1.5 rounded-md border border-border p-4">
        {[45, 62, 30, 78, 52, 88, 40, 66, 35, 72, 58, 44, 80, 50, 68].map((h, i) => (
          <div key={i} className="flex flex-1 items-end gap-0.5">
            <Shimmer className="w-full" style={{ height: `${h}%` }} />
            <Shimmer className="w-full" style={{ height: `${Math.max(12, h - 18)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PieChartSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div>
        <Shimmer className="h-4 w-40" />
        <Shimmer className="mt-1.5 h-3 w-48" />
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="relative h-56 w-56 shrink-0">
          <div className="absolute inset-0 animate-pulse rounded-full border-[26px] border-muted" />
        </div>

        <ul className="w-full flex-1 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="flex items-center justify-between gap-3">
              <Shimmer className="h-3 w-28" />
              <Shimmer className="h-3 w-12" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ActivityFeedSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div>
        <Shimmer className="h-4 w-32" />
        <Shimmer className="mt-1.5 h-3 w-24" />
      </div>

      <div className="space-y-0 rounded-md border border-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 border-b border-border px-3 py-3 last:border-b-0">
            <Shimmer className="h-4 w-4 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Shimmer className="h-3 w-32" />
              <Shimmer className="h-3 w-48" />
            </div>
            <Shimmer className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
