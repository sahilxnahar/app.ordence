"use client";

/**
 * Ordence — ⭐⭐ ONE CONFIRMATION FOR EVERY DESTRUCTIVE CONSOLE ACTION
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS A MISTAKE GUARD. IT IS NOT A BOUNDARY.
 * ══════════════════════════════════════════════════════════════════════
 * A SCREEN THAT HIDES OR DISABLES A BUTTON HAS PREVENTED NOTHING. The
 * button lives in a bundle the operator's browser already has; the
 * `disabled` attribute comes off in the inspector in four seconds; the
 * action behind it is a POST that `curl` can make without ever loading
 * this component. Everything here can be bypassed, and when it is, the
 * outcome must be identical — because the SERVER re-checks:
 *
 *   • the capability, from `platform_staff` and the env allowlist
 *   • the step-up, if the action needs one
 *   • the typed object name, against the record it is actually about
 *   • the reason, its minimum length, and it writes it to the audit log
 *
 * ⭐ SO WHAT IS THIS FOR? SLOWING A HUMAN DOWN. The realistic failure in
 * this console is not an attacker. It is an operator with two hundred
 * near-identical rows on screen suspending the wrong customer at 17:55 on
 * a Friday. Typing the customer's own name is the cheapest known way to
 * make somebody look at which row they are on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY IT WRAPS `danger-dialog.tsx` INSTEAD OF REPLACING IT
 * ══════════════════════════════════════════════════════════════════════
 * `DangerDialog` already got the hard parts right — the typed value, the
 * justification with a minimum, the consequence list that states what
 * does NOT happen, the pending and error states. A second dialog beside
 * it is how the standard drifts: screen six ends up without the typed
 * check and nobody notices until the wrong workspace is suspended.
 *
 * This component adds exactly three things on top and nothing else:
 *
 *   1. THE TYPED VALUE IS THE OBJECT'S OWN NAME, case-insensitively and
 *      trimmed. `DangerDialog` compares strictly; the caller-supplied
 *      `confirmMatch` prop (added for this) relaxes it. Case-sensitivity
 *      catches no extra mistakes — it just trains operators to
 *      copy-paste, which defeats the guard entirely.
 *   2. `consequence` — ONE sentence, rendered prominently above the
 *      bullets. The bullets are the detail; this is the thing that must
 *      not be missed.
 *   3. A single vocabulary for the labels, so "Why are you doing this?"
 *      reads the same on every screen in the console.
 */

import { type ReactNode } from "react";
import { DangerDialog } from "./danger-dialog";

export type ConfirmDestructiveProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /**
   * 🔴 THE OBJECT'S OWN NAME — the workspace name, or its slug. Whatever
   * is on the row the operator is looking at, so typing it means reading
   * it. Never a generic word: "DELETE" is a reflex, "acme-constructions"
   * is a decision.
   *
   * Matched case-insensitively after trimming.
   */
  objectName: string;
  /** The kind of thing, for the prompts: "workspace", "user", "grant". */
  objectLabel?: string;

  /** The button. An imperative verb phrase: "Suspend workspace". */
  actionLabel: string;
  /** Defaults to the action label. */
  title?: string;
  /** One line under the title. Defaults to naming the object. */
  description?: string;

  /**
   * ⭐ THE ONE SENTENCE THAT MATTERS, rendered in the dialog's loudest
   * type. Say the effect on the CUSTOMER, in their terms: "Every user in
   * this workspace is signed out immediately and cannot sign back in."
   */
  consequence: string;
  /**
   * The rest of the truth, as bullets. ⚠️ Include what does NOT happen —
   * "no data is deleted", "the customer can still export" — because an
   * operator who does not know that cannot say it to the customer.
   */
  consequences?: readonly string[];

  /**
   * Minimum characters in the reason. Default 20.
   *
   * ⚠️ The reason is EVIDENCE, not ceremony: it is written verbatim into
   * the customer's own audit log and it is what somebody reads six months
   * later when the customer asks what happened. The minimum exists to
   * make "test" impossible, not to make the operator suffer. The server
   * enforces its own floor regardless of what is passed here.
   */
  minReasonLength?: number;
  reasonLabel?: string;

  pending?: boolean;
  error?: string | null;
  /** Extra fields, e.g. a duration picker for a timed suspension. */
  extra?: ReactNode;

  /**
   * Runs only once the name matches and the reason is long enough.
   *
   * 🔴 The handler must send the reason to the SERVER and let the server
   * decide. Do not treat "this dialog was satisfied" as authorisation.
   */
  onConfirm: (input: { reason: string }) => void;
};

/**
 * Case-insensitive, whitespace-trimmed comparison, with internal runs of
 * whitespace collapsed.
 *
 * ⚠️ The collapse is deliberate: a name pasted out of a table often
 * carries a double space or a non-breaking one, and an operator retyping
 * "Acme  Constructions" by hand and being refused learns to distrust the
 * dialog rather than to read it.
 */
function sameName(typed: string, expected: string): boolean {
  const normalise = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return normalise(typed) === normalise(expected);
}

export function ConfirmDestructive({
  open,
  onOpenChange,
  objectName,
  objectLabel = "workspace",
  actionLabel,
  title,
  description,
  consequence,
  consequences,
  minReasonLength = 20,
  reasonLabel = "Why are you doing this?",
  pending = false,
  error = null,
  extra,
  onConfirm,
}: ConfirmDestructiveProps) {
  return (
    <DangerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? actionLabel}
      description={
        description ??
        `This affects the ${objectLabel} “${objectName}”. Read the consequence below before you type its name.`
      }
      headline={consequence}
      /*
       * ⚠️ Never an empty list. A dialog whose consequence box is blank
       * reads as "nothing much happens", which is the opposite of what a
       * destructive confirmation is for.
       */
      consequences={
        consequences && consequences.length > 0
          ? [...consequences]
          : [
              "This is recorded against your name in the platform action register.",
              "Anything aimed at one workspace also appears in that customer’s own audit log.",
            ]
      }
      confirmValue={objectName}
      confirmMatch={sameName}
      confirmLabel={`Type the ${objectLabel} name to confirm: ${objectName}`}
      justificationLabel={reasonLabel}
      minJustification={minReasonLength}
      actionLabel={actionLabel}
      destructive
      pending={pending}
      error={error}
      extra={extra}
      /*
       * `DangerDialog` hands back both the typed value and the
       * justification. The typed value is dropped here on purpose: it has
       * already done its only job (making the operator look), and passing
       * it onward invites a caller to treat "the browser said the names
       * matched" as a check. The server compares against its own record.
       */
      onConfirm={({ justification }) => onConfirm({ reason: justification })}
    />
  );
}
