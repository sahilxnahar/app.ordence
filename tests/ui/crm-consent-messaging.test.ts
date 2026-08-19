/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 3 AND 4 — CRM, CONSENT AND CONVERSATIONS.
 *
 * 🔴 THREE FAILURES THIS SUITE EXISTS TO PIN DOWN.
 *
 *   ① The same man enquires three times as "+91 98765 43210",
 *      "098765 43210" and "9876543210". A duplicate check on the raw
 *      text finds none of them.
 *
 *   ② Consent recorded as a boolean is not consent. The DPDP Rules 2025
 *      were notified on 13 November 2025 and the penalty regime begins
 *      May 2027. What matters is the notice shown, the purpose agreed,
 *      and whether one withdrawal reaches every channel.
 *
 *   ③ A conversation about an invoice that can be silently rewritten,
 *      or that anybody can post into, is worse than no record, because
 *      people will rely on it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  ConsentError,
  DEFAULT_RATES_MINOR,
  estimateSendCost,
  formatMinor,
  mayContact,
  splitAudience,
  type ConsentRecord,
} from "@/lib/crm/consent";
import {
  canMerge,
  findDuplicates,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  type Candidate,
} from "@/lib/crm/dedupe";
import {
  compareThreads,
  extractHandles,
  summariseInbox,
  threadState,
  ThreadError,
  type ThreadRow,
} from "@/lib/work/threads";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0061_crm_consent_messaging.sql");
const CONSENT_LIB = read("lib/crm/consent.ts");
const DEDUPE_LIB = read("lib/crm/dedupe.ts");
const THREADS_LIB = read("lib/work/threads.ts");
const CONSENT_ACTIONS = read("server/actions/consent.ts");
const MESSAGE_ACTIONS = read("server/actions/messages.ts");
const CONSENT_PAGE = read("app/(crm)/crm/consent/page.tsx");
const MESSAGES_PAGE = read("app/(crm)/messages/page.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const SCHEMA = read("db/schema/front-office.ts");
const SALES_SCHEMA = read("db/schema/sales.ts");

/* ================================================================== */
/* ① THE SAME MAN, THREE TIMES                                        */
/* ================================================================== */

describe("🔴 a phone number is the last ten digits, however it was typed", () => {
  it("reduces every form of the same number to the same key", () => {
    const forms = [
      "+91 98765 43210",
      "098765 43210",
      "9876543210",
      "+919876543210",
      "91-98765-43210",
      "(0)98765 43210",
    ];
    const keys = new Set(forms.map(normalisePhone));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("9876543210");
  });

  it("🔴 takes the LAST ten, not the first", () => {
    /** Taking from the front gets two of the three common forms wrong. */
    expect(normalisePhone("919876543210")).toBe("9876543210");
    expect(normalisePhone("09876543210")).toBe("9876543210");
  });

  it("returns empty for nothing, and empty never matches", () => {
    expect(normalisePhone(null)).toBe("");
    expect(normalisePhone("")).toBe("");
    expect(normalisePhone("   ")).toBe("");
  });

  it("lowercases and trims an email and does nothing clever", () => {
    expect(normaliseEmail("  Sharma@Example.COM ")).toBe("sharma@example.com");
    /**
     * 🔴 Dots are NOT stripped. That is a Gmail convention, not an email
     * standard, and on many corporate servers a.sharma@ and asharma@
     * are two different people.
     */
    expect(normaliseEmail("a.sharma@corp.in")).not.toBe(normaliseEmail("asharma@corp.in"));
  });

  it("strips honorifics and punctuation from a name", () => {
    expect(normaliseName("Mr. Rajesh  Kumar")).toBe("rajesh kumar");
    expect(normaliseName("M/s Sharma & Co.")).toBe("sharma co");
  });
});

describe("🔴 duplicates are surfaced, never merged automatically", () => {
  const existing: Candidate[] = [
    { id: "a", name: "Rajesh Kumar", email: "rajesh@corp.in", phone: "+91 98765 43210" },
    { id: "b", name: "Rajesh Kumar", email: "other@corp.in", phone: "9000000000" },
    { id: "c", name: "Someone Else", email: null, phone: "9111111111" },
  ];

  it("calls a phone match certain, whatever the formatting", () => {
    const hits = findDuplicates({
      incoming: { id: "new", name: "R Kumar", email: null, phone: "098765 43210" },
      existing,
    });
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.strength).toBe("certain");
    expect(hits[0]?.matchedOn).toContain("phone");
  });

  it("⚠️ calls a NAME-only match no better than possible", () => {
    const hits = findDuplicates({
      incoming: { id: "new", name: "Rajesh Kumar", email: null, phone: "9222222222" },
      existing,
    });
    /** Ten thousand people are called Rajesh Kumar. */
    expect(hits.every((h) => h.strength === "possible")).toBe(true);
  });

  it("puts the strongest match first", () => {
    const hits = findDuplicates({
      incoming: {
        id: "new",
        name: "Rajesh Kumar",
        email: "rajesh@corp.in",
        phone: "9876543210",
      },
      existing,
    });
    expect(hits[0]?.strength).toBe("certain");
  });

  it("never matches two blanks to each other", () => {
    const hits = findDuplicates({
      incoming: { id: "new", name: null, email: null, phone: null },
      existing: [{ id: "x", name: null, email: null, phone: null }],
    });
    expect(hits).toHaveLength(0);
  });

  it("does not match a record against itself", () => {
    const hits = findDuplicates({
      incoming: existing[0] as Candidate,
      existing,
    });
    expect(hits.some((h) => h.id === "a")).toBe(false);
  });
});

