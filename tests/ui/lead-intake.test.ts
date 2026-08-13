/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 7 — INDIAMART, JUSTDIAL AND META.
 *
 * 🔴 THE FIVE FAILURES THIS SUITE PINS DOWN.
 *
 *   ① `if (!response.ok) markFailed()`. IndiaMART answers **204 when
 *      nobody enquired**, so a quiet Sunday becomes an outage, the
 *      backoff climbs, and the customer is told their integration is
 *      broken because business was slow. It is self-confirming: the
 *      quieter the account, the louder the false alarm.
 *
 *   ② Returning a non-200 to IndiaMART's push for an enquiry we could
 *      not parse. They retry until they get a 200 and **deactivate the
 *      push after 48 hours of rejection**, so a two-day bug silently
 *      unsubscribes the customer and the requests simply stop.
 *
 *   ③ Confusing "the same EVENT arrived twice" with "the same PERSON
 *      enquired again". Refuse the first; show the second. A product
 *      that swaps them either loses real business or rings one man
 *      three times.
 *
 *   ④ Storing IndiaMART's own placeholder, "IndiaMART Buyer", as a
 *      person's name — and then mail-merging it.
 *
 *   ⑤ Treating a Meta webhook as a lead. It carries ids and no answers.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyIndiamartCode,
  parseIndiamartRecord,
  pushAcknowledgement,
  readIndiamartResponse,
} from "@/lib/integrations/adapters/indiamart";
import { parseJustdialLead } from "@/lib/integrations/adapters/justdial";
import {
  leadFetchFailure,
  parseLeadgenNotices,
  parseMetaLead,
  verifySubscription,
} from "@/lib/integrations/adapters/meta";
import {
  cleanEmail,
  cleanName,
  cleanPhone,
  parseIstish,
} from "@/lib/integrations/adapters/types";
import {
  DEFAULT_INTAKE_MINUTES,
  MISSED_CALL_FRACTION,
  basisFromEnquiry,
  displayNameFor,
  planIntake,
} from "@/lib/integrations/intake";
import { CONNECTOR_POLICIES } from "@/lib/integrations/policy";
import { istStamp } from "@/server/integrations/runner";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0065_lead_intake.sql");
const SQL_CODE = sqlCode(SQL);
const INGEST = read("server/integrations/ingest.ts");
const RUNNER = read("server/integrations/runner.ts");
const ROUTE = read("app/api/webhooks/intake/[token]/route.ts");
const ACTIONS = read("server/actions/connections.ts");

const NOW = new Date("2026-08-13T10:00:00.000Z");
const istDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/* ================================================================== */
/* ⭐⭐⭐ ① 204 IS NOT AN ERROR                                        */
/* ================================================================== */

