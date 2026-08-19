/**
 * Ordence — ⭐ The Notice Template Contract
 * Version: v0.38.0-alpha
 *
 * Pure. Types and the placeholder vocabulary shared by every language
 * pack in this directory.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY ONE FIXED PLACEHOLDER SET FOR ALL SIX LANGUAGES
 * ══════════════════════════════════════════════════════════════════════
 * A per-language placeholder set would be a translation bug waiting to
 * happen: the Kannada pack refers to `{{totalAmount}}` and the Tamil pack
 * — translated three months later by somebody else — refers to
 * `{{amountDue}}`, which has no value. Neither is discovered until a
 * Tamil-speaking buyer's demand refuses to render on the last day of the
 * month, or worse, renders with a hole in it.
 *
 * So the vocabulary is CLOSED and it is the same in every language.
 * `assertTemplatePack` walks every string in a pack and refuses any
 * placeholder that is not on this list, and the test suite runs it over
 * all six packs. A typo is caught at test time, in every language at
 * once, rather than by a buyer.
 *
 * ⚠️ ADDING A PLACEHOLDER MEANS FILLING IT IN ALL SIX PACKS. That is the
 * cost, and it is the point: a notice that says less in Telugu than it
 * says in English is a notice a Telugu-speaking buyer cannot act on, and
 * this phase exists because a demand a buyer cannot read is a demand that
 * does not get paid.
 */

import type {
  DunningStage,
  InterestCompounding,
  InterestDayCount,
  NoticeLanguage,
} from "@/db/schema/receivables";

/* ------------------------------------------------------------------ */
/* THE VOCABULARY                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every placeholder a notice template may use.
 *
 * ⚠️ AMOUNTS ARRIVE PRE-FORMATTED, AS STRINGS. `lib/receivables/render.ts`
 * never sees a `bigint` and never formats one — a renderer that could
 * format money would be a second money formatter, and the day the two
 * disagree is the day a notice says one figure and the ledger says
 * another.
 */
export const NOTICE_PLACEHOLDERS = Object.freeze([
  /* --- Who --------------------------------------------------------- */
  "developerName",
  "buyerName",
  "projectName",
  "unitLabel",
  /* --- The document ------------------------------------------------ */
  "noticeNumber",
  "noticeDate",
  "dueDate",
  /* --- ⭐ RERA: what fell due, and when --------------------------- */
  "triggerLabel",
  "triggerAchievedOn",
  /* --- Money, already formatted in the Indian system --------------- */
  "principalAmount",
  "taxAmount",
  "totalAmount",
  "amountInWords",
  "outstandingAmount",
  "interestAmount",
  "payableAmount",
  /* --- ⚠️ The stated interest basis. Never omitted from a notice. -- */
  "interestBasis",
  /* --- Chasing ----------------------------------------------------- */
  "daysOverdue",
  "contactLine",
] as const);

export type NoticePlaceholder = (typeof NOTICE_PLACEHOLDERS)[number];

export type NoticeValues = Readonly<Record<NoticePlaceholder, string>>;

/* ------------------------------------------------------------------ */
/* THE PACK                                                            */
/* ------------------------------------------------------------------ */

export type NoticeDocumentTemplate = {
  subject: string;
  body: string;
};

/**
 * The phrases the interest-basis sentence is assembled from.
 *
 * ⚠️ ASSEMBLED, NOT TRANSLATED WHOLE, because the sentence has to say
 * FOUR things that vary independently — the rate, the compounding rule,
 * the day-count convention and the grace treatment — and a pack that
 * carried four complete sentences per language would have twenty-four
 * strings to keep in step. Interest must not compound silently, so the
 * compounding phrase is a separate, mandatory piece rather than an
 * optional clause somebody can leave out of one translation.
 */
export type InterestBasisPhrases = {
  /** `{{rate}} {{rule}} {{from}} {{count}}` — the assembled sentence. */
  sentence: string;
  none: string;
  fromDueDate: string;
  fromGraceEnd: string;
  graceCharged: string;
  compounding: Readonly<Record<InterestCompounding, string>>;
  dayCount: Readonly<Record<InterestDayCount, string>>;
};

