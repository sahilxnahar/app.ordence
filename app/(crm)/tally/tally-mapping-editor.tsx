"use client";

/**
 * Ordence — ⭐⭐⭐ THE LEDGER MAPPING EDITOR
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MAPPINGS WERE THE ALARM ON THIS PAGE AND COULD NOT BE FIXED
 * ══════════════════════════════════════════════════════════════════════
 * The Tally screen has always opened with a count of mappings that need
 * attention, and explained , correctly , that an inactive or invalid
 * mapping does not error at export time: the transactions are simply
 * absent from the batch, and the difference surfaces weeks later when the
 * two systems disagree.
 *
 * There was no way to act on it. `upsertTallyLedgerMapping` and
 * `retireTallyLedgerMapping` were called by nothing. An alarm with no
 * remedy trains people to ignore alarms.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE IDENTITY PER MAPPING, ENFORCED THREE TIMES
 * ══════════════════════════════════════════════════════════════════════
 * A tax head is identified by its KEY and everything else by its ROW.
 * The database says so (`tally_ledger_mappings_identity_is_singular`),
 * the validator says so in a sentence, and this form makes the wrong
 * combination unreachable: choosing "tax head" swaps the row picker for a
 * key picker rather than showing both.
 *
 * ⚠️ THE GSTIN FIELD APPEARS ONLY FOR A PARTY LEDGER. Tally reads a GSTIN
 * from the party ledger; on a nominal one it is inert, and its presence
 * there means a customer has been mapped to a nominal account , which the
 * validator refuses. Hiding the field is how the form stops somebody
 * getting there.
 */

import { useMemo, useState, useTransition } from "react";
import { Link2, Trash2 } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type MappingRow = {
  id: string;
  sourceKind: string;
  sourceId: string | null;
  sourceKey: string | null;
  tallyLedgerName: string;
  tallyParentGroup: string;
  tallyParentGroupLabel: string;
  isParty: boolean;
  partyGstin: string | null;
  createMasterOnExport: boolean;
  isActive: boolean;
  findings: Array<{ severity: string; code: string; message: string }>;
};

export type MappableSource = {
  kind: "ledger" | "vendor" | "customer";
  id: string;
  label: string;
  hint: string | null;
};

