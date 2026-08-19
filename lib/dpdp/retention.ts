/**
 * Ordence — ⭐⭐⭐ THE STATUTES THAT OVERRIDE A RIGHT TO ERASURE
 * Version: v1.68.0-alpha
 *
 * Pure. No database, no clock — `now` and `asOn` are always arguments.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE SENTENCE THIS WHOLE FILE IMPLEMENTS
 * ══════════════════════════════════════════════════════════════════════
 * DPDPA 2023, s.8(7), verbatim:
 *
 *   "A Data Fiduciary shall, UNLESS RETENTION IS NECESSARY FOR
 *    COMPLIANCE WITH ANY LAW FOR THE TIME BEING IN FORCE,— (a) erase
 *    personal data, upon the Data Principal withdrawing her consent or
 *    as soon as it is reasonable to assume that the specified purpose is
 *    no longer being served, whichever is earlier; and (b) cause its
 *    Data Processor to erase any personal data that was made available
 *    by the Data Fiduciary for processing to such Data Processor."
 *
 * ⭐ THE EXCEPTION IS A NAMED-LAW EXCEPTION. "We keep it for our
 * records" is not a defence. "s.36 of the CGST Act 2017 requires it
 * until 31 December 2031" is. So every refusal produced by this file
 * carries a `RetentionRule`, and a rule with no `provision` cannot be
 * constructed — the type does not permit it.
 *
 * ⚠️ s.8(7)(b) REACHES DOWNSTREAM. The duty is not only to erase, it is
 * to cause the processor to erase. Ordence is a Processor for its
 * customers and a Fiduciary for its own staff, and the two roles have
 * different duties on the same database. `PROCESSOR_NOTE` below is where
 * that shows up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE PROVISIONS THAT CANNOT SUPPORT A REFUSAL, AND WHY THIS LIST
 *      IS THE MOST IMPORTANT THING IN THE FILE
 * ══════════════════════════════════════════════════════════════════════
 * Every one of the following is routinely cited in Indian retention
 * guidance as the authority for a period. Not one of them states a
 * period. A refusal resting on any of them tells a Data Principal that a
 * law requires something the law does not say, which is a worse failure
 * than refusing with no reason at all — it is a reason that cannot be
 * checked because checking it would show it is empty.
 *
 *   IT Act 2000 s.67C     — enabling only. "such duration ... as the
 *                           Central Government may PRESCRIBE", and no
 *                           general duration has been prescribed.
 *   RERA 2016 s.11        — six sub-sections, no number of years in any
 *                           of them. s.11(6) delegates to regulations.
 *   Income-tax Rule 31A   — governs FILING quarterly TDS statements.
 *                           Silent on retention.
 *   CGST Rule 46          — the particulars a tax invoice must CONTAIN.
 *   CGST Rule 56          — what to maintain and WHERE. Sub-rule (16)
 *                           routes the period back to s.36. There is one
 *                           GST clock, not two.
 *   EPF Scheme 1952 p.76  — "Punishment for failure to pay
 *                           contributions". A penal provision.
 *   Code on Wages s.50    — "in such manner as may be prescribed".
 *                           Delegates; states no period.
 *   EPF & MP Act 1952     — no express retention period anywhere in it.
 *
 * `FORBIDDEN_CITATIONS` below is enforced by a test. If a rule in this
 * file ever cites one of them, the suite fails.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT CHANGED UNDER ORDENCE'S FEET IN THE LAST TWELVE MONTHS
 * ══════════════════════════════════════════════════════════════════════
 * Three of the Acts a retention engine written in 2024 would have cited
 * have since been repealed, and their replacements delegate rather than
 * state a period:
 *
 *   Income-tax Act 1961      repealed 1 Apr 2026 by the Income-tax Act
 *                            2025. Rules 1962 → Rules 2026.
 *   Payment of Wages Act     repealed 21 Nov 2025, Code on Wages 2019
 *   1936 and Minimum Wages   s.69, when all four labour codes commenced.
 *   Act 1948
 *   ESI Act 1948             repealed 21 Nov 2025 by the Code on Social
 *                            Security 2020; the 1950 Regulations survive
 *                            by savings.
 *
 * 🔴 SO A CITATION IS A FACT WITH AN EXPIRY DATE, and this file records
 * `verified` on every rule — the date somebody last read the provision.
 * A rule nobody has re-read is not wrong, but it is not evidence either,
 * and the erasure screen says which is which.
 */

