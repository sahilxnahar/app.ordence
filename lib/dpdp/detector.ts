/**
 * Ordence — ⭐⭐⭐ THE PERSONAL-DATA DETECTOR
 * Version: v1.68.0-alpha
 *
 * Pure. No database, no clock, no schema import. It is handed column
 * names and it returns what it thinks they carry.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A DETECTOR AND NOT JUST A LIST
 * ══════════════════════════════════════════════════════════════════════
 * `lib/dpdp/classification.ts` is a hand-written list of every table and
 * what it holds. A hand-written list is correct on the day it is written
 * and wrong the first time somebody adds a table — which in this
 * repository is roughly weekly. Eleven features in this codebase have
 * already been declared, displayed or built and reached by nothing; a
 * data inventory that nothing re-derives would be the twelfth, and the
 * customer harmed by it would be the one who believed they had complied.
 *
 * ⭐ So the list is not the authority. The DETECTOR is the authority for
 * "this table looks like it carries personal data", the LIST is the
 * authority for "and here is what we decided to do about it", and
 * `scripts/check-data-classification.mjs` fails the build when the two
 * disagree. The list can only ever be a decision ABOUT something the
 * detector already found.
 *
 * ⚠️ THE DETECTOR IS DELIBERATELY OVER-SENSITIVE, and that is not a
 * defect to be tuned away. A false positive costs one line in the
 * classification saying "no, and here is why". A false negative is a
 * table full of somebody's phone numbers that no export ever reads and
 * no erasure ever touches, and nothing anywhere says so. The two errors
 * are not comparable, so the thresholds are not balanced.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT "PERSONAL DATA" MEANS HERE, IN THE ACT'S OWN TERMS
 * ══════════════════════════════════════════════════════════════════════
 * DPDPA 2023 s.2(t): "personal data" means any data about an individual
 * who is identifiable by or in relation to such data.
 *
 * 🔴 "IN RELATION TO" IS THE WHOLE PROBLEM. A `payslips` row holds no
 * name if you read it alone — it holds `employee_id`. Read alongside
 * `employees` it holds a named person's salary. So a foreign key to a
 * person-bearing table makes a row personal data just as surely as an
 * email column does, and a detector that only looked for names would
 * miss most of this schema.
 *
 * ⚠️ AND A COMPANY IS NOT A DATA PRINCIPAL. s.2(j) says "the individual
 * to whom the personal data relates". A GSTIN on an invoice to Acme Ltd
 * is not personal data. The same GSTIN on an invoice to a sole
 * proprietor is, because for a proprietorship the firm and the
 * individual are the same person and there is no column in this schema
 * that reliably tells them apart. The detector flags it and the
 * classification decides — which is the division of labour throughout.
 */

/* ------------------------------------------------------------------ */
/* THE SIGNAL KINDS                                                     */
/* ------------------------------------------------------------------ */

export type SignalKind =
  /**
   * ⭐ The column names or contacts a human being on its face.
   * A table with one of these is personal data with no further argument.
   */
  | "direct"
  /**
   * 🔴 A government identifier. Not merely personal data — under Rule 3
   * and the s.8(5) security-safeguards duty these are the columns whose
   * exposure is a reportable breach rather than an embarrassment.
   * Separated from `direct` so the breach artefact can say WHICH.
   */
  | "identifier"
  /**
   * A foreign key to a table that carries a person. Makes the row
   * personal data "in relation to" that person, s.2(t).
   */
  | "link"
  /**
   * ⚠️ A schemaless column. `custom_fields`, `metadata`, `payload`,
   * a free-text `notes`. It carries whatever the customer put in it, and
   * customers put phone numbers in `notes`. It cannot be classified by
   * name and it cannot be assumed empty.
   */
  | "freeform";

export type ColumnSignal = {
  column: string;
  kind: SignalKind;
  /** Which rule matched. Printed by the gate so a surprise is explainable. */
  rule: string;
};

type Rule = { rule: string; kind: SignalKind; test: RegExp };

