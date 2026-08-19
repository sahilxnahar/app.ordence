"use client";

/**
 * Ordence — ⭐⭐ TALLY CONNECTIONS, EDITABLE
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PAGE COULD SHOW CONNECTIONS AND COULD NOT CREATE ONE
 * ══════════════════════════════════════════════════════════════════════
 * `upsertTallyConnection` has existed since Phase 37 and was called by
 * nothing. The screen listed connections, reported each one's endpoint
 * verdict in a full sentence, and offered no way to add the first one ,
 * so on every workspace the list was empty and the sentence was never
 * shown to anybody.
 *
 * ⚠️ `allowPrivateHost` IS THE ONE FIELD THAT NEEDS EXPLAINING AT THE
 * POINT OF USE. Tally almost always listens on a private LAN address,
 * which a cloud Worker cannot reach , so the natural thing to do when a
 * push fails is to tick the box that sounds like it permits the address.
 * It does not make the address reachable. It only removes our refusal to
 * try, and the request then fails at the network instead. The checkbox
 * exists for a self-hosted deployment sitting on the same network, and
 * the label says so rather than implying a fix.
 */

import { useState, useTransition } from "react";
import { Plug, Save } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type ConnectionRow = {
  id: string;
  name: string;
  companyName: string;
  host: string | null;
  port: number;
  useTls: boolean;
  allowPrivateHost: boolean;
  isActive: boolean;
  endpointVerdict: string;
};

type Draft = {
  id?: string;
  name: string;
  companyName: string;
  host: string;
  port: number;
  useTls: boolean;
  allowPrivateHost: boolean;
  isActive: boolean;
  notes: string;
};

function blank(): Draft {
  return {
    name: "",
    companyName: "",
    host: "",
    port: 9000,
    useTls: false,
    allowPrivateHost: false,
    isActive: true,
    notes: "",
  };
}

function fromRow(row: ConnectionRow): Draft {
  return {
    id: row.id,
    name: row.name,
    companyName: row.companyName,
    host: row.host ?? "",
    port: row.port,
    useTls: row.useTls,
    allowPrivateHost: row.allowPrivateHost,
    isActive: row.isActive,
    notes: "",
  };
}

export function TallyConnectionForm(props: {
  rows: readonly ConnectionRow[];
  save: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [draft, setDraft] = useState<Draft>(blank());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await props.save({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        companyName: draft.companyName,
        /**
         * ⚠️ AN EMPTY HOST IS `null`, NOT `""`. A connection with no host
         * is a legitimate thing , an export you download and import by
         * hand , and an empty string would be a host that fails every
         * check with a confusing message.
         */
        host: draft.host.trim() === "" ? null : draft.host.trim(),
        port: draft.port,
        useTls: draft.useTls,
        allowPrivateHost: draft.allowPrivateHost,
        isActive: draft.isActive,
        notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(draft.id ? "Connection updated." : "Connection created.");
      setDraft(blank());
    });
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {draft.id ? "Edit connection" : "Add a connection"}
      </h3>

      {props.rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {props.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                setDraft(fromRow(row));
                setError(null);
                setSaved(null);
              }}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {row.name}
            </button>
          ))}
          {draft.id && (
            <button
              type="button"
              onClick={() => setDraft(blank())}
              className="rounded-md px-2 py-1 text-xs underline underline-offset-2"
            >
              start a new one
            </button>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Head office Tally"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Company name in Tally</span>
          <input
            value={draft.companyName}
            onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Exactly as it appears in Tally"
          />
          {/*
            ⚠️ EXACTLY. Tally matches the company by name on import, and a
            trailing space or a different spelling silently creates a
            second company rather than failing.
          */}
          <span className="block text-xs text-muted-foreground">
            Must match Tally exactly. A different spelling creates a second company there
            rather than failing.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Host</span>
          <input
            value={draft.host}
            onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Leave empty to export a file instead"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.useTls}
            onChange={(e) => setDraft({ ...draft, useTls: e.target.checked })}
          />
          <span>Connect over HTTPS</span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.allowPrivateHost}
            onChange={(e) => setDraft({ ...draft, allowPrivateHost: e.target.checked })}
          />
          <span>
            <span className="block">Allow a private network address</span>
            <span className="block text-xs text-muted-foreground">
              This does not make a private address reachable from the cloud. It only stops
              Ordence refusing to try, which is useful on a self-hosted deployment sitting on
              the same network and useless anywhere else.
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

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Notes</span>
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">{saved}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        <Save className="h-4 w-4" aria-hidden="true" />
        {pending ? "Saving…" : draft.id ? "Save changes" : "Create connection"}
      </button>
    </section>
  );
}
