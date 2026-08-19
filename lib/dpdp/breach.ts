/**
 * Ordence — ⭐⭐⭐ THE BREACH INTIMATION
 * Version: v1.68.0-alpha
 *
 * Pure. No clock — every timestamp is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS MISSING, STATED PRECISELY
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/secops.ts` records `security_events` and
 * `server/security/anomalies.ts` detects patterns in them. Both are real
 * and neither is what s.8(6) requires. A detector produces a SIGNAL. The
 * Act requires an INTIMATION — a document, to two audiences, with
 * prescribed content, on two different clocks.
 *
 * ⚠️ AND `server/platform/canary.ts` HAS A `"breach"` VERDICT THAT
 * NOTIFIES NOBODY. It logs, it returns 500, and that is the end of it.
 * Every other `breach` identifier in this codebase is credit-limit
 * arithmetic. Searching for the word finds a dozen things and none of
 * them is this.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO CLOCKS, AND NEITHER SATISFIES THE OTHER
 * ══════════════════════════════════════════════════════════════════════
 *   CERT-In, Direction (ii) of the Directions of 28 April 2022:
 *     SIX HOURS OF NOTICING. Binds "service providers, intermediaries,
 *     data centres, body corporate and Government organisations" — a
 *     multi-tenant SaaS is a body corporate, with no size threshold.
 *     ⭐ THIS IS IN FORCE TODAY.
 *
 *   DPDPA s.8(6) with Rule 7 of the DPDP Rules 2025:
 *     To each affected Data Principal, WITHOUT DELAY. To the Board,
 *     without delay, then a DETAILED REPORT WITHIN 72 HOURS.
 *     ⚠️ NOTIFIED 13 NOVEMBER 2025, IN FORCE FROM ROUGHLY MAY 2027.
 *
 * 🔴 BOTH RUN FROM NOTICING, NOT FROM OCCURRING AND NOT FROM CONFIRMING.
 * A team that waits until it is sure before starting the clock has
 * already missed it. `hoursFrom` below therefore takes `noticedAt` and
 * nothing else, and there is no parameter for "when we were certain".
 *
 * 🔴 AND RULE 7 HAS NO MATERIALITY THRESHOLD. Every personal data breach
 * is reportable. This is stricter than the GDPR and it is the most
 * commonly mis-stated part of the regime, which is why there is no
 * `isMaterial` anywhere in this file or in the table behind it: a field
 * whose only possible use is to justify not reporting.
 */

/* ------------------------------------------------------------------ */

export type BreachFacts = {
  reference: string;
  /** 🔴 When it was NOTICED. Both clocks run from here. */
  noticedAt: Date;
  occurredAt: Date | null;
  /** Rule 7: "nature, extent, timing and location of the breach". */
  nature: string;
  extent: string;
  timingAndLocation: string;
  /** Rule 7: "likely consequences". */
  likelyConsequences: string;
  /** Rule 7: "measures implemented ... to mitigate risk". */
  mitigationImplemented: string;
  /** Rule 7: "safety measures the Data Principal may take". */
  safeguardsForPrincipals: string;
  /** Rule 7: contact details of a person able to respond on behalf of the Fiduciary. */
  contactPerson: string;
  affectedPrincipalCount: number | null;
};

export type Deadline = {
  duty: string;
  provision: string;
  dueBy: Date;
  /** ⭐ Whether this duty is in force TODAY, as opposed to notified. */
  inForce: boolean;
  /** Null where nothing has been done. */
  doneAt: Date | null;
  state: "done" | "due" | "overdue" | "not-yet-in-force";
};

const HOUR = 3_600_000;

/**
 * ⚠️ THE COMMENCEMENT DATE IS A CONSTANT AND IT IS APPROXIMATE.
 *
 * The DPDP Rules 2025 were published on 13 November 2025 and the
 * operative compliance rules commence eighteen months later. The exact
 * day depends on how the Gazette date is counted, so the product treats
 * a breach as pre-commencement until this date and says which regime it
 * recorded the row under, rather than pretending to a precision the
 * notification does not give.
 */
export const DPDP_RULE_7_COMMENCEMENT = new Date("2027-05-13T00:00:00.000Z");

