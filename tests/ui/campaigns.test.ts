/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 9 — CAMPAIGNS.
 *
 * 🔴 THE FIVE FAILURES THIS SUITE PINS DOWN.
 *
 *   ① Storing the FILTER and re-running it at send time. The list that
 *      goes out is then not the list that was approved: somebody who
 *      enquired in the intervening twenty minutes receives a campaign
 *      nobody decided to send them, and the approved count is a lie.
 *
 *   ② A silent exclusion. A list of 9,000 that becomes 6,000 is how a
 *      firm spends a year not talking to a third of its customers.
 *
 *   ③ A tick box on the only action in Ordence that spends thousands of
 *      rupees and cannot be recalled.
 *
 *   ④ A retry on WhatsApp error 131049. That is the per-user marketing
 *      limit, and trying again can block delivery to that person for a
 *      further day.
 *
 *   ⑤ A stop button the runner reads once at the start. The moment
 *      somebody notices the wording is wrong is ninety seconds in.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MARKETING_GAP_DAYS,
  formatMinor,
  headlineFor,
  resolveAudience,
  type AudienceCandidate,
} from "@/lib/campaigns/audience";
import {
  DEFAULT_AUDIENCE_STALE_HOURS,
  PER_USER_LIMIT_ERROR,
  amountsMatch,
  checkApproval,
  shouldRetry,
  type ApprovalRequest,
} from "@/lib/campaigns/approval";
import type { ConsentRecord } from "@/lib/crm/consent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0067_campaigns.sql");
const SQL_CODE = sqlCode(SQL);
const RUN = read("server/campaigns/run.ts");
const ACTIONS = read("server/actions/campaigns.ts");
const PAGE = read("app/(crm)/campaigns/page.tsx");

const NOW = new Date("2026-08-13T10:00:00.000Z");

/** A live marketing grant against a notice. */
function granted(): ConsentRecord[] {
  return [
    {
      id: "c1",
      purpose: "marketing",
      channel: "whatsapp",
      state: "granted",
      noticeId: "n1",
      grantedAt: "2026-01-01T00:00:00.000Z",
      withdrawnAt: null,
    },
  ];
}

function withdrawn(): ConsentRecord[] {
  return [
    ...granted(),
    {
      id: "c2",
      purpose: "all",
      channel: "all",
      state: "withdrawn",
      noticeId: null,
      grantedAt: null,
      withdrawnAt: "2026-03-04T00:00:00.000Z",
    },
  ];
}

function candidate(over: Partial<AudienceCandidate> = {}): AudienceCandidate {
  return {
    subjectType: "contact",
    subjectId: "00000000-0000-0000-0000-000000000001",
    displayName: "Ravi",
    phone: "+91 98765 43210",
    consents: granted(),
    window: null,
    lastMarketingAt: null,
    ...over,
  };
}

/* ================================================================== */
/* ⭐⭐⭐ ① THE AUDIENCE IS ROWS, NOT A FILTER                         */
/* ================================================================== */

