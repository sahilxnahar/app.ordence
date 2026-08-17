"use client";

/**
 * Ordence — "Choose your address" (self-serve signup, step 1)
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE CONTINUE BUTTON BEING ENABLED IS NOT PERMISSION.
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * Everything in this file is a MISTAKE GUARD. It stops a typo becoming a
 * support ticket and it makes the form pleasant. An enabled button means
 * "nobody held this name a moment ago", never "this name is yours". The
 * claim path re-checks INSIDE the transaction that inserts the row and
 * maps the SQLSTATE with `rejectionFromPgError()`; it may still refuse,
 * and when it does the refusal arrives here as `serverRejection` and this
 * component renders it. Two people typing `acme` at the same second are
 * BOTH told yes by `/api/public/slug-available`, because that endpoint
 * answers a question, it does not take a lock.
 *
 * 🔴 NOBODY MAY LATER "OPTIMISE" THE CLAIM BY TRUSTING THE GREEN TICK ON
 *    THIS SCREEN. There is no reservation here to trust. The full
 *    argument lives at the top of `app/api/public/slug-available/
 *    _availability.ts` and in `lib/slug.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE `.ordence.com` SUFFIX IS PAINTED INTO THE FIELD AND CANNOT
 *    BE TYPED INTO
 * ══════════════════════════════════════════════════════════════════════
 * The wildcard certificate `*.ordence.com` covers exactly ONE label.
 * `acme.ordence.com` is covered; `acme.corp.ordence.com` is not, and a
 * paying customer would meet a full-page certificate warning with no way
 * to understand why, on the first URL they ever received from us. So the
 * user never types a dot: the suffix is fixed furniture inside the box,
 * and any dot that arrives by paste is removed and explained.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY COLOUR IS NEVER THE SIGNAL
 * ══════════════════════════════════════════════════════════════════════
 * Roughly one man in twelve in India cannot separate the red ring from
 * the green one, and the person most likely to be filling this in is a
 * site engineer holding a phone in direct sun where every ring washes out
 * anyway. So each of the four states carries a WORD and a distinctly
 * SHAPED icon (globe / spinner / tick / cross / triangle). Colour is
 * decoration on top of an already-complete signal, never the signal.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FOUR STATES, AND WHERE 429 / 503 LIVE
 * ══════════════════════════════════════════════════════════════════════
 *   idle       nothing has been checked
 *   checking   a check is outstanding (or debouncing) for THIS text
 *   available  the last complete answer for THIS text was yes
 *   blocked    the last complete answer for THIS text was anything else
 *
 * 429 and 503 are `blocked`, not a fifth state and — 🔴 emphatically —
 * not `available`. "We could not check" and "we checked and the answer is
 * no" read differently to the user (different word, different icon,
 * different `aria-invalid`) but they agree on the only thing that matters
 * to the button: we do not have a yes.
 */

import * as React from "react";
import { AlertTriangle, Check, Globe, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  checkSlugShape,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  type SlugRejection,
  type SlugRejectionCode,
} from "@/lib/slug";

/* ------------------------------------------------------------------ */
/* THE WIRE SHAPE                                                      */
/* ------------------------------------------------------------------ */

/**
 * 🔴 DECLARED HERE RATHER THAN IMPORTED FROM `_availability.ts`, AND THAT
 *    IS NOT DUPLICATION BY ACCIDENT. That module opens with
 *    `import "server-only"`, and a `"use client"` file importing it — even
 *    for a type, even though the type erases — is the exact fault
 *    `scripts/check-server-boundaries.mjs` exists to catch and the one
 *    that turned the v0.83.0 Railway build red.
 *
 * ⚠️ IF THE ENDPOINT'S SHAPE CHANGES THIS GOES STALE SILENTLY. That is
 *    why nothing below trusts the shape: every field is checked at
 *    runtime before it is used, because this is parsing a network
 *    response, not reading a local object.
 */
type AvailabilityBody = {
  available?: unknown;
  reason?: { code?: unknown; message?: unknown };
  suggestions?: unknown;
};

