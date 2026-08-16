"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * ══════════════════════════════════════════════════════════════════════
 * COOKIE BANNER — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 * A simple consent banner: one message, two choices, stored locally.
 *
 * WHY THIS BANNER AND NOT A CMP INTEGRATION.
 * The product's own cookies are limited to the Clerk session (set by
 * Clerk's infrastructure, out of our control) and nothing marketing.
 * What the platform controls — localStorage keys for UI preferences —
 * needs no consent at all under the prevailing guidance, because they
 * are not cookies and not trackers. The banner therefore covers the one
 * genuinely user-visible class of our own storage and stays honest:
 * it does not claim compliance with a framework this app does not need,
 * and it does not hide behind a dark-pattern "Accept all" wall.
 *
 * Dismissal is stored under one key. No analytics, no fingerprinting,
 * no network call on accept — the banner's own footprint is a single
 * localStorage write, exactly the thing it is announcing.
 */

const BANNER_STORAGE_KEY = "ordence-cookies-v1";

export function CookieBanner() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(BANNER_STORAGE_KEY) === "dismissed";
    } catch {
      /* Storage unavailable — banner simply stays hidden; never blocks. */
      dismissed = true;
    }
    if (!dismissed) {
      const t = setTimeout(() => setVisible(true), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  const dismiss = React.useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(BANNER_STORAGE_KEY, "dismissed");
    } catch {
      /* Ephemeral session — the banner may reappear once per window. */
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:rounded-lg sm:max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        This app uses your own Clerk session cookies to keep you signed in.
        Your UI preferences are saved on this device only. Nothing is shared
        with advertisers; nothing here is a tracker.
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Dismiss
        </Button>
        <Button size="sm" onClick={dismiss}>
          Understood
        </Button>
      </div>
    </div>
  );
}
