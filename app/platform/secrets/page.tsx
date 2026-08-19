/**
 * Ordence — Platform Console · ⭐⭐⭐ SECRET ROTATION
 * Version: v1.52.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHICH SECRET IS HOW OLD, AND WHEN IT WAS LAST ROTATED
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in Ordence answered that. `/api/diag` answered "is it set",
 * `lib/env-boot.ts` answered "will it boot", and the age of a credential
 * — the one fact that decides whether to do anything about it — lived in
 * whoever's memory last touched Railway.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND IT ANSWERS THAT WITHOUT SHOWING A SINGLE CHARACTER OF ANYTHING
 * ══════════════════════════════════════════════════════════════════════
 * Name, presence, category, age band, consequence-if-absent, who recorded
 * the last rotation. No value, no prefix, no suffix, no masked form with
 * the last four showing, and no length. The length is the one worth
 * naming again: `/api/diag` published `{ present, length }` for
 * forty-seven names including `CLERK_SECRET_KEY`, unauthenticated, and
 * defended it by saying a length is not a value. A length is a
 * truncated-paste oracle and a fingerprint of the key format. It was
 * removed there and it is not coming back here, "for operators" or
 * otherwise — this console is one XSS away from being anybody.
 *
 * ⚠️ THE NAMES ARE NOT TYPED ON THIS PAGE. They are the union of
 * `BOOT_REQUIRED`, `BOOT_ADVISORY` and the diagnostic's own category
 * table, computed in `lib/platform/secret-catalog.ts`. A fourth
 * hand-maintained list is the defect that produced migration 0091.
 */

import {
  getSecretRotationBoard,
  recordSecretRotation,
  SECRET_CATALOG,
} from "@/server/platform/secrets";
import { SecretRotationBoard } from "@/components/platform/secret-rotation-board";
import { onConsoleHost } from "@/lib/platform/console-href";
import {
  AGEING_MAX_DAYS,
  FRESH_MAX_DAYS,
  SECRET_BANDS,
} from "@/lib/platform/secret-board";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * 🔴 ONE HOP TO THE GUARD. This inline action hands its input straight to
 * `recordSecretRotation`, whose first line is
 * `requireCapability("staff:manage")`. No validation, no branching and no
 * database access on this side of that call — `"use server"` publishes
 * every export in the file it appears in, so the guard must be reachable
 * in one step from the boundary.
 */
async function recordRotation(input: { name: string; reason: string; rotatedOn: string }) {
  "use server";
  const result = await recordSecretRotation(input);
  return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
}

export default async function SecretRotationPage() {
  const [board, isConsole] = await Promise.all([getSecretRotationBoard(), onConsoleHost()]);

  if (!board.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{board.error}</CardContent>
      </Card>
    );
  }

  const neverRecorded = board.data.rows.filter((r) => r.bandKey === "never-recorded").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Secret rotation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every setting this product reads, how old its last <em>recorded</em> rotation is,
          and what breaks while it is absent. This screen shows no value, no part of a value
          and no character count — only whether each name is visible to the running process.
        </p>
      </div>

      <SecretRotationBoard
        rows={board.data.rows}
        isConsoleHost={isConsole}
        onRecordRotation={recordRotation}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Where the age comes from, and why {neverRecorded} of {board.data.rows.length} say
            &ldquo;never recorded&rdquo;
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            There is no rotation table in this product and this screen did not create one.
            The age of a secret is read from the{" "}
            <strong className="text-foreground">action register</strong> — a rotation is a
            row somebody wrote there, carrying the name, the actor, the day and the reason.
          </p>
          <p>
            <strong className="text-foreground">
              Where no row exists, the board says &ldquo;never recorded&rdquo; and shows no
              number.
            </strong>{" "}
            That is not the same statement as &ldquo;never rotated&rdquo;, and the difference
            matters: the values are changed in Railway by a human, and nothing in this
            product observes that happening. A board that printed a date it had invented, or
            a green tick over a key nobody has touched in two years, would be worse than an
            empty one.
          </p>
          <p className="border-t pt-2">
            The bands, in words —{" "}
            {(["fresh", "ageing", "overdue", "never-recorded"] as const).map((key, i) => (
              <span key={key}>
                {i === 0 ? "" : "; "}
                <strong className="text-foreground">{SECRET_BANDS[key].word}</strong>:{" "}
                {SECRET_BANDS[key].meaning}
              </span>
            ))}
            . The thresholds are {FRESH_MAX_DAYS} and {AGEING_MAX_DAYS} days. The colour
            behind each word is decoration: about one man in twelve here cannot separate the
            amber from the red, so the word is what the row is actually saying.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">This console cannot rotate anything</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Recording a rotation writes a sentence,
            not a key.</strong>{" "}
            The values live in Railway&apos;s variables and are changed there by a person.
            This screen can neither read one nor write one, and there is deliberately no code
            path from here that could — so the correct order is always: rotate it in Railway,
            confirm the deployment came back up, then record it here.
          </p>
          <p>
            The {board.data.rows.length} names above are the union of the boot assertion&apos;s
            required list, its advisory list, and the categories{" "}
            <code className="text-foreground">/api/diag</code> reports — {SECRET_CATALOG.length}{" "}
            entries, computed rather than typed, so a name added to any of those lists appears
            here without anybody remembering to add it.
          </p>
          <p>
            {board.data.recordedCount} rotation records exist in the register in total. Older
            ones are not overwritten when a newer one arrives; the register is append-only and
            the board simply reads the most recent statement per name.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
