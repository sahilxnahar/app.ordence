/**
 * Ordence — GLOBAL SEARCH
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PAGE LEADS WITH WHAT IT DOES NOT SEARCH
 * ══════════════════════════════════════════════════════════════════════
 * A search box is the one screen in a product where an empty result is
 * read as a statement of fact. Nobody thinks "the index does not cover
 * that" — they think "it is not in the system", and then they re-key a
 * contract that already exists, or tell a client a document was never
 * received.
 *
 * ⚠️ `globalSearch` covers FOUR record types: contacts, companies, deals
 * and assets. It does not cover orders, contracts, documents, invoices,
 * bookings, land parcels, compliance filings or anything else this
 * workspace holds. That is a reasonable place for the index to be today
 * and a dangerous thing to leave unsaid, so it is said first, above the
 * results, on every search — not in a tooltip, not in a footnote.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A FULL BUCKET IS A TRUNCATED BUCKET, AND IT IS LABELLED
 * ══════════════════════════════════════════════════════════════════════
 * Results are capped PER TYPE. A type that comes back exactly at the cap
 * almost certainly has more behind it — and "10 contacts" rendered
 * without that caveat is the same lie in a smaller font. Where a bucket
 * is full, the page says "at least".
 *
 * ══════════════════════════════════════════════════════════════════════
 * NO CLIENT COMPONENT, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * A plain `<form method="get">` submitting to this same route. The query
 * lives in the URL, which means a search is linkable, back-button-able,
 * and reproducible in a bug report — none of which is true of a
 * `useState` box. The action it calls is rate-limited per tenant AND per
 * user, so a keystroke-per-request live search would spend that budget
 * on nothing.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  globalSearch,
  type SearchResult,
  type SearchResultType,
} from "@/server/actions/search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export const metadata = { title: "Search · Ordence" };

/** Per-type cap sent to the action. Also the truncation threshold. */
const LIMIT = 25;

const TYPES: readonly SearchResultType[] = ["contact", "company", "deal", "asset"];

const TYPE_LABEL: Record<SearchResultType, string> = {
  contact: "Contacts",
  company: "Companies",
  deal: "Deals",
  asset: "Assets",
};

/**
 * ⚠️ THE RECORD TYPES THIS SEARCH CANNOT SEE.
 *
 * Kept as an explicit list rather than derived from anything, because it
 * is a promise to the reader and it must be maintained by hand when the
 * index grows. A list that silently keeps itself accurate is a list that
 * silently becomes inaccurate.
 */
const NOT_INDEXED = [
  { label: "Contracts", href: "/contracts" },
  { label: "Documents", href: "/documents" },
  { label: "Orders", href: "/orders" },
  { label: "Invoices & receivables", href: "/receivables" },
  { label: "Bookings", href: "/scheduling" },
  { label: "Land parcels", href: "/land" },
  { label: "Compliance filings", href: "/compliance" },
];

function typeTone(type: SearchResultType): string {
  if (type === "deal")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  if (type === "asset")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  return "";
}

function isSearchType(value: string | undefined): value is SearchResultType {
  return value !== undefined && (TYPES as readonly string[]).includes(value);
}

