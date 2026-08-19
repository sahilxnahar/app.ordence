/**
 * Ordence — 🔴🔴 THE RERA STATUTORY LADDER, END TO END
 * Version: v1.67.0-alpha  ·  SQL 0111
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS BATCH FIXED, AND THEREFORE WHAT THESE TESTS HAVE TO CATCH
 * ══════════════════════════════════════════════════════════════════════
 * ① `sendDunningNotice` and `planDunning` had NO IMPORTER ANYWHERE in
 *    `app/` or `components/`. A legal instrument with a permission model,
 *    an escalation gate and four database constraints, reachable only by
 *    somebody willing to hand-craft an RPC call.
 * ② The per-rung permission lived in a ternary inside one server action.
 *    Enough to refuse a request; not enough for a screen to offer the
 *    right rungs, and not true of a row written by anything else.
 * ③ `deemed` — the STRONGEST evidence grade in the product, `strength: 3`,
 *    `supportsEnforcement: true`, allowed by the CHECK in 0098 — had no
 *    writer anywhere. A grade that clears the gate before a forfeiture
 *    and that nothing could produce.
 *
 * ⚠️ THESE TESTS ASSERT PROPERTIES, NOT SHAPES. None of them pins a
 * count, an id, a total or a suffix. Each states something that must
 * remain true of the SYSTEM: that the rung and the right cannot drift
 * apart, that the screen cannot serve in bulk, that service is never
 * settable by the act of sending, and that no State's timeline has been
 * hardcoded into a Central Act's ladder.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DUNNING_LADDER,
  type DunningLadderPolicy,
} from "@/lib/receivables/dunning";
import {
  assessLadderAuthority,
  authorityForStage,
  ladderAuthority,
  ladderAuthorityProblem,
  permissionForStage,
  type RungAuthority,
} from "@/lib/receivables/notice-authority";
import {
  AUTHORITY_NOT_RECORDED,
  cancellationServiceFinding,
  noticeHasService,
  validateDeemedServiceClaim,
  type NoticeServiceFacts,
} from "@/lib/receivables/service-evidence";
import { statutoryLadderContext } from "@/lib/receivables/rera-state";
import {
  previewDunningSchema,
  recordDeemedServiceSchema,
  sendDunningSchema,
} from "@/lib/validators/receivables";
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  permissionsForRole,
  type PermissionKey,
} from "@/db/schema/auth";
import type { SystemRole } from "@/db/schema";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const SQL_0111 = read("SQL-FILES", "0111_deemed_service_and_notice_authority.sql");
const SCHEMA = read("db", "schema", "receivables.ts");
const SENDER = read("server", "receivables", "dunning.ts");
const ACTIONS = read("server", "actions", "receivables.ts");
const BOARD = read("components", "receivables", "dunning-ladder-board.tsx");
const PAGE = read("app", "(crm)", "receivables", "ladder", "page.tsx");
const DISPATCHER = read("server", "email", "outbox.ts");
const RECEIVABLES_PAGE = read("app", "(crm)", "receivables", "page.tsx");
const REGISTRY = read("lib", "modules", "registry.ts");
const TEMPLATES = read("lib", "industry-templates.ts");

const ROLES = Object.keys(ROLE_TEMPLATES) as SystemRole[];
const holds = (role: string, key: PermissionKey): boolean =>
  (permissionsForRole(role as SystemRole) as readonly string[]).includes(key);

function notice(over: Partial<NoticeServiceFacts> = {}): NoticeServiceFacts {
  return {
    stage: "first_notice",
    rung: 2,
    channel: "post",
    serviceEvidence: "none",
    raisedAt: new Date("2026-03-01T04:00:00.000Z"),
    dispatchedAt: null,
    dispatchProviderMessageId: null,
    dispatchFailureReason: null,
    servedAt: null,
    serviceRecordedAt: null,
    serviceReference: null,
    serviceBasis: null,
    authorisedPermission: "receivables:dun",
    legacySentAt: null,
    ...over,
  };
}

/** The slice of a source file between two markers — for scoped assertions. */
function between(source: string, from: string, to: string): string {
  const a = source.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThan(-1);
  const b = source.indexOf(to, a);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return source.slice(a, b);
}

/* ================================================================== */
/* ① THE ESCALATING RUNG NEEDS AN ESCALATING RIGHT                    */
/* ================================================================== */

