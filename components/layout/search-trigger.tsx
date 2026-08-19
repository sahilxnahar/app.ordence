"use client";
import * as React from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ══════════════════════════════════════════════════════════════════════
 * SITE SEARCH TO THE TOP — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 * The product's global search has always lived in the CommandBar
 * (⌘K/Ctrl+K), which opens only on a keyboard chord — discoverable to
 * power users, invisible to everyone else. This control puts a visible
 * search affordance in the top bar of every authenticated screen, and
 * its ONLY job is to open the existing command bar: the filtering stays
 * server-side under RLS, the rate limit stays intact, and there is no
 * second search implementation to keep in sync.
 *
 * Why a custom event instead of importing CommandBar here: CommandBar
 * mounts at the layout and manages its own state; re-mounting it inside
 * this button would create two palettes listening to the same hotkey.
 * A window-level "open:search" event lets the two stay one palette.
 */

const OPEN_SEARCH_EVENT = "ordence:open-search";

export function openSiteSearch() {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
}

/**
 * Mount ONCE in the layout that owns the CommandBar. Listens for the
 * event fired by SearchTrigger (or any future caller) and delegates to
 * the command bar's own open handler.
 */
export function SearchBridge({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;

  React.useEffect(() => {
    const handler = () => onOpenRef.current();
    window.addEventListener(OPEN_SEARCH_EVENT, handler);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, handler);
  }, []);

  return null;
}

/**
 * The visible control. Renders as an input-shaped button so users scan
 * it as "search"; clicking anywhere in it opens the palette. The ⌘K
 * caption stays because keyboard users need to know the chord exists.
 */
export function SearchTrigger({
  className,
  placeholder = "Search contacts, deals, invoices…",
}: {
  className?: string;
  placeholder?: string;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={openSiteSearch}
      aria-label="Open site search"
      className={cn(
        "h-9 w-full max-w-xs justify-start gap-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="truncate">{placeholder}</span>
      <kbd
        className={cn(
          "ml-auto hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] sm:inline",
        )}
        aria-hidden="true"
      >
        ⌘K
      </kbd>
    </Button>
  );
}
