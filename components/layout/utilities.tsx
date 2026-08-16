"use client";
import * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ══════════════════════════════════════════════════════════════════════
 * SMALL UX PRIMITIVES — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 *   CopyButton          — copy arbitrary text with visual confirmation.
 *   PasswordToggle      — pairs with an input; toggles type + aria-label
 *                         honestly (showing a password is a visible act
 *                         and the labels must say so).
 *   ExpandableFaq       — details/summary semantics, single open item.
 *   LastUpdated         — "last updated" timestamp with a human label.
 */

/**
 * Copies text and shows a brief checkmark. Uses the clipboard API with a
 * copy-free fallback for restricted contexts (non-HTTPS, some webviews)
 * where navigator.clipboard throws — failure there degrades to a toast,
 * never to a silent dead button.
 */
export function CopyButton({
  text,
  label = "Copy to clipboard",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={copy}
      className={cn("h-8 w-8", className)}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

/**
 * Show/hide for a password (or any secret) input. Attaches by ref so it
 * works inside our form shell AND inside raw inputs; the toggle button
 * states its effect in the aria-label, and the field itself stays
 * type="password" until visibly switched.
 */
export function PasswordToggle({
  inputRef,
  inputId,
}: {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  inputId?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      aria-label={visible ? "Hide password" : "Show password"}
      aria-describedby={inputId}
      onClick={() => {
        const input = inputRef.current;
        if (!input) return;
        setVisible((v) => {
          input.type = v ? "password" : "text";
          return !v;
        });
      }}
    >
      {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </Button>
  );
}

/**
 * FAQ accordion with semantic details/summary and a visually honest chevron.
 * `items` are rendered server-safe (strings only); rich content belongs in
 * a page, not a collapsing answer — if an answer needs more than text it
 * needs its own page, and the FAQ is just the pointer.
 */
export function ExpandableFaq({
  items,
  title,
}: {
  items: Array<{ question: string; answer: string }>;
  title?: string;
}) {
  return (
    <section aria-label={title ?? "Frequently asked questions"} className="space-y-2">
      {title && <h2 className="text-lg font-semibold">{title}</h2>}
      {items.map((item, i) => (
        <details key={i} className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {item.question}
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <p className="px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
            {item.answer}
          </p>
        </details>
      ))}
    </section>
  );
}

/**
 * "Last updated" line with a machine-readable timestamp. The human label
 * comes from the caller (invoice, document, setting) so the line reads
 * correctly in any context without this component guessing.
 */
export function LastUpdated({
  at,
  label = "Last updated",
}: {
  at: Date | string | null | undefined;
  label?: string;
}) {
  if (!at) return null;
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      className="text-xs text-muted-foreground"
      title={`Machine-readable: ${date.toISOString()}`}
    >
      {label}: {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
    </time>
  );
}