/* ------------------------------------------------------------------ */
/* THE KINDS OF REFUSAL, WHICH ARE NOT ALL STATUTES                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 FOUR DIFFERENT THINGS GET CALLED "WE CANNOT ERASE THAT" AND ONLY
 *    ONE OF THEM IS s.8(7)'s EXCEPTION.
 *
 * Collapsing them into one message is how a customer ends up telling a
 * Data Principal that the law requires something when what actually
 * happened is that a hash chain would break.
 */
export type RefusalKind =
  /** ⭐ A named provision states a period. The s.8(7) exception proper. */
  | "statute"
  /**
   * ⚠️ NO PROVISION STATES A PERIOD; the period is inferred from how
   * long the record could still be demanded in a proceeding. Defensible,
   * and it must never be presented as though a section said it.
   */
  | "derived-limitation"
  /**
   * 🔴 NOT A LAW AT ALL. The row sits in an append-only, hash-chained
   * structure and deleting it would invalidate every subsequent row's
   * hash. `audit_logs` is the case: 0001 puts a trigger under it and
   * 0081 chains it. The honest answer to the Data Principal is "this is
   * a tamper-evident log; here is what it contains about you and here is
   * why removing one entry would destroy the evidential value of the
   * rest" — not "the law requires it", because it does not.
   */
  | "immutable-by-design"
  /**
   * A human placed a hold. `contracts.legal_hold` is the only one that
   * exists in this build.
   */
  | "legal-hold"
  /**
   * ⚠️ WE BELIEVE A DUTY APPLIES AND COULD NOT VERIFY THE PROVISION.
   *
   * Shown to the operator, never silently resolved either way. A
   * retention engine that quietly rounds "unverified" down to "erase"
   * destroys a record somebody needed; one that rounds it up to "retain"
   * refuses a statutory right on a hunch. Both are wrong, so the
   * decision goes to a person.
   */
  | "unverified";

export type RetentionRule = {
  id: string;
  kind: RefusalKind;
  /**
   * 🔴 THE CITATION. Required by the type. If you cannot write this,
   * you do not have a rule, you have an opinion.
   */
  provision: string;
  /** What the provision actually says, close to its own words. */
  period: string;
  /** The event the clock runs from. Getting this wrong under-retains. */
  clock: string;
  /** One sentence a Data Principal could be shown verbatim. */
  toThePrincipal: string;
  /** ⚠️ The date somebody last read the provision itself. */
  verified: string;
  /** Anything that would change the answer. Empty is not allowed to be lazy. */
  caveat?: string;
};

/* ------------------------------------------------------------------ */
/* THE RULES                                                           */
/* ------------------------------------------------------------------ */