/* ------------------------------------------------------------------ */
/* THE RULES                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE ANCHORS ARE NOT DERIVED FROM THIS FILE.
 *
 * `link` rules name the columns that point AT a person. The set of
 * tables that ARE a person is declared in `classification.ts` as
 * `principal`, and the gate cross-checks the two: a `link` rule naming
 * `allottee_id` when no table is classified as holding allottees is a
 * rule that can never fire, and the gate says so rather than letting it
 * sit there looking like coverage.
 */
const RULES: readonly Rule[] = [
  /* --- government and financial identifiers ----------------------- */
  { rule: "aadhaar", kind: "identifier", test: /(^|_)(aadhaar|aadhar)(_|$)/ },
  { rule: "pan", kind: "identifier", test: /(^|_)pan(_|$)|(^|_)pan_(number|no|status)(_|$)/ },
  { rule: "uan", kind: "identifier", test: /(^|_)uan(_|$)/ },
  { rule: "esic", kind: "identifier", test: /(^|_)(esic|esi_number)(_|$)/ },
  { rule: "pf-number", kind: "identifier", test: /(^|_)pf_(number|no|account)(_|$)/ },
  { rule: "passport", kind: "identifier", test: /passport/ },
  { rule: "driving-licence", kind: "identifier", test: /driving_(licence|license)/ },
  { rule: "voter-id", kind: "identifier", test: /voter_id/ },
  { rule: "gstin", kind: "identifier", test: /(^|_)gstin(_|$)/ },
  { rule: "tan", kind: "identifier", test: /(^|_)tan(_|$)/ },
  /**
   * ⚠️ `direct`, NOT `identifier`, AND THE DIFFERENCE IS REAL.
   * `channel_partners.rera_number` registers an AGENT — often a natural
   * person. `projects.rera_number` registers a BUILDING. The same column
   * name, two different things, and only the table tells them apart.
   */
  { rule: "rera-number", kind: "direct", test: /rera_(number|no|reg)/ },
  { rule: "udyam", kind: "identifier", test: /udyam/ },
  { rule: "bank-account", kind: "identifier", test: /(^|_)(ifsc|upi_vpa|bank_details)(_|$)|account_(number|no)(_|$)/ },

  /* --- names and contact points ----------------------------------- */
  { rule: "name", kind: "direct", test: /(^|_)(first_name|last_name|full_name|middle_name|legal_name|trade_name|firm_name)(_|$)/ },
  /**
   * ⚠️ ANY `*_name` COLUMN, NOT A LIST OF KNOWN PREFIXES.
   *
   * The first version of this rule listed the prefixes it knew about and
   * missed `accepted_by_name` on `field_proofs` — the name of the person
   * who signed for a delivery. A closed list of prefixes is a detector
   * that only finds the tables somebody already thought of, which is the
   * failure this whole file exists to avoid. It now matches every
   * `*_name`, and the classification carries the exemptions
   * (`file_name`, `tool_name`, `source_filename` and the like) by name.
   */
  { rule: "person-name", kind: "direct", test: /_name$/ },
  /**
   * 🔴 BARE ROLE WORDS. `powers_of_attorney.grantor` and `.attorney` are
   * two named human beings and neither column contains the string
   * "name". No pattern finds these; they are enumerated because the
   * alternative is not finding them at all. Every legal instrument added
   * to this schema will add more.
   */
  { rule: "legal-party", kind: "direct", test: /^(grantor|grantee|attorney|witness|guardian|proposer|applicant|claimant|petitioner|respondent|assignor|assignee|executor|testator|mortgagor|mortgagee|lessor|lessee|surety)$/ },
  { rule: "bare-name", kind: "direct", test: /^name$/ },
  { rule: "email", kind: "direct", test: /(^|_)email(_|$)|email_(normalized|key|normalised)/ },
  { rule: "phone", kind: "direct", test: /(^|_)(phone|mobile|whatsapp|telephone)(_|$)|phone_(digits|number)/ },
  { rule: "postal-address", kind: "direct", test: /(^|_)address(_|$)|address_line|(^|_)(pincode|postal_code|locality)(_|$)/ },
  { rule: "geolocation", kind: "direct", test: /(^|_)(latitude|longitude|geo_lat|geo_lng)$/ },
  { rule: "network-identity", kind: "direct", test: /(^|_)(ip_address|ip_prefix|user_agent|last_viewed_ip)(_|$)/ },
  { rule: "social-handle", kind: "direct", test: /linkedin_url|twitter_|(^|_)avatar_url(_|$)/ },
  { rule: "job", kind: "direct", test: /(^|_)(designation|job_title)(_|$)/ },

  /**
   * 🔴 SENSITIVE-CATEGORY SIGNALS. DPDPA does not carve out "sensitive
   * personal data" the way the 2011 SPDI Rules did — the Act treats all
   * personal data alike. These are flagged anyway because they are the
   * columns whose presence changes what a breach report has to say, and
   * because Rule 10 of the DPDP Rules 2025 makes children's data a
   * separate duty with a separate consent path.
   */
  { rule: "date-of-birth", kind: "direct", test: /(^|_)(date_of_birth|dob|birth_date)(_|$)/ },
  { rule: "demographic", kind: "direct", test: /(^|_)(gender|marital_status|blood_group|religion|caste|nationality|disability)(_|$)/ },
  { rule: "biometric-or-image", kind: "direct", test: /(^|_)(photo|photograph|fingerprint|signature_image)(_|$)|photo_document_id/ },
  { rule: "remuneration", kind: "direct", test: /(^|_)(salary|ctc|gross_pay|net_pay|basic_pay)(_|$)|^(gross|net_pay)_minor$/ },

  /* --- links to a person ------------------------------------------ */
  /**
   * ⚠️ EVERY RULE HERE IS ANCHORED `(^|_)` AND NOT `^`.
   *
   * `^employee_id$` missed `reviewer_employee_id` on `appraisal_reviews`
   * — a performance review, about a named employee, written by another
   * named employee, invisible to the first draft of this file. Prefixed
   * foreign keys are the normal case in this schema, not the exception.
   */
  { rule: "link-contact", kind: "link", test: /(^|_)contact_id$/ },
  { rule: "link-lead", kind: "link", test: /(^|_)lead_id$|^duplicate_of$/ },
  { rule: "link-employee", kind: "link", test: /(^|_)employee_id$/ },
  { rule: "link-user", kind: "link", test: /(^|_)user_id$|^(owner_id|author_id|assigned_to|sales_rep_id|reviewer_id)$/ },
  /**
   * ⭐ `*_by` IS A PERSON, WHATEVER THE VERB IS. `created_by`,
   * `imported_by`, `closed_by`, `uan_verified_by`, `possession_recorded_by`
   * — the list of verbs is open and enumerating it is how
   * `bank_statements.imported_by` was missed.
   */
  { rule: "link-actor", kind: "link", test: /_by$/ },
  { rule: "link-worker", kind: "link", test: /(^|_)(worker_id|site_worker_id|labour_id)$/ },
  { rule: "link-deductee", kind: "link", test: /(^|_)deductee_id$/ },
  /**
   * 🔴 THERE IS NO `landowner_id` ANYWHERE IN THIS SCHEMA.
   *
   * `joint_development_agreements` names the landowner in
   * `landowner_name` — a STRING, with no key. So a landowner asking what
   * a developer holds about them cannot be answered by a join, and an
   * erasure cannot find that row by id. The rule matches the name column
   * for exactly that reason: the gap is real and this is where it shows.
   */
  { rule: "link-landowner", kind: "link", test: /(^|_)landowner_(id|name)$/ },
  { rule: "link-partner", kind: "link", test: /(^|_)channel_partner_id$/ },
  { rule: "link-vendor", kind: "link", test: /(^|_)(vendor_id|supplier_id)$/ },
  /**
   * 🔴🔴 THE POLYMORPHIC POINTER, AND IT IS THE WORST CASE IN THE SCHEMA.
   *
   * `vault_consents.subject_id` holds the id of a data principal and
   * `subject_kind` says which table it is in. So does
   * `message_sends.subject_id`, `email_outbox.subject_id`,
   * `customer_rhythms.subject_id`, `appraisal_reviews.subject_id`.
   *
   * ⚠️ There is no foreign key, so nothing in the database enforces that
   * the target exists, nothing cascades when the target is deleted, and
   * a query planner cannot help. An export that walks foreign keys walks
   * straight past every one of these rows. That is precisely the
   * "quietly misses a table" failure — except it misses them one row at
   * a time, which is harder to notice.
   *
   * They are flagged as `link` so the classification is FORCED to state
   * the discriminator column and the values it can take.
   */
  { rule: "link-polymorphic", kind: "link", test: /^subject_id$/ },

  /* --- freeform carriers ------------------------------------------ */
  {
    rule: "freeform-jsonb",
    kind: "freeform",
    test: /^(custom_fields|metadata|detail|details|payload|intake_payload|raw|raw_payload|lines|preferences|declared_deductions_minor)$/,
  },
  {
    rule: "freeform-text",
    kind: "freeform",
    test: /^(notes|note|remarks|description|body|body_text|body_html|rendered_body|comment|comments|reason|summary|requirement|consent_statement|caption|strengths|improvements|feedback|justification|message|explanation|problems|title|subject)$/,
  },
];

