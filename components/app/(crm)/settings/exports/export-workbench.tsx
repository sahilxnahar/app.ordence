"use client";

/**
 * Ordence — ⭐⭐⭐ THE EXPORT PICKER
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE IDEA IN THIS SCREEN: SAY WHAT IT COSTS BEFORE THE CLICK
 * ══════════════════════════════════════════════════════════════════════
 * Every format loses something. CSV loses the types, PDF loses every
 * script that is not Latin, Tally XML is not available for data that
 * carries no Tally mapping. A picker that lists six formats as if they
 * were interchangeable is a picker that hands somebody a page of question
 * marks where their customers' names should be.
 *
 * So `exportFormatsFor()` is called as soon as a dataset is chosen — it
 * runs no query, it inspects the SHAPE — and every caution it returns is
 * on screen before the download button is pressed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE DOWNLOAD IS ASSEMBLED IN MEMORY, NOT LINKED
 * ══════════════════════════════════════════════════════════════════════
 * The same argument `app/(crm)/settings/recovery/export-button.tsx`
 * makes: a GET URL that returns every contact in a workspace is a URL you
 * do not want in a browser history, a proxy log or a screenshot.
 */

import { useEffect, useState, useTransition } from "react";
import { Download, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  exportFormatsFor,
  runExport,
  type ExportableDataset,
  type FormatChoice,
} from "@/server/actions/export";

/**
 * ⚠️ base64 → bytes, without `atob().split("").map()`. That idiom builds
 * a JS array one character at a time and falls over on a file of any
 * size; a 30MB spreadsheet becomes 30 million array entries.
 *
 * ⭐ RETURNS THE `ArrayBuffer`, NOT THE VIEW. `Blob` accepts an
 * `ArrayBuffer` directly, and TypeScript 5.7 narrowed `BlobPart` so a
 * `Uint8Array<ArrayBufferLike>` no longer satisfies it — the view might be
 * over a `SharedArrayBuffer`. Handing over the buffer is one line shorter
 * than the cast that would silence it and does not lie about the type.
 */
function bufferFromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ExportWorkbench({ datasets }: { datasets: readonly ExportableDataset[] }) {
  const [datasetKey, setDatasetKey] = useState(datasets[0]?.key ?? "");
  const [formats, setFormats] = useState<FormatChoice[]>([]);
  const [format, setFormat] = useState("xlsx");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loadingFormats, startFormats] = useTransition();
  const [busy, setBusy] = useState(false);

  const dataset = datasets.find((d) => d.key === datasetKey);
  const chosen = formats.find((f) => f.id === format);

  useEffect(() => {
    if (!datasetKey) return;
    startFormats(async () => {
      const result = await exportFormatsFor(datasetKey);
      if (!result.ok) {
        toast.error(result.error);
        setFormats([]);
        return;
      }
      setFormats(result.data);
      /**
       * ⚠️ IF THE CURRENT CHOICE IS UNAVAILABLE FOR THE NEW DATASET, MOVE
       * IT. Leaving Tally XML selected after switching to Contacts means
       * the button is armed with a request that will be refused, and the
       * person reads the refusal as the product being broken.
       */
      setFormat((current) => {
        const still = result.data.find((f) => f.id === current && f.available);
        return still ? current : (result.data.find((f) => f.available)?.id ?? current);
      });
    });
  }, [datasetKey]);

  async function download() {
    if (!dataset) return;
    setBusy(true);
    try {
      const result = await runExport({
        datasetKey,
        format,
        ...(dataset.dated && from ? { from } : {}),
        ...(dataset.dated && to ? { to } : {}),
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const blob = new Blob([bufferFromBase64(result.data.base64)], {
        type: result.data.mediaType,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(
        `${result.data.rowCount.toLocaleString("en-IN")} rows · ${humanBytes(result.data.byteCount)}`,
      );

      /**
       * ⭐ THE NOTES ARE SHOWN AFTER THE DOWNLOAD AS WELL AS BEFORE IT.
       * "12 characters could not be drawn in this PDF" is exactly the
       * thing somebody needs to read at the moment they have the file,
       * not five minutes earlier when they were choosing a format.
       */
      for (const note of result.data.notes) toast.warning(note, { duration: 12_000 });
    } catch {
      toast.error("The export could not be prepared. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (datasets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Your role does not allow any exports. Exporting is a separate permission from viewing —
        somebody who may see a contact is not automatically allowed to take the whole list.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="export-dataset">What to export</Label>
          <Select
            id="export-dataset"
            value={datasetKey}
            onChange={(e) => setDatasetKey(e.target.value)}
          >
            {datasets.map((d) => (
              <option key={d.key} value={d.key}>
                {d.title}
              </option>
            ))}
          </Select>
          {dataset ? (
            <p className="text-xs text-muted-foreground">{dataset.description}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="export-format">Format</Label>
          <Select
            id="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            disabled={loadingFormats}
          >
            {formats.map((f) => (
              <option key={f.id} value={f.id} disabled={!f.available}>
                {f.label}
                {f.available ? "" : " — not available for this data"}
              </option>
            ))}
          </Select>
          {chosen ? <p className="text-xs text-muted-foreground">{chosen.summary}</p> : null}
        </div>
      </div>

      {dataset?.dated ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="export-from">From</Label>
            <Input
              id="export-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="export-to">To</Label>
            <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      ) : null}

      {chosen && !chosen.available && chosen.reason ? (
        <p className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>{chosen.reason}</span>
        </p>
      ) : null}

      {chosen?.caution ? (
        <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>{chosen.caution}</span>
        </p>
      ) : null}

      {dataset?.hasPersonalColumns ? (
        <p className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>
            This export contains personal data. Ordence records who ran it, when, and which
            personal fields were in it. The record is kept; the file is not.
          </span>
        </p>
      ) : null}

      <Button
        type="button"
        onClick={download}
        disabled={busy || loadingFormats || !chosen?.available}
      >
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Download className="mr-2 h-4 w-4" aria-hidden />
        )}
        {busy ? "Preparing…" : "Export"}
      </Button>
    </div>
  );
}
