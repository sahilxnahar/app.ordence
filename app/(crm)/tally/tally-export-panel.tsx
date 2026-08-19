"use client";

/**
 * Ordence — ⭐⭐⭐ GENERATE, PUSH, AND MARK DELIVERED
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE EXPORT ENGINE HAD NO BUTTON
 * ══════════════════════════════════════════════════════════════════════
 * `generateTallyExport`, `pushTallyExport` and `markTallyExportDelivered`
 * were all built, all tested, and called by nothing. The page listed
 * batches; on every workspace the list was empty, because nothing could
 * make one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE STEPS, AND THE SECOND ONE OFTEN CANNOT WORK
 * ══════════════════════════════════════════════════════════════════════
 *   GENERATE  builds the XML and stores the batch. Always available.
 *   PUSH      sends it to a running Tally over HTTP. Only possible when
 *             Tally is reachable from wherever Ordence runs, which on a
 *             cloud deployment it usually is not , Tally listens on the
 *             office LAN.
 *   DELIVER   records that the XML reached Tally by some other route:
 *             downloaded, carried over, imported by hand.
 *
 * The third step is not a consolation prize. It is how most firms will
 * actually use this, and it matters because the REMOTEIDs in a delivered
 * batch are what make the next export an update rather than a duplicate.
 * A batch that reached Tally and was never marked delivered causes the
 * next export to create second copies of every voucher in it.
 *
 * ⚠️ THE DOWNLOAD IS BUILT FROM THE XML THE ACTION RETURNS, in the
 * browser, with no second server round trip. The bytes the user carries
 * to Tally are therefore exactly the bytes whose hash was recorded.
 */

import { useState, useTransition } from "react";
import { Download, Send, CheckCircle2, FileCode2 } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Generated = {
  batchId: string;
  batchNumber: string;
  voucherCount: number;
  action: "Create" | "Alter";
  amendedCount: number;
  hash: string;
  bytes: number;
  xml: string;
  warning: string | null;
};

export type ConnectionChoice = { id: string; name: string; isActive: boolean; host: string | null };

const VOUCHER_TYPES = [
  { value: "sales", label: "Sales" },
  { value: "purchase", label: "Purchase" },
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "journal", label: "Journal" },
  { value: "contra", label: "Contra" },
  { value: "credit_note", label: "Credit note" },
  { value: "debit_note", label: "Debit note" },
] as const;

const DEFAULT_TYPES = ["sales", "purchase", "receipt", "payment", "journal"];

export function TallyExportPanel(props: {
  connections: readonly ConnectionChoice[];
  defaultCompanyName: string;
  generate: (input: unknown) => Promise<Result<Generated>>;
  push: (
    input: unknown,
  ) => Promise<Result<{ batchId: string; created: number | null; altered: number | null; ignored: number | null }>>;
  markDelivered: (input: unknown) => Promise<Result<{ batchId: string }>>;
}) {
  const [connectionId, setConnectionId] = useState<string>(props.connections[0]?.id ?? "");
  const [companyName, setCompanyName] = useState(props.defaultCompanyName);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  const [includeMasters, setIncludeMasters] = useState(false);

  const [built, setBuilt] = useState<Generated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleType(value: string) {
    setTypes((current) =>
      current.includes(value) ? current.filter((t) => t !== value) : [...current, value],
    );
  }

  function generate() {
    setError(null);
    setNotice(null);
    setBuilt(null);
    startTransition(async () => {
      const result = await props.generate({
        connectionId: connectionId === "" ? null : connectionId,
        companyName,
        periodStart,
        periodEnd,
        voucherTypes: types,
        includeMasters,
        notes: null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBuilt(result.data);
    });
  }

  function download() {
    if (!built) return;
    /**
     * ⚠️ A BLOB FROM THE STRING WE ALREADY HOLD. Re-fetching the XML
     * would be a second read of a batch that may have been altered in
     * between, and the file somebody carries to Tally must be the one
     * whose hash was recorded against the batch.
     */
    const blob = new Blob([built.xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${built.batchNumber}.xml`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function push() {
    if (!built || connectionId === "") return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.push({ batchId: built.batchId, connectionId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { created, altered, ignored } = result.data;
      setNotice(
        `Tally accepted the batch. Created ${created ?? 0}, altered ${altered ?? 0}, ignored ${ignored ?? 0}.`,
      );
    });
  }

  function deliver() {
    if (!built) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.markDelivered({
        batchId: built.batchId,
        responsePayload: null,
        notes: "Marked delivered from the Tally screen after a manual import.",
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(
        "Recorded as delivered. The next export will UPDATE these vouchers in Tally rather than creating second copies.",
      );
    });
  }

  const activeConnection = props.connections.find((c) => c.id === connectionId);

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FileCode2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Build an export
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Connection</span>
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">None , build a file to import by hand</option>
            {props.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Company name in Tally</span>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Period start</span>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Period end</span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            A financial year at most. A ten-year file cannot be reviewed before it is imported,
            and Tally has no undo for an import.
          </span>
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Voucher types</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {VOUCHER_TYPES.map((type) => (
            <label key={type.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={types.includes(type.value)}
                onChange={() => toggleType(type.value)}
              />
              <span>{type.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={includeMasters}
          onChange={(e) => setIncludeMasters(e.target.checked)}
        />
        <span>
          <span className="block">Include ledger masters</span>
          <span className="block text-xs text-muted-foreground">
            Needed the first time, so the vouchers have ledgers to post against. Only mappings
            marked &ldquo;create in Tally if missing&rdquo; are included.
          </span>
        </span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <button
        type="button"
        onClick={generate}
        disabled={pending || periodStart === "" || periodEnd === "" || types.length === 0}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : "Build the export"}
      </button>

      {built && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <p className="text-sm">
            <span className="font-medium">{built.batchNumber}</span> , {built.voucherCount}{" "}
            voucher{built.voucherCount === 1 ? "" : "s"}, {(built.bytes / 1024).toFixed(1)} KB.
          </p>

          {/*
            ⭐ CREATE vs ALTER IS THE MOST IMPORTANT LINE ON THIS PANEL.
            An Alter batch UPDATES vouchers already in Tally, because the
            REMOTEIDs are deterministic. Somebody who does not know that is
            about to worry about duplicates that will not happen.
          */}
          <p className="text-sm text-muted-foreground">
            {built.action === "Alter"
              ? `This is an UPDATE. ${built.amendedCount} voucher${built.amendedCount === 1 ? " has" : "s have"} already been delivered once and will be overwritten in Tally rather than duplicated.`
              : "This is a first delivery. Every voucher will be created in Tally."}
          </p>

          <p className="font-mono text-xs text-muted-foreground">sha256 {built.hash.slice(0, 24)}…</p>

          {built.warning && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-800 dark:bg-amber-950/30">
              {built.warning}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={download}
              className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download the XML
            </button>

            <button
              type="button"
              onClick={push}
              disabled={pending || connectionId === "" || !activeConnection?.host}
              title={
                connectionId === ""
                  ? "Choose a connection first."
                  : activeConnection?.host
                    ? undefined
                    : "This connection has no host, so there is nothing to push to."
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              Push to Tally
            </button>

            <button
              type="button"
              onClick={deliver}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              I imported it by hand
            </button>
          </div>

          <p className="text-xs text-muted-foreground">
            Mark it delivered however it got there. A batch that reached Tally and was never
            marked makes the next export create second copies of every voucher in it.
          </p>
        </div>
      )}
    </section>
  );
}