describe("⭐⭐ the quiet day that looks like an outage", () => {
  /**
   * 🔴 THE HEADLINE BUG OF THE BATCH. Every naive client writes
   * `if (!res.ok) fail()` and every one of them reports a quiet Sunday
   * as a broken integration.
   */
  it("treats 204 as an empty answer, not a failure", () => {
    const v = classifyIndiamartCode(204);
    expect(v?.kind).toBe("empty");
  });

  it("treats an empty RESPONSE array on a 200 the same way", () => {
    const v = readIndiamartResponse({ CODE: 200, RESPONSE: [] }, 200);
    expect(v.kind).toBe("empty");
  });

  /**
   * ⚠️ AND THE RUNNER STILL MOVES THE CURSOR ON A QUIET DAY. Leaving it
   * where it was means the next run re-asks the same window forever, and
   * the window only ever grows.
   */
  it("advances the cursor after an empty run", () => {
    const empty = RUNNER.slice(
      RUNNER.indexOf('if (answer.kind === "empty")'),
      RUNNER.indexOf('if (answer.kind === "error")'),
    );
    expect(empty).toContain("advanceCursor");
    expect(empty).toContain('outcome: "success"');
  });

  /**
   * 🔴 A 200 CARRYING `CODE: 401` IS NOT A SUCCESSFUL EMPTY RUN.
   *
   * ⚠️ Reading only the HTTP status is how a rejected key looks like a
   * quiet month, forever, with the connection reporting healthy.
   */
  it("reads the CODE in the body, not only the HTTP status", () => {
    const v = readIndiamartResponse({ CODE: 401, MESSAGE: "Invalid key" }, 200);
    expect(v.kind).toBe("error");
    if (v.kind === "error") expect(v.failureClass).toBe("auth");
  });

  /**
   * ⭐ 401 USUALLY MEANS "REGENERATED", NOT "WRONG", and the message
   * says so, because that is what the customer has to go and fix.
   */
  it("explains a rejected key as a regenerated one", () => {
    const v = classifyIndiamartCode(401);
    expect(v?.kind).toBe("error");
    if (v?.kind === "error") {
      expect(v.failureClass).toBe("auth");
      expect(v.message).toContain("Regenerate");
    }
  });

  it("does not retry a window IndiaMART refused as too wide", () => {
    const v = classifyIndiamartCode(400);
    if (v?.kind === "error") expect(v.failureClass).toBe("bad_request");
  });

  it("classifies their outage as theirs and keeps trying", () => {
    const v = classifyIndiamartCode(500);
    if (v?.kind === "error") expect(v.failureClass).toBe("far_end");
  });

  /** ⚠️ A 200 with no array is an unknown shape, not "no leads". */
  it("refuses to import from a shape it does not recognise", () => {
    const v = readIndiamartResponse({ CODE: 200, DATA: "oops" }, 200);
    expect(v.kind).toBe("error");
  });
});

/* ================================================================== */
/* ⭐⭐ ② THE ACKNOWLEDGEMENT THAT KEEPS THE FEED ALIVE                */
/* ================================================================== */

describe("⭐⭐ answering IndiaMART's push", () => {
  /**
   * 🔴🔴 THEY DEACTIVATE THE PUSH AFTER 48 HOURS OF CONTINUOUS
   * REJECTION, and a person must switch it back on in the seller panel.
   *
   * ⚠️ So a bug that returns 500 for two days does not delay leads. It
   * silently unsubscribes the customer, and nothing reports it, because
   * the requests just stop — which looks exactly like a quiet week.
   */
  it("returns 200 once the bytes are stored, even if nothing could be filed", () => {
    expect(pushAcknowledgement(true).status).toBe(200);
  });

  it("refuses only when it did not manage to store it", () => {
    expect(pushAcknowledgement(false).status).toBe(503);
  });

  it("records how long the sender waits before giving up on us", () => {
    expect(CONNECTOR_POLICIES.indiamart.senderGivesUpAfterHours).toBe(48);
  });

  /** ⭐ The route says so where somebody changing it will read it. */
  it("explains the rule at the top of the route", () => {
    expect(ROUTE).toContain("48 hours");
    expect(ROUTE).toContain("SILENTLY UNSUBSCRIBES");
  });
});

describe("⭐ what actually protects these endpoints", () => {
  /**
   * 🔴 THE v1.12.0 TERNARY WAS WRONG. It assumed anything that was not
   * JustDial signs with `x-hub-signature-256`. IndiaMART's push
   * documents no signature at all, so every push would have been
   * recorded `absent` and refused.
   */
  it("takes the verification method from the policy table", () => {
    expect(code(ACTIONS)).toContain("verification: policy.webhookVerification");
    expect(code(ACTIONS)).not.toContain('data.connectorKey === "justdial"');
  });

  it("knows IndiaMART and JustDial sign nothing", () => {
    expect(CONNECTOR_POLICIES.indiamart.webhookVerification).toBe("none");
    expect(CONNECTOR_POLICIES.indiamart.webhookSignatureHeader).toBeNull();
    expect(CONNECTOR_POLICIES.justdial.webhookVerification).toBe("none");
  });

  it("still signs Meta, which does", () => {
    expect(CONNECTOR_POLICIES.meta_lead_ads.webhookVerification).toBe("hmac_sha256");
    expect(CONNECTOR_POLICIES.meta_lead_ads.webhookSignatureHeader).toBe(
      "x-hub-signature-256",
    );
  });

  /**
   * ⚠️ THE TENANT COMES FROM THE TOKEN, NEVER FROM THE BODY. A
   * body-supplied tenant id on a public endpoint is a cross-tenant write
   * waiting to be found.
   */
  it("resolves the tenant from the path token alone", () => {
    expect(ROUTE).toContain("eq(webhookEndpoints.pathToken, token)");
    expect(code(ROUTE)).not.toMatch(/parsed\.\s*tenant/i);
  });

  /** ⚠️ 404 and nothing else, or a prober learns which tokens exist. */
  it("says nothing distinguishing for an unknown token", () => {
    expect(ROUTE).toContain('new NextResponse("Not found", { status: 404 })');
  });

  /** 🔴 The signature is over the bytes that arrived. */
  it("reads the raw body before anything parses it", () => {
    const post = ROUTE.slice(ROUTE.indexOf("export async function POST"));
    expect(post.indexOf("request.text()")).toBeLessThan(post.indexOf("JSON.parse"));
  });
});