describe("🔴 some merges are not available", () => {
  const base = {
    sourceId: "s",
    targetId: "t",
    sourceIsAlreadyMerged: false,
    sourceHasConverted: false,
    strength: "certain" as const,
  };

  it("allows a clean certain match", () => {
    expect(canMerge(base).allowed).toBe(true);
  });

  it("🔴 refuses to fold away an enquiry that turned into real business", () => {
    const v = canMerge({ ...base, sourceHasConverted: true });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/real business|detach/i);
  });

  it("refuses a chain of merges", () => {
    expect(canMerge({ ...base, sourceIsAlreadyMerged: true }).allowed).toBe(false);
  });

  it("⚠️ refuses to merge on a name alone", () => {
    const v = canMerge({ ...base, strength: "possible" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/shared name is not evidence/i);
  });

  it("refuses to merge a record into itself", () => {
    expect(canMerge({ ...base, targetId: "s" }).allowed).toBe(false);
  });
});

/* ================================================================== */
/* ② CONSENT                                                          */
/* ================================================================== */

const GRANT = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: "g1",
  purpose: "marketing",
  channel: "all",
  state: "granted",
  noticeId: "n1",
  grantedAt: "2026-01-10T00:00:00.000Z",
  withdrawnAt: null,
  ...over,
});

const WITHDRAW = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: "w1",
  purpose: "all",
  channel: "all",
  state: "withdrawn",
  noticeId: null,
  grantedAt: null,
  withdrawnAt: "2026-05-01T00:00:00.000Z",
  ...over,
});

describe("🔴 silence is not consent", () => {
  it("refuses when there is nothing on file", () => {
    const v = mayContact({ records: [], purpose: "marketing", channel: "whatsapp" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/Silence is not consent/i);
  });

  it("allows a grant that covers the purpose and the channel", () => {
    const v = mayContact({
      records: [GRANT()],
      purpose: "marketing",
      channel: "whatsapp",
    });
    expect(v.allowed).toBe(true);
    expect(v.decidedBy).toBe("g1");
  });

  it("🔴 IGNORES a grant with no notice behind it", () => {
    const v = mayContact({
      records: [GRANT({ noticeId: null })],
      purpose: "marketing",
      channel: "whatsapp",
    });
    /** It says somebody agreed and does not say what to. */
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/does not name the notice/i);
  });

  it("does not let a marketing question be answered by a service consent", () => {
    const v = mayContact({
      records: [GRANT({ purpose: "service" })],
      purpose: "marketing",
      channel: "email",
    });
    expect(v.allowed).toBe(false);
  });

  it("does not let an email consent authorise a WhatsApp message", () => {
    const v = mayContact({
      records: [GRANT({ channel: "email" })],
      purpose: "marketing",
      channel: "whatsapp",
    });
    expect(v.allowed).toBe(false);
  });

  it("refuses to be asked about 'all' as a question", () => {
    expect(() =>
      mayContact({ records: [], purpose: "all", channel: "email" }),
    ).toThrow(ConsentError);
  });
});

