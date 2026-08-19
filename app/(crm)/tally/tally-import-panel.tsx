"use client";

/**
 * Ordence — ⭐⭐⭐ IMPORT A TALLY FILE AND RECONCILE AGAINST IT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RECONCILIATION QUEUE HAD NOTHING TO PUT IN IT
 * ══════════════════════════════════════════════════════════════════════
 * `importTallyExport`, `getTallyImportBatches`, `getTallyReconciliation`
 * and `resolveTallyReconciliationItem` were all built and all called by
 * nothing. Reconciliation , the thing that tells a firm the two systems
 * have drifted apart , could not be started.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FILE IS READ IN THE BROWSER AND SENT AS TEXT
 * ══════════════════════════════════════════════════════════════════════
 * A Tally day book is XML and rarely more than a few megabytes; the
 * server caps it at 20 MB and says why. Reading it here rather than
 * through the upload pipeline is deliberate: this file is EVIDENCE for a
 * reconciliation, not a document in the vault, and it is stored against
 * the import batch verbatim so a disputed difference can be re-checked
 * against exactly the bytes that produced it.
 *
 * ⚠️ IMPORTING DOES NOT WRITE ANYTHING INTO THE LEDGER. It compares. The
 * panel says so out loud, because "import" in every other screen of this
 * product means "bring this data in", and here it does not.
 */

import { useState, useTransition } from "react";
import { FileUp, GitCompare } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type ImportBatchRow = {
  id: string;
  sourceLabel: string;
  companyName: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  voucherCount: number;
  differenceCount: number;
  unresolvedCount: number;
  warningCount: number;
};

export type ReconciliationRow = {
  id: string;
  kind: string;
  status: string;
  remoteId: string | null;
  ourVoucherNumber: string | null;
  ourAmountMinor: string | null;
  theirVoucherNumber: string | null;
  theirAmountMinor: string | null;
  explanation: string;
};

function inr(minor: string | null): string {
  if (!minor) return "—";
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}` : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

export function TallyImportPanel(props: {
  batches: readonly ImportBatchRow[];
  runImport: (
    input: unknown,
  ) => Promise<
    Result<{
      importBatchId: string;
      companyName: string | null;
      theirVoucherCount: number;
      matched: number;
      differences: number;
      actionable: number;
      warnings: number;
    }>
  >;
  loadReconciliation: (importBatchId: string) => Promise<Result<{ rows: ReconciliationRow[] }>>;
  resolve: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [sourceLabel, setSourceLabel] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [payload, setPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [items, setItems] = useState<ReconciliationRow[]>([]);
  const [pending, startTransition] = useTransition();

  async function onFile(file: File | null) {
    if (!file) return;
    setError(null);
    setNotice(null);
    setSourceLabel(file.name);
    /**
     * ⚠️ `text()` AND NOT A BINARY READ. A Tally export is XML in UTF-8
     * or UTF-16 depending on the version that wrote it; the browser
     * decodes it and the server's parser is given a string, which is what
     * it validates.
     */
    setPayload(await file.text());
  }

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.runImport({
        connectionId: null,
        sourceLabel,
        periodStart,
        periodEnd,
        payload,
        notes: null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const d = result.data;
      setNotice(
        `Read ${d.theirVoucherCount} voucher${d.theirVoucherCount === 1 ? "" : "s"} from Tally. ` +
          `${d.matched} matched, ${d.differences} differ, ${d.actionable} need a decision` +
          `${d.warnings > 0 ? `, ${d.warnings} warning${d.warnings === 1 ? "" : "s"}` : ""}.`,
      );
      setPayload("");
      setSourceLabel("");
      openReconciliation(d.importBatchId);
    });
  }

  function openReconciliation(batchId: string) {
    startTransition(async () => {
      const result = await props.loadReconciliation(batchId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpenBatch(batchId);
      setItems([...result.data.rows]);
    });
  }

  function decide(itemId: string, status: "open" | "explained" | "resolved", note: string) {
    setError(null);
    startTransition(async () => {
      const result = await props.resolve({ itemId, status, resolutionNote: note || null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) =>
        current.map((row) => (row.id === itemId ? { ...row, status } : row)),
      );
    });
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FileUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Compare against a Tally file
      </h3>

      <p className="text-sm text-muted-foreground">
        Export a day book from Tally for a period and upload it here. Nothing is written into
        your ledger , this reads their vouchers and tells you where the two disagree.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Tally day book (XML)</span>
          <input
            type="file"
            accept=".xml,text/xml,application/xml"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm"
          />
          {payload !== "" && (
            <span className="block text-xs text-muted-foreground">
              {sourceLabel} , {(payload.length / 1024).toFixed(1)} KB read
            </span>
          )}
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
            The period the file covers. Reconciling ten years against one month reports
            everything as a difference.
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={pending || payload === "" || periodStart === "" || periodEnd === ""}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Comparing…" : "Compare"}
      </button>

      {props.batches.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Comparisons so far
          </h4>
          <ul className="divide-y rounded-md border">
            {props.batches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                <span className="font-medium">{batch.sourceLabel}</span>
                <span className="text-xs text-muted-foreground">
                  {batch.periodStart} to {batch.periodEnd} · {batch.voucherCount} vouchers
                </span>
                {batch.unresolvedCount > 0 && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    {batch.unresolvedCount} unresolved
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => openReconciliation(batch.id)}
                  disabled={pending}
                  className="ml-auto inline-flex items-center gap-1 text-xs underline underline-offset-2 disabled:opacity-60"
                >
                  <GitCompare className="h-3 w-3" aria-hidden="true" />
                  open
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {openBatch && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Differences
          </h4>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to reconcile , the two sides agree for this period.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((row) => (
                <ReconciliationItem key={row.id} row={row} pending={pending} onDecide={decide} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * ⚠️ ITS OWN COMPONENT SO EACH ROW HOLDS ITS OWN NOTE. One shared note
 * field across a list is how a comment intended for one difference gets
 * filed against another , and a reconciliation note is read months later
 * by somebody who was not there.
 */
function ReconciliationItem(props: {
  row: ReconciliationRow;
  pending: boolean;
  onDecide: (id: string, status: "open" | "explained" | "resolved", note: string) => void;
}) {
  const [note, setNote] = useState("");
  const { row } = props;

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{row.kind}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{row.status}</span>
        {row.remoteId && (
          <code className="text-[10px] text-muted-foreground">{row.remoteId}</code>
        )}
      </div>

      <p className="text-muted-foreground">{row.explanation}</p>

      <div className="grid gap-1 text-xs sm:grid-cols-2">
        <span>
          Ordence: {row.ourVoucherNumber ?? "—"} · {inr(row.ourAmountMinor)}
        </span>
        <span>
          Tally: {row.theirVoucherNumber ?? "—"} · {inr(row.theirAmountMinor)}
        </span>
      </div>

      {row.status === "open" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What accounts for this?"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={() => props.onDecide(row.id, "explained", note)}
            disabled={props.pending}
            className="rounded-md border border-input px-2 py-1.5 text-xs disabled:opacity-60"
          >
            Explained
          </button>
          <button
            type="button"
            onClick={() => props.onDecide(row.id, "resolved", note)}
            disabled={props.pending}
            className="rounded-md border border-input px-2 py-1.5 text-xs disabled:opacity-60"
          >
            Resolved
          </button>
        </div>
      )}
    </li>
  );
}
