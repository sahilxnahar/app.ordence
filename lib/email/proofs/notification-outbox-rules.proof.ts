/**
 * Ordence — PROOF: the pure notification→outbox rules.
 * Track G / wave 16 / v1.82.0-alpha
 *
 * RUN IT:
 *
 *     npx tsx lib/email/proofs/notification-outbox-rules.proof.ts
 *
 * No database, no network, no vitest. Exits 0 when every claim holds and 1
 * with the failing claim named when one does not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A SCRIPT AND NOT A TEST FILE
 * ══════════════════════════════════════════════════════════════════════
 * `vitest.config.ts` collects `tests/security/**` and `tests/ui/**` and
 * nothing else, and `tests/**` is not in Track G's ownership block. A test
 * written there would have the whole delivery refused by integration's
 * ownership check. `PATCH-REQUEST-G.md` names the path each of these
 * assertions should end up at.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EACH CLAIM IS WRITTEN TO FAIL IF THE THING IT PROVES IS REMOVED
 * ══════════════════════════════════════════════════════════════════════
 * A proof that passes against both the fixed and the broken code proves
 * nothing. `TRACK-REPORT.md` records, for each claim below, exactly what was
 * deleted to confirm it goes red and what the output was in both states.
 */

import {
  MAX_NOTIFICATION_RECIPIENTS,
  OUTBOX_IDEMPOTENCY_KEY_MAX,
  OUTBOX_SUBJECT_MAX,
  notificationEmailSubject,
  notificationIdempotencyKey,
  planNotificationRecipients,
  severityWarrantsEmail,
} from "../notification-outbox";
import { normalizeEmail } from "../outbox";

let failures = 0;