export const RETENTION_RULES = {
  /* --- company law ------------------------------------------------- */
  "companies-act-128-5": {
    id: "companies-act-128-5",
    kind: "statute",
    provision: "Companies Act 2013, s.128(5)",
    period: "not less than eight financial years immediately preceding a financial year",
    /**
     * 🔴 A ROLLING WINDOW, NOT EIGHT YEARS FROM THE ROW.
     *
     * The section fixes the window relative to the CURRENT financial
     * year, so the set of years that must be kept moves forward every
     * 1 April. An engine keyed to "created_at + 8 years" under-retains
     * every record made late in a financial year, and it under-retains
     * silently, because nothing complains until an inspector asks.
     */
    clock: "the eight financial years immediately preceding the current financial year — a rolling window, recomputed each 1 April",
    toThePrincipal:
      "This record forms part of the company's books of account, which s.128(5) of the Companies Act 2013 requires be kept for the eight financial years preceding the current one.",
    verified: "2026-08-19",
    caveat:
      "Where the Central Government has ordered an investigation under Chapter XIV it may direct the books be kept for such longer period as it deems fit — an indefinite hold with no number, which this engine represents as a legal hold rather than a date.",
  },

  /* --- goods and services tax -------------------------------------- */
  "cgst-36": {
    id: "cgst-36",
    kind: "statute",
    provision: "CGST Act 2017, s.36 (read with CGST Rule 56(16))",
    period: "seventy-two months from the due date of furnishing the annual return for the year",
    /**
     * ⚠️ THE CLOCK IS THE ANNUAL RETURN'S DUE DATE, NOT THE INVOICE
     * DATE AND NOT THE FINANCIAL YEAR END. For FY 2024-25, GSTR-9 was
     * due 31 Dec 2025, so the records run to 31 Dec 2031 — a year and
     * nine months later than "invoice date plus 72 months" would give
     * for an April invoice.
     */
    clock: "the due date of the annual return (GSTR-9) for the financial year the record belongs to",
    toThePrincipal:
      "This is a GST record. s.36 of the CGST Act 2017 requires it be retained for 72 months from the due date of the annual return for the year it belongs to.",
    verified: "2026-08-19",
    caveat:
      "The proviso extends this: where the registered person is party to an appeal, revision, other proceeding before any Appellate or Revisional Authority, Tribunal or court, or is under investigation for an offence under Chapter XIX, records on that subject matter are kept for one year after final disposal or the 72 months, whichever is later. Subject-matter scoped, not entity-wide.",
  },

  /* --- income tax and TDS ------------------------------------------ */
  "tds-limitation-derived": {
    id: "tds-limitation-derived",
    /**
     * 🔴 `derived-limitation`, NOT `statute`, AND THE DIFFERENCE MATTERS.
     *
     * There is NO provision in Indian income-tax law that states how
     * long a deductor must keep deductee records. Rule 31A governs
     * FILING. What exists is a window during which the record can still
     * be demanded, and the retention period is inferred from it.
     *
     * ⚠️ BOTH LIMBS MOVED IN 2024 AND THE OLD FIGURES ARE STILL THE
     * ONES MOST GUIDANCE QUOTES. s.201(3) was seven years and is now
     * six-or-two-whichever-is-later; s.149 had a ten-year limb and no
     * longer does. Quoting either old figure would over-retain, which
     * under s.8(7) is itself a breach.
     */
    kind: "derived-limitation",
    provision:
      "derived from Income-tax Act 1961 s.201(3) (as amended by the Finance (No.2) Act 2024, w.e.f. 1-4-2025) and s.149; no provision states a retention period",
    period:
      "seven years from the end of the financial year of payment or credit — the envelope of s.201(3) (six years, or two years from a correction statement, whichever is later) and s.149 (three years three months, extended to five years three months where escaped income is ₹50 lakh or more)",
    clock: "the end of the financial year in which the payment was made or the credit given",
    toThePrincipal:
      "No law states how long TDS records must be kept. This one is retained for seven years from the end of the financial year of payment, because the Income-tax Department may still open proceedings about it for that long under s.201(3) and s.149.",
    verified: "2026-08-19",
    caveat:
      "The Income-tax Act 1961 was repealed with effect from 1 April 2026 by the Income-tax Act 2025. Sections 201 and 149 continue to govern years before that date under the transitional provisions. The corresponding limits under the 2025 Act have NOT been read against the gazette and are not encoded here.",
  },

  "income-tax-books-6f": {
    id: "income-tax-books-6f",
    kind: "unverified",
    /**
     * ⚠️ THE HONEST STATE OF THIS ONE.
     *
     * Rule 6F(5) of the Income-tax Rules 1962 said six years from the
     * end of the relevant assessment year, and that is verified. But the
     * 1962 Rules were replaced by the Income-tax Rules 2026 on 1 April
     * 2026 and the successor is Rule 46, whose period two secondary
     * sources report as seven tax years and which nobody here has read
     * against G.S.R. 198(E).
     *
     * 🔴 SO IT IS `unverified`, AND THAT IS THE POINT. Encoding "seven"
     * from a blog and presenting it to a customer as the law would be
     * the fabrication this whole file exists to prevent. The engine
     * refuses to decide and hands it to a person, and the screen says
     * exactly which sentence could not be verified.
     */
    provision:
      "Income-tax Rules 2026, Rule 46 (successor to Rule 6F of the Income-tax Rules 1962) — NOT READ AGAINST THE GAZETTE",
    period:
      "Rule 6F(5) of the 1962 Rules stated six years from the end of the relevant assessment year. The 2026 successor is reported as seven tax years and has not been verified.",
    clock: "the end of the relevant assessment year (1962 Rules); the trigger under the 2026 Rules is unconfirmed",
    toThePrincipal:
      "This record may be subject to an income-tax retention rule that changed on 1 April 2026 and that we have not yet confirmed. It has not been erased and it has not been treated as exempt: a person must decide.",
    verified: "2026-08-19 — verified only that it COULD NOT be verified",
    caveat:
      "Verify against G.S.R. 198(E) dated 20 March 2026 before this rule is allowed to refuse anything automatically.",
  },

  /* --- real estate --------------------------------------------------- */
  "rera-state-rules": {
    id: "rera-state-rules",
    kind: "unverified",
    /**
     * 🔴 THE BRIEF ASSUMED RERA REQUIRES ALLOTTEE RECORDS FOR THE LIFE
     *    OF THE PROJECT AND CITED s.11. s.11 DOES NOT SAY THAT.
     *
     * Its six sub-sections contain no number of years. s.11(6) requires
     * the promoter to maintain "such other details as may be specified,
     * from time to time, by regulations" — a delegation. Any retention
     * duty therefore comes from STATE RERA rules, which differ by state
     * and which nobody here has read.
     *
     * ⚠️ Ordence knows the state: `projects.state_code`. So this is a
     * per-state lookup that can be built, and until it is built the
     * honest answer is a refusal to decide — not a citation to a section
     * that would not survive being looked up.
     */
    provision:
      "state Real Estate Regulatory Authority rules made under the Real Estate (Regulation and Development) Act 2016 — state not yet resolved. NOT s.11, which states no period.",
    period: "state-dependent; not established",
    clock: "state-dependent; not established",
    toThePrincipal:
      "You are an allottee on a registered real-estate project. Retention of allottee records is governed by the RERA rules of the state the project is registered in, which we have not yet confirmed for this project. A person must decide before anything is erased.",
    verified: "2026-08-19 — verified that the CENTRAL Act states no period",
    caveat:
      "Build the per-state table keyed on projects.state_code. Until then every allottee erasure on a RERA project goes to a human.",
  },

  /* --- employment ---------------------------------------------------- */
  "wage-registers-code-rules": {
    id: "wage-registers-code-rules",
    kind: "unverified",
    /**
     * ⚠️ THE GROUND MOVED ON 21 NOVEMBER 2025.
     *
     * The three-years-from-last-entry rule everybody knows came from the
     * Payment of Wages Rules 1937 and Rule 26 of the Minimum Wages
     * (Central) Rules 1950. Both parent Acts were repealed by s.69 of
     * the Code on Wages 2019 when all four labour codes commenced.
     *
     * s.50 of the Code requires the register and says "in such manner as
     * may be prescribed" — it states no period. Central rules exist,
     * state rules are still being notified. So the number survives as
     * practice and the CITATION does not survive at all.
     */
    provision:
      "rules made under s.50 of the Code on Wages 2019 — s.50 itself prescribes no period; the Payment of Wages Act 1936 s.13A and the Minimum Wages Act 1948 were repealed on 21 November 2025",
    period:
      "three years from the date of the last entry, carried over from the Payment of Wages Rules 1937 and Rule 26 of the Minimum Wages (Central) Rules 1950 — practice, not a provision now in force",
    clock: "the date of the last entry in the register, not the wage period",
    toThePrincipal:
      "Wage registers were required to be kept for three years from the last entry under rules that were repealed in November 2025. The replacement rules under the Code on Wages 2019 are still being notified. This record has not been erased and a person must decide.",
    verified: "2026-08-19 — verified the repeal; the successor rule text was not read",
    caveat: "State rules under the Code on Wages differ. Resolve per establishment state before automating.",
  },

  "esi-register-reg-32": {
    id: "esi-register-reg-32",
    kind: "statute",
    provision: "Employees' State Insurance (General) Regulations 1950, Regulation 32",
    period: "five years from the date of the last entry in the register",
    clock: "the date of the last entry, not the contribution period",
    toThePrincipal:
      "This forms part of the register of employees, which Regulation 32 of the ESI (General) Regulations 1950 requires be preserved for five years from the last entry.",
    verified: "2026-08-19",
    caveat:
      "The ESI Act 1948 was repealed on 21 November 2025 by the Code on Social Security 2020; the 1950 Regulations continue under the Code's savings. Regulation 66's five-year rule is the ACCIDENT BOOK, a different document — do not conflate them.",
  },

  "epf-no-express-period": {
    id: "epf-no-express-period",
    kind: "unverified",
    /**
     * 🔴 THE CITATION EVERYBODY USES IS WRONG. Paragraph 76 of the
     * Employees' Provident Funds Scheme 1952 is titled "Punishment for
     * failure to pay contributions". It is a penal provision and it says
     * nothing about records.
     *
     * Neither the EPF & MP Act 1952 nor the Scheme states a retention
     * period at all. The seven-to-ten years in circulation is custom.
     */
    provision:
      "none — neither the Employees' Provident Funds and Miscellaneous Provisions Act 1952 nor the Employees' Provident Funds Scheme 1952 states a retention period. Paragraph 76 of the Scheme is a PENAL provision and does not support a refusal.",
    period: "no statutory period; seven to ten years is common practice and is not law",
    clock: "not established",
    toThePrincipal:
      "Provident fund records are commonly kept for seven to ten years, but no provision of the EPF Act or Scheme requires it. We have not erased this and a person must decide.",
    verified: "2026-08-19",
    caveat: "The EPF & MP Act 1952 was NOT repealed on 21 November 2025, unlike the ESI Act.",
  },

  /* --- logs ----------------------------------------------------------- */
  "certin-180-day-logs": {
    id: "certin-180-day-logs",
    kind: "statute",
    /**
     * ⭐ THIS ONE BINDS ORDENCE ITSELF, NOT THE CUSTOMER.
     *
     * Direction (iv) of the CERT-In Directions of 28 April 2022, issued
     * under s.70B(6) of the IT Act 2000, binds "service providers,
     * intermediaries, data centres, body corporate and Government
     * organisations". A multi-tenant SaaS is a body corporate. There is
     * no size or sector threshold.
     *
     * ⚠️ AND IT IS A FLOOR, NOT A CAP. 180 days is the minimum; it does
     * not authorise keeping logs for ever, and s.8(7) still applies to
     * anything held past a period some law requires.
     *
     * ⚠️ Direction (iv) also requires the logs be maintained WITHIN
     * INDIAN JURISDICTION. That is a placement duty this engine does not
     * evaluate — it is recorded here so nobody reads a passing retention
     * check as a passing CERT-In check.
     */
    provision:
      "CERT-In Directions No. 20(3)/2022-CERT-In dated 28 April 2022, Direction (iv), under s.70B(6) of the Information Technology Act 2000",
    period: "a rolling period of 180 days",
    clock: "rolling — the last 180 days at any moment",
    toThePrincipal:
      "This is a system access log. CERT-In's directions of 28 April 2022 require logs of all ICT systems be kept for a rolling 180 days.",
    verified: "2026-08-19",
    caveat:
      "The same direction requires these logs be maintained within Indian jurisdiction, which this engine does not check. s.67C of the IT Act 2000 is NOT the authority for any period: it is enabling only and no general duration has been prescribed under it.",
  },

  /* --- contract claims ------------------------------------------------ */
  "limitation-article-55": {
    id: "limitation-article-55",
    kind: "derived-limitation",
    provision:
      "Article 55 of the Schedule to the Limitation Act 1963 (residuary: Article 113)",
    period: "three years",
    clock:
      "when the contract is broken; where breaches are successive, the breach sued on; where the breach is continuing, when it ceases",
    toThePrincipal:
      "This record relates to a contract you are party to. It is kept for three years from any breach, because that is how long a claim on it can be brought under Article 55 of the Limitation Act 1963.",
    verified: "2026-08-19",
    caveat:
      "Article 55 is the DAMAGES limb only. Specific performance falls under Article 54 and the price of goods sold under Articles 14-15. A contract record held on 'Article 55' authority is being held on the narrowest of the three.",
  },

  /* --- not a law at all ----------------------------------------------- */
  "audit-chain-immutable": {
    id: "audit-chain-immutable",
    kind: "immutable-by-design",
    /**
     * 🔴 THE HONEST ONE. `audit_logs` cannot be erased because a trigger
     * from 0001 blocks UPDATE and DELETE and 0081 hash-chains every row
     * to its predecessor. Removing one entry does not remove one entry;
     * it invalidates every hash after it, which is the property that
     * makes the log worth having.
     *
     * ⚠️ THIS IS NOT s.8(7)'s EXCEPTION AND MUST NOT BE DRESSED AS ONE.
     * No law requires Ordence to keep an unbreakable audit chain. It is
     * a design decision, it is defensible, and a Data Principal is
     * entitled to be told that it is a design decision so they can argue
     * with it. Presenting it as a statute would be a lie that survives
     * exactly as long as nobody looks up the section.
     */
    provision:
      "not a statutory requirement — audit_logs is append-only by database trigger (SQL-FILES/0001) and hash-chained (SQL-FILES/0081)",
    period: "indefinite while the chain stands",
    clock: "n/a",
    toThePrincipal:
      "Your actions are recorded in a tamper-evident log. Each entry is cryptographically linked to the one before it, so removing a single entry would destroy the integrity of every entry after it. This is our design choice, not a legal requirement, and we will tell you exactly what the log holds about you.",
    verified: "2026-08-19",
    caveat:
      "A future migration could add a redaction column that blanks the payload while preserving the hash of the original. That is the only erasure-compatible design, and it does not exist in this build.",
  },

  "compliance-evidence": {
    id: "compliance-evidence",
    /**
     * 🔴 `immutable-by-design`, NOT `statute`, AND IT IS TEMPTING TO GET
     *    THIS WRONG IN THE MOST SELF-SERVING DIRECTION.
     *
     * The register of data-principal requests holds the requester's name
     * and email. A person who asks to be erased and is then told "we
     * cannot erase the record of you asking to be erased" deserves a
     * straight answer about why, and the straight answer is NOT that a
     * law requires it. No provision of the DPDPA states a period for
     * which a Fiduciary must keep evidence of compliance.
     *
     * ⭐ WHAT IS TRUE: this record is the only thing that establishes the
     * request was answered. Erase it and the workspace has no way to show
     * the Board it complied, and the Data Principal has no way to show it
     * did not. It protects both of them, and it is a design decision.
     *
     * ⚠️ `data_principal_request_events` is append-only by trigger
     * (0113 §4) as well, so for that table the refusal is also physical.
     */
    kind: "immutable-by-design",
    provision:
      "not a statutory requirement — the record that a request was made and answered is the only evidence, for either side, that it was",
    period: "kept while the workspace operates; no provision states a period",
    clock: "n/a",
    toThePrincipal:
      "We have kept the record of your request and of what we did about it. This is the only evidence that we answered you, and it is as much yours as ours: without it you could not show us what we told you. It holds your name, your contact details and our reasons, and nothing else about you. This is our design choice and not a legal requirement.",
    verified: "2026-08-19",
    caveat:
      "s.8(7) applies to this record too. A workspace that closes should erase it with everything else; there is no law holding it back.",
  },

  "contract-legal-hold": {
    id: "contract-legal-hold",
    kind: "legal-hold",
    provision:
      "a legal hold placed by a person in this workspace — contracts.legal_hold, with contracts.legal_hold_reason",
    period: "until the hold is lifted",
    clock: "n/a",
    toThePrincipal:
      "A legal hold has been placed on this record because litigation is anticipated. It cannot be erased while the hold stands, and the reason is recorded.",
    verified: "2026-08-19",
    caveat:
      "The hold is enforced on contracts and documents only (server/actions/documents.ts, server/actions/portal.ts). It does NOT presently block a tenant termination.",
  },
} as const satisfies Record<string, RetentionRule>;

