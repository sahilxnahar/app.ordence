"use client";

/**
 * Ordence — ⭐⭐ CMD+K FOR THE OPERATOR CONSOLE
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Thirteen destinations across a nav bar, plus four hundred workspaces,
 * plus whatever the current screen can do. An operator being paged at 3am
 * should type three letters, not remember which of "Health", "Needs
 * attention" and "Observatory" holds the thing they want.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY DESTINATION GOES THROUGH `consoleHref()`. NO EXCEPTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * The console is served at two base paths:
 *
 *   app.ordence.com/platform/tenants   ← the route that exists on disk
 *   admin.ordence.com/tenants          ← the console's own host
 *
 * A hard-coded `/platform/...` link is not a rewritten path on the admin
 * host, falls through to tenant resolution, redirects to `/dashboard`,
 * which IS rewritten, to a page that does not exist. 404. Every nav item
 * in this console was broken that way for three sessions, and the console
 * looked perfectly healthy the whole time.
 * `node scripts/check-console-links.mjs` fails the build on it.
 *
 * ⚠️ `onConsoleHost()` READS `headers()` AND IS A SERVER FUNCTION. This
 * component cannot call it, cannot import the module that holds it
 * (webpack refuses a `server-only` import from a client bundle), and must
 * NOT sniff `window.location` — that answer differs between SSR and
 * hydration, which is a link that changes under the cursor. It takes
 * `isConsoleHost` as a prop from a server component. That is the contract.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO `alert()`, `confirm()` OR `prompt()` — ANYWHERE, INCLUDING IN AN
 * ACTION A CALLER PASSES IN
 * ══════════════════════════════════════════════════════════════════════
 * They block the event loop, they cannot be styled, they cannot be
 * tested, they are suppressed after the second one in Chrome, and a
 * destructive confirmation that a browser can suppress is not a
 * confirmation. Use `<ConfirmDestructive>`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  // Aliased: the bare `KeyboardEvent` in this file must stay the DOM one,
  // which is what `window.addEventListener("keydown")` hands us.
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CONSOLE_NAV, consoleHref, type ConsoleNavItem } from "@/lib/platform/console-paths";

export type { ConsoleNavItem } from "@/lib/platform/console-paths";

/* ------------------------------------------------------------------ */
/* THE CONTRACT                                                        */
/* ------------------------------------------------------------------ */

/** Something the CURRENT screen can do, supplied by that screen. */
export type PaletteAction = {
  /** Unique within one palette. Not shown. */
  id: string;
  label: string;
  /** Second line — say what it will do, not what it is. */
  hint?: string;
  /** Extra words to match on: "suspend", "disable", "turn off". */
  keywords?: string;
  /**
   * 🔴 MUST NOT CALL `alert` / `confirm` / `prompt`. If the action is
   * destructive, open `<ConfirmDestructive>` from here instead. The
   * palette closes before this runs, so a dialog opened by it is not
   * fighting the palette for focus.
   */
  run: () => void;
};

/** One workspace, as the async search returns it. */
export type PaletteWorkspace = {
  id: string;
  name: string;
  slug: string;
  /** Optional third line: plan, status, whatever disambiguates two Acmes. */
  detail?: string;
};

export type CommandPaletteProps = {
  /**
   * 🔴 FROM A SERVER COMPONENT — `await onConsoleHost()`. See the header.
   * There is no client-side way to get this right.
   */
  isConsoleHost: boolean;

  /**
   * The workspace lookup. Debounced and sequence-guarded by this
   * component; the implementation just has to answer.
   *
   * ⚠️ It runs against every customer, so the server side of it belongs
   * behind the same capability check as the search screen, and it must
   * return only what the operator is allowed to see. The palette shows
   * whatever it is handed.
   */
  searchWorkspaces?: (query: string) => Promise<PaletteWorkspace[]>;

  /**
   * Canonical `/platform/...` path for a workspace hit. It is passed
   * through `consoleHref()` here — do NOT pre-map it.
   */
  workspaceHref?: (workspace: PaletteWorkspace) => string;

  /** Page-supplied actions. */
  actions?: readonly PaletteAction[];

  /** Defaults to `CONSOLE_NAV`. Override only in tests. */
  nav?: readonly ConsoleNavItem[];

  /** Default 180ms. */
  debounceMs?: number;
  /** Below this the workspace search is not run at all. Default 2. */
  minQueryLength?: number;

  /** Rendered as the visible opener. */
  triggerLabel?: string;
  /** The page already has its own opener and calls nothing. Rare. */
  hideTrigger?: boolean;
  className?: string;
};

