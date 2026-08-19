"use client";

/**
 * Ordence — 🔴🔴 DECIDING AN EXCEPTION, AND FILING THE PERIOD
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WORKLIST WAS READ-ONLY
 * ══════════════════════════════════════════════════════════════════════
 * `decideGstr2bMatch`, `bulkDecideGstr2bMatches` and
 * `fileGstr2bReconciliation` had no caller. The engine scored every
 * match, categorised every exception and explained each one, and nobody
 * could act on any of it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ A REASON IS REQUIRED FOR EVERYTHING EXCEPT AN ACCEPT, AND THE
 *        ASYMMETRY IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * Accepting says *"these are the same document"*, and the stored
 * `matched_on` evidence already explains that field by field. Rejecting
 * says *"the engine is wrong"* and deferring says *"not this month"* —
 * and NOTHING in the data explains either.
 *
 * 🔴 WITHOUT THE REASON, "why is this still open" HAS NO ANSWER three
 * months later, the same pair is re-investigated from scratch every
 * month, and eventually somebody accepts it to make it go away. That is
 * how an unmatched invoice becomes a claimed credit.
 *
 * ⚠️ THE BULK CAP IS 500 AND IT IS NOT FOR PERFORMANCE. An "accept all
 * 4,000" button is not a review. The cap is what keeps the action a
 * decision rather than a gesture.
 *
 * 🔴 AND THE DATABASE REFUSES AN ACCEPT WITH NOBODY NAMED AGAINST IT
 * outright — `gstr2b_matches_no_silent_auto_accept`. This screen cannot
 * be the only thing enforcing that, and it is not.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type MatchRow = {
  id: string;
  category: string;
  supplierGstin: string | null;
  explanation: string | null;
  itcAtRiskMinor: string;
  taxDeltaMinor: string;
  action: string | null;
};

const ACTIONS = [
  {
    value: "accepted",
    label: "Accept",
    help: "These are the same document. The stored evidence already explains why, field by field.",
  },
  {
    value: "rejected",
    label: "Reject",
    help: "The engine is wrong about this pair. Nothing in the data says so — only you can.",
  },
  {
    value: "deferred",
    label: "Defer",
    help: "Waiting on something, usually a supplier who has promised to file. Say what.",
  },
] as const;

function inr(minor: string): string {
  const n = BigInt(minor || "0");
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "−" : ""}₹${(a / 100n).toString()}.${(a % 100n)
    .toString()
    .padStart(2, "0")}`;
}

export function Gstr2bWorklistActions({
  rows,
  gstin,
  taxPeriod,
  decideAction,
  bulkDecideAction,
  fileAction,
}: {
  rows: readonly MatchRow[];
  gstin: string;
  taxPeriod: string;
  decideAction: (i: unknown) => Promise<Result<{ id: string }>>;
  bulkDecideAction: (i: unknown) => Promise<Result<{ updated: number }>>;
  fileAction: (
    i: unknown,
  ) => Promise<Result<{ id: string; filedAt: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<string>("accepted");
  const [reason, setReason] = useState("");
  const [filing, setFiling] = useState(false);
  const [arn, setArn] = useState("");
  const [claimed, setClaimed] = useState("");

  const open = rows.filter((r) => r.action === null || r.action === "deferred");
  const reasonRequired = action !== "accepted";
  const reasonMissing = reasonRequired && reason.trim() === "";

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function decideOne(id: string, act: string) {
    if (act !== "accepted" && reason.trim() === "") {
      toast.error(
        act === "rejected"
          ? "Say why this is not a match. Without a reason the same pair is re-investigated from scratch next month."
          : "Say what this is waiting for. A deferral with no reason is indistinguishable from neglect.",
      );
      return;
    }
    startTransition(async () => {
      const res = await decideAction({
        matchId: id,
        action: act,
        reason: reason.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Recorded.");
      setReason("");
    });
  }

  function decideMany() {
    if (selected.size === 0) return;
    if (reasonMissing) {
      toast.error("Say why. A bulk refusal with no reason explains nothing to anybody.");
      return;
    }
    startTransition(async () => {
      const res = await bulkDecideAction({
        matchIds: [...selected],
        action,
        reason: reason.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.data.updated} exception(s) recorded.`);
      setSelected(new Set());
      setReason("");
    });
  }

  function file() {
    startTransition(async () => {
      const res = await fileAction({
        gstin,
        taxPeriod,
        filedReference: arn.trim(),
        itcClaimedMinor: claimed.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `${taxPeriod} filed against ${arn.trim()}. It cannot be unfiled — a period that turns out to be wrong is corrected in a later one.`,
      );
      setFiling(false);
      setArn("");
      setClaimed("");
    });
  }

  return (
    <div className="space-y-4 rounded-md border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {open.length} exception{open.length === 1 ? "" : "s"} still open
        </p>
        <Button
          variant={open.length === 0 ? "default" : "secondary"}
          onClick={() => setFiling((v) => !v)}
        >
          File this period
        </Button>
      </div>

      {filing && (
        <div className="space-y-3 rounded-md border border-dashed p-3">
          {/**
           * 🔴 FILING IS ONE-WAY AND THE SCREEN SAYS SO BEFORE THE
           * BUTTON. There is deliberately no `unfileReconciliationSchema`
           * anywhere in this product: a period that turns out to be wrong
           * is corrected in a LATER period, which is how the
           * Government's own ledger behaves and the only way the books
           * can continue to agree with returns already submitted.
           */}
          <p className="text-muted-foreground">
            🔴 This cannot be undone. A period that turns out to be wrong is
            corrected in a later period, which is how the Government&apos;s own
            ledger behaves and the only way the books can go on agreeing with
            returns already submitted.
          </p>
          {open.length > 0 && (
            <p className="text-destructive">
              ⚠️ {open.length} exception{open.length === 1 ? " is" : "s are"}{" "}
              still open. Filing now records that the period was closed with
              them unresolved, which is a different statement from having
              resolved them.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="g-arn">GSTR-3B acknowledgement number</Label>
              <Input
                id="g-arn"
                value={arn}
                onChange={(e) => setArn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="g-claim">Input credit claimed, paise</Label>
              <Input
                id="g-claim"
                inputMode="numeric"
                value={claimed}
                onChange={(e) => setClaimed(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                What actually went into the return, so the difference against
                what was matchable is a recorded number rather than a memory.
              </p>
            </div>
          </div>
          <Button
            disabled={pending || arn.trim() === ""}
            onClick={file}
          >
            File {taxPeriod}
          </Button>
        </div>
      )}

      <div className="space-y-2 rounded-md border border-dashed p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="g-act">Decision</Label>
            <select
              id="g-act"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="secondary"
            disabled={pending || selected.size === 0 || reasonMissing}
            onClick={decideMany}
          >
            Apply to {selected.size} selected
          </Button>
          {selected.size > 500 && (
            <span className="text-xs text-destructive">
              More than 500 in one action is not a review. Filter the worklist
              and work through it.
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {ACTIONS.find((a) => a.value === action)?.help}
        </p>
        <div className="space-y-1">
          <Label htmlFor="g-reason">
            Reason {reasonRequired ? "(required)" : "(optional)"}
          </Label>
          <Textarea
            id="g-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {reasonMissing && (
            <p className="text-xs text-destructive">
              Without a reason the same pair is re-investigated from scratch
              next month, and eventually accepted to make it go away.
            </p>
          )}
        </div>
      </div>

      <ul className="divide-y">
        {open.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
            <input
              type="checkbox"
              aria-label={`Select ${r.supplierGstin ?? r.id}`}
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
            />
            <Badge variant="secondary">{r.category}</Badge>
            <span className="font-mono text-xs">{r.supplierGstin ?? "—"}</span>
            <span className="text-muted-foreground">{r.explanation}</span>
            {BigInt(r.itcAtRiskMinor || "0") > 0n && (
              <Badge variant="destructive">
                {inr(r.itcAtRiskMinor)} at risk
              </Badge>
            )}
            <span className="ml-auto flex gap-1">
              {ACTIONS.map((a) => (
                <Button
                  key={a.value}
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={pending}
                  onClick={() => decideOne(r.id, a.value)}
                >
                  {a.label}
                </Button>
              ))}
            </span>
          </li>
        ))}
        {open.length === 0 && (
          <li className="py-4 text-muted-foreground">
            Every exception has been decided.
          </li>
        )}
      </ul>
    </div>
  );
}
