"use client";

/**
 * Ordence — ⭐ HANDING THE BROWSER A STATUTORY RETURN FILE
 * Version: v1.52.0-alpha · Batch 78
 *
 * ⚠️ A CLIENT COMPONENT, AND FOR THE SAME REASON AS
 * `app/(crm)/settings/recovery/export-button.tsx`: the file is assembled
 * in memory and saved through an object URL, because there is
 * deliberately NO GET ROUTE to link to. An ECR is every colleague's UAN
 * and PF wages; a URL that returns it is a URL that ends up in a browser
 * history, a proxy log or a screenshot.
 *
 * 🔴 THE TEXT ARRIVES ALREADY VALIDATED. This component makes no
 * decisions about content — if `lib/payroll/returns/` refused, the page
 * renders the refusal and this button is not on the screen at all.
 */

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

export function ReturnDownload(props: {
  readonly fileName: string;
  readonly text: string;
  readonly confirmedAgainstPortal: boolean;
}) {
  const [saved, setSaved] = useState(false);

  function handleDownload() {
    // ⚠️ `text/plain` and NOT a portal-specific type. The ECR is a `.txt`
    // and the ESIC worksheet is a `.csv`; claiming a MIME type the file
    // is not would make some browsers rewrite the extension.
    const blob = new Blob([props.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = props.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // ⚠️ Released immediately — an object URL holds the whole file until
    // it is revoked, and one leak per click eventually takes the tab down.
    URL.revokeObjectURL(url);
    setSaved(true);
    toast.success(
      props.confirmedAgainstPortal
        ? `Saved ${props.fileName}.`
        : `Saved ${props.fileName}. Check the layout against the portal before uploading it.`,
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleDownload}
        className="inline-flex w-fit items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        <Download className="h-4 w-4" aria-hidden />
        Download {props.fileName}
      </button>
      {/* ⭐ EVERY STATE CARRIES A WORD. "Saved" with nothing after it
          reads as "filed", and it is not filed until it is uploaded. */}
      <p className="text-xs text-slate-500">
        {saved
          ? "Saved to your downloads. It is not filed until you upload it to the portal and pay the challan."
          : "Nothing has been filed. This saves the file for you to upload yourself."}
      </p>
    </div>
  );
}
