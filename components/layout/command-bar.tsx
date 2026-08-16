"use client";

/**
 * Ordence — Global Command Bar (⌘K / Ctrl+K)
 * Version: v0.83.1
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS BUILT ON RADIX DIALOG AND NOT `cmdk`
 * ══════════════════════════════════════════════════════════════════════
 * `cmdk` is the obvious choice and it was deliberately not taken. Ordence
 * deploys from GitHub to Railway and the deploy is the fragile part of
 * this project, not the UI. `@radix-ui/react-dialog` is ALREADY a
 * dependency, already bundled, already used by `components/ui/dialog.tsx`.
 * Adding a package to ship a palette means the palette can break `npm ci`.
 *
 * The parts `cmdk` would have given us — filtering, keyboard nav, roving
 * focus — are ~80 lines here because the filtering is done SERVER-side by
 * `globalSearch()` under RLS, not client-side over a preloaded list.
 * That is not a compromise: a client-side command palette would have to
 * ship every contact, company, deal and asset to the browser to filter
 * them, which for a multi-tenant CRM is the wrong shape regardless of
 * which library draws the box.
 *
 * ⚠️ `globalSearch` IS A `"use server"` ACTION. Importing it from this
 * client file is the supported direction. Importing a `server-only`
 * module here instead is what broke the production build in v0.83.0 —
 * see the note in `components/platform/user-actions.tsx`.
 *
 * ⚠️ SEARCH IS RATE-LIMITED SERVER-SIDE (`checkRateLimit("search", ...)`).
 * The 200ms debounce below is not decoration — typing "invoice" without it
 * is seven searches, and seven searches per keystroke-burst per user will
 * trip a limit that exists to protect the most expensive read in the
 * product.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, CornerDownLeft, Loader2 } from "lucide-react";
import { globalSearch, type SearchResult } from "@/server/actions/search";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* STATIC ACTIONS                                                      */
/* ------------------------------------------------------------------ */

/**
 * Navigation and create targets that do not require a search round trip.
 *
 * ⚠️ These are NOT permission-filtered here, and that is intentional —
 * hiding a link is not access control. Every destination re-checks
 * entitlement and RLS on arrival, so the worst case is a user navigating
 * to a page that tells them they cannot see it. Filtering this list
 * client-side would require shipping the entitlement matrix to the
 * browser, which is both a leak and a second source of truth.
 */
type CommandAction = {
  id: string;
  label: string;
  hint: string;
  href: string;
  keywords: string;
};

const ACTIONS: CommandAction[] = [
  { id: "nav-dashboard", label: "Dashboard", hint: "Go", href: "/dashboard", keywords: "home overview kpi" },
  { id: "nav-contacts", label: "Contacts", hint: "Go", href: "/contacts", keywords: "people person customer" },
  { id: "nav-companies", label: "Companies", hint: "Go", href: "/companies", keywords: "org account vendor" },
  { id: "nav-deals", label: "Deals", hint: "Go", href: "/deals", keywords: "pipeline opportunity sales" },
  { id: "nav-receivables", label: "Receivables", hint: "Go", href: "/receivables", keywords: "money owed outstanding debtors" },
  { id: "nav-gst", label: "GST", hint: "Go", href: "/gst", keywords: "tax return gstr filing" },
  { id: "nav-gstr2b", label: "GSTR-2B", hint: "Go", href: "/gstr2b", keywords: "reconciliation itc input credit" },
  { id: "nav-tds", label: "TDS", hint: "Go", href: "/tds", keywords: "tax deducted source challan" },
  { id: "nav-purchases", label: "Purchases", hint: "Go", href: "/purchases", keywords: "bills vendor payable" },
  { id: "nav-inventory", label: "Inventory", hint: "Go", href: "/inventory", keywords: "stock materials" },
  { id: "nav-compliance", label: "Compliance", hint: "Go", href: "/compliance", keywords: "deadline licence obligation" },
  { id: "nav-automations", label: "Automations", hint: "Go", href: "/automations", keywords: "workflow rules triggers" },
  { id: "nav-approvals", label: "Approvals", hint: "Go", href: "/automations/approvals", keywords: "approve review pending" },
  { id: "nav-reports", label: "Reports", hint: "Go", href: "/reports", keywords: "analytics charts export" },
  { id: "nav-assistant", label: "Assistant", hint: "Go", href: "/assistant", keywords: "ai chat copilot ask" },
  { id: "nav-deployment", label: "Deployment Control", hint: "Go", href: "/deployment-control", keywords: "release backup deploy manifest" },
  { id: "nav-settings", label: "Settings", hint: "Go", href: "/settings", keywords: "config preferences workspace" },
  { id: "nav-team", label: "Team", hint: "Go", href: "/settings/team", keywords: "users members invite roles" },
  { id: "nav-billing", label: "Billing", hint: "Go", href: "/settings/billing", keywords: "invoice subscription plan pay" },
  { id: "new-contact", label: "New contact", hint: "Create", href: "/contacts/new", keywords: "add create person" },
  { id: "new-company", label: "New company", hint: "Create", href: "/companies/new", keywords: "add create org" },
  { id: "new-asset", label: "New asset", hint: "Create", href: "/assets/new", keywords: "add create property unit" },
];

