/**
 * Ordence — Reports Gallery Page
 * Version: v0.82.0-alpha
 */

import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

export default function ReportsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <ReportsClient />
    </div>
  );
}