/* ================================================================== */
/* ⭐⭐ ③ THE SAME EVENT vs THE SAME PERSON                            */
/* ================================================================== */

describe("⭐⭐ the enquiry that arrives twice", () => {
  /**
   * 🔴 IndiaMART pushes AND answers on the pull AND retries, so every
   * enquiry reaches us more than once by design.
   */
  it("refuses the same event at the database, scoped to the connection", () => {
    expect(flat(SQL_CODE)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS leads_external_unique ON leads (connection_id, external_id)",
    );
  });

  /**
   * ⚠️ SCOPED TO THE CONNECTION, NOT THE TENANT. Two IndiaMART accounts
   * in one company are two seller panels with independent id sequences,
   * and colliding them silently drops a real enquiry from the second.
   */
  it("does not collide two accounts' id sequences", () => {
    expect(flat(SQL_CODE)).not.toContain("ON leads (tenant_id, external_id)");
  });

  /**
   * 🔴 IDEMPOTENT AT THE DATABASE, NOT IN THE APPLICATION. A
   * check-then-insert races the retry that arrives while a poll is
   * already running, which is the normal state of affairs here.
   */
  it("inserts with ON CONFLICT rather than checking first", () => {
    expect(INGEST).toContain("onConflictDoNothing");
  });

  /**
   * ⭐⭐ AND THE PERSON-LEVEL CHECK IS DELIBERATELY NOT UNIQUE. A
   * genuine second enquiry six months later is real business, and
   * refusing it teaches the salesman to type a fake number.
   */
  it("shows a repeat person rather than refusing them", () => {
    expect(INGEST).toContain("findPersonDuplicates");
    expect(INGEST).toContain("duplicateOfExisting");
    // ⚠️ The duplicate check must not gate the insert.
    const main = INGEST.slice(
      INGEST.indexOf("const duplicates = await findPersonDuplicates"),
      INGEST.indexOf("// ② The unique index refused it"),
    );
    expect(main).not.toMatch(/if \(duplicates\.length[^)]*\)\s*return/);
  });

  it("matches a person on the generated columns 0061 added", () => {
    expect(INGEST).toContain("phoneDigits");
    expect(INGEST).toContain("emailKey");
  });
});

/* ================================================================== */
/* ⭐⭐ ④ THE PLACEHOLDER THAT IS NOT A NAME                           */
/* ================================================================== */

