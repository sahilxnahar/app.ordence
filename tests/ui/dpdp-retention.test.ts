/**
 * ⭐⭐⭐ THE STATUTES THAT REFUSE AN ERASURE, AND THE ONES THAT CANNOT
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THESE EXIST FOR
 * ══════════════════════════════════════════════════════════════════════
 * s.8(7) DPDPA requires erasure "unless retention is necessary for
 * compliance with any law for the time being in force". So a refusal
 * that names no law is not the exception, and a refusal that names a law
 * which does not say what is claimed is worse than no reason at all: it
 * is a reason the person cannot check, because checking it would show
 * the section is silent.
 *
 * ⚠️ THREE PROVISIONS IN THE BRIEF FOR THIS BATCH WERE OF THAT KIND —
 * RERA s.11, IT Act s.67C and Income-tax Rule 31A. None states a period.
 * `FORBIDDEN_CITATIONS` names them and this suite enforces it, because
 * the next person to add a retention rule will reach for exactly those
 * three: they are what every retention guide on the internet cites.
 */

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_CITATIONS,
  RETENTION_RULES,
  RETENTION_RULE_IDS,
  decide,
  mentionsOnlyToDisclaim,
} from "@/lib/dpdp/retention";
import { CLASSIFICATION } from "@/lib/dpdp/classification";
import { buildExportPlan } from "@/lib/dpdp/subject-graph";
import { buildErasurePlan, citableRules, refusalNotice } from "@/lib/dpdp/erasure";
import {
  DPDP_RULE_7_COMMENCEMENT,
  blockersToClosing,
  deadlines,
  intimationToPrincipal,
  type BreachFacts,
} from "@/lib/dpdp/breach";

/* ------------------------------------------------------------------ */