export type RetentionRuleId = keyof typeof RETENTION_RULES;

export const RETENTION_RULE_IDS = Object.keys(RETENTION_RULES) as RetentionRuleId[];

/* ------------------------------------------------------------------ */
/* THE PROVISIONS THAT MUST NEVER APPEAR IN A REFUSAL                  */
/* ------------------------------------------------------------------ */

/**
 * 🔴 ENFORCED BY A TEST, NOT BY A COMMENT.
 *
 * Each entry is a provision that states no period, paired with what it
 * actually does. A rule citing one of these is not a small error: it is
 * a refusal a Data Principal cannot check, because checking it would
 * show the section is silent. Two of these — RERA s.11 and the IT Act
 * s.67C — were in the brief for this batch as though they were periods.
 *
 * ⚠️ MATCHED AS SUBSTRINGS AGAINST `provision`, WITH ONE DELIBERATE
 * EXCEPTION: a rule may NAME a forbidden provision in order to say it
 * does not apply. `mentionsOnlyToDisclaim` decides which, and it looks
 * for the disclaiming words. A rule that names s.67C without disclaiming
 * it fails.
 */
export const FORBIDDEN_CITATIONS: readonly { needle: string; because: string }[] = [
  { needle: "s.67C", because: "IT Act 2000 s.67C is enabling only; no general duration has been prescribed under it" },
  { needle: "section 67C", because: "same as s.67C" },
  { needle: "RERA 2016, s.11", because: "s.11 of the RERA Act states no retention period; the duty is in state rules" },
  { needle: "Rule 31A", because: "Income-tax Rule 31A governs filing quarterly TDS statements, not retention" },
  { needle: "CGST Rule 46", because: "CGST Rule 46 lists the particulars of a tax invoice; it states no period" },
  { needle: "Paragraph 76", because: "EPF Scheme 1952 para 76 is a penal provision" },
  { needle: "para 76", because: "EPF Scheme 1952 para 76 is a penal provision" },
];

