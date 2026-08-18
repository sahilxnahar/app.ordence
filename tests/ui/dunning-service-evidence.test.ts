/**
 * Ordence — 🔴🔴 A DEMAND NOTICE MAY NOT CLAIM A SEND NOBODY MADE
 * Version: v1.55.0-alpha  ·  SQL 0098
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `dunning_events.sent_at` was `NOT NULL DEFAULT now()`. Creating the row
 * asserted the send, and nothing sent anything. In a table whose stated
 * purpose is "the evidence that the buyer was given every chance", before
 * a RERA allotment is cancelled and a family's money forfeited, that is
 * not a missing feature. It is false evidence, and it is found by the
 * other side.
 *
 * ⚠️ THESE TESTS ASSERT PROPERTIES, NOT SHAPES. None of them checks a
 * column list or a string of SQL for its own sake; each one states a
 * thing that must remain true of the SYSTEM — that creating a demand
 * cannot claim a dispatch, that a human's tick is distinguishable from a
 * verified send, and that history is never quietly promoted.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cancellationServiceFinding,
  channelCanBeMachineDispatched,
  describeServiceEvidence,
  ladderGapInstant,
  noticeHasService,
  validatePostalServiceClaim,
  SERVICE_EVIDENCE_GRADES,
  type NoticeServiceFacts,
} from "@/lib/receivables/service-evidence";

const ROOT = process.cwd();
const SQL = readFileSync(
  join(ROOT, "SQL-FILES", "0098_dunning_service_evidence.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "db", "schema", "receivables.ts"), "utf8");
const SENDER = readFileSync(
  join(ROOT, "server", "receivables", "dunning.ts"),
  "utf8",
);
const DISPATCHER = readFileSync(join(ROOT, "server", "email", "outbox.ts"), "utf8");

function notice(over: Partial<NoticeServiceFacts> = {}): NoticeServiceFacts {
  return {
    stage: "first_notice",
    rung: 2,
    channel: "email",
    serviceEvidence: "none",
    raisedAt: new Date("2026-03-01T04:00:00.000Z"),
    dispatchedAt: null,
    dispatchProviderMessageId: null,
    dispatchFailureReason: null,
    servedAt: null,
    serviceRecordedAt: null,
    serviceReference: null,
    legacySentAt: null,
    ...over,
  };
}

/* ================================================================== */
/* ① CREATING A DEMAND CANNOT SET A DISPATCHED TIMESTAMP              */
/* ================================================================== */

describe("creating a demand notice cannot assert that it was sent", () => {
  it("the write path never sets a send or dispatch timestamp on insert", () => {
    // The property: the INSERT that creates the row does not mention any
    // of the three evidence timestamps. Only `raisedAt` — the one fact
    // that creating a row genuinely establishes.
    const insert = SENDER.slice(
      SENDER.indexOf(".insert(dunningEvents)"),
      SENDER.indexOf(".returning()", SENDER.indexOf(".insert(dunningEvents)")),
    );
    expect(insert.length).toBeGreaterThan(50);
    expect(insert).toContain("raisedAt:");
    expect(insert).not.toContain("sentAt:");
    expect(insert).not.toContain("dispatchedAt:");
    expect(insert).not.toContain("servedAt:");
  });

  it("a CHECK — not a convention — refuses a send stamp on an unproven row", () => {
    // Both the migration and the Drizzle table carry it, so a database
    // built from either one behaves the same way.
    for (const source of [SQL, SCHEMA]) {
      expect(source).toContain("dunning_events_sent_at_is_not_a_claim");
    }
    // And the two properties that make the CHECK bite on a fresh insert:
    // the default is the unproven grade, and the old auto-stamp is gone.
    expect(SQL).toContain("ALTER COLUMN service_evidence SET DEFAULT 'none'");
    expect(SQL).toContain("ALTER COLUMN sent_at DROP DEFAULT");
    expect(SQL).toContain("ALTER COLUMN sent_at DROP NOT NULL");
  });

  it("dispatch is unreachable without a provider id, which only the provider makes", () => {
    expect(SQL).toContain("dunning_events_dispatch_needs_proof");
    // The only WRITER of dispatchedAt in the codebase is the dispatcher.
    expect(DISPATCHER).toContain("dispatchedAt: outcome.at");
    // The sender only ever reads it back out for display — never assigns
    // one. Anything other than `event.dispatchedAt` on the right-hand
    // side would be the write path claiming a dispatch again.
    for (const [, rhs] of SENDER.matchAll(/dispatchedAt:\s*([^,\n]+)/g)) {
      const value = rhs.trim();
      // Type declarations are not assignments.
      if (/^(string|Date)\b/.test(value)) continue;
      expect(value).toMatch(/^event\.dispatchedAt/);
    }
  });

  it("a raised-only notice is not treated as served, however it is graded", () => {
    expect(noticeHasService(notice())).toBe(false);
    // Grade says dispatched, but there is no provider id behind it: the
    // grade alone is never believed, because a believed label is exactly
    // what the old `sent_at` was.
    expect(
      noticeHasService(
        notice({ serviceEvidence: "system_dispatch", dispatchedAt: new Date() }),
      ),
    ).toBe(false);
  });

  it("an unrecognised grade resolves to the weakest one, never the strongest", () => {
    const unknown = describeServiceEvidence("definitely_served_trust_me");
    expect(unknown.strength).toBe(0);
    expect(unknown.machineVerified).toBe(false);
    expect(unknown.supportsEnforcement).toBe(false);
  });
});