describe("⭐⭐ the frozen audience", () => {
  /**
   * 🔴 THE HEADLINE. Every marketing tool stores the filter and re-runs
   * it, so the list that goes out is not the list that was approved.
   */
  it("keeps the filter as evidence and never re-runs it", () => {
    expect(SQL).toContain("KEPT AS EVIDENCE OF HOW THE LIST WAS BUILT AND");
    expect(SQL_CODE).toContain("audience_filter");
    // ⚠️ The run reads rows. It must not touch the filter at all.
    expect(code(RUN)).not.toContain("audienceFilter");
  });

  it("writes one row per person, included or not", () => {
    expect(SQL_CODE).toContain("CREATE TABLE IF NOT EXISTS campaign_recipients");
    expect(flat(SQL_CODE)).toContain("is_included boolean NOT NULL");
  });

  /** 🔴 The same customer twice is two messages and one complaint. */
  it("refuses the same person twice in one campaign", () => {
    expect(flat(SQL_CODE)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_unique ON campaign_recipients (campaign_id, subject_type, subject_id)",
    );
  });

  /**
   * 🔴🔴 THE APPROVED FIGURES MUST MATCH THE AUDIENCE THAT EXISTS. A
   * product that resolves a list and then approves a different number
   * has moved the bug one table along.
   */
  it("refuses an approval whose numbers do not match the list", () => {
    expect(SQL_CODE).toContain("IF NEW.approved_recipients <> v_included THEN");
    expect(SQL_CODE).toContain("IF NEW.approved_cost_minor <> v_cost THEN");
  });

  /** ⚠️ Nobody may be added after approval. */
  it("refuses to add a recipient after approval", () => {
    expect(SQL_CODE).toContain(
      "Nobody may be added to a campaign that has already been approved",
    );
  });

  it("refuses to change who is in or what it costs after approval", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.is_included IS DISTINCT FROM OLD.is_included",
    );
  });

  /** ⭐ But the run must still be able to record what happened. */
  it("still lets the run write the outcome onto the row", () => {
    const guard = SQL_CODE.slice(
      SQL_CODE.indexOf("FUNCTION ordence_guard_campaign_audience"),
      SQL_CODE.indexOf("trg_guard_campaign_audience"),
    );
    expect(guard).not.toContain("send_outcome IS DISTINCT FROM");
  });

  /**
   * ⚠️ A CAMPAIGN THAT HAS GONE OUT CANNOT BE UN-APPROVED. The messages
   * have left; changing the record makes the trail say nobody authorised
   * them.
   */
  it("refuses to return a sent campaign to draft", () => {
    expect(SQL_CODE).toContain(
      "OLD.status IN ('sending', 'sent', 'stopped')",
    );
  });

  it("demands a whole approval or none of it", () => {
    expect(flat(SQL_CODE)).toContain("CONSTRAINT campaigns_approval_is_whole");
    expect(flat(SQL_CODE)).toContain("approved_amount_typed IS NOT NULL");
  });

  it("refuses to approve a campaign whose audience was never resolved", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT campaigns_approved_has_an_audience",
    );
  });
});

/* ================================================================== */
/* ⭐⭐ ② NOBODY IS DROPPED SILENTLY                                   */
/* ================================================================== */