/* ------------------------------------------------------------------ */

type PaletteItem = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
};

/** Every token in the query must appear somewhere in the haystack. */
function matches(haystack: string, query: string): boolean {
  if (!query) return true;
  const hay = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token));
}

export function CommandPalette({
  isConsoleHost,
  searchWorkspaces,
  workspaceHref = (w) => `/platform/tenants/${w.id}`,
  actions,
  nav = CONSOLE_NAV,
  debounceMs = 180,
  minQueryLength = 2,
  triggerLabel = "Search or jump to…",
  hideTrigger = false,
  className,
}: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Whatever had focus when the palette opened, so it can be given back. */
  const restoreRef = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  /* ---------------- the hotkey ---------------- */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // ⚠️ Bound with the modifier, so unlike the table's j/k this is safe
      // to fire while the operator is typing in a field — Cmd+K is not a
      // character anybody is trying to enter.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) setOpen(false);
        else openPalette();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, openPalette]);

  /* ---------------- the async workspace search ---------------- */

  const [workspaces, setWorkspaces] = useState<readonly PaletteWorkspace[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "done" | "error">(
    "idle",
  );
  const [searchError, setSearchError] = useState<string | null>(null);

  /**
   * ⚠️ HELD IN A REF SO AN INLINE ARROW PROP DOES NOT RESTART THE
   * DEBOUNCE. `searchWorkspaces={(q) => lookup(q)}` is a new function on
   * every render; in the dependency array it would cancel and restart the
   * timer on every keystroke's re-render and the search would never fire.
   */
  const searchRef = useRef(searchWorkspaces);
  searchRef.current = searchWorkspaces;

  /**
   * ⭐⭐ THE SEQUENCE NUMBER IS THE WHOLE POINT OF THIS BLOCK.
   *
   * Type "ac", then "acme". Two requests are in flight. "ac" is the
   * broader query, so it is frequently the SLOWER one, and it lands last:
   * the operator sees results for a query they have already finished
   * typing, and the row they click is not the row they think it is.
   *
   * 🔴 AN AbortController DOES NOT FIX THIS ON ITS OWN. Aborting a fetch
   * that has already resolved does nothing — the `.then` handler is
   * queued and will run. The only reliable guard is to check, at the
   * moment of applying the result, whether a newer request has been
   * issued since. Bumping `seqRef` also invalidates in-flight work when
   * the query drops below the minimum or the palette closes.
   */
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const lookup = searchRef.current;
    if (!lookup) return;

    const trimmed = query.trim();
    if (trimmed.length < minQueryLength) {
      seqRef.current += 1; // anything still in flight is now stale
      setWorkspaces([]);
      setSearchState("idle");
      setSearchError(null);
      return;
    }

    const timer = setTimeout(() => {
      const seq = (seqRef.current += 1);
      setSearchState("searching");
      lookup(trimmed).then(
        (results) => {
          if (seq !== seqRef.current) return;
          setWorkspaces(results);
          setSearchError(null);
          setSearchState("done");
        },
        (cause: unknown) => {
          if (seq !== seqRef.current) return;
          setWorkspaces([]);
          setSearchError(
            cause instanceof Error ? cause.message : "The workspace search did not answer.",
          );
          setSearchState("error");
        },
      );
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [open, query, debounceMs, minQueryLength]);

  // Closing invalidates in-flight work, so re-opening never paints a
  // result belonging to the previous session's query.
  useEffect(() => {
    if (open) return;
    seqRef.current += 1;
    setWorkspaces([]);
    setSearchState("idle");
    setSearchError(null);
  }, [open]);

  /* ---------------- the item list ---------------- */

  const go = useCallback(
    (canonical: string) => {
      setOpen(false);
      // 🔴 `consoleHref` or a 404. See the header.
      router.push(consoleHref(canonical, isConsoleHost));
    },
    [router, isConsoleHost],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];

    for (const action of actions ?? []) {
      if (!matches(`${action.label} ${action.hint ?? ""} ${action.keywords ?? ""}`, query)) {
        continue;
      }
      out.push({
        key: `action:${action.id}`,
        group: "On this page",
        label: action.label,
        hint: action.hint,
        run: () => {
          // Closed FIRST: an action that opens a confirmation must not
          // have to fight the palette's focus trap for the keyboard.
          setOpen(false);
          action.run();
        },
      });
    }

    for (const item of nav) {
      if (!matches(`${item.label} ${item.keywords ?? ""}`, query)) continue;
      out.push({
        key: `nav:${item.href}`,
        group: "Go to",
        label: item.label,
        run: () => go(item.href),
      });
    }

    for (const workspace of workspaces) {
      out.push({
        key: `workspace:${workspace.id}`,
        group: "Workspaces",
        label: workspace.name,
        hint: workspace.detail ? `${workspace.slug} · ${workspace.detail}` : workspace.slug,
        run: () => go(workspaceHref(workspace)),
      });
    }

    return out;
  }, [actions, nav, workspaces, query, go, workspaceHref]);

  useEffect(() => {
    setActiveIndex((i) => (i >= items.length ? 0 : i));
  }, [items.length]);

  useEffect(() => {
    const holder = listRef.current;
    if (!holder) return;
    const el = holder.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items.length]);

  const runActive = useCallback(() => {
    const item = items[activeIndex];
    if (item) item.run();
  }, [items, activeIndex]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, items.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runActive();
    }
    // Escape is Radix's: it closes the dialog and returns focus.
  };

  /* ---------------- render ---------------- */

  let lastGroup: string | null = null;
  const rows: ReactNode[] = [];
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      rows.push(
        <div
          key={`group:${item.group}`}
          role="presentation"
          className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {item.group}
        </div>,
      );
    }
    const active = index === activeIndex;
    rows.push(
      <button
        key={item.key}
        type="button"
        id={`palette-item-${index}`}
        data-index={index}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        onMouseMove={() => setActiveIndex(index)}
        onClick={() => item.run()}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
          active && "bg-accent text-accent-foreground",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.label}</span>
          {item.hint ? (
            <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>
          ) : null}
        </span>
        {/* The chevron says "this one runs on Enter"; the word next to it
            is what a screen reader and a colour-blind operator get. */}
        {active ? (
          <span className="shrink-0 text-xs text-muted-foreground">Enter ↵</span>
        ) : null}
      </button>,
    );
  });

  return (
    <>
      {hideTrigger ? null : (
        <button
          ref={triggerRef}
          type="button"
          onClick={openPalette}
          className={cn(
            "inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Search className="h-4 w-4" aria-hidden />
          <span>{triggerLabel}</span>
          <kbd className="ml-2 rounded border border-border px-1 text-xs">Ctrl K</kbd>
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          Radix supplies the focus trap and the Escape handling. Both are
          the kind of thing that is 90% right when hand-rolled, and the
          missing 10% is a keyboard user tabbing out of a modal into a
          page they cannot see.
        */}
        <DialogContent
          className="top-[12%] max-w-xl translate-y-0 gap-2 p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Radix restores focus to whatever opened the dialog. If that
            // element has gone (a row that was filtered away), landing on
            // `document.body` would make the next Tab start from the top
            // of the page, so fall back to the trigger.
            const previous = restoreRef.current;
            if (previous && document.contains(previous)) return;
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Console command palette</DialogTitle>
            <DialogDescription>
              Jump to a console screen, find a workspace by name or address, or run an
              action on this page. Arrow keys to move, Enter to run, Escape to close.
            </DialogDescription>
          </DialogHeader>

          <div className="border-b border-border p-3">
            <Input
              ref={inputRef}
              value={query}
              autoComplete="off"
              spellCheck={false}
              placeholder="Jump to a screen, or find a workspace by name or address"
              aria-label="Search the console"
              aria-controls="palette-results"
              aria-activedescendant={
                items.length > 0 ? `palette-item-${activeIndex}` : undefined
              }
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>

          <div
            id="palette-results"
            ref={listRef}
            role="listbox"
            aria-label="Results"
            className="max-h-[50vh] overflow-y-auto pb-2"
          >
            {rows}

            {/* Every state below carries a WORD. An empty list and a
                still-loading list must not look the same. */}
            {searchState === "searching" ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Searching workspaces…
              </p>
            ) : null}

            {searchState === "error" ? (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                Workspace search failed: {searchError}. Console screens above still work.
              </p>
            ) : null}

            {items.length === 0 && searchState !== "searching" ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {query.trim().length === 0
                  ? "Start typing. Screens match on name, workspaces on name or address."
                  : query.trim().length < minQueryLength
                    ? `Type at least ${minQueryLength} characters to search workspaces.`
                    : "Nothing matches that."}
              </p>
            ) : null}
          </div>

          <p
            role="status"
            aria-live="polite"
            className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {items.length} result{items.length === 1 ? "" : "s"}. Arrow keys move, Enter
            opens, Escape closes.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