describe("the rung and the right", () => {
  it("gives every rung a key the catalogue recognises", () => {
    // An unrecognised key fails CLOSED at every call site — which means
    // a typo here does not weaken the gate, it makes the rung
    // unsendable by anybody. Both are wrong; this catches it either way.
    for (const stage of DUNNING_LADDER) {
      expect(permissionForStage(stage) in PERMISSION_CATALOG).toBe(true);
    }
  });

  it("does not let a reminder and a cancellation warning share a key", () => {
    const first = authorityForStage(DUNNING_LADDER[0]!);
    const top = authorityForStage(DUNNING_LADDER[DUNNING_LADDER.length - 1]!);
    expect(top.permission).not.toBe(first.permission);
  });

  it("never weakens as the ladder climbs", () => {
    // The property: once a rung needs a key on the dangerous list, every
    // rung above it does too. A dangerous third rung under an ordinary
    // fourth is a regression that looks tidy in a diff.
    let sawDangerous = false;
    for (const rung of ladderAuthority()) {
      if (rung.dangerous) sawDangerous = true;
      else expect(sawDangerous, `rung ${rung.rung} weakens the ladder`).toBe(false);
    }
    const top = ladderAuthority().at(-1)!;
    expect(DANGEROUS_PERMISSIONS.includes(top.permission)).toBe(true);
    expect(top.needsNamedAuthoriser).toBe(true);
  });

  it("keeps the separation of duties real, in BOTH directions", () => {
    /*
     * 🔴 TWO KEY NAMES PROVE NOTHING IF ONE PERSON HOLDS BOTH. The design
     * is that the accountant who chases the money all quarter cannot
     * serve the letter that precedes forfeiting a home, and that counsel,
     * who can, is not the one sending routine reminders.
     */
    const first = ladderAuthority()[0]!;
    const top = ladderAuthority().at(-1)!;

    const collectorOnly = ROLES.filter(
      (r) => holds(r, first.permission) && !holds(r, top.permission),
    );
    const authoriserOnly = ROLES.filter(
      (r) => holds(r, top.permission) && !holds(r, first.permission),
    );

    expect(collectorOnly.length).toBeGreaterThan(0);
    expect(authoriserOnly.length).toBeGreaterThan(0);
  });

  it("never lets somebody authorise a forfeiture they cannot read the account for", () => {
    const top = ladderAuthority().at(-1)!;
    for (const role of ROLES) {
      if (!holds(role, top.permission)) continue;
      expect(holds(role, "receivables:read"), `${role} signs blind`).toBe(true);
    }
  });

  it("matches a rung to its own key and to no other", () => {
    /*
     * ⚠️ EQUALITY, NOT "AT LEAST". Counsel holds the top key and NOT the
     * collecting one, so a screen that treated a stronger key as
     * satisfying a weaker rung would offer counsel a reminder the server
     * refuses. The keys are not ordered; they are different jobs.
     */
    expect(permissionForStage("reminder")).toBe("receivables:dun");
    expect(permissionForStage("cancellation_warning")).toBe(
      "receivables:warn_cancellation",
    );
    expect(permissionForStage("reminder")).not.toBe(
      permissionForStage("cancellation_warning"),
    );
  });
});

/* ================================================================== */
/* ② THE GUARD THAT WATCHES THE ROLE MODEL — BOTH BRANCHES            */
/* ================================================================== */

describe("the board refuses to render a permission model that has been flattened", () => {
  it("finds nothing wrong with the tree as it stands", () => {
    expect(ladderAuthorityProblem()).toBeNull();
  });

  it("REFUSES when the accountant is quietly given the forfeiture key", () => {
    /*
     * 🔴 THE FAILING BRANCH, EXERCISED. A verify function that has only
     * ever been run on the passing case is not a verify function. This
     * is the one-line edit in another file that would leave every other
     * assertion in this suite true and the design gone.
     */
    const everybodyHoldsEverything = () => true;
    const problem = assessLadderAuthority(
      ladderAuthority(),
      everybodyHoldsEverything,
      ROLES,
    );
    expect(problem).toBeTruthy();
    expect(problem).toMatch(/withhold|chases the money/i);
  });

  it("REFUSES a ladder whose top rung is not on the dangerous list", () => {
    const flattened: RungAuthority[] = ladderAuthority().map((r) => ({
      ...r,
      permission: "receivables:dun" as PermissionKey,
      dangerous: false,
    }));
    expect(assessLadderAuthority(flattened, holds, ROLES)).toBeTruthy();
  });

  it("REFUSES a key the catalogue has never heard of", () => {
    const typo: RungAuthority[] = ladderAuthority().map((r, i) =>
      i === 0 ? { ...r, permission: "receivables:dunn" as PermissionKey } : r,
    );
    expect(assessLadderAuthority(typo, holds, ROLES)).toMatch(/catalogue/i);
  });
});