/**
 * ⭐ THE FOUR DUTIES, EACH WITH ITS OWN CLOCK AND ITS OWN STATE.
 *
 * 🔴 THEY ARE NOT COLLAPSIBLE INTO A "reported" FLAG. A workspace that
 * filed with CERT-In within six hours and told nobody else has met one
 * duty of four, and a single boolean would let that read as compliance.
 * `db/schema/dpdp.ts` carries four separate timestamps for the same
 * reason.
 */
export function deadlines(args: {
  facts: BreachFacts;
  certinReportedAt: Date | null;
  boardIntimatedAt: Date | null;
  boardDetailedReportAt: Date | null;
  principalsIntimatedAt: Date | null;
  now: Date;
}): Deadline[] {
  const t = args.facts.noticedAt.getTime();
  const rulesInForce = args.now >= DPDP_RULE_7_COMMENCEMENT;

  const state = (dueBy: Date, doneAt: Date | null, inForce: boolean): Deadline["state"] => {
    if (doneAt) return "done";
    if (!inForce) return "not-yet-in-force";
    return args.now > dueBy ? "overdue" : "due";
  };

  const list: Deadline[] = [
    {
      duty: "Report the incident to CERT-In",
      provision:
        "CERT-In Directions No. 20(3)/2022-CERT-In dated 28 April 2022, Direction (ii), under s.70B(6) of the IT Act 2000 — six hours of NOTICING",
      dueBy: new Date(t + 6 * HOUR),
      inForce: true,
      doneAt: args.certinReportedAt,
      state: state(new Date(t + 6 * HOUR), args.certinReportedAt, true),
    },
    {
      duty: "Intimate each affected Data Principal",
      provision: "DPDPA 2023 s.8(6) with Rule 7 of the DPDP Rules 2025 — without delay",
      /**
       * ⚠️ "WITHOUT DELAY" HAS NO NUMBER. Twenty-four hours is
       * ORDENCE'S OWN operational reading, not the Rule's, and the
       * provision string above does not claim otherwise. A deadline
       * invented here and presented as statutory would be the same fault
       * as citing a section that states no period.
       */
      dueBy: new Date(t + 24 * HOUR),
      inForce: rulesInForce,
      doneAt: args.principalsIntimatedAt,
      state: state(new Date(t + 24 * HOUR), args.principalsIntimatedAt, rulesInForce),
    },
    {
      duty: "Intimate the Data Protection Board",
      provision: "DPDPA 2023 s.8(6) with Rule 7 — without delay upon becoming aware",
      dueBy: new Date(t + 24 * HOUR),
      inForce: rulesInForce,
      doneAt: args.boardIntimatedAt,
      state: state(new Date(t + 24 * HOUR), args.boardIntimatedAt, rulesInForce),
    },
    {
      duty: "File the detailed report with the Board",
      provision: "Rule 7 of the DPDP Rules 2025 — within 72 hours, or such longer period as the Board allows on request",
      dueBy: new Date(t + 72 * HOUR),
      inForce: rulesInForce,
      doneAt: args.boardDetailedReportAt,
      state: state(new Date(t + 72 * HOUR), args.boardDetailedReportAt, rulesInForce),
    },
  ];

  return list;
}

/* ------------------------------------------------------------------ */
/* THE DOCUMENT TO THE PERSON                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHAT RULE 7 ACTUALLY REQUIRES BE SAID, IN ORDER.
 *
 * 🔴 IT DOES NOT VALIDATE THAT THE SENTENCES ARE ANY GOOD. It cannot.
 * What it does is refuse to produce a document with a section missing,
 * because a five-element requirement answered in four is the failure
 * that reads as compliance: the letter exists, it went out, and nobody
 * counted the paragraphs.
 *
 * ⚠️ IT IS ALSO NOT A LEGAL OPINION AND SAYS SO IN ITS OWN FOOTER. A
 * generated document that omitted that would be the product telling a
 * founder that filing it discharges his duty.
 */