/**
 * What the claim path hands back when the INSERT lost the race.
 *
 * `claimSlug()` in `server/platform/claim-slug.ts` returns
 * `{ ok: false, rejection: SlugRejection }`. The caller maps it to this by
 * taking `rejection.code`, `rejection.publicMessage` — 🔴 never
 * `operatorMessage` — and the slug it passed in.
 */
export type ClaimRejection = {
  /**
   * ⭐ THE SLUG THE SERVER ACTUALLY REFUSED, AND IT IS REQUIRED.
   *
   * Without it this banner would keep accusing whatever is in the box —
   * including a different name the user typed afterwards, which the
   * server has never seen and may well be free. Carrying the subject of
   * the refusal with the refusal is what makes it impossible to point at
   * the wrong name.
   */
  slug: string;
  code: SlugRejectionCode;
  /**
   * ⚠️ ALWAYS `publicMessage`, NEVER `operatorMessage`. The operator
   * string may name the workspace that collided; naming it on a public
   * form turns signup into a lookup tool for near-miss names, which is
   * reconnaissance for the phishing attack the confusable fold exists to
   * prevent. The split is made in `lib/slug.ts`; this component's only
   * job is not to undo it.
   */
  message: string;
  /** Re-checked by the claim path at the moment of refusal. Still advisory. */
  suggestions?: string[];
};

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

const SUFFIX = ".ordence.com";
const ENDPOINT = "/api/public/slug-available";

/**
 * 400ms. Long enough that a normal typist produces one request for a
 * whole word rather than one per letter — which matters because the
 * endpoint allows 10 checks a minute per source network, and a
 * per-keystroke form burns that in two seconds and then shows a rate
 * limit to somebody who did nothing wrong.
 */
const DEBOUNCE_MS = 400;

/** Used only when a 429 arrives without a parseable `Retry-After`. */
const FALLBACK_RETRY_SECONDS = 30;

/* ------------------------------------------------------------------ */
/* STATE                                                               */
/* ------------------------------------------------------------------ */

/**
 * Why we cannot say yes. Kept separate from the message text because the
 * throttle message contains a live countdown and must therefore be
 * composed at render time, not frozen into state when the 429 landed.
 */
type Blocker =
  /** `checkSlugShape()` refused locally. No request was ever made. */
  | { source: "shape"; rejection: SlugRejection }
  /** The endpoint answered `available: false` with a public reason. */
  | { source: "server"; message: string; suggestions: string[] }
  /** 429. Checking is suspended until the countdown reaches zero. */
  | { source: "throttled" }
  /** 503, or any answer we could not make sense of. NOT a no, and NOT a yes. */
  | { source: "unreachable" }
  /** fetch() itself failed — no network, DNS, captive portal on site. */
  | { source: "offline" }
  /** The claim path refused inside its transaction. The authoritative no. */
  | { source: "claim"; rejection: ClaimRejection };

/**
 * ⚠️ EVERY VERDICT CARRIES THE EXACT TEXT IT IS ABOUT.
 *
 * A verdict without its subject is a verdict that can be shown next to a
 * different name. See `liveVerdict()` below: the render compares
 * `verdict.slug` with what is in the box and refuses to display anything
 * that does not match, which is what makes a stale frame impossible even
 * for the one paint between a keystroke and the effect that reacts to it.
 */
type Verdict =
  | { kind: "idle"; slug: string }
  | { kind: "checking"; slug: string }
  | { kind: "available"; slug: string }
  | { kind: "blocked"; slug: string; blocker: Blocker };

/* ------------------------------------------------------------------ */
/* INPUT SANITISING                                                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE DOT IS THE ONE CHARACTER WE REMOVE RATHER THAN COMPLAIN ABOUT.
 *
 * Every other illegal character gets an honest message out of
 * `checkSlugShape()` and the user fixes it. A dot is different in kind:
 * `acme.corp` is not a typo, it is somebody reasonably assuming
 * subdomains nest. They do not — the wildcard certificate covers one
 * label — so we take it out and say so in one line, rather than leaving
 * them to guess which of their characters we hated.
 *
 * Capitals are folded silently: `tenants_slug_lowercase` means the
 * database only ever holds lowercase, and refusing the shift key while
 * somebody types their own company name is hostility, not validation.
 */