/* ================================================================== */
/* ③ THE RULE IS THE SAME IN TYPESCRIPT AND IN THE DATABASE           */
/* ================================================================== */

describe("the per-rung permission is a fact about the row, not a promise by one action", () => {
  it("names in SQL exactly the keys TypeScript maps the rungs to", () => {
    /*
     * ⭐⭐ THE CROSS-ARTIFACT PROPERTY. `permissionForStage` decides what
     * to require; `dunning_events_authority_matches_rung` decides what
     * may be stored. If they drift, an import writes a cancellation
     * warning as ordinary chasing work — or, worse, the send starts
     * failing on a constraint nobody can find. Neither file can be
     * changed alone.
     */
    const check = between(
      SQL_0111,
      "dunning_events_authority_matches_rung\n            CHECK",
      "END $$;",
    );
    for (const stage of DUNNING_LADDER) {
      expect(check).toContain(permissionForStage(stage));
    }
    // And every key the CHECK names is one the ladder actually uses.
    const named = [...check.matchAll(/'(receivables:[a-z_]+)'/g)].map((m) => m[1]!);
    const used = new Set<string>(DUNNING_LADDER.map(permissionForStage));
    for (const key of named) expect(used.has(key)).toBe(true);
  });

  it("makes the action ask the shared rule rather than re-deciding", () => {
    const body = between(
      ACTIONS,
      "export async function sendDunningNotice(",
      "export async function planDunning(",
    );
    expect(body).toContain("permissionForStage(data.stage)");
    // The ternary that used to live here must not come back beside it.
    expect(body).not.toMatch(/\?\s*"receivables:warn_cancellation"/);
  });

  it("writes the same key onto the row that the guard checked", () => {
    const insert = between(SENDER, ".insert(dunningEvents)", ".returning()");
    expect(insert).toContain("permissionForStage(stage)");
    // ⚠️ Not a literal. A literal here could disagree with the guard.
    expect(insert).not.toContain('"receivables:dun"');
  });

  it("requires the column with no default, so a forgetful writer throws", () => {
    // Drizzle side: notNull and no .default().
    const column = between(
      SCHEMA,
      'authorisedPermission: varchar("authorised_permission"',
      "\n",
    );
    expect(column).toContain(".notNull()");
    expect(column).not.toContain(".default(");

    // SQL side: added WITH a default (to mark history without an UPDATE),
    // then the default dropped in the very next statement.
    const added = SQL_0111.indexOf(
      "ADD COLUMN IF NOT EXISTS authorised_permission varchar(60) NOT NULL DEFAULT",
    );
    const dropped = SQL_0111.indexOf(
      "ALTER COLUMN authorised_permission DROP DEFAULT",
    );
    expect(added).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(added);
  });

  it("marks history with a DEFAULT and never with DML", () => {
    /*
     * 🔴 THE SAME RULE 0098 ESTABLISHED. An UPDATE against a FORCE ROW
     * LEVEL SECURITY table is the failure mode 0091 and 0092 both hit,
     * and inventing an authority for a row raised two years ago is the
     * crime 0098 refused to commit with `dispatched_at`.
     */
    const statements = SQL_0111.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/^\s*UPDATE\s/im);
    expect(statements).not.toMatch(/^\s*INSERT\s+INTO/im);
    expect(statements).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(statements).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(statements).not.toMatch(/^\s*SET\s+LOCAL/im);
  });
});

/* ================================================================== */
/* ④ SERVED IS NOT SETTABLE BY THE ACT OF SENDING                     */
/* ================================================================== */

