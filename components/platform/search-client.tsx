"use client";

/**
 * Ordence — Cross-Tenant Search UI
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE UI IS PART OF THE DATA-PROTECTION STORY, NOT A WRAPPER AROUND IT
 * ══════════════════════════════════════════════════════════════════════
 * Three things it does that a plain search box would not:
 *
 *   1. IT DEMANDS THE JUSTIFICATION BEFORE THE QUERY RUNS, in the same
 *      form, with no "skip" path. A justification collected afterwards is
 *      a justification written to fit what was found.
 *
 *   2. IT NAMES WHAT THE SCOPE RETURNS, in the operator's own words,
 *      before they search. "Existence, owning tenant, size and timestamps
 *      — never the filename" sets the expectation that this tool does not
 *      show customer content, so nobody goes looking for the setting that
 *      turns it on.
 *
 *   3. IT SHOWS THE REMAINING BUDGET. A limit discovered by hitting it
 *      feels like a bug; a limit visible from the first search is a norm.
 *
 * ⚠️ Everything here is re-decided on the server: the scope allow-list,
 * the query shape, the justification length, the cap and the budget.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  SCOPE_DEFINITIONS,
  SEARCH_SCOPES,
  MIN_SEARCH_JUSTIFICATION,
  type SearchScope,
} from "@/lib/platform/search-scopes";

export type SearchResultRow = {
  scope: string;
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  label: string;
  detail: string;
  occurredAt: string | null;
};

type Outcome =
  | { ok: true; data: { results: SearchResultRow[]; truncated: boolean; scopeNote: string; budgetRemaining: number } }
  | { ok: false; error: string };

export function PlatformSearchClient({
  onSearch,
}: {
  onSearch: (input: {
    scope: string;
    query: string;
    justification: string;
  }) => Promise<Outcome>;
}) {
  const [scope, setScope] = useState<SearchScope>("tenants");
  const [query, setQuery] = useState("");
  const [justification, setJustification] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const def = SCOPE_DEFINITIONS[scope];
  const ready =
    query.trim().length >= def.minLength &&
    justification.trim().length >= MIN_SEARCH_JUSTIFICATION;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          <Label htmlFor="search-scope">Look in</Label>
          <Select
            id="search-scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as SearchScope);
              setOutcome(null);
            }}
          >
            {SEARCH_SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_DEFINITIONS[s].label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="search-query">
            Search ({def.match === "exact" ? "exact match" : "starts with"})
          </Label>
          <Input
            id="search-query"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={def.match === "exact" ? "Exact identifier" : "First few characters"}
          />
        </div>
      </div>

      {/* ⭐ Stated BEFORE the search, not as a footnote after it. */}
      <p
        data-testid="scope-note"
        className="rounded-md border border-border bg-muted/40 p-3 text-xs"
      >
        <strong>Returns:</strong> {def.returns}
        {def.containsPersonalData ? (
          <Badge variant="outline" className="ml-2">
            personal data
          </Badge>
        ) : null}
      </p>

      <div className="space-y-1">
        <Label htmlFor="search-why">Why are you searching?</Label>
        <Textarea
          id="search-why"
          rows={2}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="Ticket reference and what you are trying to answer."
        />
        <p className="text-xs text-muted-foreground">
          Recorded against your name in the cross-tenant access log.{" "}
          {justification.trim().length}/{MIN_SEARCH_JUSTIFICATION} minimum.
        </p>
      </div>

      <Button
        disabled={!ready || pending}
        onClick={() =>
          startTransition(async () => {
            setOutcome(
              await onSearch({
                scope,
                query: query.trim(),
                justification: justification.trim(),
              }),
            );
          })
        }
      >
        <Search className="h-4 w-4" aria-hidden />
        {pending ? "Searching…" : "Search"}
      </Button>

      {outcome && !outcome.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {outcome.error}
        </p>
      ) : null}

      {outcome?.ok ? (
        <div className="space-y-2" data-testid="search-results">
          <p className="text-xs text-muted-foreground">
            {outcome.data.results.length} result
            {outcome.data.results.length === 1 ? "" : "s"}
            {outcome.data.truncated ? " (capped — narrow the query)" : ""} ·{" "}
            {outcome.data.budgetRemaining} searches left this hour
          </p>

          {outcome.data.results.map((r) => (
            <div
              key={`${r.scope}-${r.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
            >
              <div>
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.detail}</div>
              </div>
              <Link
                href={`/platform/tenants/${r.tenantId}`}
                className="text-xs underline"
              >
                {r.tenantName}
              </Link>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
