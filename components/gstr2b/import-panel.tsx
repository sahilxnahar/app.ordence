"use client";

/**
 * Ordence — 🔴🔴🔴 IMPORTING GSTR-2B AND RUNNING THE RECONCILIATION
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SEVEN OF TEN ACTIONS IN THIS MODULE HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * `/gstr2b` wired three reads. `importGstr2b`, `runGstr2bReconciliation`,
 * `getGstr2bDocuments`, `getVendorChase`, `decideGstr2bMatch`,
 * `bulkDecideGstr2bMatches` and `fileGstr2bReconciliation` were reachable
 * from nothing — 4,986 lines of parser, matcher, tolerance and summary
 * engine behind a screen that could only ever say "nothing reconciled
 * yet".
 *
 * ⚠️ AND THIS IS THE STATUTORY ONE. s.16(2)(aa) CGST with Rule 36(4)
 * makes input credit conditional on the invoice having been furnished by
 * the supplier and communicated to the recipient — which in practice
 * means appearing in GSTR-2B. A workspace with no reconciliation is
 * claiming credit it has no way to evidence, and the whole ITC surface
 * was in that state.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE FILE IS STORED AS THE FILE, NOT AS PARSED COLUMNS
 * ══════════════════════════════════════════════════════════════════════
 * `importGstr2b` hashes the content and keeps it, and the action's own
 * comment gives the reason: a CSV that has been through a column mapper
 * is no longer the file the accountant sent. When a figure is disputed
 * eighteen months later, the artefact that settles it is the download
 * from the portal, byte for byte.
 *
 * 🔴 THE DATE-ORDER SWITCH IS NOT A CONVENIENCE. `03-04-2024` is 3 April
 * to the GST portal and 4 March to a spreadsheet saved under a US locale,
 * and NO PARSER CAN TELL. Day-first is the default because that is what
 * the portal emits without exception. The switch exists so somebody who
 * KNOWS their file has been through Excel can say so — rather than
 * discovering it later as invoices sitting in the wrong tax period.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type RegistrationOption = { id: string; gstin: string };

const BLANK = {
  registrationId: "",
  gstin: "",
  returnPeriod: "",
  sourceFormat: "portal_json",
  fileName: "",
  content: "",
  dateOrder: "day-first",
  defaultSection: "b2b",
  toleranceMinor: "100",
};

export function Gstr2bImportPanel({
  registrations,
  importAction,
  reconcileAction,
}: {
  registrations: readonly RegistrationOption[];
  importAction: (i: unknown) => Promise<
    Result<{
      documentId: string;
      rowCount: number;
      parseStatus: string;
      issues: { path: string; message: string; severity: string }[];
    }>
  >;
  reconcileAction: (i: unknown) => Promise<
    Result<{
      reconciliationId: string;
      matchCount: number;
      itcAtRiskMinor: string;
      /**
       * 🔴 THE IDENTITY CHECK. Matched plus unmatched must equal the total
       * on each side. When it does not, every figure on the summary is
       * suspect and the page says so in red — so a run that fails it must
       * not be reported here as a success.
       */
      reconciles: boolean;
      identityFailures: string[];
    }>
  >;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ...BLANK });
  const [fe, setFe] = useState<Record<string, string[]>>({});

  const ready =
    f.gstin.trim().length === 15 &&
    /^\d{4}-\d{2}$/.test(f.returnPeriod.trim()) &&
    f.content.trim() !== "";

  /**
   * ⭐ IMPORT AND RECONCILE ARE ONE BUTTON AND TWO CALLS, in that order,
   * and the reconciliation is NOT skipped if the import succeeds and it
   * fails. An imported statement nobody reconciled is a file on a shelf.
   */
  function submit() {
    setFe({});
    startTransition(async () => {
      const imported = await importAction({
        registrationId: f.registrationId || null,
        gstin: f.gstin.trim().toUpperCase(),
        returnPeriod: f.returnPeriod.trim(),
        sourceFormat: f.sourceFormat,
        fileName: f.fileName.trim() || null,
        content: f.content,
        defaultSection:
          f.sourceFormat === "csv" ? f.defaultSection : undefined,
        dateOrder: f.dateOrder,
      });
      if (!imported.ok) {
        if (imported.fieldErrors) setFe(imported.fieldErrors);
        toast.error(imported.error);
        return;
      }
      /**
       * ⚠️ PARSE ISSUES ARE SURFACED, NOT SWALLOWED. A statement that
       * parsed with warnings is not the same as one that parsed clean,
       * and the difference decides whether a missing invoice is the
       * supplier's fault or the file's.
       */
      const errs = imported.data.issues.filter((i) => i.severity === "error");
      const warns = imported.data.issues.filter((i) => i.severity !== "error");
      if (errs.length > 0) {
        toast.error(
          `${imported.data.rowCount} row(s) imported with ${errs.length} error(s). First: ${errs[0]?.path} — ${errs[0]?.message}`,
        );
      } else {
        toast.success(
          `${imported.data.rowCount} row(s) imported for ${f.returnPeriod.trim()}` +
            (warns.length > 0
              ? `, with ${warns.length} warning(s). First: ${warns[0]?.message}`
              : ` (${imported.data.parseStatus}).`),
        );
      }

      const run = await reconcileAction({
        gstin: f.gstin.trim().toUpperCase(),
        taxPeriod: f.returnPeriod.trim(),
        registrationId: f.registrationId || null,
        documentId: imported.data.documentId,
        toleranceMinor: Number(f.toleranceMinor || "0"),
      });
      if (!run.ok) {
        /**
         * ⚠️ THE IMPORT IS NOT ROLLED BACK. The statement is a fact that
         * arrived; a failed match run is a separate problem, and
         * discarding the file would mean re-downloading it from the
         * portal to try again.
         */
        toast.error(
          `Imported, but the reconciliation did not run: ${run.error} The statement is stored and can be reconciled again.`,
        );
        setOpen(false);
        return;
      }
      /**
       * 🔴 A RUN THAT DOES NOT RECONCILE IS NOT REPORTED AS A SUCCESS.
       * `reconciles` is the identity check — matched plus unmatched must
       * equal the total on each side. When it fails, every figure on the
       * summary is arithmetic over rows that do not add up, and the page
       * already refuses to present it as anything else.
       */
      if (!run.data.reconciles) {
        toast.error(
          `Reconciled ${run.data.matchCount} row(s), BUT THE RUN DOES NOT BALANCE: ${run.data.identityFailures.join("; ")}. Treat every figure on the summary as suspect until this is explained.`,
        );
      } else {
        toast.success(
          `${run.data.matchCount} match(es) scored. ${inr(run.data.itcAtRiskMinor)} of input credit is at risk and is waiting on the worklist.`,
        );
      }
      setF({ ...BLANK });
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Import a GSTR-2B statement
        </Button>
        <span className="text-xs text-muted-foreground">
          Rule 36(4): credit is conditional on the invoice appearing here.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="g-reg">Our registration</Label>
          <select
            id="g-reg"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.registrationId}
            onChange={(e) => {
              const r = registrations.find((x) => x.id === e.target.value);
              setF({
                ...f,
                registrationId: e.target.value,
                gstin: r?.gstin ?? f.gstin,
              });
            }}
          >
            <option value="">Choose…</option>
            {registrations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.gstin}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="g-gstin">GSTIN</Label>
          <Input
            id="g-gstin"
            maxLength={15}
            value={f.gstin}
            onChange={(e) => setF({ ...f, gstin: e.target.value })}
          />
          <Errors list={fe.gstin} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="g-period">Return period</Label>
          <Input
            id="g-period"
            placeholder="2026-03"
            value={f.returnPeriod}
            onChange={(e) => setF({ ...f, returnPeriod: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The period the statement is FOR, not the month it was downloaded.
          </p>
          <Errors list={fe.returnPeriod} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="g-fmt">Format</Label>
          <select
            id="g-fmt"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.sourceFormat}
            onChange={(e) => setF({ ...f, sourceFormat: e.target.value })}
          >
            <option value="portal_json">Portal JSON</option>
            <option value="portal_excel">Portal Excel</option>
            <option value="csv">CSV</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="g-content">The file</Label>
        <Textarea
          id="g-content"
          rows={6}
          className="font-mono text-xs"
          value={f.content}
          placeholder="Paste the downloaded file here."
          onChange={(e) => setF({ ...f, content: e.target.value })}
        />
        {/**
         * ⭐ THE FILE IS KEPT AS THE FILE. When a figure is disputed
         * eighteen months later, the artefact that settles it is the
         * download from the portal, not a table somebody re-keyed.
         */}
        <p className="text-xs text-muted-foreground">
          Stored exactly as pasted and hashed. A file that has been through a
          column mapper is no longer the file the portal produced, and that is
          the artefact a dispute is settled against.
        </p>
        <Errors list={fe.content} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="g-order">Date order in this file</Label>
          <select
            id="g-order"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.dateOrder}
            onChange={(e) => setF({ ...f, dateOrder: e.target.value })}
          >
            <option value="day-first">Day first — the portal&apos;s format</option>
            <option value="month-first">Month first — been through Excel</option>
          </select>
          {/**
           * 🔴 NO PARSER CAN TELL. This is the one field on the form that
           * silently changes which tax period an invoice lands in.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 `03-04-2026` is 3 April to the portal and 4 March to a
            spreadsheet saved under a US locale, and no parser can tell. Only
            change this if you know the file has been through Excel.
          </p>
        </div>
        {f.sourceFormat === "csv" && (
          <div className="space-y-1">
            <Label htmlFor="g-sect">Default section</Label>
            <select
              id="g-sect"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={f.defaultSection}
              onChange={(e) => setF({ ...f, defaultSection: e.target.value })}
            >
              <option value="b2b">B2B</option>
              <option value="b2ba">B2BA — amendments</option>
              <option value="cdnr">CDNR — credit and debit notes</option>
              <option value="cdnra">CDNRA</option>
              <option value="isd">ISD</option>
              <option value="impg">IMPG — imports</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Only for a delimited file whose sheet does not say. B2B is the
              safe default: a mis-sectioned row is matched normally rather than
              treated as an amendment that supersedes something.
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="g-tol">Tolerance, paise</Label>
          <Input
            id="g-tol"
            inputMode="numeric"
            value={f.toleranceMinor}
            onChange={(e) => setF({ ...f, toleranceMinor: e.target.value })}
          />
          {/**
           * ⚠️ RECORDED WITH THE RUN. A reconciliation produced under a
           * ₹1 tolerance and one under ₹100 are different documents and
           * the difference is invisible on the result.
           */}
          <p className="text-xs text-muted-foreground">
            Recorded with the run, because a reconciliation done at ₹1 and one
            done at ₹100 are different documents. ⚠️ Capped at ₹100: beyond
            that a tolerance stops absorbing round-off and starts absorbing
            real differences.
          </p>
          <Errors list={fe.toleranceMinor} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !ready} onClick={submit}>
          Import and reconcile
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setF({ ...BLANK });
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** ⚠️ Paise to rupees. Money never crosses the boundary as a number. */
function inr(minor: string): string {
  const n = BigInt(minor || "0");
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "−" : ""}₹${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, "0")}`;
}

function Errors({ list }: { list?: string[] }) {
  if (!list) return null;
  return (
    <>
      {list.map((m) => (
        <p key={m} className="text-xs text-destructive">
          {m}
        </p>
      ))}
    </>
  );
}