describe("⭐⭐ the enquiry with no name", () => {
  /**
   * 🔴 INDIAMART SENDS THE LITERAL STRING "IndiaMART Buyer" WHEN THE
   * BUYER GAVE NO NAME. Storing it produces a pipeline of identical
   * rows and a mail merge that opens "Dear IndiaMART Buyer".
   */
  it("refuses IndiaMART's own placeholder as a name", () => {
    expect(cleanName("IndiaMART Buyer")).toBeNull();
    expect(cleanName("  buyer ")).toBeNull();
    expect(cleanName("N/A")).toBeNull();
    expect(cleanName("Ravi Kumar")).toBe("Ravi Kumar");
  });

  /**
   * ⭐ `leads.name` IS NOT NULL, so the fallback is something a human
   * can act on and never a constant — two nameless enquiries must not
   * look like the same person.
   */
  it("falls back to the company, then the number they rang from", () => {
    const base = {
      externalId: "X",
      name: null,
      phone: null,
      altPhone: null,
      email: null,
      companyName: null,
      city: null,
      state: null,
      pincode: null,
      countryIso: null,
      interestLabel: null,
      message: null,
      occurredAt: null,
      enquiryKind: "message" as const,
      extra: {},
    };
    expect(displayNameFor({ ...base, companyName: "Shah Traders" })).toBe(
      "Shah Traders",
    );
    expect(displayNameFor({ ...base, phone: "+91 98765 43210" })).toBe(
      "+91 98765 43210",
    );
    // ⚠️ Never "Unknown".
    expect(displayNameFor({ ...base, phone: "9000000001" })).not.toBe("Unknown");
    expect(displayNameFor({ ...base, phone: "9000000001" })).not.toBe(
      displayNameFor({ ...base, phone: "9000000002" }),
    );
  });

  /** 🔴 No phone and no email is not a lead. It is reported, not dropped. */
  it("reports an enquiry with nobody to contact", () => {
    const out = parseIndiamartRecord({
      UNIQUE_QUERY_ID: "IM-1",
      SENDER_NAME: "Somebody",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reasonCode).toBe("no_contact_details");
      expect(out.externalId).toBe("IM-1");
      // ⭐ It says where the enquiry can still be found.
      expect(out.reason).toContain("panel");
    }
  });

  /**
   * 🔴 AND AN ENQUIRY WITH NO ID OF THEIRS IS NOT FILED, because they
   * retry until accepted and we would create a copy every time.
   */
  it("refuses to file an IndiaMART record with no reference of its own", () => {
    const out = parseIndiamartRecord({ SENDER_MOBILE: "9876543210" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasonCode).toBe("unknown_shape");
  });
});

/* ================================================================== */
/* ⭐ THE RECORD ITSELF                                                */
/* ================================================================== */

describe("⭐ an IndiaMART enquiry", () => {
  const record = {
    UNIQUE_QUERY_ID: "IM-99",
    QUERY_TYPE: "W",
    QUERY_TIME: "2026-08-13 15:34:12",
    SENDER_NAME: "Ravi Kumar",
    SENDER_MOBILE: "+91-98765-43210",
    SENDER_EMAIL: "  RAVI@Example.COM ",
    SENDER_COMPANY: "Kumar Industries",
    SENDER_CITY: "Pune",
    SENDER_STATE: "Maharashtra",
    SENDER_COUNTRY_ISO: "in",
    QUERY_PRODUCT_NAME: "MS Angle 50x50",
    QUERY_MESSAGE: "Need 20 tonnes monthly",
    SOME_NEW_FIELD: "value nobody mapped",
  };

  it("normalises what it understands", () => {
    const out = parseIndiamartRecord(record);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.enquiry.externalId).toBe("IM-99");
    expect(out.enquiry.name).toBe("Ravi Kumar");
    expect(out.enquiry.email).toBe("ravi@example.com");
    expect(out.enquiry.countryIso).toBe("IN");
    expect(out.enquiry.interestLabel).toBe("MS Angle 50x50");
  });

  /**
   * 🔴 THE NUMBER IS KEPT AS THE BUYER WROTE IT. The matching is done on
   * the last ten digits by the generated column; mangling the stored
   * text helps nobody who has to dial it.
   */
  it("keeps the number exactly as typed", () => {
    const out = parseIndiamartRecord(record);
    if (out.ok) expect(out.enquiry.phone).toBe("+91-98765-43210");
  });

  /**
   * 🔴 AN UNMARKED LOCAL TIME PARSED AS UTC LANDS FIVE AND A HALF HOURS
   * EARLY, which puts a morning enquiry on the previous day's report
   * often enough to be noticed and never often enough to be diagnosed.
   */
  it("reads their bare timestamp as IST", () => {
    const d = parseIstish("2026-08-13 15:34:12");
    expect(d?.toISOString()).toBe("2026-08-13T10:04:12.000Z");
  });

  it("still trusts a timestamp that carries its own zone", () => {
    expect(parseIstish("2026-08-13T10:00:00Z")?.toISOString()).toBe(
      "2026-08-13T10:00:00.000Z",
    );
  });

  /** ⚠️ The unmapped field is always the one the customer asks about. */
  it("keeps the fields it did not map", () => {
    const out = parseIndiamartRecord(record);
    if (out.ok) expect(out.enquiry.extra.SOME_NEW_FIELD).toBe("value nobody mapped");
  });

  /**
   * ⭐ A CALL OF ZERO SECONDS IS A MISSED CALL, and it is the one most
   * worth ringing back within the hour.
   */
  it("recognises a missed call from a zero duration", () => {
    const out = parseIndiamartRecord({
      ...record,
      QUERY_TYPE: "P",
      CALL_DURATION: "00:00:00",
    });
    if (out.ok) expect(out.enquiry.enquiryKind).toBe("missed_call");
  });

  it("refuses a number that is not one", () => {
    expect(cleanPhone("00000000000")).toBeNull();
    expect(cleanPhone("12345")).toBeNull();
    expect(cleanPhone("98765 43210")).toBe("98765 43210");
  });

  it("refuses an address that is not one", () => {
    expect(cleanEmail("not-an-email")).toBeNull();
    expect(cleanEmail("a@b.co")).toBe("a@b.co");
  });

  /**
   * ⚠️ INDIAMART WANTS IST IN ITS OWN FORMAT. Sending UTC asks for a
   * window five and a half hours in the past, which loses every enquiry
   * in the gap and then keeps a permanent offset.
   */
  it("stamps the pull window in IST", () => {
    expect(istStamp(new Date("2026-08-13T10:04:12Z"))).toBe("13-08-202615:34:12");
  });
});