const DISCLAIMERS = [
  "NOT",
  "not the authority",
  "states no period",
  "does not support",
  "penal provision",
  "enabling only",
  "governs filing",
  "prescribes no period",
];

export function mentionsOnlyToDisclaim(provision: string, needle: string): boolean {
  const at = provision.indexOf(needle);
  if (at < 0) return true;
  return DISCLAIMERS.some((d) => provision.includes(d));
}

/* ------------------------------------------------------------------ */
/* ORDENCE'S OWN POSITION                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE TWO HATS, WHICH ARE EASY TO MIX UP AND EXPENSIVE TO MIX UP.
 *
 * For a workspace's contacts, employees and allottees, the WORKSPACE is
 * the Data Fiduciary and Ordence is its Data Processor. Ordence does not
 * decide whether to erase; it does what the Fiduciary instructs, and
 * s.8(7)(b) makes the Fiduciary responsible for causing it.
 *
 * For Ordence's own staff, its billing records and its platform logs,
 * ORDENCE is the Fiduciary and the duty is its own.
 *
 * ⚠️ The same database holds both. `platform_staff`, `platform_action_log`
 * and `billing.invoices` are Ordence's; everything under a tenant_id is
 * the customer's. An erasure request arriving at a workspace must not
 * reach into the first group, and an erasure request from an Ordence
 * employee must not reach into the second.
 */