describe("raised, then dispatched, then served — and never all at once", () => {
  it("creates a rung claiming only that somebody decided to demand", () => {
    const insert = between(SENDER, ".insert(dunningEvents)", ".returning()");
    expect(insert).toContain("raisedAt:");
    for (const claim of ["servedAt", "dispatchedAt", "sentAt", "serviceEvidence"]) {
      expect(insert, `the insert asserts ${claim}`).not.toContain(`${claim}:`);
    }
  });

  it("never lets the dispatcher record service", () => {
    /*
     * 🔴 THE OUTBOX IS THE ONLY WRITER OF `dispatchedAt` AND IT MUST NOT
     * BE A WRITER OF `servedAt`. Dispatch is ours to prove; receipt is
     * not, and collapsing the two is the defect 0098 exists to end.
     */
    const mirror = between(DISPATCHER, "async function mirrorToSubject(", "\n}\n");
    expect(mirror).toContain("dispatchedAt:");
    expect(mirror).toContain("dispatchProviderMessageId:");
    expect(mirror).not.toContain("servedAt:");
  });

  it("only calls a row served when there is something behind it", () => {
    expect(noticeHasService(notice())).toBe(false);
    expect(noticeHasService(notice({ serviceEvidence: "legacy_unverified" }))).toBe(false);

    // A dispatch is service only with the provider's id behind it.
    expect(
      noticeHasService(
        notice({
          channel: "email",
          serviceEvidence: "system_dispatch",
          dispatchedAt: new Date(),
          dispatchProviderMessageId: null,
        }),
      ),
    ).toBe(false);
    expect(
      noticeHasService(
        notice({
          channel: "email",
          serviceEvidence: "system_dispatch",
          dispatchedAt: new Date(),
          dispatchProviderMessageId: "resend_abc",
        }),
      ),
    ).toBe(true);
  });
});

/* ================================================================== */
/* ⑤ `deemed` — THE GRADE THAT HAD NO WRITER                          */
/* ================================================================== */