/* ------------------------------------------------------------------ */
/* EXCLUSIONS — THE FALSE POSITIVES THAT ARE WORTH NAMING              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EXACT COLUMN NAMES ONLY, NEVER A PATTERN.
 *
 * A pattern exclusion is how a detector quietly stops detecting. Every
 * entry here is one column that matched one rule and does not carry a
 * person, written out in full so that adding a genuinely personal column
 * whose name is one character different does not inherit the exemption.
 */
const NOT_PERSONAL = new Map<string, string>([
  ["signature_header", "an HTTP header NAME on a webhook endpoint, not a person's signature"],
  ["signature_state", "an enum describing whether a webhook signature verified"],
  ["content_hash", "a digest of a document, not a person"],
  ["pf_applicable", "a boolean on a pay COMPONENT definition, not on a person"],
  ["pf_exempt", "a boolean policy flag; kept out of `identifier` but the row is personal via employee"],
  ["pf_on_full_wages", "a policy flag on the employer's PF election"],
  ["pf_on_allowance", "a policy flag on a reimbursement class"],
  ["esi_exempt", "a policy flag, not an ESIC number"],
  ["net_payable_minor", "an amount on a bill or commission line, not a wage"],
  ["unit_amount_minor", "a subscription price, not a person's pay"],
  ["name", "see BARE_NAME_EXEMPT — decided per table, not globally"],

  /**
   * ⭐ THE `*_name` FALSE POSITIVES, EACH BY EXACT NAME.
   *
   * The `person-name` rule matches every `*_name` column deliberately —
   * a closed list of known prefixes missed `accepted_by_name` on
   * `field_proofs`, the person who signed for a delivery. The cost of
   * that breadth is this list, and paying it by exact name is the point:
   * a future `signer_table_name` inherits no exemption.
   *
   * ⚠️ SEVERAL PLAUSIBLE CANDIDATES ARE NOT HERE ON PURPOSE.
   * `bank_name`, `court_name`, `carrier_name` and `authority_name` are
   * institutions, not people — and each sits on a row that is about a
   * person anyway, so exempting them would change nothing except to make
   * this list longer and the next reviewer more confident than they
   * should be.
   */
  ["table_name", "the name of a database TABLE, written by the erasure recorder"],
  ["api_name", "a developer-facing identifier on a dynamic object"],
  ["display_field_api_name", "an identifier naming another field"],
  ["display_field_name", "an identifier naming another field"],
  ["physical_table_name", "a generated PostgreSQL table name"],
  ["physical_column_name", "a generated PostgreSQL column name"],
  ["field_name", "a custom-field identifier"],
  ["plural_name", "the plural label of an object type"],
  ["file_name", "⚠️ the name of an uploaded FILE. The file itself is very often a person — see `documents` — and this exempts the column, never the row"],
  ["tool_name", "an MCP tool identifier"],
  ["error_name", "a JavaScript error class"],
  ["provider_event_name", "a payment provider's webhook event type"],
  ["source_name", "the name of an integration source"],
  ["role_name", "a permission role"],
  ["item_name", "a catalogue item"],
  ["product_name", "a catalogue product"],
  ["block_name", "an income-tax block of assets"],
  ["group_name", "a grouping label on a bookable resource"],

  /**
   * ⚠️ COLUMNS ENDING `_by` THAT HOLD PROSE RATHER THAN A USER ID.
   *
   * The `link-actor` rule matches every `_by$` because `imported_by`,
   * `closed_by` and `possession_recorded_by` are all user ids and
   * enumerating the verbs is how `bank_statements.imported_by` was
   * missed in the first draft. These are the exceptions.
   *
   * 🔴 THEY LIVE IN THIS MAP AND NOT A SECOND ONE. The first attempt put
   * them in a separate `PROSE_NOT_A_PERSON` map merged in with a loop,
   * and `scripts/check-data-classification.mjs` — which reads this file
   * as TEXT — went on parsing only the first map. The gate and the
   * detector disagreed about which columns were personal data, and the
   * gate was the one that was wrong. One map, read once, by both.
   */
  ["established_by", "a sentence explaining why a record was judged to be a given person"],
  ["quoted_for", "a free-text note on a rate quote"],
  ["joined_via", "how a participant joined a thread"],
  ["granted_via", "how a consent was collected"],
]);

