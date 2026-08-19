"use client";

/**
 * Ordence — ⭐⭐ COST CENTRE MAPPINGS
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A PROJECT BECOMES A COST CENTRE AND NOT A LEDGER
 * ══════════════════════════════════════════════════════════════════════
 * A construction firm running four sites wants profitability per site.
 * Doing that with LEDGERS means four copies of every expense head , four
 * "Cement", four "Labour" , and a chart of accounts nobody can read. Tally
 * has cost centres for exactly this: one expense ledger, tagged per site.
 *
 * ⚠️ `upsertTallyCostCentreMapping` and `getTallyCostCentreMappings` were
 * both built in Phase 37 and called by nothing.
 *
 * ⚠️ THE PROJECT IS IDENTIFIED BY ITS ID AND THIS FORM ASKS FOR ONE.
 * There is no project picker here because the Tally screen reads under
 * `tally:read`, and a project list is a different module behind a
 * different permission. Rather than widening a narrow permission for a
 * convenience, the field takes the id from the project's own URL and the
 * label says so. That is a real rough edge and it is recorded as one
 * rather than paid for with a permission.
 */

import { useState, useTransition } from "react";
import { FolderTree } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type CostCentreRow = {
  id: string;
  projectId: string;
  tallyCostCentreName: string;
  tallyCostCategory: string;
  isActive: boolean;
};

export function TallyCostCentres(props: {
  rows: readonly CostCentreRow[];
  save: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Primary Cost Category");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.save({
        projectId,
        tallyCostCentreName: name,
        tallyCostCategory: category,
        isActive: true,
        notes: null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Cost centre mapped.");
      setProjectId("");
      setName("");
    });
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FolderTree className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Cost centres
      </h3>

      <p className="text-sm text-muted-foreground">
        Map a project to a Tally cost centre so one expense ledger can carry four sites,
        rather than four copies of every expense head.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Project id</span>
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value.trim())}
            placeholder="From the project's own URL"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Cost centre name in Tally</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Cost category</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
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
        disabled={pending || projectId === "" || name === ""}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Saving…" : "Map the cost centre"}
      </button>

      {props.rows.length > 0 && (
        <ul className="divide-y rounded-md border">
          {props.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
              <span className="font-medium">{row.tallyCostCentreName}</span>
              <span className="text-xs text-muted-foreground">{row.tallyCostCategory}</span>
              <code className="ml-auto text-[10px] text-muted-foreground">
                {row.projectId.slice(0, 8)}…
              </code>
              {!row.isActive && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">inactive</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