export type NoticeTemplatePack = {
  language: NoticeLanguage;
  /** Bumped when a body changes. Stored on every rendered document. */
  version: string;
  /** The language's own name, for a picker that is readable to its user. */
  endonym: string;
  /**
   * ⭐ AMOUNT IN WORDS, OR `null` WHEN WE CANNOT SAY IT CORRECTLY.
   *
   * ⚠️ `null` IS A FEATURE AND NOT A GAP. Indian financial documents state
   * the amount in figures AND in words, and where the two disagree the
   * WORDS conventionally prevail. A half-implemented numbering system
   * that renders ₹4,50,000 as the words for ₹45,000 does not produce an
   * ugly notice — it produces a legal document that says, in the part
   * that prevails, a number the developer never demanded.
   *
   * So a pack either implements the numbering system completely or
   * declares `null`, and `renderDemandNotice` falls back to the figures
   * in the Indian grouping, recording `wordsFellBack` so the gap is
   * reportable rather than invisible.
   */
  amountInWords: ((minor: bigint) => string) | null;
  demand: NoticeDocumentTemplate;
  stages: Readonly<Record<DunningStage, NoticeDocumentTemplate>>;
  interestBasis: InterestBasisPhrases;
};

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

export class TemplatePackError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "TemplatePackError";
    this.remedy = remedy;
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Every template string in a pack, with a path for the error message. */
export function templateStringsIn(
  pack: NoticeTemplatePack,
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [
    { path: "demand.subject", value: pack.demand.subject },
    { path: "demand.body", value: pack.demand.body },
  ];
  for (const [stage, template] of Object.entries(pack.stages)) {
    out.push({ path: `stages.${stage}.subject`, value: template.subject });
    out.push({ path: `stages.${stage}.body`, value: template.body });
  }
  return out;
}

/**
 * ⭐ REFUSE A PACK THAT CANNOT RENDER.
 *
 * Run over all six packs by `tests/security/receivables.test.ts`, so a
 * typo in a Telugu template fails the build rather than a buyer's notice.
 */
export function assertTemplatePack(pack: NoticeTemplatePack): void {
  const allowed = new Set<string>(NOTICE_PLACEHOLDERS);

  for (const { path, value } of templateStringsIn(pack)) {
    if (!value || value.trim() === "") {
      throw new TemplatePackError(
        `The ${pack.language} pack has an empty template at ${path}.`,
        "Every language needs every letter. A buyer whose language has a blank " +
          "final notice receives nothing at the point it matters most.",
      );
    }

    for (const match of value.matchAll(PLACEHOLDER)) {
      const key = match[1];
      if (key && !allowed.has(key)) {
        throw new TemplatePackError(
          `The ${pack.language} pack refers to {{${key}}} at ${path}, which is not a ` +
            `notice placeholder.`,
          `The vocabulary is closed — see NOTICE_PLACEHOLDERS. An unknown ` +
            `placeholder has no value, so this notice would refuse to render for ` +
            `every buyer in this language, discovered on the last day of a month.`,
        );
      }
    }

    // ⚠️ Braces that do not match the placeholder pattern survive
    // rendering and are PRINTED. `{{ buyer-name }}` is the usual shape.
    const withoutPlaceholders = value.replace(PLACEHOLDER, "");
    if (/\{\{|\}\}/.test(withoutPlaceholders)) {
      throw new TemplatePackError(
        `The ${pack.language} pack has template braces at ${path} that are not a ` +
          `valid placeholder.`,
        "Placeholders are {{likeThis}}. A hyphen, a space in the middle or a " +
          "leading digit is not matched, and the raw braces would be printed on " +
          "the notice.",
      );
    }
  }

  /* --- ⚠️ THE INTEREST SENTENCE IS MANDATORY IN EVERY LANGUAGE. --- */
  const basis = pack.interestBasis;
  if (!basis.sentence.includes("{{rule}}")) {
    throw new TemplatePackError(
      `The ${pack.language} interest-basis sentence does not state the compounding ` +
        `rule.`,
      "⚠️ Interest must not compound silently. ₹10,00,000 held for a year at 18% " +
        "is ₹1,80,000 simple and ₹1,95,618 compounded monthly; a notice that does " +
        "not say which was applied cannot be defended in front of an Authority.",
    );
  }
  if (!pack.demand.body.includes("{{interestBasis}}")) {
    throw new TemplatePackError(
      `The ${pack.language} demand notice does not print the interest basis.`,
      "⚠️ The basis sentence is the one part of the notice that says how a later " +
        "interest charge will be worked out. A demand without it charges interest " +
        "the buyer was never told the rule for.",
    );
  }
  if (!pack.demand.body.includes("{{triggerLabel}}")) {
    throw new TemplatePackError(
      `The ${pack.language} demand notice does not state what triggered it.`,
      "⚠️ A demand under RERA derives its force from the construction event having " +
        "happened. A document that does not name the event cannot answer the buyer " +
        "who says it had not.",
    );
  }
}