describe("🔴🔴 one stop means stop", () => {
  it("a blanket withdrawal reaches every channel and every purpose", () => {
    for (const channel of ["whatsapp", "email", "sms", "call", "post"] as const) {
      const v = mayContact({
        records: [GRANT(), WITHDRAW()],
        purpose: "marketing",
        channel,
      });
      expect(v.allowed, channel).toBe(false);
      expect(v.reason).toMatch(/withdrew consent entirely/i);
    }
  });

  it("⚠️ a withdrawal beats a grant whatever the dates say", () => {
    /**
     * The grant here is NEWER than the withdrawal. It still loses,
     * because 0061 refuses to record a grant over a withdrawal without a
     * fresh notice: the only route back onto the list is a new consent.
     */
    const v = mayContact({
      records: [
        WITHDRAW({ withdrawnAt: "2026-01-01T00:00:00.000Z" }),
        GRANT({ grantedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      purpose: "marketing",
      channel: "email",
    });
    expect(v.allowed).toBe(false);
  });

  it("a channel-specific withdrawal leaves the other channels alone", () => {
    const records = [GRANT(), WITHDRAW({ purpose: "marketing", channel: "email" })];
    expect(
      mayContact({ records, purpose: "marketing", channel: "email" }).allowed,
    ).toBe(false);
    expect(
      mayContact({ records, purpose: "marketing", channel: "whatsapp" }).allowed,
    ).toBe(true);
  });

  it("tells the caller a withdrawal cannot simply be reversed", () => {
    const v = mayContact({
      records: [WITHDRAW()],
      purpose: "marketing",
      channel: "email",
    });
    expect(v.remedy).toMatch(/cannot be reversed/i);
  });
});

describe("⭐ a contractual basis covers a dispatch note, never a campaign", () => {
  it("allows a transactional message with no consent on file", () => {
    const v = mayContact({
      records: [],
      purpose: "transactional",
      channel: "whatsapp",
      hasLegitimateContractualBasis: true,
    });
    expect(v.allowed).toBe(true);
  });

  it("🔴 does NOT let it unlock marketing", () => {
    const v = mayContact({
      records: [],
      purpose: "marketing",
      channel: "whatsapp",
      hasLegitimateContractualBasis: true,
    });
    expect(v.allowed).toBe(false);
  });

  it("still loses to a withdrawal", () => {
    const v = mayContact({
      records: [WITHDRAW()],
      purpose: "transactional",
      channel: "whatsapp",
      hasLegitimateContractualBasis: true,
    });
    expect(v.allowed).toBe(false);
  });
});

describe("🔴 the audience keeps its exclusions and their reasons", () => {
  it("splits and counts the two reasons apart", () => {
    const split = splitAudience({
      members: [
        { party: "in", records: [GRANT()] },
        { party: "said-stop", records: [WITHDRAW()] },
        { party: "never-asked", records: [] },
        { party: "no-notice", records: [GRANT({ noticeId: null })] },
      ],
      purpose: "marketing",
      channel: "whatsapp",
    });
    expect(split.reachableCount).toBe(1);
    expect(split.excludedCount).toBe(3);
    /** ⚠️ Two different problems needing two different actions. */
    expect(split.withdrawnCount).toBe(1);
    expect(split.noRecordCount).toBe(2);
    expect(split.excluded.map((e) => e.party)).toContain("said-stop");
  });
});

/* ================================================================== */
/* ③ WHAT A SEND COSTS                                                */
/* ================================================================== */

describe("🔴 WhatsApp marketing costs real money, per message, in India", () => {
  it("prices a campaign to 10,000 people at about ₹10,900", () => {
    const e = estimateSendCost({ recipients: 10_000, category: "marketing" });
    expect(e.totalMinor).toBe(1_090_000n);
    expect(formatMinor(e.totalMinor)).toBe("₹10,900.00");
    expect(e.warning).toMatch(/spent the moment it goes/i);
  });

  it("🔴 does NOT make marketing free inside the service window", () => {
    const e = estimateSendCost({
      recipients: 1000,
      category: "marketing",
      insideServiceWindow: 1000,
    });
    /** ⚠️ Treating the window as a general discount understates the
     *  bill by a factor of seven. */
    expect(e.freeCount).toBe(0);
    expect(e.chargeableCount).toBe(1000);
    expect(e.totalMinor).toBe(109_000n);
  });

  it("does make utility free inside the window", () => {
    const e = estimateSendCost({
      recipients: 1000,
      category: "utility",
      insideServiceWindow: 400,
    });
    expect(e.freeCount).toBe(400);
    expect(e.chargeableCount).toBe(600);
    expect(e.totalMinor).toBe(600n * DEFAULT_RATES_MINOR.utility);
  });

  it("⭐ utility is roughly a seventh of marketing, which is why it ships first", () => {
    expect(DEFAULT_RATES_MINOR.marketing).toBeGreaterThan(
      DEFAULT_RATES_MINOR.utility * 6n,
    );
    expect(DEFAULT_RATES_MINOR.service).toBe(0n);
  });

  it("takes rates as an argument, because a stale rate is a stale slab", () => {
    const e = estimateSendCost({
      recipients: 10,
      category: "marketing",
      ratesMinor: { ...DEFAULT_RATES_MINOR, marketing: 200n },
    });
    expect(e.totalMinor).toBe(2000n);
  });

  it("refuses a negative recipient count", () => {
    expect(() => estimateSendCost({ recipients: -1, category: "marketing" })).toThrow(
      ConsentError,
    );
  });

  it("never counts more free than there are recipients", () => {
    const e = estimateSendCost({
      recipients: 10,
      category: "utility",
      insideServiceWindow: 999,
    });
    expect(e.freeCount).toBe(10);
    expect(e.totalMinor).toBe(0n);
  });

  it("knows its own vocabulary", () => {
    expect(CONSENT_PURPOSES).toContain("marketing");
    expect(CONSENT_CHANNELS).toContain("whatsapp");
    expect(CONSENT_CHANNELS[0]).toBe("all");
  });
});

/* ================================================================== */
/* ④ CONVERSATIONS                                                    */
/* ================================================================== */

const THREAD = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t1",
  title: "About invoice 114",
  subjectLabel: null,
  lastMessageAt: "2026-08-13T10:00:00.000Z",
  messageCount: 3,
  isClosed: false,
  lastReadAt: "2026-08-13T09:00:00.000Z",
  isMuted: false,
  mentionedSinceRead: false,
  ...over,
});

describe("🔴 unread is two timestamps, never a stored count", () => {
  it("is unread when the last message is newer than the last read", () => {
    expect(threadState(THREAD()).unread).toBe(true);
  });

  it("is read when the reader has looked since", () => {
    expect(
      threadState(THREAD({ lastReadAt: "2026-08-13T11:00:00.000Z" })).unread,
    ).toBe(false);
  });

  it("⚠️ a thread never opened is unread, not neutral", () => {
    expect(threadState(THREAD({ lastReadAt: null })).unread).toBe(true);
  });

  it("an empty thread is not unread", () => {
    expect(
      threadState(THREAD({ messageCount: 0, lastMessageAt: null })).unread,
    ).toBe(false);
  });

  it("muting suppresses plain unread", () => {
    expect(threadState(THREAD({ isMuted: true })).unread).toBe(false);
  });

  it("🔴 but muting NEVER suppresses a message that named you", () => {
    const s = threadState(THREAD({ isMuted: true, mentionedSinceRead: true }));
    /**
     * ⚠️ Muting is "stop shouting about this", not "hide it from me
     * even when it is addressed to me". Treating them the same is how
     * people miss the one message that mattered.
     */
    expect(s.unread).toBe(true);
    expect(s.needsAttention).toBe(true);
    expect(s.tone).toBe("attention");
  });
});

describe("⭐ the inbox, in four numbers", () => {
  it("counts unread, attention and stale apart", () => {
    const s = summariseInbox({
      rows: [
        THREAD({ id: "a" }),
        THREAD({ id: "b", mentionedSinceRead: true }),
        THREAD({ id: "c", lastReadAt: "2026-08-13T11:00:00.000Z" }),
        THREAD({ id: "d", lastMessageAt: "2026-06-01T10:00:00.000Z" }),
      ],
      now: "2026-08-13T12:00:00.000Z",
    });
    expect(s.total).toBe(4);
    /**
     * ⚠️ "d" is NOT unread: its last message is June and the reader
     * looked in August. Old is not the same as unseen, and conflating
     * them is how a stale thread gets mistaken for a missed one.
     */
    expect(s.unread).toBe(2);
    expect(s.needsAttention).toBe(1);
    /** ⚠️ The counter nobody builds. */
    expect(s.stale).toBe(1);
  });

  it("does not count a closed thread as gone quiet", () => {
    const s = summariseInbox({
      rows: [THREAD({ lastMessageAt: "2026-01-01T00:00:00.000Z", isClosed: true })],
      now: "2026-08-13T12:00:00.000Z",
    });
    expect(s.stale).toBe(0);
  });

  it("refuses a nonsense staleness window or timestamp", () => {
    expect(() =>
      summariseInbox({ rows: [], now: "2026-08-13T12:00:00.000Z", staleAfterDays: 0 }),
    ).toThrow(ThreadError);
    expect(() => summariseInbox({ rows: [], now: "not a date" })).toThrow(ThreadError);
  });

  it("sorts attention above unread above recency", () => {
    const a = threadState(THREAD({ id: "a", lastMessageAt: "2026-08-13T11:00:00.000Z" }));
    const b = threadState(
      THREAD({
        id: "b",
        mentionedSinceRead: true,
        /** ⚠️ Older than "a", but unseen, and it named the reader. */
        lastMessageAt: "2026-08-10T11:00:00.000Z",
        lastReadAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect([a, b].sort(compareThreads)[0]?.id).toBe("b");
  });
});

describe("⭐ mentions", () => {
  it("finds handles at the start and after a space", () => {
    expect(extractHandles("@ravi can you check, cc @meera_k")).toEqual(["ravi", "meera_k"]);
  });

  it("⚠️ does not treat an email address as a mention", () => {
    expect(extractHandles("mail him at ravi@corp.in")).toEqual([]);
  });

  it("does not repeat a handle named twice", () => {
    expect(extractHandles("@ravi and again @ravi")).toEqual(["ravi"]);
  });
});

/* ================================================================== */
/* ⑤ THE RULES THAT LIVE IN THE DATABASE                              */
/* ================================================================== */

describe("🔴 0061 puts the rules where nothing can route around them", () => {
  const sql = sqlCode(SQL);

  it("⭐ does NOT create a second lead table", () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS leads\b/);
    expect(sql).toContain("ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source_id");
  });

  it("normalises the phone in a GENERATED column so it cannot drift", () => {
    expect(sql).toContain("GENERATED ALWAYS AS");
    expect(flat(sql)).toMatch(/right\(regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 10\)/);
  });

  it("⚠️ indexes the duplicate key rather than making it unique", () => {
    /** A genuine second enquiry six months later is a real lead. */
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS leads_phone_digits_idx");
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*leads_phone_digits/);
  });

  it("refuses more or fewer than one won stage on a board", () => {
    expect(sql).toContain("ordence_validate_pipeline");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(flat(sql)).toMatch(/two conversion rates/i);
  });

  it("refuses gaps in the stage positions", () => {
    expect(flat(sql)).toMatch(/Positions must run from 1 with no gaps/i);
  });

  it("🔴 refuses a granted consent that does not name its notice", () => {
    expect(sql).toContain("consents_grant_names_its_notice");
    expect(flat(sql)).toMatch(
      /consents_grant_names_its_notice CHECK \(\s*state <> 'granted' OR \(notice_id IS NOT NULL AND granted_at IS NOT NULL\)/,
    );
  });

  it("refuses an undated withdrawal, and one that precedes its grant", () => {
    expect(sql).toContain("consents_withdrawal_is_dated");
    expect(sql).toContain("consents_withdrawal_follows_grant");
  });

  it("🔴🔴 refuses to DELETE a consent at all", () => {
    expect(sql).toContain("ordence_guard_consent");
    expect(flat(sql)).toMatch(/consent record cannot be deleted/i);
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON consents");
  });

  it("refuses to edit what somebody agreed to, or to un-withdraw", () => {
    expect(flat(sql)).toMatch(/cannot be changed afterwards/i);
    expect(flat(sql)).toMatch(/withdrawn consent cannot be switched back on/i);
  });

  it("🔴 freezes a notice once anybody has agreed against it", () => {
    expect(sql).toContain("ordence_guard_consent_notice");
    expect(flat(sql)).toMatch(/worth exactly as much as no notice at all/i);
  });

  it("refuses a notice with no words in it", () => {
    expect(sql).toContain("consent_notices_has_words");
  });

  it("refuses a consent belonging to nobody", () => {
    expect(sql).toContain("consents_has_a_party");
  });

  it("🔴 refuses a post into a thread you are not in", () => {
    expect(sql).toContain("ordence_guard_message");
    expect(flat(sql)).toMatch(/not in this conversation/i);
    expect(flat(sql)).toMatch(/screen is not the boundary|only one of them is a permission/i);
  });

  it("⭐ a mention adds the person to the thread", () => {
    expect(flat(sql)).toMatch(/INSERT INTO thread_participants[^;]*'mentioned'/);
    expect(sql).toContain("ON CONFLICT (thread_id, user_id) DO NOTHING");
  });

  it("refuses to delete a message, or to edit one without marking it", () => {
    expect(sql).toContain("ordence_guard_message_history");
    expect(flat(sql)).toMatch(/message cannot be deleted/i);
    expect(flat(sql)).toMatch(/has to be marked as edited/i);
  });

  it("refuses a thread nobody could ever find again", () => {
    expect(sql).toContain("message_threads_is_findable");
  });

  it("puts RLS on every new table, with platform scope in USING only", () => {
    for (const t of [
      "lead_sources",
      "pipeline_stages",
      "consent_notices",
      "consents",
      "message_threads",
      "thread_participants",
      "messages",
    ]) {
      expect(sql, t).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    const withChecks = sql.match(/WITH CHECK \([^)]*\)/g) ?? [];
    expect(withChecks.length).toBeGreaterThan(0);
    for (const w of withChecks) expect(w).not.toContain("app_platform_scope");
  });
});

/* ================================================================== */
/* ⑥ THE ACTIONS AND THE SCREENS                                      */
/* ================================================================== */

describe("🔴 the actions refuse the quiet mistakes with a sentence", () => {
  it("requires the notice on a grant in the schema, not only in the database", () => {
    const c = code(CONSENT_ACTIONS);
    expect(c).toMatch(/noticeId: z\.string\(\)\.uuid\(\)/);
    expect(c).toContain("grantedAt: new Date()");
  });

  it("🔴 refuses a consent recorded against a notice that never covered it", () => {
    expect(flat(code(CONSENT_ACTIONS))).toMatch(/does not cover/i);
    expect(flat(code(CONSENT_ACTIONS))).toMatch(/evidence of the opposite/i);
  });

  it("🔴 defaults a withdrawal to every purpose and every channel", () => {
    const c = code(CONSENT_ACTIONS);
    const w = c.slice(c.indexOf("const withdrawSchema"), c.indexOf("export async function withdrawConsent"));
    expect(w).toMatch(/purpose: z\.enum\(purposes\)\.default\("all"\)/);
    expect(w).toMatch(/channel: z\.enum\(channels\)\.default\("all"\)/);
  });

  it("records a withdrawal as a new row rather than editing the grant", () => {
    const c = code(CONSENT_ACTIONS);
    const w = c.slice(c.indexOf("export async function withdrawConsent"));
    expect(w).toContain("insert(consents)");
    expect(w).not.toContain("update(consents)");
  });

  it("makes the thread creator a participant before the first message", () => {
    const c = code(MESSAGE_ACTIONS);
    expect(c).toContain("insert(threadParticipants)");
    const start = c.indexOf("export async function startThread");
    const partIdx = c.indexOf("insert(threadParticipants)", start);
    const msgIdx = c.indexOf("insert(messages)", start);
    /** 🔴 Participants first, or the trigger refuses the first post. */
    expect(partIdx).toBeGreaterThan(-1);
    expect(partIdx).toBeLessThan(msgIdx);
  });

  it("refuses to turn the same message into two tasks", () => {
    expect(flat(code(MESSAGE_ACTIONS))).toMatch(/already been turned into a task/i);
  });

  it("refuses a thread with neither a title nor a record", () => {
    expect(flat(code(MESSAGE_ACTIONS))).toMatch(/cannot be found again/i);
  });
});

describe("⭐ the screens lead with the rule", () => {
  it("the consent screen says a tick box is not consent", () => {
    expect(flat(CONSENT_PAGE)).toMatch(/tick box is not consent/i);
  });

  it("shows unevidenced grants as their own counter, in red", () => {
    expect(flat(CONSENT_PAGE)).toMatch(/Not evidence/);
    expect(flat(CONSENT_PAGE)).toMatch(/do not say what to/i);
  });

  it("states all four rules where the decision is made", () => {
    const p = flat(CONSENT_PAGE);
    expect(p).toMatch(/Silence is not consent/i);
    expect(p).toMatch(/One stop means stop/i);
    expect(p).toMatch(/withdrawal beats a grant/i);
    expect(p).toMatch(/grant with no notice behind it is ignored/i);
  });

  it("the messages screen explains muting and the stale counter", () => {
    const p = flat(MESSAGES_PAGE);
    expect(p).toMatch(/Muting stops the noise, not the message addressed to you/i);
    expect(p).toMatch(/unanswered question looks exactly like a finished one/i);
  });
});

describe("⭐ registered, and the schema declares the new tables", () => {
  it("registers messages and consent, charged for", () => {
    const c = code(REGISTRY);
    for (const nav of ["messages", "consent"]) {
      expect(c, nav).toContain(`navId: "${nav}"`);
    }
    const block = c.slice(c.indexOf('navId: "messages"'), c.indexOf('navId: "search"'));
    expect(block).not.toContain("feature: null");
  });

  it("declares the new tables", () => {
    for (const t of [
      "leadSources",
      "pipelineStages",
      "consentNotices",
      "consents",
      "messageThreads",
      "threadParticipants",
      "messages",
    ]) {
      expect(SCHEMA, t).toContain(`export const ${t} = pgTable`);
    }
    expect(read("db/schema/index.ts")).toContain('export * from "./front-office"');
  });

  it("⭐ extends the EXISTING leads table rather than adding a rival", () => {
    expect(SALES_SCHEMA).toContain("phoneDigits");
    expect(SALES_SCHEMA).toContain("leadSourceId");
    expect(SALES_SCHEMA).toContain("generatedAlwaysAs");
  });
});

describe("⚠️ the libs stay pure", () => {
  it("read no clock and no database", () => {
    for (const [name, src] of [
      ["consent", CONSENT_LIB],
      ["dedupe", DEDUPE_LIB],
      ["threads", THREADS_LIB],
    ] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/Date\.now\(/);
      expect(c, name).not.toMatch(/new Date\(\)/);
      expect(c, name).not.toContain("@/db");
    }
  });

  it("uses bigint minor units for money, never a float", () => {
    expect(code(CONSENT_LIB)).not.toMatch(/parseFloat/);
  });
});