export const PROCESSOR_NOTE =
  "For tenant-scoped data Ordence is a Data Processor and the workspace is the Data Fiduciary: Ordence executes, the workspace decides. s.8(7)(b) makes the workspace responsible for causing this erasure, which is why the request is recorded against the workspace and not against Ordence.";

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

export type ErasureAction =
  /** The rows go. */
  | "delete"
  /**
   * ⭐ The identifying columns are blanked and the row stays. The
   * statutory record survives without the contactable identity — which
   * is the shape s.8(7) actually wants where a law requires the RECORD
   * but not the NAME.
   */
  | "redact"
  /** Nothing happens and a reason is recorded. */
  | "retain"
  /** 🔴 A person decides. Never resolved silently in either direction. */
  | "refer";

export type RetentionVerdict = {
  action: ErasureAction;
  rule: RetentionRule | null;
  /** ⭐ Shown to the operator AND to the principal. One sentence. */
  because: string;
};

/**
 * ⚠️ `retain` AND `refer` ARE NOT INTERCHANGEABLE.
 *
 * `retain` says a law we have read requires this. `refer` says we do not
 * know, and the difference is the whole difference between a compliance
 * feature and a compliance theatre.
 */
export function decide(args: {
  /** The rule the classification attached to this table, if any. */
  ruleId: RetentionRuleId | null;
  /** ⭐ True where the statutory clock has demonstrably run out. */
  periodExpired?: boolean;
  /** A hold placed by a person, which beats everything. */
  legalHold?: boolean;
  /** Whether the row's identifying columns can be blanked without breaking the statutory record. */
  redactable?: boolean;
}): RetentionVerdict {
  if (args.legalHold) {
    const r = RETENTION_RULES["contract-legal-hold"];
    return { action: "retain", rule: r, because: r.toThePrincipal };
  }

  if (!args.ruleId) {
    return {
      action: "delete",
      rule: null,
      because:
        "No retention rule is attached to this table, so s.8(7) applies without exception and the data is erased.",
    };
  }

  const rule = RETENTION_RULES[args.ruleId];

  /**
   * 🔴 `unverified` NEVER AUTO-RESOLVES, AND IT DOES NOT MATTER THAT
   * THE CLOCK MIGHT HAVE EXPIRED — the clock is the thing we could not
   * establish.
   */
  if (rule.kind === "unverified") {
    return { action: "refer", rule, because: rule.toThePrincipal };
  }

  if (rule.kind === "immutable-by-design") {
    return { action: "retain", rule, because: rule.toThePrincipal };
  }

  /**
   * ⭐ THE EXCEPTION IS TIME-BOUND AND SO IS THE REFUSAL. s.8(7) does
   * not permit keeping a record for ever because a law once required it
   * for six years. When the period has run, the duty to erase revives.
   */
  if (args.periodExpired === true) {
    return {
      action: "delete",
      rule,
      because: `${rule.provision} no longer requires this record: the period (${rule.period}) has run. s.8(7) applies again and the data is erased.`,
    };
  }

  /**
   * ⚠️ REDACTION IS OFFERED ONLY WHERE THE CLASSIFICATION SAYS THE
   * STATUTORY RECORD SURVIVES WITHOUT THE NAME. It usually does not: a
   * tax invoice under CGST Rule 46 must carry the recipient's name and
   * address, so redacting them would destroy the very record s.36
   * requires be kept. The default is therefore `retain`.
   */
  if (args.redactable === true) {
    return {
      action: "redact",
      rule,
      because: `${rule.toThePrincipal} The contactable identity has been removed; the statutory record remains.`,
    };
  }

  return { action: "retain", rule, because: rule.toThePrincipal };
}
