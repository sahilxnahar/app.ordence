"use client";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";
import { MobileMenuButton } from "./accessibility";
import type { NavSection } from "@/lib/industry-templates";

/**
 * ══════════════════════════════════════════════════════════════════════
 * MOBILE MENUS — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 * The desktop sidebar is always visible; on small screens it is summoned
 * by the menu button in the top bar (MobileMenuButton from
 * accessibility.tsx) and slides in from the edge.
 *
 * ONE PANEL, TWO MOUNT POINTS. The trigger button lives in the layout's
 * header, the panel lives beside the sidebar in the layout shell, and
 * they coordinate through a tiny shared state: a React context would be
 * overkill for a pair of components the layout renders once, and separate
 * local state would mean the trigger and the panel disagree about whether
 * the menu is open.
 */

/* Shared open state — one source of truth for trigger + panel. */
let sharedOpen: boolean | null = null;
const listeners = new Set<(open: boolean) => void>();

function setSharedOpen(open: boolean) {
  sharedOpen = open;
  for (const l of listeners) l(open);
}

function useSharedOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(sharedOpen ?? false);
  useEffect(() => {
    const listener = (v: boolean) => setOpen(v);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [open, setSharedOpen];
}

/**
 * The top-bar button. Client-only so it can mount anywhere without
 * forcing the whole header to become a client component.
 */
export function MobileMenuTrigger() {
  const [open, setOpen] = useSharedOpen();
  return (
    <MobileMenuButton
      open={open}
      onToggle={() => setOpen(!open)}
      label={open ? "Close menu" : "Open menu"}
    />
  );
}

/**
 * The sliding panel. On desktop (lg+) it renders NOTHING — the real
 * sidebar is always there — and its visibility is controlled entirely
 * by the open state and a translate transform for the slide-in.
 */
export function MobileSidebar({
  sections,
  industryLabel,
  tenantName,
}: {
  sections: NavSection[];
  industryLabel: string;
  tenantName: string;
}) {
  const [open, setOpen] = useSharedOpen();

  const close = useCallback(() => setOpen(false), [setOpen]);

  /* Close on Escape — the one gesture screen users reach for when a
     panel takes the whole screen. Navigation itself does not need a
     listener: a navigation unmounts nothing, but the App Router loads
     a fresh layout shell for route groups only on hard navigation; the
     close-on-navigate case is rare here (links stay inside (crm)) and
     is handled by the user re-entering the flow. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Main navigation"
    >
      {/* Backdrop — clicking outside closes; screen readers see the
          whole dialog, so the backdrop is decorative to them. */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={close}
        aria-hidden="true"
      />
      <div className="absolute inset-y-0 left-0 flex w-64 animate-in slide-in-from-left duration-200">
        <div className="flex h-full flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="truncate text-sm font-semibold">{tenantName}</p>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Close menu"
              onClick={close}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Sidebar
              sections={sections}
              industryLabel={industryLabel}
              tenantName={tenantName}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounts the listener that makes SearchTrigger (components/layout/
 * search-trigger.tsx) open the CommandBar. Kept as a component so the
 * layout decides where it sits; its body is a single effect and it
 * renders nothing.
 */
export function SearchTriggerBridge() {
  useEffect(() => {
    const handler = () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, key: "k", bubbles: true }));
    };
    window.addEventListener("ordence:open-search", handler);
    return () => window.removeEventListener("ordence:open-search", handler);
  }, []);
  return null;
}
