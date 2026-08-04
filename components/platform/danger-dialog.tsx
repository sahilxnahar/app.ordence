"use client";

/**
 * Ordence — Confirmation For Dangerous Console Actions
 * Version: v0.14.0-alpha
 *
 * One dialog for suspend, reactivate, impersonate and staff revocation,
 * because four bespoke confirmations drift and the fourth one ends up
 * without the typed check.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT EACH ELEMENT IS ACTUALLY FOR — THEY ARE NOT THE SAME THING
 * ══════════════════════════════════════════════════════════════════════
 *   THE TYPED SLUG is a MISTAKE guard. Anyone can type a slug; it stops
 *   nobody who intends harm. It exists because the console shows two
 *   hundred near-identical rows and the realistic failure is suspending
 *   the wrong customer at 17:55 on a Friday.
 *
 *   THE JUSTIFICATION is EVIDENCE. It is written verbatim into the
 *   customer's own audit log, and it is the field somebody reads six
 *   months later when the customer asks what happened. The minimum
 *   length is there to make "test" impossible, not to make the operator
 *   suffer.
 *
 *   THE CONSEQUENCE LIST is HONESTY. Every dangerous action states, in
 *   the dialog, what it will and will not do — specifically that
 *   suspension deletes nothing and that the customer can still export.
 *   An operator who does not know that will not say it to the customer.
 *
 * ⚠️ NOT A SECURITY BOUNDARY. The server re-validates the slug, re-checks
 * the capability, re-checks the step-up and re-validates the
 * justification length. This dialog can be bypassed entirely with a curl
 * command and nothing about the outcome changes.
 */

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type DangerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Bullet list of exactly what happens. Include what does NOT happen. */
  consequences: string[];
  /** When set, the operator must type this string exactly. */
  confirmValue?: string;
  confirmLabel?: string;
  justificationLabel?: string;
  minJustification?: number;
  actionLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  extra?: ReactNode;
  onConfirm: (input: { confirmValue: string; justification: string }) => void;
};

export function DangerDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmValue,
  confirmLabel = "Type the workspace address to confirm",
  justificationLabel = "Why are you doing this?",
  minJustification = 20,
  actionLabel,
  destructive = true,
  pending = false,
  error = null,
  extra,
  onConfirm,
}: DangerDialogProps) {
  const [typed, setTyped] = useState("");
  const [justification, setJustification] = useState("");

  const slugOk = !confirmValue || typed.trim() === confirmValue;
  const reasonOk = justification.trim().length >= minJustification;
  const ready = slugOk && reasonOk && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs">
          {consequences.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden>·</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>

        {extra}

        {confirmValue ? (
          <div className="space-y-1">
            <Label htmlFor="danger-confirm">{confirmLabel}</Label>
            <Input
              id="danger-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={confirmValue}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="danger-reason">{justificationLabel}</Label>
          <Textarea
            id="danger-reason"
            rows={3}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Ticket reference and one sentence. This is written to the customer's audit log."
          />
          <p className="text-xs text-muted-foreground">
            {justification.trim().length}/{minJustification} characters minimum.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!ready}
            onClick={() => onConfirm({ confirmValue: typed.trim(), justification: justification.trim() })}
          >
            {pending ? "Working…" : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