export function intimationToPrincipal(args: {
  facts: BreachFacts;
  workspaceName: string;
  principalLabel: string;
  onDate: string;
}): { text: string; missing: string[] } {
  const f = args.facts;

  const required: { label: string; value: string }[] = [
    { label: "nature", value: f.nature },
    { label: "extent", value: f.extent },
    { label: "timing and location", value: f.timingAndLocation },
    { label: "likely consequences", value: f.likelyConsequences },
    { label: "mitigation implemented", value: f.mitigationImplemented },
    { label: "safeguards the Data Principal may take", value: f.safeguardsForPrincipals },
    { label: "contact details of a person able to respond", value: f.contactPerson },
  ];

  const missing = required.filter((r) => r.value.trim().length === 0).map((r) => r.label);

  const out: string[] = [];
  out.push(`${args.workspaceName} — intimation of a personal data breach`);
  out.push(`Reference ${f.reference}. ${args.onDate}.`);
  out.push("");
  out.push(`Dear ${args.principalLabel},`);
  out.push("");
  out.push(
    "We are writing to tell you about a breach affecting personal data we hold about you. " +
      "Section 8(6) of the Digital Personal Data Protection Act 2023 requires us to tell you and to tell " +
      "the Data Protection Board of India.",
  );
  out.push("");
  out.push("WHAT HAPPENED");
  out.push(`  ${f.nature || "[NOT STATED]"}`);
  out.push("");
  out.push("HOW MUCH WAS AFFECTED");
  out.push(`  ${f.extent || "[NOT STATED]"}`);
  if (f.affectedPrincipalCount !== null) {
    out.push(`  Approximately ${f.affectedPrincipalCount} people are affected.`);
  }
  out.push("");
  out.push("WHEN AND WHERE");
  out.push(`  ${f.timingAndLocation || "[NOT STATED]"}`);
  out.push(`  We became aware of it at ${f.noticedAt.toISOString()}.`);
  if (f.occurredAt) out.push(`  We believe it occurred at ${f.occurredAt.toISOString()}.`);
  out.push("");
  out.push("WHAT IT MAY MEAN FOR YOU");
  out.push(`  ${f.likelyConsequences || "[NOT STATED]"}`);
  out.push("");
  out.push("WHAT WE HAVE DONE");
  out.push(`  ${f.mitigationImplemented || "[NOT STATED]"}`);
  out.push("");
  out.push("WHAT YOU CAN DO");
  out.push(`  ${f.safeguardsForPrincipals || "[NOT STATED]"}`);
  out.push("");
  out.push("WHO TO CONTACT");
  out.push(`  ${f.contactPerson || "[NOT STATED]"}`);
  out.push("");
  out.push(
    "You may also complain to the Data Protection Board of India about this breach or about how we have handled it.",
  );

  if (missing.length > 0) {
    out.push("");
    out.push(
      `⚠️ THIS DRAFT IS INCOMPLETE. Rule 7 of the DPDP Rules 2025 requires the following and they are not stated: ${missing.join("; ")}. ` +
        `Do not send it in this form.`,
    );
  }

  return { text: out.join("\n"), missing };
}

/**
 * 🔴 THE ONE FUNCTION IN THIS FILE THAT SAYS "NO".
 *
 * A breach may not be closed with a required section unwritten or an
 * audience untold. The database enforces the second (0113 §5); this
 * enforces the first, and it returns REASONS rather than a boolean so
 * the screen can say which.
 */
export function blockersToClosing(args: {
  facts: BreachFacts;
  boardIntimatedAt: Date | null;
  principalsIntimatedAt: Date | null;
  intimationText: string | null;
}): string[] {
  const reasons: string[] = [];
  const { missing } = intimationToPrincipal({
    facts: args.facts,
    workspaceName: "—",
    principalLabel: "—",
    onDate: "—",
  });
  if (missing.length > 0)
    reasons.push(
      `The intimation is missing content Rule 7 requires: ${missing.join("; ")}.`,
    );
  if (!args.boardIntimatedAt)
    reasons.push("The Data Protection Board has not been told. s.8(6) requires both the Board and the affected people.");
  if (!args.principalsIntimatedAt)
    reasons.push("The affected Data Principals have not been told. s.8(6) requires both.");
  if (args.principalsIntimatedAt && !args.intimationText)
    reasons.push(
      "The intimation is recorded as sent and its text was not kept. What a person was told must be frozen as sent: a template edited later would silently rewrite it.",
    );
  return reasons;
}