describe("🔴 every refusal names a real provision", () => {
  it("gives every rule a citation, a period, a clock and a sentence for the person", () => {
    for (const id of RETENTION_RULE_IDS) {
      const r = RETENTION_RULES[id];
      expect(r.provision.trim().length).toBeGreaterThan(10);
      expect(r.period.trim().length).toBeGreaterThan(3);
      expect(r.clock.trim().length).toBeGreaterThan(2);
      expect(r.toThePrincipal.trim().length).toBeGreaterThan(30);
      /** ⚠️ A citation is a fact with an expiry date. */
      expect(r.verified).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  /**
   * 🔴 THE ONE THAT MATTERS MOST IN THIS FILE.
   *
   * A rule may NAME a hollow provision in order to say it does not
   * apply — `certin-180-day-logs` names s.67C precisely to disclaim it —
   * and may not lean on one.
   */
  it("never leans on a provision that states no period", () => {
    const offences: string[] = [];
    for (const id of RETENTION_RULE_IDS) {
      const r = RETENTION_RULES[id];
      for (const f of FORBIDDEN_CITATIONS) {
        if (!r.provision.includes(f.needle)) continue;
        if (!mentionsOnlyToDisclaim(r.provision, f.needle)) {
          offences.push(`${id} cites ${f.needle}: ${f.because}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  /**
   * ⭐ A rule that does not state a number of years may not be typed
   * `statute`. `derived-limitation` and `unverified` are the honest
   * labels and they read differently to the person.
   */
  it("labels a derived period as derived and an unread provision as unverified", () => {
    expect(RETENTION_RULES["tds-limitation-derived"].kind).toBe("derived-limitation");
    expect(RETENTION_RULES["rera-state-rules"].kind).toBe("unverified");
    /** 🔴 Not a statute. `audit_logs` is held by a hash chain, not by a law. */
    expect(RETENTION_RULES["audit-chain-immutable"].kind).toBe("immutable-by-design");
  });

  it("says out loud that the RERA and IT-Act citations do not carry a period", () => {
    expect(RETENTION_RULES["rera-state-rules"].provision).toContain("NOT s.11");
    expect(RETENTION_RULES["certin-180-day-logs"].caveat ?? "").toContain("s.67C");
  });

  it("keeps every rule the inventory can cite", () => {
    const cited = new Set(
      CLASSIFICATION.map((c) => c.retention).filter((r): r is string => r !== null),
    );
    const missing = [...cited].filter((id) => !RETENTION_RULE_IDS.includes(id as never));
    expect(missing).toEqual([]);
    /** And nothing on the settings screen is a rule nobody uses. */
    expect(citableRules().every((r) => cited.has(r.id))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("🔴 the decision", () => {
  it("erases where no law is attached", () => {
    expect(decide({ ruleId: null }).action).toBe("delete");
  });

  /**
   * 🔴 `unverified` NEVER AUTO-RESOLVES, IN EITHER DIRECTION.
   *
   * Rounding it down destroys a record somebody needed. Rounding it up
   * refuses a statutory right on a hunch. Both are wrong, so it goes to
   * a person — and it does so even when the caller claims the period has
   * expired, because the period is the thing that could not be
   * established.
   */
  it("refers an unverified rule to a person, even when told the period expired", () => {
    expect(decide({ ruleId: "rera-state-rules" }).action).toBe("refer");
    expect(decide({ ruleId: "rera-state-rules", periodExpired: true }).action).toBe("refer");
  });

  /**
   * ⭐ THE EXCEPTION IS TIME-BOUND AND SO IS THE REFUSAL. s.8(7) does not
   * permit keeping a record for ever because a law once required it for
   * six years.
   */
  it("revives the duty to erase when a statutory period has run", () => {
    const still = decide({ ruleId: "cgst-36" });
    const expired = decide({ ruleId: "cgst-36", periodExpired: true });
    expect(still.action).toBe("retain");
    expect(expired.action).toBe("delete");
    expect(expired.because).toContain("s.36");
  });

  it("lets a human-placed hold beat everything", () => {
    const v = decide({ ruleId: null, legalHold: true });
    expect(v.action).toBe("retain");
    expect(v.rule?.kind).toBe("legal-hold");
  });

  it("attaches a rule to every refusal it issues", () => {
    for (const id of RETENTION_RULE_IDS) {
      const v = decide({ ruleId: id });
      if (v.action === "delete") continue;
      expect(v.rule).not.toBeNull();
      expect(v.because.length).toBeGreaterThan(20);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the erasure plan and its notice", () => {
  const plan = () =>
    buildErasurePlan({
      exportPlan: buildExportPlan({
        anchors: [
          { kind: "contact", id: "11111111-1111-1111-1111-111111111111", establishedBy: "fixture" },
          { kind: "lead", id: "22222222-2222-2222-2222-222222222222", establishedBy: "fixture" },
        ],
        identifiers: { emails: ["someone@example.invalid"], phones: ["9876543210"] },
      }),
    });

  it("names a rule on every retained table and none on a plain delete", () => {
    for (const t of plan().tables) {
      if (t.action === "retain") expect(t.rule).not.toBeNull();
      if (t.action === "delete" && !t.couldNotSearch) {
        /** A delete may carry a rule only when the rule's period has run. */
        expect(t.rule === null || t.because.includes("no longer requires")).toBe(true);
      }
    }
  });

  /**
   * 🔴 A PLAN WITH ANYTHING WAITING ON A PERSON IS BLOCKED. An erasure
   * that ran on the tables it was sure about would leave somebody partly
   * erased with no way to say which half.
   */
  it("blocks itself whenever a rule needs a person", () => {
    const p = plan();
    expect(p.blocked).toBe(p.summary.referred > 0);
  });

  it("separates a table it could not search from a table with nothing in it", () => {
    const p = plan();
    for (const t of p.tables) {
      if (!t.couldNotSearch) continue;
      expect(t.action).toBe("refer");
      /** ⚠️ And it says it is OUR gap, not a legal refusal. */
      expect(t.because).toContain("not a legal refusal");
    }
  });

  it("writes a notice that names a provision for everything it kept", () => {
    const p = plan();
    const notice = refusalNotice({
      plan: p,
      workspaceName: "A Workspace",
      principalLabel: "A Person",
      requestReference: "DPR-2026-0001",
      onDate: "2026-08-19",
    });
    expect(notice).toContain("Section 8(7)");
    for (const r of p.refusals) {
      expect(notice).toContain(r.rule.provision);
      expect(notice).toContain(r.rule.period);
    }
    /** ⭐ And it tells the person they can argue. */
    expect(notice).toContain("Data Protection Board of India");
  });

  /**
   * ⭐ THE SECTION MOST DOCUMENTS OF THIS KIND DO NOT HAVE.
   */
  it("admits in the notice where it could not look", () => {
    const p = plan();
    if (p.summary.couldNotSearch === 0) return;
    const notice = refusalNotice({
      plan: p,
      workspaceName: "A Workspace",
      principalLabel: "A Person",
      requestReference: "DPR-2026-0001",
      onDate: "2026-08-19",
    });
    expect(notice).toContain("WHERE WE COULD NOT LOOK");
  });
});

/* ------------------------------------------------------------------ */

describe("🔴 the breach intimation", () => {
  const complete: BreachFacts = {
    reference: "PDB-2026-0001",
    noticedAt: new Date("2026-08-19T09:00:00.000Z"),
    occurredAt: new Date("2026-08-18T22:00:00.000Z"),
    nature: "An export endpoint returned rows belonging to another workspace.",
    extent: "Fourteen contact records.",
    timingAndLocation: "Between 22:00 and 22:40 IST on 18 August 2026, on the production database.",
    likelyConsequences: "Names, email addresses and phone numbers were visible to one other customer.",
    mitigationImplemented: "The endpoint was withdrawn and the policy corrected.",
    safeguardsForPrincipals: "Be alert to unexpected contact claiming to be from us.",
    contactPerson: "privacy@example.invalid",
    affectedPrincipalCount: 14,
  };

  it("produces a document containing every element Rule 7 requires", () => {
    const { text, missing } = intimationToPrincipal({
      facts: complete,
      workspaceName: "A Workspace",
      principalLabel: "A Person",
      onDate: "2026-08-19",
    });
    expect(missing).toEqual([]);
    for (const heading of [
      "WHAT HAPPENED",
      "HOW MUCH WAS AFFECTED",
      "WHEN AND WHERE",
      "WHAT IT MAY MEAN FOR YOU",
      "WHAT WE HAVE DONE",
      "WHAT YOU CAN DO",
      "WHO TO CONTACT",
    ]) {
      expect(text).toContain(heading);
    }
  });

  /**
   * 🔴 THE FAILURE THAT READS AS COMPLIANCE: a five-element requirement
   * answered in four. The letter exists, it goes out, and nobody counts
   * the paragraphs.
   */
  it("refuses to pretend a draft missing an element is sendable", () => {
    const { text, missing } = intimationToPrincipal({
      facts: { ...complete, safeguardsForPrincipals: "" },
      workspaceName: "A Workspace",
      principalLabel: "A Person",
      onDate: "2026-08-19",
    });
    expect(missing.length).toBeGreaterThan(0);
    expect(text).toContain("Do not send it in this form");
  });

  it("will not let a breach be closed with an audience untold", () => {
    const blockers = blockersToClosing({
      facts: complete,
      boardIntimatedAt: new Date("2026-08-19T10:00:00.000Z"),
      principalsIntimatedAt: null,
      intimationText: null,
    });
    expect(blockers.join(" ")).toContain("Data Principals have not been told");
  });

  it("will not let a sent intimation go unrecorded", () => {
    const blockers = blockersToClosing({
      facts: complete,
      boardIntimatedAt: new Date("2026-08-19T10:00:00.000Z"),
      principalsIntimatedAt: new Date("2026-08-19T11:00:00.000Z"),
      intimationText: null,
    });
    expect(blockers.join(" ")).toContain("frozen as sent");
  });

  /* --- the two clocks --------------------------------------------- */

  /**
   * 🔴 BOTH RUN FROM NOTICING. A team that waits until it is certain has
   * already missed the six hours.
   */
  it("runs CERT-In's six hours from noticing, not from occurring", () => {
    const d = deadlines({
      facts: complete,
      certinReportedAt: null,
      boardIntimatedAt: null,
      boardDetailedReportAt: null,
      principalsIntimatedAt: null,
      now: new Date("2026-08-19T10:00:00.000Z"),
    });
    const certin = d.find((x) => x.provision.includes("CERT-In"));
    expect(certin?.dueBy.toISOString()).toBe("2026-08-19T15:00:00.000Z");
    /** ⭐ Occurrence was eleven hours earlier and does not move it. */
    expect(certin?.dueBy.getTime()).toBe(complete.noticedAt.getTime() + 6 * 3_600_000);
  });

  it("treats CERT-In as in force today and Rule 7 as not yet", () => {
    const now = new Date("2026-08-19T10:00:00.000Z");
    expect(now < DPDP_RULE_7_COMMENCEMENT).toBe(true);
    const d = deadlines({
      facts: complete,
      certinReportedAt: null,
      boardIntimatedAt: null,
      boardDetailedReportAt: null,
      principalsIntimatedAt: null,
      now,
    });
    expect(d.find((x) => x.provision.includes("CERT-In"))?.inForce).toBe(true);
    expect(d.filter((x) => x.provision.includes("Rule 7")).every((x) => !x.inForce)).toBe(true);
  });

  it("marks Rule 7 overdue once the Rules are in force and the time has run", () => {
    const d = deadlines({
      facts: { ...complete, noticedAt: new Date("2027-06-01T00:00:00.000Z") },
      certinReportedAt: null,
      boardIntimatedAt: null,
      boardDetailedReportAt: null,
      principalsIntimatedAt: null,
      now: new Date("2027-06-10T00:00:00.000Z"),
    });
    expect(d.every((x) => x.state === "overdue")).toBe(true);
  });

  it("counts a duty as done the moment it is recorded, whatever the clock says", () => {
    const d = deadlines({
      facts: complete,
      certinReportedAt: new Date("2026-08-25T00:00:00.000Z"),
      boardIntimatedAt: null,
      boardDetailedReportAt: null,
      principalsIntimatedAt: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });
    /** ⚠️ Late is still done. A screen that reported it as overdue for ever would be read as noise. */
    expect(d.find((x) => x.provision.includes("CERT-In"))?.state).toBe("done");
  });
});