const SOURCE_KINDS = ["ledger", "vendor", "customer", "tax_head"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

type Draft = {
  id?: string;
  sourceKind: SourceKind;
  sourceId: string;
  sourceKey: string;
  tallyLedgerName: string;
  tallyParentGroup: string;
  isParty: boolean;
  partyGstin: string;
  createMasterOnExport: boolean;
  isActive: boolean;
};

function blank(defaultGroup: string): Draft {
  return {
    sourceKind: "ledger",
    sourceId: "",
    sourceKey: "",
    tallyLedgerName: "",
    tallyParentGroup: defaultGroup,
    isParty: false,
    partyGstin: "",
    createMasterOnExport: false,
    isActive: true,
  };
}

export function TallyMappingEditor(props: {
  rows: readonly MappingRow[];
  sources: readonly MappableSource[];
  sourcesTruncated: boolean;
  taxHeads: readonly string[];
  primaryGroups: readonly { value: string; label: string }[];
  save: (input: unknown) => Promise<Result<{ id: string }>>;
  retire: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const defaultGroup = props.primaryGroups[0]?.value ?? "suspense_account";
  const [draft, setDraft] = useState<Draft>(blank(defaultGroup));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isTaxHead = draft.sourceKind === "tax_head";

  const candidates = useMemo(
    () => props.sources.filter((s) => s.kind === draft.sourceKind),
    [props.sources, draft.sourceKind],
  );

  /**
   * ⚠️ ALREADY-MAPPED ROWS ARE STILL OFFERED, and marked rather than
   * hidden. Re-mapping an existing source is the normal way to correct a
   * mistake, and a picker that silently omits the row somebody is looking
   * for reads as "that ledger has disappeared".
   */
  const mappedIds = useMemo(
    () => new Set(props.rows.filter((r) => r.sourceId).map((r) => `${r.sourceKind}:${r.sourceId}`)),
    [props.rows],
  );

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.save({
        ...(draft.id ? { id: draft.id } : {}),
        sourceKind: draft.sourceKind,
        // Exactly one identity. See the header.
        sourceId: isTaxHead ? null : draft.sourceId || null,
        sourceKey: isTaxHead ? draft.sourceKey || null : null,
        tallyLedgerName: draft.tallyLedgerName,
        tallyParentGroup: draft.tallyParentGroup,
        isParty: draft.isParty,
        partyGstin: draft.isParty && draft.partyGstin.trim() !== "" ? draft.partyGstin.trim() : null,
        createMasterOnExport: draft.createMasterOnExport,
        isActive: draft.isActive,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(draft.id ? "Mapping updated." : "Mapping created.");
      setDraft(blank(defaultGroup));
    });
  }

  function retire(id: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.retire({ id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Mapping retired. It will not appear in the next export.");
    });
  }

  function edit(row: MappingRow) {
    setDraft({
      id: row.id,
      sourceKind: (SOURCE_KINDS as readonly string[]).includes(row.sourceKind)
        ? (row.sourceKind as SourceKind)
        : "ledger",
      sourceId: row.sourceId ?? "",
      sourceKey: row.sourceKey ?? "",
      tallyLedgerName: row.tallyLedgerName,
      tallyParentGroup: row.tallyParentGroup,
      isParty: row.isParty,
      partyGstin: row.partyGstin ?? "",
      createMasterOnExport: row.createMasterOnExport,
      isActive: row.isActive,
    });
    setError(null);
    setNotice(null);
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {draft.id ? "Edit mapping" : "Add a mapping"}
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">What is being mapped</span>
          <select
            value={draft.sourceKind}
            onChange={(e) => {
              const kind = e.target.value as SourceKind;
              // Clear the other identity so the two can never both be set.
              setDraft({ ...draft, sourceKind: kind, sourceId: "", sourceKey: "" });
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="ledger">A ledger account</option>
            <option value="vendor">A vendor</option>
            <option value="customer">A customer</option>
            <option value="tax_head">A tax head</option>
          </select>
        </label>

        {isTaxHead ? (
          <label className="space-y-1 text-sm">
            <span className="font-medium">Tax head</span>
            <select
              value={draft.sourceKey}
              onChange={(e) => {
                /**
                 * ⭐ THE GROUP FOLLOWS THE HEAD, AND THERE IS ONLY ONE
                 * RIGHT ANSWER. `assessMapping` warns on any tax head not
                 * filed under Duties & Taxes, and the warning explains
                 * why: Tally's own GST reports read that group and
                 * nothing else, so a head under Indirect Expenses still
                 * balances the books and shows no tax in the GSTR-1 the
                 * CA files from.
                 *
                 * ⚠️ SET, NOT LOCKED. The select below stays editable,
                 * because a workspace with a genuinely unusual chart
                 * should be able to override a default and read the
                 * engine's warning about it.
                 */
                setDraft({
                  ...draft,
                  sourceKey: e.target.value,
                  tallyParentGroup: "duties_and_taxes",
                });
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Choose a tax head</option>
              {props.taxHeads.map((head) => (
                <option key={head} value={head}>
                  {head}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="space-y-1 text-sm">
            <span className="font-medium">Which one</span>
            <select
              value={draft.sourceId}
              onChange={(e) => {
                const id = e.target.value;
                const source = candidates.find((s) => s.id === id);
                setDraft({
                  ...draft,
                  sourceId: id,
                  // A blank Tally name defaults to ours, which is right far more often than not.
                  tallyLedgerName: draft.tallyLedgerName || (source?.label ?? ""),
                  isParty: draft.sourceKind !== "ledger" ? true : draft.isParty,
                });
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Choose one</option>
              {candidates.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                  {source.hint ? ` (${source.hint})` : ""}
                  {mappedIds.has(`${source.kind}:${source.id}`) ? " · already mapped" : ""}
                </option>
              ))}
            </select>
            {props.sourcesTruncated && (
              <span className="block text-xs text-muted-foreground">
                Only the first 500 of each kind are listed.
              </span>
            )}
          </label>
        )}

        <label className="space-y-1 text-sm">
          <span className="font-medium">Ledger name in Tally</span>
          <input
            value={draft.tallyLedgerName}
            onChange={(e) => setDraft({ ...draft, tallyLedgerName: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            Free text in Tally, so it is free text here, and it has to match character for
            character.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Under group</span>
          <select
            value={draft.tallyParentGroup}
            onChange={(e) => setDraft({ ...draft, tallyParentGroup: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {props.primaryGroups.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-2 text-sm">
        {!isTaxHead && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.isParty}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  isParty: e.target.checked,
                  partyGstin: e.target.checked ? draft.partyGstin : "",
                })
              }
            />
            <span>This is a party ledger (a customer or a vendor)</span>
          </label>
        )}

        {draft.isParty && !isTaxHead && (
          <label className="block space-y-1">
            <span className="font-medium">GSTIN</span>
            <input
              value={draft.partyGstin}
              onChange={(e) => setDraft({ ...draft, partyGstin: e.target.value.toUpperCase() })}
              maxLength={15}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm sm:w-72"
              placeholder="27AAAAA0000A1Z5"
            />
          </label>
        )}

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.createMasterOnExport}
            onChange={(e) => setDraft({ ...draft, createMasterOnExport: e.target.checked })}
          />
          <span>
            <span className="block">Create this ledger in Tally if it is missing</span>
            <span className="block text-xs text-muted-foreground">
              Leave this off when the CA maintains the chart of accounts. On, a typo in the
              name above creates a new ledger in Tally rather than failing.
            </span>
          </span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          />
          <span>Active</span>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : draft.id ? "Save changes" : "Create mapping"}
        </button>
        {draft.id && (
          <button
            type="button"
            onClick={() => setDraft(blank(defaultGroup))}
            className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
          >
            Cancel
          </button>
        )}
      </div>

      {props.rows.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Existing mappings
          </h4>
          <ul className="divide-y rounded-md border">
            {props.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                <span className="font-medium">{row.tallyLedgerName}</span>
                <span className="text-xs text-muted-foreground">
                  {row.sourceKind}
                  {row.sourceKey ? ` · ${row.sourceKey}` : ""} · {row.tallyParentGroupLabel}
                </span>
                {!row.isActive && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">inactive</span>
                )}
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => edit(row)}
                    className="text-xs underline underline-offset-2"
                  >
                    edit
                  </button>
                  {row.isActive && (
                    <button
                      type="button"
                      onClick={() => retire(row.id)}
                      disabled={pending}
                      className="inline-flex items-center gap-1 text-xs text-destructive underline underline-offset-2 disabled:opacity-60"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      retire
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
