import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE SECRET ROTATION BOARD, SERVER HALF
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS MODULE CANNOT READ OR WRITE A SECRET'S VALUE, BY CONSTRUCTION
 * ══════════════════════════════════════════════════════════════════════
 * The values live in Railway and are changed there by a human. Nothing
 * here touches one:
 *
 *   • the READ asks `buildSecretBoard()` one question per name — is it
 *     set to a non-empty string — and gets a boolean back. No length, no
 *     prefix, no hash, no masked form. See the header of
 *     `lib/platform/secret-board.ts` for why a character count was the
 *     thing worth removing from `/api/diag`.
 *   • the WRITE records the FACT of a rotation in the action register. It
 *     has no field for a value and no code path to Railway. An operator
 *     who fills this form has not rotated anything; they have written
 *     down that they did.
 *
 * ⚠️ THAT DISTINCTION IS PRINTED ON THE SCREEN, not merely commented
 * here. An operator who believes the console rotated the key is an
 * operator who will not go and rotate the key.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHERE "LAST ROTATED" COMES FROM, AND WHAT IT SAYS WHEN IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * There is no rotation table and this batch was forbidden to create one,
 * which turned out to be the right constraint: `platform_action_log` is
 * already the append-only register of what platform staff did, it already
 * carries actor, time, justification and severity, and it is already
 * readable by every grade. A rotation is exactly such an act.
 *
 * So a rotation is a row with `resource_type = 'platform_secret'` and
 * `resource_id = <THE NAME>`, and the board's history is a read of that
 * table. Where there is no row the board says NEVER RECORDED — never a
 * date, never a number, never a green tick. A board that implies a secret
 * was rotated is worse than an empty one.
 */

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope } from "@/db";
import { platformActionLog } from "@/db/schema/platform";
import {
  buildSecretBoard,
  isCataloguedSecret,
  SECRET_CATALOG,
  type RecordedRotation,
} from "@/lib/platform/secret-catalog";
import type { SecretBoardRow } from "@/lib/platform/secret-board";
import type { PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";

/**
 * 🔴 THE JOIN KEY BETWEEN THE WRITE AND THE READ. Both sides import this
 * constant; a literal typed twice is a rotation recorded into a register
 * the board does not look at, which reads on screen as "never recorded"
 * forever.
 */
export const SECRET_ROTATION_RESOURCE = "platform_secret";

/**
 * How many register rows to consider. Rotations are rare — a handful per
 * name per year across ~60 names — so this is generous. Bounded anyway,
 * because an unbounded read of an append-only table is a page that gets
 * slower every month until somebody stops opening it.
 */
const ROTATION_SCAN_LIMIT = 1000;

export type SecretBoard = {
  readonly rows: readonly SecretBoardRow[];
  /** How many rotations the register knows about at all. */
  readonly recordedCount: number;
  readonly generatedAt: string;
};

/**
 * ⚠️ `staff:read` — the grade that may see who holds platform access may
 * see which platform secrets are set and how old their rotations are.
 * Both are answers about US, not about a customer, and both are the kind
 * of thing peer visibility improves. Nothing here is customer data, and
 * nothing here is a credential.
 *
 * ⚠️ OPENING THE BOARD IS NOT AUDITED, following the register's own line
 * (see `listPlatformActions`): a row written every time somebody glances
 * at a dashboard buries the rows that matter. Recording a rotation IS
 * audited, because that is the act.
 */
export async function getSecretRotationBoard(): Promise<PlatformResult<SecretBoard>> {
  await requireCapability("staff:read");

  const rows = await withPlatformScope(
    "Platform console: read recorded secret rotations from the action register",
    async (db) =>
      db
        .select({
          resourceId: platformActionLog.resourceId,
          actorEmail: platformActionLog.actorEmail,
          justification: platformActionLog.justification,
          metadata: platformActionLog.metadata,
          createdAt: platformActionLog.createdAt,
        })
        .from(platformActionLog)
        .where(
          and(
            eq(platformActionLog.resourceType, SECRET_ROTATION_RESOURCE),
            eq(platformActionLog.action, "config_change"),
          ),
        )
        .orderBy(desc(platformActionLog.createdAt))
        .limit(ROTATION_SCAN_LIMIT),
  );

  /**
   * ⚠️ NEWEST WINS AND EARLIER ROWS ARE NOT DISCARDED — they stay in the
   * register, which is the point of an append-only table. This map is
   * only "what is the most recent statement about this name".
   *
   * ⚠️ `rows` is ordered newest first, so the FIRST row seen for a name is
   * the one to keep. Later rows are skipped rather than overwriting.
   */
  const rotations: Record<string, RecordedRotation | undefined> = {};
  let recordedCount = 0;
  for (const row of rows) {
    const name = row.resourceId;
    if (name === null || !isCataloguedSecret(name)) continue;
    recordedCount += 1;
    if (rotations[name] !== undefined) continue;
    /**
     * ⚠️ The operator may state a date earlier than the moment they typed
     * it — a key rotated on Friday and written down on Monday. That
     * stated instant is in the metadata; the row's own `created_at` is
     * the fallback, and is what the register itself will always show.
     */
    const stated = row.metadata["rotatedAt"];
    const at = typeof stated === "string" ? stated : row.createdAt.toISOString();
    rotations[name] = {
      at,
      by: row.actorEmail,
      reason: row.justification,
    };
  }

  const now = new Date();
  return {
    ok: true,
    data: {
      /**
       * 🔴 `process.env` GOES IN; BOOLEANS COME OUT. This is the only
       * place the live environment is touched, and `buildSecretBoard`
       * turns each value into `present: true | false` inside one
       * expression. Nothing that leaves this function has ever held a
       * secret's contents or its size.
       */
      rows: buildSecretBoard({
        env: process.env as unknown as Record<string, string | undefined>,
        rotations,
        now,
      }),
      recordedCount,
      generatedAt: now.toISOString(),
    },
  };
}

/**
 * ⚠️ NO `value` FIELD, AND THERE IS NOWHERE TO ADD ONE. The schema is the
 * contract: a name from the catalogue, a written reason, and optionally
 * the day it actually happened.
 */
const recordRotationSchema = z.object({
  name: z
    .string()
    .trim()
    .max(200)
    // ⚠️ ALLOW-LISTED AGAINST THE CATALOGUE, not merely length-checked.
    // `resource_id` is displayed on the register and this board; a free
    // string would let anybody write an arbitrary label into both.
    .refine(isCataloguedSecret, "That is not a setting this product reads."),
  reason: z
    .string()
    .trim()
    // Ten characters is `withPlatformScope`'s own floor for a
    // justification, and this sentence is the whole value of the row a
    // year from now.
    .min(10, "Say why it was rotated — at least a sentence.")
    .max(1000),
  /**
   * The day the rotation happened, `YYYY-MM-DD`, defaulting to today.
   * Bounded on both sides: a future date would produce a negative age,
   * and a date years back is a typo far more often than it is history.
   */
  rotatedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-08-17.")
    .optional(),
});

export type RecordSecretRotationInput = z.input<typeof recordRotationSchema>;

const MAX_BACKDATE_DAYS = 365;

/**
 * ⭐ RECORD THE FACT OF A ROTATION.
 *
 * ⚠️ `staff:manage` — the grade that may grant and revoke platform access
 * is the grade that may make an assertion about platform credentials.
 * Support can READ this board (they are the people who will be told a
 * connector is dark) and cannot write to it, because an unverifiable
 * claim that a key was rotated is exactly the claim that stops somebody
 * rotating it.
 */
export async function recordSecretRotation(
  input: unknown,
): Promise<PlatformResult<{ name: string; rotatedAt: string }>> {
  const operator = await requireCapability("staff:manage");

  const parsed = recordRotationSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid rotation record." };
  }
  const { name, reason } = parsed.data;

  const now = new Date();
  let rotatedAt = now;
  if (parsed.data.rotatedOn) {
    // ⚠️ Parsed as UTC midnight, which is what an unqualified `YYYY-MM-DD`
    // means to `Date`. Precision below a day is not claimed anywhere on
    // this screen, so it does not need to be right below a day.
    const candidate = new Date(`${parsed.data.rotatedOn}T00:00:00.000Z`);
    if (!Number.isFinite(candidate.getTime())) {
      return { ok: false, error: "That is not a real date." };
    }
    if (candidate.getTime() > now.getTime()) {
      return { ok: false, error: "A rotation cannot have happened in the future." };
    }
    if (now.getTime() - candidate.getTime() > MAX_BACKDATE_DAYS * 86_400_000) {
      return {
        ok: false,
        error: `A rotation more than ${MAX_BACKDATE_DAYS} days ago is almost always a typo. Correct the date.`,
      };
    }
    rotatedAt = candidate;
  }

  /**
   * 🔴 THE WHOLE WRITE. One row in the register, through the same
   * function every other platform act uses — so it appears in
   * `/platform/log` beside everything else, carries the actor's identity
   * and IP, and cannot be deleted by any application role.
   *
   * ⚠️ `config_change`, not a new action kind: it IS a configuration
   * change, and the register's filter control is built from the action
   * values present, so a bespoke kind would fragment the one place an
   * investigator looks.
   *
   * ⚠️ NOTHING IN `metadata` DESCRIBES THE VALUE. The name, the stated
   * date, and the fact that this console did not perform the rotation.
   */
  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: SECRET_ROTATION_RESOURCE,
    resourceId: name,
    severity: "notice",
    reason,
    metadata: {
      secretName: name,
      rotatedAt: rotatedAt.toISOString(),
      // ⭐ Stated in the row itself, for whoever reads it in a year: the
      // console records rotations, it does not perform them.
      performedIn: "railway_by_a_human",
      recordedVia: "platform_secrets_board",
    },
  });

  return { ok: true, data: { name, rotatedAt: rotatedAt.toISOString() } };
}

/** The catalogue, for the form's name list. Re-exported so the page has one import. */
export { SECRET_CATALOG };