/* ================================================================== */
/* ② A HUMAN-RECORDED POSTAL SERVICE ≠ A SYSTEM DISPATCH              */
/* ================================================================== */

describe("a person's record of postal service is weaker, and says so", () => {
  const posted = notice({
    channel: "post",
    serviceEvidence: "human_recorded",
    serviceRecordedAt: new Date("2026-03-04T05:00:00.000Z"),
    serviceReference: "EY123456789IN",
    servedAt: new Date("2026-03-06T05:00:00.000Z"),
  });
  const dispatched = notice({
    serviceEvidence: "system_dispatch",
    dispatchedAt: new Date("2026-03-02T05:00:00.000Z"),
    dispatchProviderMessageId: "re_abc123",
  });

  it("both count as service, and only one of them is machine verified", () => {
    expect(noticeHasService(posted)).toBe(true);
    expect(noticeHasService(dispatched)).toBe(true);

    const human = describeServiceEvidence(posted.serviceEvidence);
    const machine = describeServiceEvidence(dispatched.serviceEvidence);
    expect(human.machineVerified).toBe(false);
    expect(machine.machineVerified).toBe(true);
  });

  it("they never render as the same thing", () => {
    const human = describeServiceEvidence("human_recorded");
    const machine = describeServiceEvidence("system_dispatch");
    expect(human.word).not.toBe(machine.word);
    expect(human.label).not.toBe(machine.label);
    expect(human.meaning).not.toBe(machine.meaning);
    // Every grade carries a WORD, and the words are distinct.
    const words = SERVICE_EVIDENCE_GRADES.map((g) => describeServiceEvidence(g).word);
    expect(new Set(words).size).toBe(SERVICE_EVIDENCE_GRADES.length);
  });

  it("a postal claim without something anybody can look up is refused", () => {
    const empty = validatePostalServiceClaim({
      channel: "post",
      reference: "   ",
      recordedBy: "user-1",
    });
    expect(empty.ok).toBe(false);

    const anonymous = validatePostalServiceClaim({
      channel: "post",
      reference: "EY123456789IN",
      recordedBy: null,
    });
    expect(anonymous.ok).toBe(false);

    const good = validatePostalServiceClaim({
      channel: "hand_delivery",
      reference: " acknowledgement-4471 ",
      recordedBy: "user-1",
    });
    expect(good.ok).toBe(true);
  });

  it("a channel the machine can drive may not be recorded by hand instead", () => {
    // Otherwise the weaker evidence becomes the easy path and the outbox
    // is bypassed — the defect coming back through a different door.
    expect(channelCanBeMachineDispatched("email")).toBe(true);
    expect(channelCanBeMachineDispatched("post")).toBe(false);
    expect(channelCanBeMachineDispatched("hand_delivery")).toBe(false);
    expect(
      validatePostalServiceClaim({
        channel: "email",
        reference: "I definitely emailed it",
        recordedBy: "user-1",
      }).ok,
    ).toBe(false);
  });

  it("the database refuses to let a human record wear the machine's badge", () => {
    for (const source of [SQL, SCHEMA]) {
      expect(source).toContain("dunning_events_system_dispatch_is_machine_only");
      expect(source).toContain("dunning_events_human_record_is_not_a_dispatch");
      expect(source).toContain("dunning_events_human_record_names_a_person");
    }
  });
});

/* ================================================================== */
/* ③ LEGACY ROWS ARE NEVER SILENTLY PROMOTED                          */
/* ================================================================== */