function claim(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  🔴 ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n     expected ${b}\n     actual   ${a}`);
}

console.log("\nPROOF — lib/email/notification-outbox.ts\n");

/* ================================================================== */
/* 1 · THE SEVERITY GATE                                               */
/* ================================================================== */

claim(
  "only critical and warning email; the default severity does not",
  () => {
    assert(severityWarrantsEmail("critical"), "critical must email");
    assert(severityWarrantsEmail("warning"), "warning must email");
    /*
     * 🔴 THE ONE THAT REGRESSED ONCE. The condition used to carry
     * `|| !input.severity`, so an ordinary info notification — which
     * `server/ai/background-workers.ts` creates on a schedule — mailed every
     * active user in the workspace on every run.
     */
    assert(!severityWarrantsEmail("info"), "info must NOT email");
    assert(!severityWarrantsEmail(""), "an empty severity must NOT email");
    assert(!severityWarrantsEmail("INFO"), "severity is compared exactly, not case-insensitively");
  },
);

/* ================================================================== */
/* 2 · THE IDEMPOTENCY KEY                                             */
/* ================================================================== */

const NOTIFICATION_ID = "11111111-2222-3333-4444-555555555555";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";

claim(
  "the idempotency key is derived from the message, not the clock or the attempt",
  () => {
    const first = notificationIdempotencyKey({
      notificationId: NOTIFICATION_ID,
      recipientUserId: USER_A,
    });
    const second = notificationIdempotencyKey({
      notificationId: NOTIFICATION_ID,
      recipientUserId: USER_A,
    });
    equal(first, second, "the same message must produce the same key");
    assert(
      !/\d{13}/.test(first),
      "the key contains something that looks like a timestamp, which would defeat the unique index",
    );
  },
);

claim(
  "the key cannot overflow email_outbox.idempotency_key (varchar 200)",
  () => {
    /*
     * 🔴 THIS IS WHY THE KEY IS BUILT FROM A USER ID AND NOT AN ADDRESS.
     * `to_email` is varchar(320). A key derived from one could exceed the
     * column and fail the INSERT inside the caller's transaction — which,
     * now that the enqueue is inside that transaction, would roll back the
     * notification itself. The email path must not be able to destroy the
     * thing it is delivering.
     */
    const key = notificationIdempotencyKey({
      notificationId: NOTIFICATION_ID,
      recipientUserId: USER_B,
    });
    assert(
      key.length <= OUTBOX_IDEMPOTENCY_KEY_MAX,
      `key is ${key.length} characters, the column holds ${OUTBOX_IDEMPOTENCY_KEY_MAX}`,
    );
    assert(key.includes(NOTIFICATION_ID), "the key must name the notification it belongs to");
    assert(key.includes(USER_B), "the key must name the recipient it belongs to");
  },
);

claim("two recipients of one notification get two different keys", () => {
  const a = notificationIdempotencyKey({ notificationId: NOTIFICATION_ID, recipientUserId: USER_A });
  const b = notificationIdempotencyKey({ notificationId: NOTIFICATION_ID, recipientUserId: USER_B });
  assert(a !== b, "a shared key would silence one of the two recipients through the unique index");
});

/* ================================================================== */
/* 3 · THE SUBJECT LINE                                                */
/* ================================================================== */

claim("the subject never exceeds the column, however long the title", () => {
  const subject = notificationEmailSubject({
    severity: "critical",
    title: "x".repeat(5_000),
  });
  assert(
    subject.length <= OUTBOX_SUBJECT_MAX,
    `subject is ${subject.length} characters, the column holds ${OUTBOX_SUBJECT_MAX}`,
  );
  assert(subject.startsWith("[CRITICAL] "), "the severity prefix must survive truncation");
});

claim("a normal title is not mangled", () => {
  equal(
    notificationEmailSubject({ severity: "warning", title: "  Stock below reorder level  " }),
    "[WARNING] Stock below reorder level",
    "an ordinary title must pass through trimmed and otherwise untouched",
  );
});

/* ================================================================== */
/* 4 · WHO GETS A ROW                                                  */
/* ================================================================== */

claim("the planner agrees with lib/email/outbox.ts on what normalisation means", () => {
  /*
   * 🔴 IF THESE TWO EVER DISAGREE, THE SUPPRESSION LIST BECOMES A ROW
   * NOBODY MATCHES. The dispatcher looks a claimed row up by
   * `to_email_normalized`; the planner is what writes that column.
   */
  for (const raw of ["  Bob@Example.COM ", "ALL@CAPS.IN", "already@lower.test"]) {
    const planned = planNotificationRecipients([{ userId: USER_A, email: raw }]);
    equal(
      planned[0]?.toEmailNormalized,
      normalizeEmail(raw),
      `the planner and normalizeEmail disagree on "${raw}"`,
    );
  }
});

claim("the display form is kept exactly as the user gave it", () => {
  const planned = planNotificationRecipients([{ userId: USER_A, email: "  Bob@Example.COM  " }]);
  equal(planned[0]?.toEmail, "Bob@Example.COM", "the envelope address must keep its case");
});

claim(
  "🔴 one shared mailbox gets ONE row, and the retained user does not depend on row order",
  () => {
    /*
     * ⭐⭐ THE CLAIM THIS MODULE EXISTS FOR.
     *
     * Two active logins on one `accounts@` mailbox is ordinary in an SMB.
     * The recipient query has no ORDER BY, so the row order is whatever the
     * planner hands back that day. If the retained user id varied with that
     * order, two containers running the same notification would compute two
     * DIFFERENT idempotency keys for the same address — and the unique index,
     * which is the thing actually preventing a double send, would let both
     * rows through.
     *
     * 🔴 THIS IS THE CLAIM THAT GOES RED IF THE `userId < held.recipientUserId`
     * TIE-BREAK IS REMOVED. With a plain "first one wins" it passes in one
     * order and fails in the other, which is exactly the bug.
     */
    const forward = planNotificationRecipients([
      { userId: USER_B, email: "accounts@example.test" },
      { userId: USER_A, email: "Accounts@Example.test" },
    ]);
    const reversed = planNotificationRecipients([
      { userId: USER_A, email: "Accounts@Example.test" },
      { userId: USER_B, email: "accounts@example.test" },
    ]);

    equal(forward.length, 1, "one address must produce one row");
    equal(reversed.length, 1, "one address must produce one row");
    equal(
      forward[0]?.recipientUserId,
      reversed[0]?.recipientUserId,
      "the retained user id changed with the input order, so two containers would compute two different idempotency keys for the same mailbox and both messages would be sent",
    );
    equal(
      forward[0]?.recipientUserId,
      USER_A,
      "the retained user must be the lexicographically smallest id for that address",
    );
  },
);

claim("the output order is stable, so a cap always drops the same people", () => {
  const shuffled = planNotificationRecipients([
    { userId: USER_B, email: "zoe@example.test" },
    { userId: USER_A, email: "adam@example.test" },
  ]);
  equal(
    shuffled.map((r) => r.toEmailNormalized),
    ["adam@example.test", "zoe@example.test"],
    "an unordered cap makes the fifty-first user a different person on every run, which reads as flaky delivery rather than a bound somebody chose",
  );
});

claim("blank addresses and blank user ids are dropped, not queued", () => {
  const planned = planNotificationRecipients([
    { userId: USER_A, email: "   " },
    { userId: "", email: "orphan@example.test" },
    { userId: USER_B, email: "real@example.test" },
  ]);
  equal(planned.length, 1, "only the complete candidate may produce a row");
  equal(planned[0]?.toEmailNormalized, "real@example.test", "the wrong candidate survived");
});

claim("the recipient cap is enforced by the planner, not only by the query", () => {
  const many = Array.from({ length: MAX_NOTIFICATION_RECIPIENTS + 25 }, (_, i) => ({
    userId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    email: `user${String(i).padStart(4, "0")}@example.test`,
  }));
  equal(
    planNotificationRecipients(many).length,
    MAX_NOTIFICATION_RECIPIENTS,
    "a bound that lives only in a caller's .limit() is a bound the next caller writes without",
  );
});

/* ================================================================== */

console.log("");
if (failures > 0) {
  console.error(`🔴 ${failures} claim(s) FAILED.\n`);
  process.exit(1);
}
console.log("✅ every claim holds.\n");
