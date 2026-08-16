"use client";
import * as React from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * ══════════════════════════════════════════════════════════════════════
 * ACCESSIBILITY PRIMITIVES — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 *   SkipToContent      — keyboard users jump past chrome on first Tab.
 *   MobileMenuButton   — aria-expanded screen-reader toggle for a nav
 *                        trigger; pairs with any collapsible panel the
 *                        consumer controls (state deliberately lives in
 *                        the consumer — the button knows nothing about
 *                        the panel's internals).
 *   LoadingAnimation   — a single consistent loading treatment instead
 *                        of three ad-hoc spinners; `aria-busy` marks the
 *                        region so screen readers announce "busy".
 */

/**
 * Must render as the FIRST element inside <body> — a skip link that
 * appears after the sidebar and header is not a skip link, it is
 * decoration. `href="#main-content"` targets the layout's main region;
 * mount the anchor element with that id at the same spot once.
 */
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to content
    </a>
  );
}

/**
 * The panel itself stays controlled by whoever owns the menu state.
 * This button's only job is to be a correct, styled, keyboard-honest
 * toggle: `aria-expanded` follows the open prop on every render, and
 * `aria-controls` ties it to the panel id the consumer passes.
 */
export function MobileMenuButton({
  open,
  onToggle,
  controlsId = "mobile-nav-panel",
  label = "Open menu",
}: {
  open: boolean;
  onToggle: () => void;
  controlsId?: string;
  label?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9 shrink-0 lg:hidden"
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={label}
      onClick={onToggle}
    >
      <Menu className="h-4 w-4" />
    </Button>
  );
}

/**
 * Consistent in-page loading treatment. Use on the container that is
 * being replaced by the busy content — NOT as a full-screen veil for
 * route transitions (that is a different, rarer beast this app does not
 * currently need, and a veil that outlives its data is a dark pattern).
 */
export function LoadingAnimation({
  label = "Loading content",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={`flex flex-col items-center justify-center gap-3 p-8 ${className}`}
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="text-sm text-muted-foreground">{label}…</p>
    </div>
  );
}

/**
 * Floating "back to top" button — the wave-8b "floating content" item.
 * Appears after a modest scroll down, floats in the lower corner, and
 * returns the reader to the top without hunting for the scroll bar.
 * Mount next to ScrollProgressBar at the layout root.
 */
export function BackToTop() {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => {
      setShow(document.documentElement.scrollTop > 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-16 right-4 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background shadow-md transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M10 15V5M10 5l-4 4M10 5l4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * Mount at the top of the layout, below the Toaster. Tracks scroll
 * position with a passive listener (scroll listeners that are not
 * passive cause jank on every wheel tick) and paints a thin progress
 * bar at the very top of the viewport.
 */
export function ScrollProgressBar({ color = "hsl(var(--primary))" }: { color?: string }) {
  const [pct, setPct] = React.useState(0);

  React.useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setPct(max > 0 ? Math.min(100, (doc.scrollTop / max) * 100) : 0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-transparent"
      style={{ transform: `scaleX(${pct / 100})` }}
    >
      <div className="h-full w-full" style={{ backgroundColor: color }} />
    </div>
  );
}
