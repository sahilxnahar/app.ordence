"use client";

/**
 * Triggers the workspace export and hands the browser a file.
 *
 * A client component because the download is assembled in memory and
 * saved with an object URL — there is no route to link to, deliberately:
 * a GET endpoint returning every record in a workspace is exactly the
 * URL you do not want appearing in a browser history, a proxy log or a
 * shared screenshot.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { exportWorkspace } from "@/server/actions/recovery";
import { cn } from "@/lib/utils";

export function ExportButton() {
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setBusy(true);
    try {
      const result = await exportWorkspace();

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const blob = new Blob([result.data.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // ⚠️ Released immediately. An object URL holds the entire export in
      // memory until revoked, and this file can be tens of megabytes —
      // leaking one per click would eventually take the tab down.
      URL.revokeObjectURL(url);

      const total = Object.values(result.data.counts).reduce((a, b) => a + b, 0);
      toast.success(`Exported ${total.toLocaleString("en-IN")} records.`);
    } catch {
      toast.error("The export could not be prepared. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
        "bg-primary text-primary-foreground hover:bg-primary/90",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
      )}
    >
      {busy ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Preparing your file…
        </>
      ) : (
        <>
          <Download className="h-4 w-4" aria-hidden="true" />
          Download my data
        </>
      )}
    </button>
  );
}