/* ================================================================== */
/* ⭐ JUSTDIAL — THE ONE WITH NO DOCUMENTATION                         */
/* ================================================================== */

describe("⭐ JustDial", () => {
  /**
   * 🔴 THERE IS NO PUBLIC REFERENCE. The delivery is configured by their
   * account manager against whatever names that account was set up with,
   * and different sellers report different names for the same thing.
   *
   * ⚠️ Pinning one name from one seller's setup fails silently for the
   * second customer, and it fails as "no leads are arriving" — the
   * hardest failure in this batch to diagnose.
   */
  it("accepts several spellings of the same field", () => {
    for (const key of ["mobile", "Mobile", "mobile_no", "MobileNumber"]) {
      const out = parseJustdialLead({ [key]: "9876543210", name: "A" }, "fb-1");
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.enquiry.phone).toBe("9876543210");
    }
  });

  /**
   * ⭐ AND THIS ADAPTER ALONE MINTS AN ID WHEN THE SENDER GIVES NONE.
   *
   * ⚠️ The difference from IndiaMART is deliberate: there, a missing id
   * plus retries means a copy every hour forever. Here there are no
   * retries, so it means one lead, once.
   */
  it("falls back to the delivery id, unlike IndiaMART", () => {
    const out = parseJustdialLead({ mobile: "9876543210" }, "delivery-7");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.enquiry.externalId).toBe("delivery-7");
  });

  it("prefers their own id when they send one", () => {
    const out = parseJustdialLead({ leadid: "JD-5", mobile: "9876543210" }, "d");
    if (out.ok) expect(out.enquiry.externalId).toBe("JD-5");
  });

  it("reports an empty delivery rather than filing a blank", () => {
    const out = parseJustdialLead({}, "d");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasonCode).toBe("unparseable");
  });

  /** ⚠️ It does not say whether they rang or typed, so no guess is made. */
  it("does not invent an enquiry kind", () => {
    const out = parseJustdialLead({ mobile: "9876543210" }, "d");
    if (out.ok) expect(out.enquiry.enquiryKind).toBe("unknown");
  });
});

/* ================================================================== */
/* ⭐⭐ ⑤ META — A NOTIFICATION, NOT A LEAD                            */
/* ================================================================== */