describe("deemed service is the hardest claim in the product to make", () => {
  it("refuses a deeming with no stated basis, however it arrives", () => {
    // ⚠️ THE PURE RULE, not the form. A row that reached the type by any
    // route is still not treated as served without a basis.
    const bare = notice({
      serviceEvidence: "deemed",
      servedAt: new Date(),
      serviceRecordedAt: new Date(),
      serviceReference: "EX123456789IN",
      serviceBasis: null,
    });
    expect(noticeHasService(bare)).toBe(false);

    const stated = notice({
      serviceEvidence: "deemed",
      servedAt: new Date(),
      serviceRecordedAt: new Date(),
      serviceReference: "EX123456789IN",
      serviceBasis:
        "Clause 14.2 of the agreement for sale; cover returned endorsed refused.",
    });
    expect(noticeHasService(stated)).toBe(true);
  });

  it("refuses to deem service on a channel the machine can prove", () => {
    const verdict = validateDeemedServiceClaim({
      channel: "email",
      alreadyDispatchedAt: null,
      reference: "EX123456789IN",
      basis: "Clause 14.2 of the agreement for sale; cover returned endorsed refused.",
      recordedBy: "user-1",
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses to deem service on a notice that was actually dispatched", () => {
    const verdict = validateDeemedServiceClaim({
      channel: "post",
      alreadyDispatchedAt: new Date(),
      reference: "EX123456789IN",
      basis: "Clause 14.2 of the agreement for sale; cover returned endorsed refused.",
      recordedBy: "user-1",
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a deeming nobody has put their name to", () => {
    const verdict = validateDeemedServiceClaim({
      channel: "post",
      alreadyDispatchedAt: null,
      reference: "EX123456789IN",
      basis: "Clause 14.2 of the agreement for sale; cover returned endorsed refused.",
      recordedBy: null,
    });
    expect(verdict.ok).toBe(false);
  });

  it("accepts the refused registered post, which is the whole point of it", () => {
    const verdict = validateDeemedServiceClaim({
      channel: "post",
      alreadyDispatchedAt: null,
      reference: "EX123456789IN",
      basis:
        "Clause 14.2 of the agreement for sale; cover returned endorsed refused; s.27 General Clauses Act 1897.",
      recordedBy: "user-1",
    });
    expect(verdict.ok).toBe(true);
  });

  it("has a writer at all, which it did not before this batch", () => {
    /*
     * 🔴 THE DEFECT THIS CATCHES IS THE ONE THIS CODEBASE KEEPS
     * PRODUCING: a grade declared, described, permitted by a CHECK,
     * granted `supportsEnforcement: true`, and reachable by nothing.
     */
    expect(SENDER).toContain('serviceEvidence: "deemed"');
    expect(ACTIONS).toContain("recordNoticeDeemedService");
    expect(BOARD).toContain("onRecordDeemedService");
    expect(PAGE).toContain("recordNoticeDeemedService");
  });

  it("puts the deeming behind the forfeiture key and not the collecting one", () => {
    const body = between(
      ACTIONS,
      "export async function recordNoticeDeemedService(",
      "export async function getDunningLadderBoard(",
    );
    // ⭐ DERIVED, NOT SPELT OUT. A literal would be a second copy of the
    // mapping — the thing this batch removed from `sendDunningNotice`.
    expect(body).toContain('permissionForStage("cancellation_warning")');
    expect(body).not.toContain('permission: "receivables:');
  });

  it("requires a basis in the database, not only in the form", () => {
    expect(SQL_0111).toContain("dunning_events_deemed_states_its_basis");
    const check = between(
      SQL_0111,
      "dunning_events_deemed_states_its_basis\n            CHECK",
      "END $$;",
    );
    for (const field of [
      "service_recorded_by",
      "service_recorded_at",
      "served_at",
      "service_reference",
      "service_basis",
    ]) {
      expect(check).toContain(field);
    }
    expect(SCHEMA).toContain("deemedStatesItsBasis");
  });
});

/* ================================================================== */
/* ⑥ THE FINDING IN FRONT OF A FORFEITURE NAMES WHAT IT RESTS ON      */
/* ================================================================== */

describe("the cancellation finding", () => {
  it("names deemed rungs even when the file otherwise passes", () => {
    const finding = cancellationServiceFinding([
      notice({
        stage: "reminder",
        channel: "email",
        serviceEvidence: "system_dispatch",
        dispatchedAt: new Date(),
        dispatchProviderMessageId: "resend_a",
      }),
      notice({
        stage: "final_notice",
        serviceEvidence: "deemed",
        servedAt: new Date(),
        serviceRecordedAt: new Date(),
        serviceReference: "EX1",
        serviceBasis: "Clause 14.2; cover returned endorsed refused.",
      }),
    ]);
    expect(finding.word).toBe("clear");
    expect(finding.blocking).toBe(false);
    // ⚠️ Passing is not the same as silent.
    expect(finding.deemedStages).toContain("final_notice");
    expect(finding.detail).toMatch(/deemed/i);
  });

  it("names rungs whose authority this system never recorded", () => {
    const finding = cancellationServiceFinding([
      notice({
        stage: "cancellation_warning",
        serviceEvidence: "human_recorded",
        serviceRecordedAt: new Date(),
        serviceReference: "EX1",
        servedAt: new Date(),
        authorisedPermission: AUTHORITY_NOT_RECORDED,
      }),
    ]);
    expect(finding.unrecordedAuthorityStages).toContain("cancellation_warning");
    expect(finding.detail).toMatch(/which right/i);
  });

  it("stays quiet about both when neither applies", () => {
    const finding = cancellationServiceFinding([
      notice({
        channel: "email",
        serviceEvidence: "system_dispatch",
        dispatchedAt: new Date(),
        dispatchProviderMessageId: "resend_a",
      }),
    ]);
    expect(finding.deemedStages).toHaveLength(0);
    expect(finding.unrecordedAuthorityStages).toHaveLength(0);
    expect(finding.detail).not.toMatch(/deemed/i);
  });
});

/* ================================================================== */
/* ⑦ NO BULK SEND, ANYWHERE                                           */
/* ================================================================== */

describe("one demand, one rung, one confirmation", () => {
  it("refuses a list of demands at the schema", () => {
    const good = {
      demandId: "11111111-1111-1111-1111-111111111111",
      stage: "reminder",
      channel: "email",
    };
    expect(previewDunningSchema.safeParse(good).success).toBe(true);
    expect(
      previewDunningSchema.safeParse({
        ...good,
        demandId: [good.demandId, good.demandId],
      }).success,
    ).toBe(false);
    expect(
      sendDunningSchema.safeParse({
        ...good,
        demandId: [good.demandId, good.demandId],
      }).success,
    ).toBe(false);
  });

  it("gives the board no way to send anything", () => {
    /*
     * 🔴 THE BOARD IS A READ. Not "a read by convention" — the function
     * that builds it contains no insert, no update and no enqueue, so
     * there is nothing to accidentally call in a loop.
     */
    const body = between(
      SENDER,
      "export async function dunningBoard(",
      "async function listDunningEventsForDemands(",
    );
    for (const write of [".insert(", ".update(", ".delete(", "enqueueEmail"]) {
      expect(body, `the board ${write}`).not.toContain(write);
    }
  });

  it("keeps the confirm on a single preview rather than a selection", () => {
    // The property: the component holds ONE open demand, not a set, and
    // sends what the person actually read.
    expect(BOARD).toContain("setOpenDemandId");
    expect(BOARD).not.toMatch(/new Set\(/);
    expect(BOARD).not.toMatch(/Promise\.all/);
    expect(BOARD).toContain("demandId: preview.demandId");
    expect(BOARD).toContain("stage: preview.stage");
  });

  it("shows the letter, the allottee, the amount and the rung before it asks", () => {
    for (const shown of [
      "preview.body",
      "preview.subject",
      "preview.allotteeName",
      "preview.outstandingMinor",
      "preview.rung",
      "preview.stageLabel",
    ]) {
      expect(BOARD, `the confirm hides ${shown}`).toContain(shown);
    }
  });

  it("renders the letter itself rather than a template name", () => {
    const body = between(SENDER, "export async function previewDunningLetter(", "\n}\n");
    // The same renderer and the same gate the sender uses — a preview
    // built from its own copy would eventually show one letter and send
    // another.
    expect(body).toContain("renderDunningLetter(stage");
    expect(body).toContain("canEscalate({");
    // And it writes nothing.
    for (const write of [".insert(", ".update(", "enqueueEmail"]) {
      expect(body, `the preview ${write}`).not.toContain(write);
    }
  });
});

/* ================================================================== */
/* ⑧ THE AUDIT ROW NAMES THE RIGHT AND THE RUNG                       */
/* ================================================================== */

describe("an audit row per notice", () => {
  it("records which right, which rung, and when, alongside who", () => {
    /*
     * ⚠️ THE ACTOR AND THE TIME WERE NEVER THE GAP — `writeAudit` fills
     * both from the context. The right and the rung were, and they are
     * the two a hearing actually asks about.
     */
    const body = between(
      ACTIONS,
      "export async function sendDunningNotice(",
      "export async function planDunning(",
    );
    const metadata = between(body, "metadata: {", "},");
    expect(metadata).toContain("permission,");
    expect(metadata).toContain("rung:");
    expect(metadata).toContain("authorisedAt:");
    // 🔴 The key logged is the const the guard was given, never a literal
    // that could disagree with it.
    expect(metadata).not.toContain('"receivables:');
  });

  it("logs a deeming at the same severity as the warning it enables", () => {
    const body = between(
      ACTIONS,
      "export async function recordNoticeDeemedService(",
      "export async function getDunningLadderBoard(",
    );
    expect(body).toContain('severity: "critical"');
    expect(body).toContain("basis: data.basis");
  });
});

/* ================================================================== */
/* ⑨ RERA IS STATE-LEGISLATED AND NO STATE IS HARDCODED               */
/* ================================================================== */

describe("what is Central and what is not", () => {
  const allText = (c: ReturnType<typeof statutoryLadderContext>) =>
    [
      c.headline,
      c.detail,
      ...c.uniform.map((p) => `${p.citation ?? ""} ${p.point}`),
      ...c.stateDependent.map((p) => `${p.citation ?? ""} ${p.point}`),
    ].join(" ");

  it("never states a number of days for any State", () => {
    /*
     * 🔴 THE FAILURE THIS PREVENTS IS A TABLE OF PER-STATE TIMELINES
     * SEEDED WITH ONE STATE'S FIGURES. It is wrong on the day it ships
     * for every project outside that State, silently, on a screen that
     * is about to threaten somebody's home.
     */
    for (const stateCode of [null, "27", "29"]) {
      const text = allText(statutoryLadderContext({ stateCode }));
      expect(text, `a day count leaked for ${stateCode}`).not.toMatch(
        /\b\d+\s*(days?|weeks?|months?)\b/i,
      );
    }
  });

  it("keeps saying the ladder's own thresholds are unverified even once the State is known", () => {
    // ⚠️ Knowing the State does not let this product check a day count,
    // because it carries no table of them. A screen that read this as
    // "unset state" would show a false all-clear the day somebody fills
    // the field in.
    expect(statutoryLadderContext({ stateCode: null }).thresholdsUnverifiable).toBe(true);
    expect(statutoryLadderContext({ stateCode: "27" }).thresholdsUnverifiable).toBe(true);
  });

  it("says out loud when the project has no State recorded, and names the field", () => {
    const unknown = statutoryLadderContext({ stateCode: null, projectName: "Basaveshwar" });
    expect(unknown.stateKnown).toBe(false);
    expect(unknown.detail).toContain("state_code");

    const known = statutoryLadderContext({ stateCode: "27" });
    expect(known.stateKnown).toBe(true);
    expect(known.headline).not.toBe(unknown.headline);
  });

  it("treats blank and whitespace as no State rather than as a State", () => {
    expect(statutoryLadderContext({ stateCode: "  " }).stateKnown).toBe(false);
    expect(statutoryLadderContext({ stateCode: undefined }).stateKnown).toBe(false);
  });

  it("puts the interest rate's margin on the State side, not the Central one", () => {
    const c = statutoryLadderContext({ stateCode: "27" });
    const stateText = c.stateDependent.map((p) => p.point).join(" ");
    expect(stateText).toMatch(/margin/i);
    // s.2(za)'s symmetry IS Central and stays there.
    expect(c.uniform.map((p) => p.citation).join(" ")).toContain("s.2(za)");
  });

  it("reads projects.state_code rather than inventing one", () => {
    expect(SENDER).toContain("statutoryLadderContext({");
    expect(SENDER).toContain("projectStateCode");
    expect(BOARD).toContain("statutory.stateKnown");
    // ⚠️ And the "not checked against any State's rules" line is driven by
    // `thresholdsUnverifiable`, NOT by `stateKnown` — otherwise it would
    // vanish the morning somebody fills the field in.
    expect(BOARD).toContain("statutory.thresholdsUnverifiable");
  });
});

/* ================================================================== */
/* ⑩ BUILT AND REACHED — THE DEFECT THIS CODEBASE KEEPS PRODUCING     */
/* ================================================================== */

describe("the ladder is reachable by a person", () => {
  it("gives sendDunningNotice an importer outside the server layer", () => {
    // 🔴 It had NONE before this batch. `check:reachability` walks tables,
    // and `connection-setup` walks actions — neither caught an action
    // whose only importer was another action.
    expect(PAGE).toContain("sendDunningNotice");
    expect(PAGE).toContain("previewDunningNotice");
    expect(PAGE).toContain("getDunningLadderBoard");
  });

  it("is in the module registry, the sidebar and the page people already read", () => {
    expect(REGISTRY).toContain('href: "/receivables/ladder"');
    expect(TEMPLATES).toContain('href: "/receivables/ladder"');
    // ⚠️ A sidebar-only route is one collapsed menu from being
    // unreachable again, so the arrears page links it too.
    expect(RECEIVABLES_PAGE).toContain('href="/receivables/ladder"');
  });

  it("never puts the ladder on a clock", () => {
    /*
     * ⚠️ THE DESIGN CONSTRAINT FOR THE WHOLE BATCH. A cron holds no
     * permission, so scheduling the send would not be running it as
     * somebody with the right — it would be removing the right from the
     * design.
     */
    expect(PAGE).toMatch(/cron/i);
    expect(SENDER).toContain("nextSweepAction");
    // The board reports; it does not act. Asserted in ⑦ as well.
  });
});

/* ================================================================== */
/* ⑪ THE LADDER'S POLICY IS A SETTING, AND THE SCREEN SAYS SO         */
/* ================================================================== */

describe("the day counts on this ladder", () => {
  it("come from the workspace's dunning policy, which is data", () => {
    // A guard against somebody moving the thresholds into the statutory
    // module: the policy type is the only place they live.
    const policy: DunningLadderPolicy = {
      reminderAfterDays: 3,
      firstNoticeAfterDays: 15,
      finalNoticeAfterDays: 30,
      cancellationWarningAfterDays: 60,
      minGapDays: 7,
    };
    expect(policy.cancellationWarningAfterDays).toBeGreaterThan(
      policy.finalNoticeAfterDays,
    );
    const statutory = read("lib", "receivables", "rera-state.ts");
    expect(statutory).not.toContain("AfterDays");
  });
});
