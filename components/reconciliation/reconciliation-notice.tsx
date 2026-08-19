/**
 * Ordence — ⭐⭐⭐ THE BREACH BANNER
 * Version: v1.46.0-alpha (Batch 49)
 *
 * One component for every gated report, because the rule this enforces
 * survives exactly as long as there is one place it is enforced. Two
 * banners is two places, and the second one is where somebody adds "just
 * show the total anyway, greyed out" for a demo.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE STATES, THREE VISUAL LANGUAGES, AND NONE OF THEM IS AMBER
 * ══════════════════════════════════════════════════════════════════════
 *   breached      RED. No figures anywhere on the card, or beside it.
 *   unconfigured  PLAIN. Figures shown, with "nothing has checked these"
 *                 in words. Deliberately not a warning colour and
 *                 deliberately not a tick.
 *   reconciled    QUIET. One line naming what it was checked against.
 *
 * ⚠️ AMBER IS THE COLOUR THAT KILLED THIS CLASS OF CHECK EVERYWHERE ELSE
 * IT HAS BEEN TRIED. It means "a number you can still use", and a
 * receivables total that disagrees with the books is not a number you
 * can still use — it is either the report or the books being wrong by a
 * knowable amount, and both cases need somebody to look before anybody
 * acts. There is no half-trusted state here, so there is no half-trusted
 * colour.
 *
 * ⚠️ AND THE RECONCILED STATE IS NOT A GREEN TICK EITHER. A tick invites
 * the reader to stop reading; the sentence naming the control account
 * tells them what was actually compared, which is the only thing that
 * makes the tick worth anything. It also keeps the unconfigured state
 * from looking like a *missing* tick, which would read as a fault in the
 * product rather than a gap in the workspace's setup.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SerializedReconciliation } from "@/lib/reconciliation/gate";

/**
 * ⚠️ MINOR UNITS IN, DISPLAY OUT, NEVER PARSED TO A NUMBER. The strings
 * that arrive here are `bigint` paise serialised across the RSC
 * boundary; `Number("420000000")` is fine today and silently wrong at
 * ₹90,07,19,92,54,740.99, which is a balance a real estate developer's
 * control account can reach.
 */
function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

export function ReconciliationNotice({
  reconciliation,
  breachCauses,
}: {
  reconciliation: SerializedReconciliation;
  /** Named, domain-specific reasons this particular check comes apart. */
  breachCauses?: readonly string[];
}) {
  if (reconciliation.state === "breached") {
    const failed = reconciliation.checks.filter((c) => c.breached);

    return (
      <Card className="border-red-400 dark:border-red-700">
        <CardHeader>
          <CardTitle className="text-red-700 dark:text-red-300">
            {reconciliation.subject} unavailable — it does not reconcile to the
            books
          </CardTitle>
          {/*
            🔴 SAYING THAT NO FIGURES ARE SHOWN, RATHER THAN LEAVING A
            BLANK SPACE. A card that simply omits the numbers reads as a
            loading failure, and the response to a loading failure is to
            refresh until it comes back — which, here, it will not.
          */}
          <p className="text-xs text-muted-foreground">
            No figures are shown on purpose. A receivables total that is nearly
            right is chased, lent against and filed exactly like one that is
            right.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-2 pl-5">
            {failed.map((check) => (
              <li key={check.id}>
                <span className="font-medium">{check.claim}</span>{" "}
                <span>{check.sentence}</span>
              </li>
            ))}
          </ul>

          {/*
            ⚠️ THE GAP IS SHOWN BECAUSE IT IS A DIAGNOSTIC, NOT A REPORT
            FIGURE. "Your books are out by ₹14,500.00" is a number
            somebody can search the day book for. It is the one amount on
            this card that is safe to print precisely because nobody can
            mistake it for the receivables position.
          */}
          {failed.some((c) => c.differenceMinor !== "0") && (
            <dl className="space-y-2 rounded-md border border-red-200 bg-red-50/60 p-3 text-xs dark:border-red-900 dark:bg-red-950/20">
              {failed
                .filter((c) => c.differenceMinor !== "0")
                .map((check) => (
                  <div key={check.id} className="space-y-0.5">
                    <dt className="font-medium">{check.reportLabel} vs {check.ledgerLabel}</dt>
                    <dd className="tabular-nums text-muted-foreground">
                      out by {inr(check.differenceMinor.replace(/^-/, ""))}
                    </dd>
                  </div>
                ))}
            </dl>
          )}

          {breachCauses && breachCauses.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What causes this
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {breachCauses.map((cause) => (
                  <li key={cause}>{cause}</li>
                ))}
              </ul>
            </div>
          )}

          {reconciliation.notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (reconciliation.state === "unconfigured") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            These figures have not been checked against the books
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          {/*
            🔴 "NOT CHECKED" IS NOT "CHECKED AND FINE", AND IT IS NOT
            "CHECKED AND WRONG". Both of those have their own state. This
            one says only that no second opinion exists yet, which on a
            workspace where nothing is mapped is the literal truth — and
            saying it plainly is the whole of design point ④: zero equals
            zero is an unconfigured workspace, not a passing check.
          */}
          {reconciliation.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {reconciliation.checks.map((check) => (
        <p key={check.id}>
          Checked: {check.reportLabel} agrees with {check.ledgerLabel} to the
          paisa.
        </p>
      ))}
      {reconciliation.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}