describe("⭐⭐ Meta lead ads", () => {
  const notice = {
    object: "page",
    entry: [
      {
        id: "PAGE1",
        time: 1_755_079_452,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: "LG-1",
              page_id: "PAGE1",
              form_id: "FORM1",
              ad_id: "AD1",
              created_time: 1_755_079_452,
            },
          },
        ],
      },
    ],
  };

  it("reads the ids out of the webhook", () => {
    const [n] = parseLeadgenNotices(notice);
    expect(n?.leadgenId).toBe("LG-1");
    expect(n?.formId).toBe("FORM1");
  });

  /**
   * 🔴 META BATCHES UNDER LOAD, which is exactly when a campaign is
   * working and the leads matter most.
   *
   * ⚠️ Reading `entry[0].changes[0]` drops every enquiry after the
   * first, silently, only when things are going well.
   */
  it("reads every notice in a batched delivery", () => {
    const batched = {
      object: "page",
      entry: [
        { id: "P", changes: [{ field: "leadgen", value: { leadgen_id: "A" } }] },
        {
          id: "P",
          changes: [
            { field: "leadgen", value: { leadgen_id: "B" } },
            { field: "leadgen", value: { leadgen_id: "C" } },
          ],
        },
      ],
    };
    expect(parseLeadgenNotices(batched).map((n) => n.leadgenId)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  /**
   * ⚠️ A PAGE WEBHOOK ALSO CARRIES `feed`, `messages` AND MORE, and
   * Instagram and WhatsApp arrive on the same endpoint. Treating those
   * as malformed leads fills the failure list with somebody else's
   * traffic.
   */
  it("ignores changes that are not leadgen", () => {
    expect(
      parseLeadgenNotices({
        object: "page",
        entry: [{ id: "P", changes: [{ field: "feed", value: { post_id: "x" } }] }],
      }),
    ).toEqual([]);
  });

  it("ignores an object that is not a page", () => {
    expect(parseLeadgenNotices({ ...notice, object: "instagram" })).toEqual([]);
  });

  /**
   * 🔴 ECHOING THE CHALLENGE WITHOUT CHECKING THE TOKEN lets anybody who
   * finds the address subscribe their own page to it.
   */
  it("refuses the handshake when the verify token is wrong", () => {
    const eq = (a: string, b: string) => a === b;
    expect(
      verifySubscription(
        { mode: "subscribe", token: "guess", challenge: "1234" },
        "real-token",
        eq,
      ).ok,
    ).toBe(false);
  });

  it("refuses the handshake when no token is stored at all", () => {
    const eq = (a: string, b: string) => a === b;
    const v = verifySubscription(
      { mode: "subscribe", token: "anything", challenge: "1234" },
      null,
      eq,
    );
    expect(v.ok).toBe(false);
  });

  it("echoes the challenge when the token matches", () => {
    const eq = (a: string, b: string) => a === b;
    const v = verifySubscription(
      { mode: "subscribe", token: "real-token", challenge: "1234" },
      "real-token",
      eq,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.challenge).toBe("1234");
  });

  /**
   * ⚠️ THE FIELD NAMES ARE THE ADVERTISER'S, NOT META'S. `full_name` is
   * only the default; `naam` and `contact_person` are real.
   */
  it("finds the answers whatever the advertiser called the questions", () => {
    const out = parseMetaLead(
      {
        created_time: "2026-08-13T10:00:00+0000",
        field_data: [
          { name: "naam", values: ["Priya"] },
          { name: "mobile_number", values: ["9876543210"] },
          { name: "how_many_tonnes_per_month", values: ["20"] },
        ],
      },
      { leadgenId: "LG-1", formId: "F", pageId: "P", adId: "A", createdAt: null },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.enquiry.name).toBe("Priya");
    expect(out.enquiry.phone).toBe("9876543210");
    /**
     * ⭐ THE CUSTOM QUESTION IS OFTEN THE MOST VALUABLE ANSWER IN THE
     * FORM. No standard mapping will ever contain it, so it is kept.
     */
    expect(out.enquiry.extra.how_many_tonnes_per_month).toBe("20");
  });

  /** ⚠️ `values` is an array even for one answer, and several for a choice. */
  it("joins a multiple-choice answer instead of taking the first", () => {
    const out = parseMetaLead(
      {
        field_data: [
          { name: "email", values: ["a@b.co"] },
          { name: "interested_in", values: ["Angles", "Channels"] },
        ],
      },
      { leadgenId: "LG-2", formId: null, pageId: null, adId: null, createdAt: null },
    );
    if (out.ok) expect(out.enquiry.extra.interested_in).toBe("Angles, Channels");
  });

  /**
   * 🔴 THE FETCH FAILING IS NOT THE ENQUIRY BEING BAD, and the
   * `leadgen_id` is carried through so a person can find it in Meta's
   * own Leads Center.
   */
  it("carries the reference into the failure when the answers cannot be read", () => {
    const f = leadFetchFailure(
      { leadgenId: "LG-9", formId: null, pageId: null, adId: null, createdAt: null },
      "token expired",
    );
    expect(f.ok).toBe(false);
    if (!f.ok) {
      expect(f.reasonCode).toBe("lead_fetch_failed");
      expect(f.externalId).toBe("LG-9");
      expect(f.reason).toContain("LG-9");
      expect(f.reason).toContain("Leads Center");
    }
  });
});

/* ================================================================== */
/* ⭐⭐ WHAT AN ENQUIRY BECOMES                                        */
/* ================================================================== */

describe("⭐⭐ the first hour is the product", () => {
  const enquiry = {
    externalId: "IM-1",
    name: "Ravi",
    phone: "9876543210",
    altPhone: null,
    email: null,
    companyName: "Kumar Industries",
    city: "Pune",
    state: "MH",
    pincode: null,
    countryIso: "IN",
    interestLabel: "MS Angle",
    message: "20 tonnes monthly",
    occurredAt: NOW,
    enquiryKind: "message" as const,
    extra: { grade: "IS 2062" },
  };

  it("gives every enquiry a task with a time on it", () => {
    const plan = planIntake(enquiry, NOW, {
      connectorLabel: "IndiaMART",
      istDay,
    });
    expect(plan.dueAt.getTime()).toBe(NOW.getTime() + DEFAULT_INTAKE_MINUTES * 60_000);
    expect(plan.title).toContain("Ravi");
    expect(plan.title).toContain("MS Angle");
  });

  /**
   * 🔴 A MISSED CALL GETS A QUARTER OF THE TIME. Somebody who actually
   * rang and did not get through has already tried hardest, and is the
   * enquiry most likely to be gone by tomorrow.
   */
  it("gives a missed call a quarter of the time and the top priority", () => {
    const plan = planIntake(
      { ...enquiry, enquiryKind: "missed_call" },
      NOW,
      { connectorLabel: "IndiaMART", istDay },
    );
    expect(plan.priority).toBe("urgent");
    expect(plan.dueAt.getTime()).toBe(
      NOW.getTime() + DEFAULT_INTAKE_MINUTES * MISSED_CALL_FRACTION * 60_000,
    );
    expect(plan.title).toContain("Call back");
  });

  /**
   * ⭐ IT IS A FRACTION OF THE ONE NUMBER THE TENANT CHOSE, not a second
   * setting. Two dials produce a configuration nobody understands and
   * one of them ends up wrong.
   */
  it("scales the missed-call window with the tenant's own setting", () => {
    const plan = planIntake(
      { ...enquiry, enquiryKind: "missed_call" },
      NOW,
      { dueMinutes: 240, connectorLabel: "IndiaMART", istDay },
    );
    expect(plan.dueAt.getTime()).toBe(NOW.getTime() + 60 * 60_000);
  });

  /** ⚠️ Never below five minutes, however small the setting. */
  it("never produces a due time nobody could meet", () => {
    const plan = planIntake(
      { ...enquiry, enquiryKind: "missed_call" },
      NOW,
      { dueMinutes: 5, connectorLabel: "IndiaMART", istDay },
    );
    expect(plan.dueAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 5 * 60_000);
  });

  /** ⭐ The unmapped answers go into the task, not only into a jsonb column. */
  it("puts everything the buyer sent where the salesman will read it", () => {
    const plan = planIntake(enquiry, NOW, { connectorLabel: "IndiaMART", istDay });
    expect(plan.detail).toContain("9876543210");
    expect(plan.detail).toContain("20 tonnes monthly");
    expect(plan.detail).toContain("IS 2062");
  });

  it("files the timeline entry as machine-made so it cannot be tidied up", () => {
    expect(INGEST).toContain('source: "integration"');
  });

  /**
   * 🔴🔴 AN ENQUIRY IS NOT CONSENT TO A MARKETING LIST.
   *
   * ⚠️ That is the line every CRM crosses: an enquiry becomes a contact,
   * the contact becomes a segment, and eighteen months later somebody
   * who asked one question about pipe fittings receives a Diwali
   * campaign. Under the DPDP Act that is a reportable complaint, and
   * "they enquired" is not a defence.
   */
  it("records the narrow basis and nothing wider", () => {
    const basis = basisFromEnquiry(enquiry);
    expect(basis.basis).toBe("contract");
    expect(basis.purpose).toBe("enquiry_response");
    expect(basis.note).toContain("not agreement to a marketing list");
  });

  it("writes no consent row, so the campaign work finds nothing here", () => {
    expect(code(INGEST)).not.toContain("insert(consents)");
  });
});

/* ================================================================== */
/* ⭐ NOTHING IS LOST SILENTLY                                         */
/* ================================================================== */

describe("⭐⭐ the enquiry nobody could file", () => {
  /**
   * 🔴 THE CUSTOMER PAID FOR THAT ENQUIRY. IndiaMART charges for the
   * subscription that produced it; Meta charged for the click. The
   * choice is between a row somebody has to look at and no row at all.
   */
  it("records a failure for every path the adapter refused", () => {
    expect(INGEST).toContain("recordFailure");
    const guard = INGEST.slice(
      INGEST.indexOf("export async function ingestEnquiry"),
      INGEST.indexOf("const enquiry = parsed.enquiry"),
    );
    expect(guard).toContain("recordFailure");
  });

  it("names the reasons the database will accept", () => {
    for (const codeName of [
      "no_contact_details",
      "unparseable",
      "unknown_shape",
      "lead_fetch_failed",
      "rejected_by_rules",
      "internal_error",
    ]) {
      expect(SQL_CODE).toContain(`'${codeName}'`);
    }
  });

  /** ⚠️ A failure is evidence too: resolvable, purgeable, not rewritable. */
  it("refuses to rewrite what failed and why", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF NEW.reason IS DISTINCT FROM OLD.reason OR NEW.reason_code IS DISTINCT FROM OLD.reason_code",
    );
  });

  /** 🔴 A lost enquiry counted twice is worse than not counting it. */
  it("refuses to reopen a resolved failure", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL THEN",
    );
  });

  it("demands both who and when for a resolution", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT lead_intake_failures_resolution_is_whole",
    );
  });

  /** 🔴 DPDP again. A failed enquiry is still somebody's phone number. */
  it("gives a failed enquiry a deletion date at birth", () => {
    expect(flat(SQL_CODE)).toContain("purge_after date NOT NULL");
  });

  it("redacts the stored enquiry before writing it", () => {
    expect(INGEST).toContain("redactPayloadObject");
  });
});

describe("⭐ 0065's own rules", () => {
  it("keeps the intake window inside something a person could meet", () => {
    expect(flat(SQL_CODE)).toContain(
      "CHECK (intake_task_due_minutes BETWEEN 5 AND 10080)",
    );
  });

  /**
   * ⚠️ NOT "the first stage by position". A tenant who reorders their
   * board would silently start filing new enquiries into whatever ended
   * up leftmost, which on a board beginning with "Contacted" records
   * every new lead as already contacted.
   */
  it("names the intake stage rather than deriving it", () => {
    expect(SQL_CODE).toContain("intake_stage_id");
    expect(SQL).toContain("NOT \"the first stage by position\"");
  });

  it("raises a task by default, which is the point of the batch", () => {
    expect(flat(SQL_CODE)).toContain(
      "intake_creates_task boolean NOT NULL DEFAULT true",
    );
  });

  it("puts platform scope in USING and never in WITH CHECK", () => {
    const policies = SQL_CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(1);
    for (const p of policies) {
      expect(p.slice(p.indexOf("WITH CHECK"))).not.toContain("app_platform_scope");
    }
  });
});
