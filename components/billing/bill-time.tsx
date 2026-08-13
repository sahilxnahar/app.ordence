"use client";

/**
 * Ordence — ⭐⭐ THE LAST STEP: HOURS BECOME A TAX INVOICE
 * Version: v1.2.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ENGINE SHIPPED IN v1.1.0 WITH NOTHING ABLE TO CALL IT
 * ══════════════════════════════════════════════════════════════════════
 * Time could be recorded, rated, approved and written off. There was no
 * way to bill it. A firm running Ordence would have a perfect record of
 * every hour worked and would raise its invoices in Word — which is the
 * same as not having the module at all, except that it also has two
 * places where an hour lives.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SELECTION IS PER CLIENT, BECAUSE AN INVOICE IS PER CLIENT
 * ══════════════════════════════════════════════════════════════════════
 * The server refuses a mixed selection — but a screen that lets somebody
 * tick forty boxes across three clients and THEN refuses is a screen
 * that wasted their afternoon. One panel per client, checkboxes inside
 * it, and the mistake cannot be made.
 *
 * ⚠️ THE BUTTON IS DISABLED FOR A NAMED REASON, NEVER JUST GREYED. A
 * disabled control with no explanation is read as a broken product.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveTimeEntries,
  raiseInvoiceFromTime,
  writeOffTimeEntries,
} from "@/server/actions/time-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { minutesToHoursLabel } from "@/lib/billing/time";
import { GST_STATE_CODES } from "@/lib/billing/money";

export type TimeRow = {
  id: string;
  userName: string | null;
  subjectLabel: string | null;
  entryDate: string;
  minutes: number;
  billableMinutes: number;
  isBillable: boolean;
  rateMinor: string;
  valueMinor: string;
  narrative: string | null;
  status: string;
  rated: boolean;
};

function inr(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

const STATUS_TONE: Record<string, string> = {
  draft: "outline",
  submitted: "outline",
  approved: "default",
};

export function BillTime({
  companyId,
  companyName,
  rows,
  defaultDate,
  canBill,
}: {
  companyId: string | null;
  companyName: string;
  rows: readonly TimeRow[];
  defaultDate: string;
  /** ⚠️ Internal time has no client, so it can never become an invoice. */
  canBill: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [billing, setBilling] = useState(false);

  const [invoiceDate, setInvoiceDate] = useState(defaultDate);
  const [dueDate, setDueDate] = useState("");
  const [sacCode, setSacCode] = useState("9982");
  const [taxRatePercent, setTaxRatePercent] = useState("18");
  const [placeOfSupplyCode, setPlaceOfSupplyCode] = useState("27");
  const [isInterState, setIsInterState] = useState(false);
  const [groupBySubject, setGroupBySubject] = useState(true);

  const picked = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  /**
   * ⭐ THE SAME FIVE REFUSALS THE SERVER MAKES, SAID BEFORE THE CLICK.
   *
   * ⚠️ THEY DO NOT REPLACE THE SERVER'S CHECKS — a browser can send
   * anything, and the server is where the transaction is. These exist so
   * the reason arrives while the person can still act on it.
   */
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (picked.length === 0) return ["Tick the entries to bill."];
    if (!canBill) {
      out.push(
        "This time is not recorded against a client, so it cannot become an invoice. Set a client on the entries first.",
      );
      return out;
    }
    const notApproved = picked.filter((r) => r.status !== "approved");
    if (notApproved.length > 0) {
      out.push(
        `${notApproved.length} of these are not approved yet. Approved time is what the firm will stand behind on a bill.`,
      );
    }
    const nonBillable = picked.filter((r) => !r.isBillable);
    if (nonBillable.length > 0) {
      out.push(`${nonBillable.length} of these are marked non-billable.`);
    }
    const unrated = picked.filter((r) => !r.rated);
    if (unrated.length > 0) {
      out.push(
        `${unrated.length} of these have no rate, so they would go on the bill as ₹0.00.`,
      );
    }
    return out;
  }, [picked, canBill]);

  const selectedValue = useMemo(
    () => picked.reduce((sum, r) => sum + BigInt(r.valueMinor), 0n),
    [picked],
  );
  const selectedMinutes = useMemo(
    () => picked.reduce((sum, r) => sum + r.billableMinutes, 0),
    [picked],
  );

  /** The tax is shown before the invoice exists, from the same rate that is sent. */
  const taxRateBps = Math.round(Number(taxRatePercent || "0") * 100);
  const estimatedTax =
    Number.isFinite(taxRateBps) && taxRateBps >= 0
      ? (selectedValue * BigInt(taxRateBps) + 5000n) / 10000n
      : 0n;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
    );
  }

  function run(what: "approve" | "writeOff") {
    setError(null);
    setNote(null);
    const entryIds = [...selected];
    if (entryIds.length === 0) {
      setError("Tick some entries first.");
      return;
    }
    start(async () => {
      if (what === "approve") {
        const res = await approveTimeEntries({ entryIds });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNote(`${res.data.approved} approved.`);
      } else {
        const res = await writeOffTimeEntries({ entryIds });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        /**
         * 🔴 SAID PLAINLY, BECAUSE THE MINUTES SURVIVE. Write-off is not
         * deletion — the hours stay on the record and only the value
         * goes. That is the difference between a firm that knows what it
         * gave away and one that does not.
         */
        setNote(
          `${res.data.writtenOff} written off — the hours stay on the record, the value does not.`,
        );
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  function bill() {
    setError(null);
    setNote(null);
    if (!companyId) {
      setError("This time has no client on it.");
      return;
    }
    start(async () => {
      const res = await raiseInvoiceFromTime({
        companyId,
        entryIds: [...selected],
        invoiceDate,
        ...(dueDate ? { dueDate } : {}),
        ...(sacCode.trim() ? { sacCode: sacCode.trim() } : {}),
        taxRateBps,
        placeOfSupplyCode,
        isInterState,
        groupBySubject,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      /**
       * ⚠️ STRAIGHT TO THE DRAFT INVOICE. It is a DRAFT — Rule 46(b)
       * numbering happens at issue — and the person who just billed a
       * month of work needs to read it before it goes out.
       */
      router.push(`/invoices/${res.data.invoiceId}`);
    });
  }

  return (
    <div className="space-y-3 rounded border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{companyName}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {rows.length} unbilled {rows.length === 1 ? "entry" : "entries"}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={toggleAll}>
          {selected.size === rows.length ? "Clear" : "Select all"}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="w-8 py-2" />
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Who</th>
              <th className="py-2 pr-3 font-medium">Matter</th>
              <th className="py-2 pr-3 text-right font-medium">Billed</th>
              <th className="py-2 pr-3 text-right font-medium">Value</th>
              <th className="py-2 pr-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0 align-top">
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select entry of ${r.entryDate}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    className="h-4 w-4"
                  />
                </td>
                <td className="py-2 pr-3 tabular-nums">{r.entryDate}</td>
                <td className="py-2 pr-3">{r.userName ?? "—"}</td>
                <td className="py-2 pr-3">
                  <p>{r.subjectLabel ?? "—"}</p>
                  {r.narrative && (
                    <p className="text-xs text-muted-foreground">{r.narrative}</p>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {minutesToHoursLabel(r.billableMinutes)}
                  {r.billableMinutes > r.minutes && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {/* Worked minutes, so the rounding is never hidden. */}
                      ({r.minutes}m)
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {inr(BigInt(r.valueMinor))}
                </td>
                <td className="py-2 pr-3">
                  <Badge
                    variant={
                      (STATUS_TONE[r.status] as "default" | "outline" | undefined) ??
                      "outline"
                    }
                  >
                    {r.status}
                  </Badge>
                  {!r.rated && (
                    <Badge variant="destructive" className="ml-1">
                      no rate
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="rounded bg-muted p-3 text-sm">
          <p className="font-medium tabular-nums">
            {selected.size} selected · {minutesToHoursLabel(selectedMinutes)} ·{" "}
            {inr(selectedValue)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => run("approve")}
          disabled={pending || selected.size === 0}
        >
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => run("writeOff")}
          disabled={pending || selected.size === 0}
        >
          Write off
        </Button>
        {canBill && (
          <Button
            type="button"
            size="sm"
            onClick={() => setBilling((v) => !v)}
            disabled={pending || selected.size === 0}
          >
            {billing ? "Hide invoice details" : "Raise invoice"}
          </Button>
        )}
      </div>

      {billing && (
        <div className="space-y-4 rounded border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`iv-date-${companyId ?? "none"}`} required>
                Invoice date
              </Label>
              <Input
                id={`iv-date-${companyId ?? "none"}`}
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`iv-due-${companyId ?? "none"}`}>Due date</Label>
              <Input
                id={`iv-due-${companyId ?? "none"}`}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`iv-sac-${companyId ?? "none"}`}>SAC code</Label>
              <Input
                id={`iv-sac-${companyId ?? "none"}`}
                value={sacCode}
                onChange={(e) => setSacCode(e.target.value)}
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                {/**
                 * ⚠️ SAC, NOT HSN. This is a service; Rule 46 requires the
                 * service accounting code, and 9982 is legal & accounting.
                 */}
                A service code, not an HSN. 9982 covers legal and accounting.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`iv-tax-${companyId ?? "none"}`}>GST %</Label>
              <Input
                id={`iv-tax-${companyId ?? "none"}`}
                value={taxRatePercent}
                onChange={(e) => setTaxRatePercent(e.target.value)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`iv-pos-${companyId ?? "none"}`}>Place of supply</Label>
              <Select
                id={`iv-pos-${companyId ?? "none"}`}
                value={placeOfSupplyCode}
                onChange={(e) => setPlaceOfSupplyCode(e.target.value)}
              >
                {Object.entries(GST_STATE_CODES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} — {name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2 pt-6">
              <div className="flex items-center gap-2">
                <input
                  id={`iv-inter-${companyId ?? "none"}`}
                  type="checkbox"
                  checked={isInterState}
                  onChange={(e) => setIsInterState(e.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor={`iv-inter-${companyId ?? "none"}`}>
                  Inter-state (IGST)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={`iv-group-${companyId ?? "none"}`}
                  type="checkbox"
                  checked={groupBySubject}
                  onChange={(e) => setGroupBySubject(e.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor={`iv-group-${companyId ?? "none"}`}>
                  One line per matter
                </Label>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ 240 LINES IS A BILL THAT GETS QUERIED — but a client
             * entitled to the detail must be able to get it. Grouping is
             * the default and the choice is on the screen.
             */}
            Grouped, a month of work is a handful of lines. Ungrouped, every
            entry is its own line with its date and narrative — some clients
            insist on it.
          </p>

          <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3 text-sm">
            <p className="font-medium tabular-nums">
              A draft invoice for {inr(selectedValue)} plus about{" "}
              {inr(estimatedTax)} GST.
            </p>
            <p className="mt-1 text-muted-foreground">
              {/**
               * 🔴 THE SENTENCE THAT MATTERS. Marking billed happens in
               * the same transaction as the invoice, so these hours
               * cannot appear on next month's bill as well.
               */}
              These {selected.size} entries are marked billed at the same moment
              the invoice is created, so they cannot be billed again. The
              invoice is a draft — it gets its number when you issue it.
            </p>
          </div>

          {blockers.length > 0 ? (
            <ul className="space-y-1 text-sm text-destructive">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <Button type="button" onClick={bill} disabled={pending}>
              {pending ? "Raising…" : `Bill ${selected.size} entries`}
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-emerald-700">{note}</p>}
    </div>
  );
}