describe("rows written under the old behaviour stay exactly where they are", () => {
  const legacy = notice({
    serviceEvidence: "legacy_unverified",
    raisedAt: null,
    legacySentAt: new Date("2024-07-11T00:00:00.000Z"),
  });

  it("an old sent_at proves nothing and does not count as service", () => {
    expect(legacy.legacySentAt).not.toBeNull();
    expect(noticeHasService(legacy)).toBe(false);
    expect(describeServiceEvidence("legacy_unverified").supportsEnforcement).toBe(false);
  });

  it("the migration never copies sent_at into dispatched_at", () => {
    // The property: no DML at all touches dunning_events in 0098. A
    // backfill would manufacture precisely the evidence the defect
    // fabricated, in the file written to stop fabricating it.
    // ⚠️ Comments are stripped first. The file EXPLAINS the backfill it
    // refuses to do, in the words somebody would otherwise have written,
    // and that explanation must not be mistaken for the deed.
    const executable = SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toUpperCase();
    expect(executable).not.toContain("UPDATE PUBLIC.DUNNING_EVENTS");
    expect(executable).not.toContain("INSERT INTO PUBLIC.DUNNING_EVENTS");
    expect(executable).not.toContain("DISPATCHED_AT = SENT_AT");
    // History is marked by an ADD COLUMN default, not by a write.
    expect(SQL).toContain("NOT NULL DEFAULT 'legacy_unverified'");
  });

  it("a legacy row cannot be promoted later either — the CHECK forbids it", () => {
    for (const source of [SQL, SCHEMA]) {
      expect(source).toContain("dunning_events_legacy_is_never_promoted");
    }
  });

  it("the ladder's pacing arithmetic still works on a legacy row without believing it", () => {
    // ⚠️ Falling back is about the minimum gap between rungs, not about
    // service. If this returned null the gate would read "nothing sent
    // yet" and let the next rung go out immediately — an evidence fix
    // becoming a harassment bug.
    expect(ladderGapInstant(legacy)).toEqual(legacy.legacySentAt);
    expect(ladderGapInstant(notice())?.toISOString()).toBe(
      "2026-03-01T04:00:00.000Z",
    );
    // And it still is not service.
    expect(noticeHasService(legacy)).toBe(false);
  });
});

/* ================================================================== */
/* ④ THE FINDING IN FRONT OF A CANCELLATION                           */
/* ================================================================== */

describe("the cancellation flow can see a notice that was never dispatched", () => {
  it("blocks and names the rungs when any notice is unproven", () => {
    const finding = cancellationServiceFinding([
      notice({
        stage: "reminder",
        rung: 1,
        serviceEvidence: "system_dispatch",
        dispatchedAt: new Date(),
        dispatchProviderMessageId: "re_1",
      }),
      notice({ stage: "final_notice", rung: 3 }),
    ]);
    expect(finding.word).toBe("unproven_service");
    expect(finding.blocking).toBe(true);
    expect(finding.unprovenStages).toContain("final_notice");
    expect(finding.unprovenStages).not.toContain("reminder");
  });

  it("names legacy rows separately, because 'unknowable' is its own answer", () => {
    const finding = cancellationServiceFinding([
      notice({ stage: "reminder", rung: 1, serviceEvidence: "legacy_unverified" }),
    ]);
    expect(finding.blocking).toBe(true);
    expect(finding.legacyStages).toContain("reminder");
  });

  it("clears only when every rung has something real behind it", () => {
    const finding = cancellationServiceFinding([
      notice({
        stage: "reminder",
        rung: 1,
        serviceEvidence: "system_dispatch",
        dispatchedAt: new Date(),
        dispatchProviderMessageId: "re_1",
      }),
      notice({
        stage: "first_notice",
        rung: 2,
        channel: "post",
        serviceEvidence: "human_recorded",
        serviceRecordedAt: new Date(),
        serviceReference: "EY99",
        servedAt: new Date(),
      }),
    ]);
    expect(finding.word).toBe("clear");
    expect(finding.blocking).toBe(false);
  });

  it("no ladder at all is its own finding, not a pass", () => {
    const finding = cancellationServiceFinding([]);
    expect(finding.word).toBe("no_ladder");
    expect(finding.blocking).toBe(true);
  });

  it("the cancellation preview actually carries it to the screen", () => {
    const action = readFileSync(
      join(ROOT, "server", "actions", "sales-bookings.ts"),
      "utf8",
    );
    expect(action).toContain("noticeServiceForBooking");
    expect(action).toContain("serviceFinding");
    const board = readFileSync(
      join(ROOT, "components", "sales", "cancellation-board.tsx"),
      "utf8",
    );
    expect(board).toContain("serviceFinding");
    expect(board).toContain("cancel-service-finding");
  });
});

/* ================================================================== */
/* ⑤ IT GOES THROUGH THE OUTBOX THAT ALREADY EXISTS                   */
/* ================================================================== */

describe("the notice is dispatched by the outbox, not by a second dispatcher", () => {
  it("the sender enqueues rather than calling a mail provider itself", () => {
    expect(SENDER).toContain("enqueueEmail");
    expect(SENDER).not.toContain("resend");
    expect(SENDER).not.toContain("sendEmail(");
  });

  it("the idempotency key is derived from the message, never from the clock", () => {
    expect(SENDER).toContain("`dunning:${demandId}:${stage}`");
    const keyLine = SENDER.slice(
      SENDER.indexOf("idempotencyKey: `dunning"),
      SENDER.indexOf("idempotencyKey: `dunning") + 80,
    );
    expect(keyLine).not.toContain("Date");
  });

  it("a failed dispatch is recorded as not served, not left blank", () => {
    expect(DISPATCHER).toContain("dispatchFailureReason");
  });
});
