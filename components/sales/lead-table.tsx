"use client";

/**
 * Ordence — Lead List
 * Version: v0.22.0-alpha
 *
 * The alternative to the board, for the questions a board cannot answer:
 * sort by score, filter to overdue, find the NRI leads it is currently a
 * civil hour to ring.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CALLING-HOUR COLUMN IS THE POINT OF THIS TABLE
 * ══════════════════════════════════════════════════════════════════════
 * Calling a buyer in New Jersey at 11am IST is calling them at 1:30am.
 * It happens constantly, it is the fastest way to lose an NRI lead, and
 * no amount of training fixes it because the rep is looking at a list,
 * not a clock.
 *
 * So the list shows the clock.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  STAGE_LABELS,
  SOURCE_LABELS,
  localHourFor,
  isCivilCallingHour,
} from "@/lib/sales/pipeline";
import type { LeadStatus, LeadTemperature, LeadSource } from "@/db/schema/sales";

export type LeadTableRow = {
  id: string;
  reference: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
  source: LeadSource;
  score: number;
  locality: string | null;
  isNri: boolean;
  timezone: string | null;
  urgency: "none" | "scheduled" | "due" | "overdue" | "stale";
  activityCount: number;
  partnerFirmName: string | null;
  nextFollowUpAt: string | null;
};

type SortKey = "score" | "name" | "followUp";

export function LeadTable({ rows, total }: { rows: LeadTableRow[]; total: number }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [callableOnly, setCallableOnly] = useState(false);

  // ⚠️ `now` is captured once per render rather than per row. Calling
  // `new Date()` inside the map would give different rows different
  // clocks, which is invisible until a list straddles an hour boundary
  // and two NRI leads in the same timezone disagree.
  const now = useMemo(() => new Date(), []);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();

    const filtered = rows.filter((row) => {
      if (overdueOnly && row.urgency !== "overdue" && row.urgency !== "stale" && row.urgency !== "due") {
        return false;
      }
      if (callableOnly && isCivilCallingHour(row.timezone, now) === false) {
        return false;
      }
      if (!term) return true;
      return (
        row.name.toLowerCase().includes(term) ||
        row.reference.toLowerCase().includes(term) ||
        (row.phone ?? "").toLowerCase().includes(term) ||
        (row.email ?? "").toLowerCase().includes(term) ||
        (row.locality ?? "").toLowerCase().includes(term)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "followUp") {
        const at = a.nextFollowUpAt ? Date.parse(a.nextFollowUpAt) : Number.POSITIVE_INFINITY;
        const bt = b.nextFollowUpAt ? Date.parse(b.nextFollowUpAt) : Number.POSITIVE_INFINITY;
        return at - bt;
      }
      return b.score - a.score;
    });
  }, [rows, query, sortKey, overdueOnly, callableOnly, now]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, reference, phone, locality…"
          className="h-9 max-w-xs"
          aria-label="Search leads"
        />

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(event) => setOverdueOnly(event.target.checked)}
          />
          Needs a call
        </label>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={callableOnly}
            onChange={(event) => setCallableOnly(event.target.checked)}
          />
          Civil hour where they are
        </label>

        <label className="ml-auto flex items-center gap-1.5 text-xs">
          Sort
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            className="rounded border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="score">Score</option>
            <option value="followUp">Follow-up date</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {visible.length} of {total} leads
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Lead</th>
              <th scope="col" className="px-3 py-2 font-medium">Stage</th>
              <th scope="col" className="px-3 py-2 font-medium">Source</th>
              <th scope="col" className="px-3 py-2 font-medium">Their time</th>
              <th scope="col" className="px-3 py-2 font-medium">Follow-up</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const hour = localHourFor(row.timezone, now);
              const civil = isCivilCallingHour(row.timezone, now);

              return (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/sales/leads/${row.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">
                      {row.reference}
                      {row.phone ? ` · ${row.phone}` : ""}
                      {row.partnerFirmName ? ` · via ${row.partnerFirmName}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="text-[11px]">
                      {STAGE_LABELS[row.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {SOURCE_LABELS[row.source]}
                    {row.isNri ? " · NRI" : ""}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {hour === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={civil ? "text-muted-foreground" : "font-medium text-destructive"}>
                        {String(hour).padStart(2, "0")}:00
                        {civil ? "" : " · do not call"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {row.nextFollowUpAt ? (
                      <span
                        className={
                          row.urgency === "stale" || row.urgency === "overdue"
                            ? "font-medium text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(
                          new Date(row.nextFollowUpAt),
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not scheduled</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.score}</td>
                </tr>
              );
            })}

            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {rows.length === 0
                    ? "No leads yet."
                    : "No leads match those filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {visible.length.toLocaleString("en-IN")} of{" "}
        {total.toLocaleString("en-IN")} leads.
      </p>
    </div>
  );
}
