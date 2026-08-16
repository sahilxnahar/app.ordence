"use client";
import * as React from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ══════════════════════════════════════════════════════════════════════
 * FORM & NAVIGATION PRIMITIVES — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 *   ConfirmDialog   — a destructive action must ask once, name exactly
 *                     what it will do, and be cancellable by Esc.
 *   FormSuccess / FormError — the two states every form reports through
 *                     toast(); these are the IN-FORM twins for when the
 *                     message must sit next to the fields (server-action
 *                     results, validation summaries).
 *   StickyHeader    — makes a scrollable section's header stick without
 *                     pulling z-index math into every consumer.
 *   UtmBadge        — renders the UTM tags this session arrived with;
 *                     the actual capture runs in a tiny client hook and
 *                     logs to the web-vitals reporter, never to storage
 *                     beyond the current page's memory.
 */

/**
 * Guard for destructive actions. `onConfirm` only ever runs after a real
 * click on the confirm button — keyboard activation included (Enter on
 * the focused confirm). `onOpenChange` lets the caller track intent
 * separately from confirmation.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={async () => {
                await onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * In-form success banner. Use beside the submit area when the toast is
 * not enough context — the message must name what actually succeeded,
 * not merely "success".
 */
export function FormSuccess({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-secondary-foreground"
    >
      <span className="font-medium text-primary">✓ </span>
      {message}
      {onDismiss && (
        <button
          type="button"
          className="ml-2 text-xs underline"
          onClick={onDismiss}
          aria-label="Dismiss success message"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * In-form error summary. `aria-live="assertive"` so screen readers
 * announce it immediately; `role="alert"` is deliberately NOT used on
 * the container because an error list is assertive by nature and alert
 * would interrupt mid-sentence reading. Each message gets an id so the
 * form's aria-describedby can point at the whole list.
 */
export function FormError({
  id = "form-error-list",
  messages,
}: {
  id?: string;
  messages: string[];
}) {
  if (messages.length === 0) return null;
  return (
    <div
      id={id}
      role="status"
      aria-live="assertive"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <p className="font-medium">
        {messages.length === 1 ? "One problem prevented saving:" : `${messages.length} problems prevented saving:`}
      </p>
      <ul className="mt-1 list-disc pl-5">
        {messages.map((m, i) => (
          <li key={i} id={`${id}-${i}`}>
            {m}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sticky section header for long scrollable content (invoice lines,
 * ledger tables). Sticky without a z-index arms race: the bar's own
 * background covers what scrolls beneath it, which is all it needs.
 */
export function StickyHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Hover affordance: wraps children with a consistent focus-visible ring
 * AND hover treatment for interactive surfaces that are not buttons
 * (table rows, cards). Pure styling — no behaviour.
 */
export function Hoverable({
  children,
  className,
  as: Tag = "div",
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "tr" | "li" | "span";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        "transition-colors duration-150 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * UTM capture — memory only, current page. The tags arrive in the URL;
 * we copy them into a ref so components can display them (the badge
 * below) and send them to the telemetry reporter, and we never persist
 * them into storage. Attribution is for understanding traffic, not for
 * building a profile; the moment it outlives the session it has become
 * tracking, and this app does not do that.
 */
export function useUtm(): Record<string, string | null> {
  const [tags] = React.useState(() => {
    if (typeof window === "undefined") return {};
    const params = new URLSearchParams(window.location.search);
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = params.get(k);
    return out;
  });
  return tags;
}

/**
 * Shows the UTM tags only when present — an empty badge that says
 * "none" teaches nobody anything and clutters settings pages.
 */
export function UtmBadge({ className }: { className?: string }) {
  const tags = useUtm();
  const present = Object.entries(tags).filter(([, v]) => v);
  if (present.length === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex flex-wrap gap-1 text-[11px] text-muted-foreground",
        className,
      )}
      aria-label={`UTM tags: ${present.map(([k, v]) => `${k}=${v}`).join(", ")}`}
    >
      {present.map(([k, v]) => (
        <span key={k} className="rounded border border-border px-1.5 py-0.5">
          {v}
        </span>
      ))}
    </span>
  );
}

/**
 * Report captured UTM tags once per page view. Mounted in the layout;
 * failure is silent — attribution is not worth a broken page.
 */
export function useUtmReport() {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tags: Record<string, string> = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const v = params.get(k);
      if (v) tags[k] = v;
    }
    if (Object.keys(tags).length === 0) return;
    // Deliberately NOT beamed to the server: the telemetry ingest is
    // public-write and adding an unauthenticated UTM sink would invite
    // log growth from anyone. Attribution surfaces here are display-only;
    // if server-side funnel analytics is wanted later it needs the same
    // rate-limit-and-scrub treatment as every other public write.
    void tags;
  }, []);
}


/**
 * ⭐⭐ THE CLIENT WRAPPER FOR `useUtmReport`, AND WHY IT LIVES HERE.
 *
 * 🔴 THIS COMPONENT WAS DEFINED IN `app/layout.tsx`, WHICH IS A SERVER
 * COMPONENT, AND IT TOOK THE WHOLE APPLICATION DOWN.
 *
 *     Error: Attempted to call useUtmReport() from the server but
 *     useUtmReport is on the client.
 *
 * Defining the wrapper inside `layout.tsx` looks like it makes it a
 * client component, and it does not: a function declared in a server
 * module IS server code, wherever the hook it calls happens to live.
 * The root layout renders on every request, so a throw there is not one
 * broken page , it is a 500 on every route in the product, customer app
 * and staff console alike. It was.
 *
 * ⚠️ `next build` DOES NOT CATCH IT. The build succeeded and deployed
 * green; the error is thrown at render time, per request.
 *
 * ⭐ THE FIX IS WHERE THE COMPONENT LIVES, NOT WHAT IT DOES. This file
 * carries `"use client"` at the top, so anything exported from it is a
 * client component and the layout may render it as a child.
 */
export function UtmCapture() {
  useUtmReport();
  return null;
}