const TYPE_LABEL: Record<SearchResult["type"], string> = {
  contact: "Contact",
  company: "Company",
  deal: "Deal",
  asset: "Asset",
};

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function CommandBar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const listRef = useRef<HTMLDivElement>(null);

  /*
   * ⚠️ Guards against a slow search overwriting a fast one. Type "ab" then
   * "abc": if the "ab" request resolves LAST, the user sees results for a
   * query they have already moved past. Comparing the sequence number on
   * arrival is what makes that impossible.
   */
  const seq = useRef(0);

  /* ---- ⌘K / Ctrl+K ------------------------------------------------ */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- SearchTrigger: the visible top-bar control opens this palette */
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("ordence:open-search", handler);
    return () => window.removeEventListener("ordence:open-search", handler);
  }, []);

  /* ---- Reset on close --------------------------------------------- */
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setActive(0);
      setError(null);
    }
  }, [open]);

  /* ---- Debounced server search ------------------------------------ */
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      return;
    }

    const mine = ++seq.current;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const res = await globalSearch({ query: trimmed, limit: 5 });
        if (mine !== seq.current) return; // a newer keystroke won

        if (res.ok) {
          setResults(res.data.results);
          setError(null);
        } else {
          setResults([]);
          setError(res.error);
        }
        setActive(0);
      });
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  /* ---- Filtered static actions ------------------------------------ */
  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ACTIONS.slice(0, 8);
    return ACTIONS.filter(
      (a) => a.label.toLowerCase().includes(q) || a.keywords.includes(q),
    ).slice(0, 6);
  }, [query]);

  /* ---- One flat list, so arrow keys cross the section boundary ----- */
  /*
   * ⚠️ ONE shape, with `subtitle` always present and nullable, rather than
   * a union of "action" and "result". A union here compiles to `subtitle`
   * existing on only one branch, which forces an `in` narrowing at the
   * render site and types the value as `unknown`. Normalising at
   * construction is cheaper than narrowing at every use.
   */
  type CommandItem = {
    key: string;
    href: string;
    label: string;
    hint: string;
    subtitle: string | null;
  };

  const items = useMemo<CommandItem[]>(
    () => [
      ...filteredActions.map((a) => ({
        key: a.id,
        href: a.href,
        label: a.label,
        hint: a.hint,
        subtitle: null,
      })),
      ...results.map((r) => ({
        key: `${r.type}:${r.id}`,
        href: r.href,
        label: r.title,
        hint: TYPE_LABEL[r.type],
        subtitle: r.subtitle,
      })),
    ],
    [filteredActions, results],
  );

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (items.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = items[active];
        if (target) go(target.href);
      }
    },
    [items, active, go],
  );

  /* Keep the highlighted row inside the scroll viewport. */
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-[15vh] z-50 w-[92vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-background shadow-2xl"
          aria-label="Command bar"
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search contacts, companies, deals and assets, or jump to a page.
          </Dialog.Description>

          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search or jump to…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Search"
              aria-activedescendant={items[active] ? `cmd-${items[active].key}` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {isPending && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>

          <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-2" role="listbox">
            {error && (
              <p className="px-3 py-6 text-center text-sm text-destructive">{error}</p>
            )}

            {!error && items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {query.trim().length < 2
                  ? "Type at least two characters to search."
                  : isPending
                    ? "Searching…"
                    : "Nothing found."}
              </p>
            )}

            {items.map((item, i) => (
              <button
                key={item.key}
                id={`cmd-${item.key}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onClick={() => go(item.href)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                  i === active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{item.label}</span>
                  {item.subtitle && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.subtitle}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                  {i === active && (
                    <CornerDownLeft className="h-3 w-3 text-muted-foreground" aria-hidden />
                  )}
                </span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