/** The panel that is always visible, whether or not anything was typed. */
function CoveragePanel({ narrowed }: { narrowed: SearchResultType | null }) {
  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader>
        <CardTitle className="text-base text-amber-700 dark:text-amber-300">
          This searches four record types
          {narrowed ? ` — and right now, only ${TYPE_LABEL[narrowed].toLowerCase()}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Contacts, companies, deals and assets. Everything below is NOT in the
          index, and a search that finds nothing here is not evidence that a
          record does not exist:
        </p>
        <ul className="flex flex-wrap gap-2">
          {NOT_INDEXED.map((m) => (
            <li key={m.href}>
              <Link href={m.href}>
                <Badge variant="outline" className="text-[11px] hover:bg-muted">
                  {m.label}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          ⚠️ An empty result is the one place in a product where nobody
          suspects the tool — they conclude the record was never created, and
          then somebody re-keys a contract that already exists. Open the module
          itself for anything on this list.
        </p>
      </CardContent>
    </Card>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  return (
    <li className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm">
      <Badge variant="outline" className={`text-[10px] ${typeTone(result.type)}`}>
        {result.type}
      </Badge>
      <Link href={result.href} className="font-medium hover:underline">
        {result.title}
      </Link>
      {result.subtitle && (
        <span className="text-xs text-muted-foreground">{result.subtitle}</span>
      )}
      {result.meta && (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {result.meta}
        </span>
      )}
    </li>
  );
}

async function SearchBody({
  query,
  type,
}: {
  query: string;
  type: SearchResultType | null;
}) {
  if (!query) {
    return (
      <div className="space-y-6">
        <CoveragePanel narrowed={type} />
        <Card>
          <CardHeader>
            <CardTitle>Nothing typed yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Search matches on the fields somebody would recognise a record
              by, not on everything it holds: a person&apos;s name, email or
              job title; a company&apos;s name, domain or industry; a
              deal&apos;s title or description; an asset&apos;s name, code,
              locality or city.
            </p>
            <p>
              ⚠️ It matches substrings, not word stems. &ldquo;Building&rdquo;
              will not find &ldquo;Buildings&rdquo;, and a misspelling finds
              nothing at all — there is no fuzzy matching and no
              &ldquo;did you mean&rdquo;. Type the fragment you are sure of
              rather than the whole phrase you half-remember.
            </p>
            <p>
              Every query is confined to this workspace before a single
              character is compared, so nothing typed here can reach another
              tenant&apos;s records.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const result = await globalSearch({
    query,
    types: type ? [type] : [...TYPES],
    limit: LIMIT,
  });

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <CoveragePanel narrowed={type} />
        <Card>
          <CardHeader>
            <CardTitle>Search unavailable</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{result.error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { results, counts, tookMs } = result.data;

  /**
   * ⭐ A bucket that came back exactly at the cap has been truncated.
   *
   * ⚠️ The action returns what it returned; it does not run a second
   * COUNT(*) to find out how much it left behind, and it should not — a
   * search that costs two queries per type to render a number nobody
   * acts on is a search that gets rate-limited. So the page reports the
   * fact it can actually stand behind: "at least".
   */
  const truncated = TYPES.filter((t) => counts[t] >= LIMIT);

  return (
    <div className="space-y-6">
      <CoveragePanel narrowed={type} />

      {truncated.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-base text-blue-700 dark:text-blue-300">
              {truncated.length === 1
                ? `${TYPE_LABEL[truncated[0] as SearchResultType]} hit the display limit`
                : `${truncated.length} record types hit the display limit`}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {truncated.map((t) => TYPE_LABEL[t]).join(", ")} came back with
            exactly {LIMIT} matches, which is the cap — so there are almost
            certainly more. Narrow the query, or use the module&apos;s own list
            with its filters. The count below is a floor, not a total.
          </CardContent>
        </Card>
      )}

      {/* Counts per type, and the narrowing links. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TYPES.map((t) => {
          const active = type === t;
          const href = active
            ? `/search?q=${encodeURIComponent(query)}`
            : `/search?q=${encodeURIComponent(query)}&type=${t}`;
          const suppressed = type !== null && !active;
          return (
            <Link key={t} href={href}>
              <Card
                className={
                  active
                    ? "border-foreground/40"
                    : suppressed
                      ? "opacity-50"
                      : "hover:bg-muted/40"
                }
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {TYPE_LABEL[t]}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {suppressed ? "—" : counts[t] >= LIMIT ? `${LIMIT}+` : counts[t]}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {suppressed
                      ? "not searched — filter is on"
                      : active
                        ? "showing only this type"
                        : "click to show only this type"}
                  </p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {results.length === 0
              ? "No matches"
              : `${results.length} match${results.length === 1 ? "" : "es"}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {results.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                Nothing matched &ldquo;{query}&rdquo;.
              </p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                ⚠️ This does not mean the record does not exist. It means no
                contact, company, deal or asset in this workspace has that text
                in one of its identifying fields. Contracts, documents, orders,
                invoices, bookings, land and compliance filings are not
                searched at all — open the module. And because matching is on
                substrings rather than word stems, a plural or a typo finds
                nothing: try a shorter fragment.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {results.map((r) => (
                <ResultRow key={`${r.type}-${r.id}`} result={r} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        The workspace filter is applied before any text is compared, and
        row-level security enforces it a second time underneath — so no query,
        however it is written, can widen a result set past this workspace.
        Matching is case-insensitive substring matching, ranked exact before
        prefix before word-boundary before substring. Wildcards typed into the
        box are treated as literal characters. This search took {tookMs}ms and
        wrote nothing.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-32 animate-pulse rounded-lg border bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const params = await searchParams;
  /* Trimmed and capped here as well as in the action's schema. The action
   * is the enforcement; this keeps a 10,000-character paste out of the
   * value we echo straight back into the input. */
  const query = (params.q ?? "").trim().slice(0, 200);
  const type = isSearchType(params.type) ? params.type : null;

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Across contacts, companies, deals and assets — and nothing else, which
          is the part worth knowing.
        </p>
      </header>

      {/* A GET form: the query ends up in the URL, so a search is
          linkable and reproducible. No client component involved. */}
      <form method="get" action="/search" className="flex flex-wrap gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name, email, company, code, locality…"
          maxLength={200}
          autoComplete="off"
          className="max-w-md"
          aria-label="Search contacts, companies, deals and assets"
        />
        {/* Carries the active narrowing through a new query rather than
            silently dropping it — a filter that resets itself on every
            search is a filter people stop believing. */}
        {type && <input type="hidden" name="type" value={type} />}
        <Button type="submit">Search</Button>
        {(query || type) && (
          <Link href="/search">
            <Button type="button" variant="outline">
              Clear
            </Button>
          </Link>
        )}
      </form>

      <Suspense key={`${query}:${type ?? "all"}`} fallback={<Skeleton />}>
        <SearchBody query={query} type={type} />
      </Suspense>
    </div>
  );
}