/**
 * 🔴 `name` IS THE HARDEST COLUMN IN THIS SCHEMA AND IT IS NOT DECIDABLE
 * BY NAME.
 *
 * `leads.name` is a human being. `landowners.name` is a human being.
 * `plans.name` is a price plan. `warehouses.name` is a building.
 * `roles.name` is a permission set. There is no rule that separates them,
 * so the detector flags EVERY bare `name` as `direct` and the
 * classification is required to say which it is.
 *
 * ⚠️ THAT RULE LIVES IN `signalsForColumn` BELOW — the one place `name`
 * is deliberately NOT skipped despite sitting in `NOT_PERSONAL`. An
 * earlier draft also declared `export const BARE_NAME_NEEDS_A_DECISION =
 * true`, which nothing read: a constant asserting a policy that was
 * already implemented four lines away. It was the twelfth instance of
 * this codebase's own recorded defect, inside the batch written to stop
 * it, and it was deleted rather than wired.
 */

/* ------------------------------------------------------------------ */
/* THE DETECTION                                                       */
/* ------------------------------------------------------------------ */

export function signalsForColumn(column: string): ColumnSignal[] {
  if (NOT_PERSONAL.has(column) && column !== "name") return [];
  const found: ColumnSignal[] = [];
  for (const r of RULES) {
    if (r.test.test(column)) found.push({ column, kind: r.kind, rule: r.rule });
  }
  return found;
}