function sanitise(raw: string): { value: string; removedDot: boolean } {
  const lowered = raw.toLowerCase();
  const value = lowered.replace(/\./g, "");
  return { value, removedDot: value !== lowered };
}

/* ------------------------------------------------------------------ */
/* PRESENTATION OF A VERDICT                                           */
/* ------------------------------------------------------------------ */

type Presentation = {
  /** 🔴 The word. Never remove it in favour of a colour. */
  word: string;
  detail: string | null;
  icon: React.ReactNode;
  tone: "neutral" | "busy" | "good" | "bad";
  /**
   * ⚠️ FALSE FOR "we could not check". `aria-invalid` is a claim that the
   * value is wrong. A 503 says nothing about the value, and telling a
   * screen reader the field is invalid because our database blinked is a
   * lie told with extra confidence.
   */
  invalid: boolean;
  suggestions: string[];
};

const ICON_CLASS = "h-4 w-4 shrink-0";

function present(verdict: Verdict, retrySeconds: number | null): Presentation {
  switch (verdict.kind) {
    case "idle":
      return {
        word: "Not checked",
        detail: "Type the name you want and we will check it.",
        icon: <Globe className={ICON_CLASS} aria-hidden="true" />,
        tone: "neutral",
        invalid: false,
        suggestions: [],
      };

    case "checking":
      return {
        word: "Checking",
        detail: `${verdict.slug}${SUFFIX}`,
        icon: <Loader2 className={cn(ICON_CLASS, "animate-spin")} aria-hidden="true" />,
        tone: "busy",
        invalid: false,
        suggestions: [],
      };

    case "available":
      return {
        word: "Available",
        /**
         * ⭐ THE SECOND SENTENCE IS THE PRODUCT BEING HONEST ABOUT ITS OWN
         *    RACE. "Yours" would be a promise this screen cannot keep, and
         *    the user who reads "not held until you finish" is not
         *    surprised by `serverRejection` thirty seconds later.
         */
        detail: `${verdict.slug}${SUFFIX} — nobody holds it right now. It is not held for you until you finish.`,
        icon: <Check className={ICON_CLASS} aria-hidden="true" />,
        tone: "good",
        invalid: false,
        suggestions: [],
      };

    case "blocked":
      break;
  }

  const blocker = verdict.blocker;
  switch (blocker.source) {
    case "shape":
      return {
        word: "Not allowed",
        detail: blocker.rejection.publicMessage,
        icon: <X className={ICON_CLASS} aria-hidden="true" />,
        tone: "bad",
        invalid: true,
        suggestions: [],
      };

    case "server":
      return {
        word: "Not available",
        detail: blocker.message,
        icon: <X className={ICON_CLASS} aria-hidden="true" />,
        tone: "bad",
        invalid: true,
        suggestions: blocker.suggestions,
      };

    case "claim":
      return {
        word: "Not available",
        detail: blocker.rejection.message,
        icon: <X className={ICON_CLASS} aria-hidden="true" />,
        tone: "bad",
        invalid: true,
        suggestions: blocker.rejection.suggestions ?? [],
      };

    case "throttled": {
      const seconds = Math.max(1, retrySeconds ?? FALLBACK_RETRY_SECONDS);
      return {
        word: "Too many checks",
        detail: `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
        icon: <AlertTriangle className={ICON_CLASS} aria-hidden="true" />,
        tone: "neutral",
        invalid: false,
        suggestions: [],
      };
    }

    case "unreachable":
      /**
       * 🔴 THE WORD IS "CANNOT CHECK", NOT "AVAILABLE" AND NOT "TAKEN".
       *    The endpoint returns 503 with `available: false` and NO reason
       *    code precisely so that "we could not check" stays
       *    distinguishable from "we checked and the answer is no". Showing
       *    this as available would teach the form to say yes exactly when
       *    it knows least.
       */
      return {
        word: "Cannot check",
        detail: "We could not check this address right now. Try again in a moment.",
        icon: <AlertTriangle className={ICON_CLASS} aria-hidden="true" />,
        tone: "neutral",
        invalid: false,
        suggestions: [],
      };

    case "offline":
      return {
        word: "Cannot check",
        detail: "No connection. Check your mobile data or Wi-Fi and try again.",
        icon: <AlertTriangle className={ICON_CLASS} aria-hidden="true" />,
        tone: "neutral",
        invalid: false,
        suggestions: [],
      };
  }
}

const TONE_TEXT: Record<Presentation["tone"], string> = {
  neutral: "text-foreground",
  busy: "text-muted-foreground",
  good: "text-primary",
  bad: "text-destructive",
};

const TONE_BORDER: Record<Presentation["tone"], string> = {
  neutral: "border-input",
  busy: "border-input",
  good: "border-primary",
  bad: "border-destructive",
};

/* ------------------------------------------------------------------ */
/* THE COMPONENT                                                       */
/* ------------------------------------------------------------------ */

export type ClaimSubdomainProps = {
  /** Prefilled name, e.g. carried over from a marketing form. */
  initialValue?: string;
  /**
   * The refusal from the claim path, when submit lost the race. See
   * `ClaimRejection`: it carries the slug it is about so it can never be
   * shown against a different name.
   */
  serverRejection?: ClaimRejection | null;
  /** Called with the trimmed slug when the user continues. */
  onContinue?: (slug: string) => void;
  /** True while the parent's claim is in flight. */
  busy?: boolean;
  continueLabel?: string;
  className?: string;
};

export function ClaimSubdomain({
  initialValue = "",
  serverRejection = null,
  onContinue,
  busy = false,
  continueLabel = "Continue",
  className,
}: ClaimSubdomainProps) {
  const fieldId = React.useId();
  const hintId = `${fieldId}-hint`;
  const statusId = `${fieldId}-status`;
  const dotId = `${fieldId}-dot`;
  const suggestionsId = `${fieldId}-suggestions`;

  const [value, setValue] = React.useState(() => sanitise(initialValue).value);
  const [verdict, setVerdict] = React.useState<Verdict>({ kind: "idle", slug: "" });
  const [dotRemoved, setDotRemoved] = React.useState(false);

  /**
   * Seconds left on a 429. `null` means not throttled. Held as a live
   * countdown rather than a deadline so the sentence on screen updates
   * without a second timer feeding a re-render.
   */
  const [retrySeconds, setRetrySeconds] = React.useState<number | null>(null);
  const throttled = retrySeconds !== null;

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE SEQUENCE NUMBER. THIS IS HOW OUT-OF-ORDER ANSWERS DIE.
   * ══════════════════════════════════════════════════════════════════
   * The classic bug on this screen: the user types `acme`, then adds an
   * `x`. Two requests are outstanding. `acmex` is answered fast ("taken")
   * and `acme` is answered slowly ("free"), the slow one lands LAST, and
   * the form cheerfully shows a green tick for a name the user is not
   * typing and which is not what was checked.
   *
   * ⚠️ AbortController ALONE DOES NOT FIX IT, and believing it does is
   *    why this bug survives code review. `abort()` is a request to stop;
   *    a response whose body has already been read, or which resolves in
   *    the same tick the abort is issued, still runs its `.then`. Aborting
   *    saves bandwidth and a socket. It does not order anything.
   *
   * ⭐ SO: a counter that increases on EVERY value change — whether or
   *    not that change starts a request. Each attempt captures its number
   *    and every single state write it performs is guarded by
   *    `seq === latestSeqRef.current`. A late answer belongs to a
   *    superseded number and writes nothing. There is no path where a
   *    stale answer wins, because winning requires being the newest, not
   *    being the last to arrive.
   */
  const latestSeqRef = React.useRef(0);

  /* ---------------------------------------------------------------- */
  /* THE CHECK                                                         */
  /* ---------------------------------------------------------------- */

  React.useEffect(() => {
    /** Everything outstanding is now superseded, whatever we do next. */
    const seq = (latestSeqRef.current += 1);
    const isCurrent = () => seq === latestSeqRef.current;

    if (value.length === 0) {
      setVerdict({ kind: "idle", slug: "" });
      return;
    }

    /**
     * ⭐ SHAPE FIRST, LOCALLY, WITH NO NETWORK CALL AT ALL.
     *
     * `checkSlugShape()` is the same function the resolver, the operator
     * console and the endpoint use — not a second reading of the same
     * rules, which is exactly the drift that once let provisioning mint
     * names `lib/tenant.ts` refused to resolve. "ac" is not a rejected
     * name, it is an unfinished one; answering it instantly and for free
     * also means a half-typed word never spends one of the ten checks a
     * minute this caller is allowed.
     */
    const shape = checkSlugShape(value);
    if (shape) {
      setVerdict({ kind: "blocked", slug: value, blocker: { source: "shape", rejection: shape } });
      return;
    }

    /**
     * Rate limited: do not fetch, and say so. The countdown effect below
     * flips `throttled` back to false, which re-runs this effect and
     * resumes checking on its own — the user does not have to poke it.
     */
    if (throttled) {
      setVerdict({ kind: "blocked", slug: value, blocker: { source: "throttled" } });
      return;
    }

    /**
     * Shape is valid and nothing is known yet, so the honest state while
     * the debounce runs is `checking`, not the previous verdict. This is
     * the first half of "never show a stale verdict"; `liveVerdict()` is
     * the second half and covers the frame before this effect runs.
     */
    setVerdict({ kind: "checking", slug: value });

    const controller = new AbortController();

    const timer = setTimeout(() => {
      void (async () => {
        try {
          /**
           * 🔴 POST WITH THE SLUG IN THE BODY. NEVER A QUERY STRING.
           *    `?slug=acme-corp` lands in the access log of every hop, in
           *    the `Referer` of whatever loads next, in browser history
           *    and in any CDN sampling URLs — a record, in systems never
           *    scoped for it, of a name somebody typed while deciding
           *    whether to become a customer. The route documents the same
           *    rule from its side.
           */
          const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ slug: value.trim() }),
            signal: controller.signal,
            cache: "no-store",
          });

          if (!isCurrent()) return;

          /* ---- 429: stop checking until the window reopens ---------- */
          if (response.status === 429) {
            const header = Number(response.headers.get("retry-after"));
            const seconds =
              Number.isFinite(header) && header > 0
                ? Math.min(Math.ceil(header), 300)
                : FALLBACK_RETRY_SECONDS;
            setRetrySeconds(seconds);
            setVerdict({ kind: "blocked", slug: value, blocker: { source: "throttled" } });
            return;
          }

          /* ---- 503 and every other refusal: we do not have a yes ---- */
          if (!response.ok) {
            setVerdict({ kind: "blocked", slug: value, blocker: { source: "unreachable" } });
            return;
          }

          const body = (await response.json()) as AvailabilityBody;
          if (!isCurrent()) return;

          if (body.available === true) {
            setVerdict({ kind: "available", slug: value });
            return;
          }

          const message =
            typeof body.reason?.message === "string" && body.reason.message.length > 0
              ? body.reason.message
              : null;

          /**
           * ⚠️ `available: false` WITH NO REASON IS NOT A "NO".
           *
           * The endpoint omits the reason code deliberately when it could
           * not reach the database, so the absence of a reason is how
           * "could not check" stays distinguishable from "checked, and
           * no". Inventing a refusal message here would erase that
           * distinction on the only screen that reads it.
           */
          if (!message) {
            setVerdict({ kind: "blocked", slug: value, blocker: { source: "unreachable" } });
            return;
          }

          const suggestions = Array.isArray(body.suggestions)
            ? body.suggestions.filter((s): s is string => typeof s === "string")
            : [];

          setVerdict({
            kind: "blocked",
            slug: value,
            blocker: { source: "server", message, suggestions },
          });
        } catch {
          /**
           * An abort lands here too. The sequence guard already makes it
           * harmless, and the `isCurrent()` test keeps a cancelled
           * request from painting an offline warning over the answer for
           * the text the user is now typing.
           */
          if (!isCurrent()) return;
          setVerdict({ kind: "blocked", slug: value, blocker: { source: "offline" } });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Bandwidth and sockets, not ordering. Ordering is `latestSeqRef`.
      controller.abort();
    };
  }, [value, throttled]);

  /* ---------------------------------------------------------------- */
  /* THE 429 COUNTDOWN                                                 */
  /* ---------------------------------------------------------------- */

  React.useEffect(() => {
    if (retrySeconds === null) return;
    if (retrySeconds <= 0) {
      setRetrySeconds(null);
      return;
    }
    const tick = setTimeout(() => {
      setRetrySeconds((current) => (current === null ? null : current - 1));
    }, 1000);
    return () => clearTimeout(tick);
  }, [retrySeconds]);

  /* ---------------------------------------------------------------- */
  /* WHAT IS ACTUALLY SHOWN                                            */
  /* ---------------------------------------------------------------- */

  /**
   * ⭐ THE SECOND HALF OF THE ANTI-STALE GUARANTEE.
   *
   * Effects run after paint, so between the keystroke that changes
   * `value` and the effect that reacts to it there is one frame where
   * `verdict` still describes the PREVIOUS text. Comparing the verdict's
   * own `slug` against what is in the box removes that frame entirely: a
   * verdict about other text is not rendered at all, it is rendered as
   * `checking`, which is the truth.
   */
  const liveVerdict: Verdict =
    value.length === 0
      ? { kind: "idle", slug: "" }
      : verdict.slug === value
        ? verdict
        : { kind: "checking", slug: value };

  /**
   * 🔴 THE CLAIM PATH'S ANSWER OUTRANKS OURS. It ran inside the
   *    transaction; we ran a prediction. While the box still holds the
   *    name it refused, that refusal is what the field says — otherwise
   *    the user reads "Available" directly above "already in use", and
   *    believes whichever one they prefer.
   */
  const claimBlock =
    serverRejection !== null && serverRejection.slug === value.trim().toLowerCase()
      ? serverRejection
      : null;

  const shown: Verdict = claimBlock
    ? { kind: "blocked", slug: value, blocker: { source: "claim", rejection: claimBlock } }
    : liveVerdict;

  const view = present(shown, retrySeconds);

  /**
   * 🔴 A MISTAKE GUARD, NOT A GATE. Disabling the button stops somebody
   *    submitting a name we already know is taken; it does not, and
   *    cannot, make an enabled button mean the name is theirs. The server
   *    re-checks inside the transaction and can still refuse — that is
   *    what `serverRejection` is for. If this line is ever deleted the
   *    product still has to be correct.
   */
  const canContinue = shown.kind === "available" && !busy;

  const describedBy = [hintId, statusId, dotRemoved ? dotId : null]
    .filter((id): id is string => id !== null)
    .join(" ");

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const { value: next, removedDot } = sanitise(event.target.value);
    // Sticky until the field is emptied: a notice that vanishes on the
    // next keystroke is a notice nobody outdoors ever finishes reading.
    setDotRemoved((was) => (next.length === 0 ? false : was || removedDot));
    setValue(next);
  }

  function pickSuggestion(candidate: string) {
    setDotRemoved(false);
    setValue(candidate);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canContinue) return;
    onContinue?.(value.trim());
  }

  return (
    <form onSubmit={handleSubmit} className={cn("w-full max-w-md space-y-3", className)} noValidate>
      <Label htmlFor={fieldId} required>
        Your workspace address
      </Label>

      {/*
        ⚠️ THE BOX IS THE FIELD, THE INPUT IS ONLY PART OF IT. The border,
        the focus ring and the state colour live on this wrapper so that
        the fixed suffix sits INSIDE the same visual control the user is
        typing into. Two adjacent boxes would read as two fields and
        invite somebody to type the dot themselves.
      */}
      <div
        className={cn(
          "flex items-stretch overflow-hidden rounded-md border bg-background shadow-sm transition-colors",
          "focus-within:ring-2 focus-within:ring-ring",
          TONE_BORDER[view.tone],
        )}
      >
        <input
          id={fieldId}
          name="slug"
          value={value}
          onChange={handleChange}
          aria-describedby={describedBy}
          aria-invalid={view.invalid}
          /*
           * ⚠️ THE FOUR KEYBOARD ATTRIBUTES ARE NOT DECORATION. An Android
           * keyboard capitalises the first letter of a field by default
           * and iOS autocorrects `acme` into a word it prefers. Both
           * produce a value the user did not type and cannot see the
           * problem with. `sanitise()` folds the capital anyway; not
           * fighting the user for it is better.
           */
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          placeholder="your-company"
          /*
           * ⚠️ NO `maxLength`. A pasted 80-character name would be
           * silently truncated to something the user never chose and
           * cannot see the end of; `checkSlugShape()` says "At most 63
           * characters" instead, which is a fact they can act on.
           *
           * `text-base` below 640px: anything under 16px makes iOS Safari
           * zoom the page on focus, and the site engineer then has to
           * pinch back out to find the Continue button.
           */
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        />

        {/* The state icon sits in the field itself, where a thumb is
            already looking. The word lives in the status line below. */}
        <span className={cn("flex items-center pr-2", TONE_TEXT[view.tone])}>{view.icon}</span>

        {/*
          🔴 FIXED FURNITURE. Not an input, not editable, not removable —
          the wildcard certificate covers exactly one label, so the user
          must never be able to put a dot in front of this.
          `aria-hidden` because the same fact is stated in the hint below,
          which IS wired to the field through aria-describedby; without
          that it would be read as loose text with no relationship to
          anything.
        */}
        <span
          aria-hidden="true"
          className="flex select-none items-center border-l border-input bg-muted px-2 text-sm text-muted-foreground"
        >
          {SUFFIX}
        </span>
      </div>

      <p id={hintId} className="text-xs text-muted-foreground">
        {SLUG_MIN_LENGTH}–{SLUG_MAX_LENGTH} characters. Lowercase letters, numbers and hyphens.
        We add {SUFFIX} for you.
      </p>

      {dotRemoved && (
        <p id={dotId} aria-live="polite" className="text-xs font-medium text-foreground">
          Dots removed — an address can have only one part before {SUFFIX}.
        </p>
      )}

      {/*
        🔴 THE ONE STATUS LINE, AND IT IS `aria-live="polite"`.
        Polite, not assertive: this text changes on a debounce while the
        user is still typing, and an assertive region would interrupt the
        screen reader mid-word on every keystroke. The WORD is first and
        the icon is decoration, so the line is complete when read aloud,
        when rendered in monochrome, and in sunlight.
      */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn("flex items-start gap-2 text-sm", TONE_TEXT[view.tone])}
      >
        <span className="mt-0.5">{view.icon}</span>
        <span className="min-w-0">
          <span className="font-semibold">{view.word}</span>
          {view.detail && <span className="text-muted-foreground"> — {view.detail}</span>}
        </span>
      </p>

      {view.suggestions.length > 0 && (
        <div className="space-y-2">
          <p id={suggestionsId} className="text-xs font-medium">
            Try one of these instead:
          </p>
          {/*
            ⚠️ THESE WERE CHECKED AGAINST THE DATABASE BEFORE THEY WERE
            OFFERED (`verifiedSuggestions()` on the server) — and they are
            STILL advisory, like everything else on this screen. Offering
            an unchecked suggestion is worse than offering none: the user
            clicks the name we proposed and we refuse it, on the one
            screen where they most need to believe our answers.

            `min-h-11` is 44px: the smallest target a thumb reliably hits
            on a phone held at arm's length on a site, which is where this
            form is actually being filled in.
          */}
          <ul aria-labelledby={suggestionsId} className="flex flex-wrap gap-2">
            {view.suggestions.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  onClick={() => pickSuggestion(candidate)}
                  className="inline-flex min-h-11 items-center rounded-md border border-input bg-background px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium">{candidate}</span>
                  <span className="text-muted-foreground">{SUFFIX}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {claimBlock && (
        /*
          ⭐ THE RACE, EXPLAINED IN THE ONE PLACE IT CAN ACTUALLY HAPPEN.
          The user saw a green tick and then a refusal. Without this
          sentence that reads as the form lying to them; with it, it reads
          as somebody else being three seconds faster, which is both true
          and forgivable. The status line above already carries the
          refusal itself, so this block does not repeat it.
        */
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Someone claimed <span className="font-semibold">{claimBlock.slug}{SUFFIX}</span> while you
          were signing up. Nothing else you entered was lost — pick another address and continue.
        </div>
      )}

      <Button type="submit" disabled={!canContinue} className="min-h-11 w-full sm:w-auto">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy ? "Creating your workspace…" : continueLabel}
      </Button>
    </form>
  );
}

export default ClaimSubdomain;