describe("⭐⭐ who was left out, and why", () => {
  it("includes somebody who agreed and has a number", () => {
    const a = resolveAudience({
      candidates: [candidate()],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.included).toBe(1);
    expect(a.estimatedCostMinor).toBe(109n);
  });

  /**
   * 🔴 CONSENT, AND `hasLegitimateContractualBasis` IS NOT PASSED. This
   * is marketing; "we have a contract" is the excuse every firm reaches
   * for when it wants to send an offer.
   */
  it("excludes somebody who withdrew, and says so", () => {
    const a = resolveAudience({
      candidates: [candidate({ consents: withdrawn() })],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.included).toBe(0);
    expect(a.recipients[0]?.exclusionCode).toBe("no_consent");
    expect(a.recipients[0]?.exclusionReason).toBeTruthy();
  });

  /** ⚠️ Silence is not consent. No record means no permission. */
  it("excludes somebody with no consent record at all", () => {
    const a = resolveAudience({
      candidates: [candidate({ consents: [] })],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.recipients[0]?.exclusionCode).toBe("no_consent");
  });

  /**
   * 🔴 A HARD SUPPRESSION OUTRANKS A LIVE CONSENT RECORD. It was set by
   * a person who had a reason, and a system that lets a later automated
   * grant override it will message somebody who complained in writing.
   */
  it("puts a hold above any consent record", () => {
    const a = resolveAudience({
      candidates: [candidate({ suppressed: true, consents: granted() })],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.recipients[0]?.exclusionCode).toBe("suppressed");
  });

  /** ⚠️ Worth fixing: this person agreed to hear from you and cannot. */
  it("excludes a missing number and says it is worth fixing", () => {
    const a = resolveAudience({
      candidates: [candidate({ phone: null })],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.recipients[0]?.exclusionCode).toBe("no_number");
    expect(a.recipients[0]?.exclusionReason).toContain("Worth fixing");
  });

  /**
   * ⭐ THE SAME NUMBER TWICE IS ONE PERSON WITH TWO RECORDS. Excluded
   * rather than merged, because merging is destructive and belongs
   * behind a person's decision.
   */
  it("sends once to a number that appears twice", () => {
    const a = resolveAudience({
      candidates: [
        candidate({ subjectId: "00000000-0000-0000-0000-000000000001" }),
        candidate({
          subjectId: "00000000-0000-0000-0000-000000000002",
          phone: "098765 43210",
        }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.included).toBe(1);
    expect(a.recipients[1]?.exclusionCode).toBe("duplicate_number");
  });

  /**
   * 🔴 THE GAP IS NOT TIDINESS. WhatsApp limits how many marketing
   * templates a person receives, invisibly, and punishes retries against
   * that limit.
   */
  it("excludes somebody messaged inside the gap", () => {
    const a = resolveAudience({
      candidates: [
        candidate({ lastMarketingAt: new Date(NOW.getTime() - 2 * 86_400_000) }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.recipients[0]?.exclusionCode).toBe("recently_messaged");
    expect(a.recipients[0]?.exclusionReason).toContain("not delivered");
    expect(DEFAULT_MARKETING_GAP_DAYS).toBe(7);
  });

  it("includes somebody messaged before the gap", () => {
    const a = resolveAudience({
      candidates: [
        candidate({ lastMarketingAt: new Date(NOW.getTime() - 30 * 86_400_000) }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.included).toBe(1);
  });

  /** ⚠️ A marketing message at six in the morning is a complaint. */
  it("excludes everybody during quiet hours", () => {
    // 10:00 UTC is 15:30 IST; quiet from 15:00 to 22:00 catches it.
    const a = resolveAudience({
      candidates: [candidate()],
      rateMinor: 109n,
      now: NOW,
      quietHours: [15, 22],
    });
    expect(a.recipients[0]?.exclusionCode).toBe("quiet_hours");
  });

  it("handles quiet hours that wrap past midnight", () => {
    const a = resolveAudience({
      candidates: [candidate()],
      rateMinor: 109n,
      now: NOW,
      quietHours: [21, 8],
    });
    // 15:30 IST is outside 21:00–08:00.
    expect(a.included).toBe(1);
  });

  /** ⭐ Marketing is charged inside an ordinary window. */
  it("still charges marketing inside the 24 hour window", () => {
    const a = resolveAudience({
      candidates: [
        candidate({
          window: {
            openedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
            isFreeEntryPoint: false,
          },
        }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.estimatedCostMinor).toBe(109n);
  });

  /** ⭐ But not inside a free entry point window. */
  it("does not charge inside a free entry point window", () => {
    const a = resolveAudience({
      candidates: [
        candidate({
          window: {
            openedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
            isFreeEntryPoint: true,
          },
        }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.estimatedCostMinor).toBe(0n);
    expect(a.freeCount).toBe(1);
  });

  it("groups the exclusions so the screen shows the shape of the loss", () => {
    const a = resolveAudience({
      candidates: [
        candidate({ subjectId: "00000000-0000-0000-0000-00000000000a", consents: [] }),
        candidate({ subjectId: "00000000-0000-0000-0000-00000000000b", consents: [] }),
        candidate({ subjectId: "00000000-0000-0000-0000-00000000000c", phone: null }),
      ],
      rateMinor: 109n,
      now: NOW,
    });
    expect(a.exclusionsByCode.no_consent).toBe(2);
    expect(a.exclusionsByCode.no_number).toBe(1);
  });

  /**
   * 🔴 THE HEADLINE NAMES THE SHRINKAGE BEFORE THE MONEY. "6,000
   * recipients · ₹6,540" hides the only interesting fact.
   */
  it("leads with how many were dropped", () => {
    expect(headlineFor(9000, 6000, 3000, 654_000n)).toContain("6000 of 9000");
    expect(headlineFor(9000, 6000, 3000, 654_000n)).toContain("3000 will not be messaged");
  });

  it("says plainly when nobody can be messaged", () => {
    expect(headlineFor(500, 0, 500, 0n)).toContain("Nothing will be sent");
  });

  /** 🔴 And the database refuses an exclusion with no reason. */
  it("demands a reason for every exclusion", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT campaign_recipients_exclusion_is_explained CHECK ( is_included OR (exclusion_code IS NOT NULL AND exclusion_reason IS NOT NULL) )",
    );
  });

  /** ⭐ And refuses to send to somebody who was excluded. */
  it("refuses to attach a message to an excluded person", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT campaign_recipients_excluded_are_not_sent CHECK ( is_included OR message_send_id IS NULL )",
    );
  });
});

/* ================================================================== */
/* ⭐⭐ ③ THE AMOUNT IS TYPED                                          */
/* ================================================================== */

describe("⭐⭐ approving", () => {
  const base: ApprovalRequest = {
    status: "review",
    audienceResolvedAt: new Date(NOW.getTime() - 3_600_000),
    includedCount: 600,
    estimatedCostMinor: 654_00n,
    typedAmount: "₹654.00",
    approverId: "u1",
    createdBy: "u2",
    templateMaySend: true,
    templateReason: "",
    dailySendCap: null,
    sentTodayCount: 0,
    dailySpendCapMinor: null,
    spentTodayMinor: 0n,
  };

  it("approves when everything is in order", () => {
    expect(checkApproval(base, NOW).mayApprove).toBe(true);
  });

  /**
   * ⭐ FORGIVING ABOUT FORMATTING, EXACT ABOUT THE NUMBER. Rejecting
   * somebody on a comma teaches them to copy and paste, which defeats
   * the entire control.
   */
  it("accepts the amount however it is punctuated", () => {
    for (const typed of ["654", "654.00", "₹654.00", "654.0", " ₹ 654 "]) {
      expect(amountsMatch(typed, "₹654.00")).toBe(true);
    }
  });

  it("refuses a different number", () => {
    expect(amountsMatch("655", "₹654.00")).toBe(false);
    expect(amountsMatch("65400", "₹654.00")).toBe(false);
    expect(amountsMatch("", "₹654.00")).toBe(false);
    expect(amountsMatch("six hundred", "₹654.00")).toBe(false);
  });

  it("blocks when the amount is not typed at all", () => {
    const v = checkApproval({ ...base, typedAmount: "" }, NOW);
    expect(v.mayApprove).toBe(false);
    expect(v.blocks[0]?.code).toBe("amount_not_typed");
    expect(v.blocks[0]?.remedy).toContain("not a tick box");
  });

  /** ⚠️ And says the surprise IS the control working. */
  it("treats a mismatch as the check working", () => {
    const v = checkApproval({ ...base, typedAmount: "100" }, NOW);
    expect(v.blocks[0]?.code).toBe("amount_mismatch");
    expect(v.blocks[0]?.remedy).toContain("that is the check working");
  });

  /**
   * 🔴 A LIST BUILT ON FRIDAY AND APPROVED ON MONDAY has three days of
   * withdrawn consents in it, and those are the ones that matter most.
   */
  it("refuses a stale audience", () => {
    const v = checkApproval(
      { ...base, audienceResolvedAt: new Date(NOW.getTime() - 48 * 3_600_000) },
      NOW,
    );
    expect(v.mayApprove).toBe(false);
    expect(v.blocks.some((b) => b.code === "audience_stale")).toBe(true);
    expect(DEFAULT_AUDIENCE_STALE_HOURS).toBe(24);
  });

  it("refuses when the audience was never resolved", () => {
    const v = checkApproval({ ...base, audienceResolvedAt: null }, NOW);
    expect(v.blocks.some((b) => b.code === "no_audience")).toBe(true);
    expect(v.blocks.find((b) => b.code === "no_audience")?.remedy).toContain(
      "approving a guess",
    );
  });

  it("refuses an empty audience", () => {
    const v = checkApproval({ ...base, includedCount: 0 }, NOW);
    expect(v.blocks.some((b) => b.code === "empty_audience")).toBe(true);
  });

  it("refuses a template that cannot be sent", () => {
    const v = checkApproval(
      { ...base, templateMaySend: false, templateReason: "Paused by Meta." },
      NOW,
    );
    expect(v.blocks.some((b) => b.code === "template_unusable")).toBe(true);
  });

  /**
   * 🔴 A CAMPAIGN THAT STOPS AT MESSAGE 4,000 OF 6,000 has told four
   * thousand people about an offer and left two thousand out, which is
   * worse than not sending it at all.
   */
  it("refuses a campaign that would not fit under today's ceiling", () => {
    const v = checkApproval(
      { ...base, dailySendCap: 500, sentTodayCount: 100 },
      NOW,
    );
    expect(v.mayApprove).toBe(false);
    const block = v.blocks.find((b) => b.code === "over_ceiling");
    expect(block?.remedy).toContain("worse than not sending it");
  });

  it("refuses one that would not fit under the spend ceiling", () => {
    const v = checkApproval(
      { ...base, dailySpendCapMinor: 100_00n, spentTodayMinor: 0n },
      NOW,
    );
    expect(v.blocks.some((b) => b.code === "over_ceiling")).toBe(true);
  });

  /**
   * ⚠️ EVERY BLOCK IS RETURNED, not only the first. Somebody fixing an
   * approval screen one error at a time gives up, and giving up here
   * means sending it from a phone instead.
   */
  it("reports every block at once", () => {
    const v = checkApproval(
      {
        ...base,
        audienceResolvedAt: null,
        includedCount: 0,
        typedAmount: "",
        templateMaySend: false,
        templateReason: "Paused.",
      },
      NOW,
    );
    expect(v.blocks.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * ⭐ THE SECOND PAIR OF EYES IS OFF BY DEFAULT. A one-person firm
   * cannot supply a second person, and a control that makes the product
   * unusable for them is a control they switch off entirely.
   */
  it("allows self-approval unless the workspace asks otherwise", () => {
    expect(checkApproval({ ...base, createdBy: "u1" }, NOW).mayApprove).toBe(true);
    const strict = checkApproval(
      { ...base, createdBy: "u1", requiresSecondPerson: true },
      NOW,
    );
    expect(strict.blocks.some((b) => b.code === "self_approval")).toBe(true);
  });

  /** ⚠️ Warnings do not block. */
  it("suggests a test send on a large list without blocking it", () => {
    const v = checkApproval({ ...base, includedCount: 5000 }, NOW);
    expect(v.mayApprove).toBe(true);
    expect(v.warnings.some((w) => w.includes("twenty"))).toBe(true);
  });

  /**
   * ⭐ A FREE MARKETING CAMPAIGN IS SUSPICIOUS, not a saving: it usually
   * means a utility template is being used as one, which is a policy
   * problem.
   */
  it("questions a marketing campaign that costs nothing", () => {
    const v = checkApproval({ ...base, estimatedCostMinor: 0n, typedAmount: "0" }, NOW);
    expect(v.warnings.some((w) => w.includes("policy problem"))).toBe(true);
  });

  it("tells the person exactly what to type", () => {
    expect(checkApproval(base, NOW).expectedAmount).toBe("₹654.00");
  });

  /** 🔴 The action records it as critical, like a suspension. */
  it("audits an approval as critical", () => {
    const approve = ACTIONS.slice(ACTIONS.indexOf("export async function approveCampaign"));
    expect(approve).toContain('severity: "critical"');
  });
});

/* ================================================================== */
/* ⭐⭐ ④ 131049 IS NEVER RETRIED                                      */
/* ================================================================== */

describe("⭐⭐ the per-user marketing limit", () => {
  /**
   * 🔴🔴 WhatsApp limits how many marketing templates a person receives
   * "when they are less likely to be receptive" — dynamic, personalised
   * and unpublished. The message comes back undelivered, and repeated
   * attempts within 24 hours can block delivery to them for a day.
   */
  it("never retries 131049", () => {
    const v = shouldRetry(PER_USER_LIMIT_ERROR);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain("makes it worse");
    expect(PER_USER_LIMIT_ERROR).toBe("131049");
  });

  it("never retries an unreachable number", () => {
    expect(shouldRetry("131026").retry).toBe(false);
  });

  /** ⭐ Rate limiting IS retryable, more slowly. */
  it("retries a rate limit", () => {
    expect(shouldRetry("131056").retry).toBe(true);
  });

  /**
   * ⚠️ AND THE DEFAULT IS NOT TO RETRY. A marketing message that failed
   * once is not worth risking a second charge and a second complaint.
   */
  it("does not retry by default", () => {
    expect(shouldRetry("some_new_code").retry).toBe(false);
    expect(shouldRetry(null).retry).toBe(false);
  });

  /** 🔴 And the run records WHY it will not retry, so nobody adds one. */
  it("writes the no-retry reason onto the recipient row", () => {
    expect(RUN).toContain("shouldRetry(");
    expect(RUN).toContain("retry.reason");
  });
});

/* ================================================================== */
/* ⭐⭐ ⑤ THE STOP BUTTON                                              */
/* ================================================================== */

describe("⭐⭐ stopping", () => {
  /**
   * 🔴 CHECKED PER MESSAGE, IN THE DATABASE. A flag the runner reads
   * once at the start is not a stop button.
   */
  it("enforces the stop on every message insert", () => {
    expect(SQL_CODE).toContain("FUNCTION ordence_enforce_campaign_stop");
    expect(SQL_CODE).toContain("BEFORE INSERT ON message_sends");
    expect(SQL_CODE).toContain("This campaign was stopped");
  });

  /** ⭐ And a campaign nobody approved sends nothing, whatever the caller believes. */
  it("refuses to send from an unapproved campaign at the database", () => {
    expect(SQL_CODE).toContain(
      "Marketing messages are not sent from a campaign nobody has authorised",
    );
  });

  /** ⚠️ The runner checks it too, inside the loop, so it bites in seconds. */
  it("re-reads the stop inside the loop, not only per batch", () => {
    const loop = RUN.slice(RUN.indexOf("for (const r of batch"));
    expect(loop.indexOf("stopRequestedAt")).toBeLessThan(loop.indexOf("sendUtilityMessage"));
  });

  it("says why it is checked twice", () => {
    expect(RUN).toContain("Twice, deliberately");
  });

  /** 🔴 A stop names who and why. "It stopped" is not an answer. */
  it("demands who stopped it and why", () => {
    expect(flat(SQL_CODE)).toContain("CONSTRAINT campaigns_stop_is_explained");
  });

  /** ⚠️ Short reason field: a long form on a stop button is a button nobody presses. */
  it("asks for a short reason on the stop action", () => {
    expect(ACTIONS).toContain("reason: z.string().min(3).max(500)");
    expect(ACTIONS).toContain("a stop button nobody presses");
  });
});

/* ================================================================== */
/* ⭐ THE RUN READS THE FROZEN LIST                                    */
/* ================================================================== */

describe("⭐⭐ the run", () => {
  /**
   * 🔴 IT READS ROWS. It does not re-run the filter, does not re-check
   * who qualifies, and does not add anybody.
   */
  it("selects the frozen recipients and nothing else", () => {
    expect(RUN).toContain("from(campaignRecipients)");
    expect(code(RUN)).not.toContain("resolveAudience");
  });

  /**
   * ⭐⭐ CONSENT IS THE ONE THING RE-READ. The audience is frozen so
   * nobody is ADDED; a withdrawal is somebody removing themselves, which
   * must win however late it arrives.
   */
  it("re-reads consent per person", () => {
    expect(RUN).toContain("consentsFor(");
    expect(RUN).toContain("must win however late it arrives");
  });

  /**
   * ⭐ THE KEY NAMES THE CAMPAIGN AND THE PERSON, so re-running a
   * half-finished campaign after a deploy cannot message anybody twice.
   */
  it("cannot message the same person twice on a re-run", () => {
    expect(RUN).toContain('subjectType: "campaign"');
    expect(RUN).toContain("purpose: `${subjectType}-${subjectId}`");
  });

  /**
   * ⚠️ A REFUSAL AND A FAILURE ARE DIFFERENT ANSWERS to "why did this
   * customer not hear from us".
   */
  it("separates what we refused from what WhatsApp refused", () => {
    expect(RUN).toContain('sendOutcome: isRefusal ? "skipped" : "failed"');
  });

  it("batches so the stop can take effect between commits", () => {
    expect(RUN).toContain("batchSize");
    expect(flat(RUN)).toContain("the stop button cannot * take effect inside a transaction that has not committed");
  });
});

describe("⭐ 0067's own rules", () => {
  /**
   * ⭐ The outcome view reports the actual cost beside the approved one,
   * because billing is on delivery and the two are never equal.
   */
  it("reports actual cost from the receipts, beside what was approved", () => {
    expect(SQL_CODE).toContain("CREATE OR REPLACE VIEW v_campaign_outcome");
    expect(SQL_CODE).toContain("actual_cost_minor");
    expect(SQL_CODE).toContain("never_reached");
  });

  /** 🔴 A campaign that reached some customers and not others. */
  it("names the people in an approved audience who were never messaged", () => {
    expect(flat(PAGE)).toContain("were never messaged");
    expect(flat(PAGE)).toContain("worse than one that was never sent");
  });

  it("puts platform scope in USING and never in WITH CHECK", () => {
    const policies = SQL_CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(2);
    for (const p of policies) {
      expect(p.slice(p.indexOf("WITH CHECK"))).not.toContain("app_platform_scope");
    }
  });

  it("formats money the way the rest of the system does", () => {
    expect(formatMinor(654_00n)).toBe("₹654.00");
    expect(formatMinor(10_90_000n)).toBe("₹10,900.00");
  });
});