export type TableVerdict = {
  table: string;
  signals: ColumnSignal[];
  /** Any `direct` or `identifier` signal. The row names a person. */
  carriesDirect: boolean;
  /** Any `link` signal. The row is personal data in relation to a person. */
  carriesLink: boolean;
  /** Any `freeform` signal. The row MIGHT carry anything. */
  carriesFreeform: boolean;
  /** ⭐ The single question the classification must answer for this table. */
  suspected: boolean;
};

/**
 * ⚠️ `suspected` DELIBERATELY INCLUDES `freeform`-ONLY TABLES.
 *
 * A table whose only signal is a `metadata` jsonb is a table nobody can
 * promise is empty of personal data, and "we assumed that column was
 * internal" is not a defence anybody would accept after the fact. It
 * costs one classification line to say "internal, written only by
 * `server/queue/drain.ts`, never customer-supplied" — and writing that
 * line is the moment somebody checks whether it is true.
 */
export function detectTable(table: string, columns: readonly string[]): TableVerdict {
  const signals = columns.flatMap(signalsForColumn);
  const has = (k: SignalKind) => signals.some((s) => s.kind === k);
  const carriesDirect = has("direct") || has("identifier");
  const carriesLink = has("link");
  const carriesFreeform = has("freeform");
  return {
    table,
    signals,
    carriesDirect,
    carriesLink,
    carriesFreeform,
    suspected: carriesDirect || carriesLink || carriesFreeform,
  };
}
