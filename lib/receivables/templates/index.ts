/**
 * Ordence — ⭐ Multi-language Demand Notices
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. No `@/db` import beyond types.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS EXISTS AT ALL — AND `leads.preferred_lang` SAID SO IN PHASE 22
 * ══════════════════════════════════════════════════════════════════════
 * That column has carried a comment since Phase 22 explaining itself:
 *
 *     "A payment demand a buyer cannot read is a payment demand that does
 *      not get paid, and in a market where buyers span four or five
 *      languages this is the difference between a collection and a
 *      follow-up call."
 *
 * This is the phase that cashes it in. A Kannada-speaking buyer handed an
 * English demand takes it to somebody else to read — a son, a neighbour,
 * a broker — which adds days to the collection and removes the developer
 * from the conversation about their own money.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE FALLBACK RULE, WHICH IS THE MOST IMPORTANT DECISION HERE
 * ══════════════════════════════════════════════════════════════════════
 * Indian financial documents state the amount twice — in figures and in
 * WORDS — and where the two disagree, the words conventionally prevail.
 * That is why a cheque is written the way it is, and a demand notice ends
 * up in the same file as the cheque.
 *
 * ⚠️ SO A HALF-KNOWN NUMBERING SYSTEM IS A LIABILITY, NOT A FEATURE. A
 * generated Tamil numeral that says ₹45,000 where the figures say
 * ₹4,50,000 is not an untidy notice: it is a legal document stating, in
 * the part that prevails, an amount the developer never demanded.
 *
 * The rule, therefore:
 *
 *   • ENGLISH and HINDI have their numbering systems implemented in full,
 *     irregular forms and all, in `lib/receivables/numbers.ts`.
 *   • KANNADA, TAMIL, TELUGU and MARATHI do not. Their notices carry the
 *     FIGURES in Indian grouping in place of the words, `wordsFellBack`
 *     is set, and `demand_notice_documents.words_language` records what
 *     the words are really in.
 *
 * A fallback that is recorded is a gap somebody can close. A fallback
 * that is silent is a gap nobody knows exists — and the SQL CHECK
 * `demand_notice_documents_fallback_is_honest` refuses a row that claims
 * to have fallen back into its own language.
 *
 * ⚠️ AND THE BODY IS STILL IN THE BUYER'S LANGUAGE. Falling back on the
 * words does not fall back on the letter: a Tamil buyer gets a Tamil
 * notice quoting ₹4,50,000 in figures, which is a document they can read
 * and act on. Falling back to an English notice because one line could
 * not be produced would throw away the whole point of the phase.
 */

import type {
  DunningStage,
  NoticeLanguage,
} from "@/db/schema/receivables";
import { formatPaise, formatRateBps } from "../numbers";
import {
  COMPOUNDING_LABELS,
  DAY_COUNT_LABELS,
  addDays,
  toCivilDay,
  type InterestTerms,
} from "../interest";
import { renderNotice, renderTemplate, type RenderMode } from "../render";
import {
  NOTICE_PLACEHOLDERS,
  assertTemplatePack,
  type NoticePlaceholder,
  type NoticeTemplatePack,
  type NoticeValues,
} from "./contract";
import { EN_PACK } from "./en";
import { HI_PACK } from "./hi";
import { KN_PACK } from "./kn";
import { TA_PACK } from "./ta";
import { TE_PACK } from "./te";
import { MR_PACK } from "./mr";

export * from "./contract";
export { EN_PACK, HI_PACK, KN_PACK, TA_PACK, TE_PACK, MR_PACK };

/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

export const NOTICE_PACKS: Readonly<Record<NoticeLanguage, NoticeTemplatePack>> =
  Object.freeze({
    en: EN_PACK,
    hi: HI_PACK,
    kn: KN_PACK,
    ta: TA_PACK,
    te: TE_PACK,
    mr: MR_PACK,
  });

export const SUPPORTED_LANGUAGES = Object.freeze(
  Object.keys(NOTICE_PACKS) as NoticeLanguage[],
);

export function isNoticeLanguage(value: unknown): value is NoticeLanguage {
  return typeof value === "string" && value in NOTICE_PACKS;
}

/**
 * ⭐ `leads.preferred_lang` IS A `varchar(8)`, NOT AN ENUM, AND THIS IS
 * WHERE THAT IS RECONCILED.
 *
 * It has held whatever an import, a form or an API put in it since Phase
 * 22 — `kn`, `kn-IN`, `KN`, `en_US`, `""`. Normalising in the DATABASE
 * would have meant a migration that silently discarded values nobody had
 * looked at; normalising here means the messy value survives on the lead
 * and the notice still comes out in the right language.
 *
 * ⚠️ AN UNKNOWN TAG FALLS BACK TO ENGLISH RATHER THAN REFUSING. A buyer
 * whose language tag is `bn` (Bengali, not implemented) must still
 * receive a demand — an English notice is imperfect, and no notice at all
 * means no collection and, eventually, no defensible chase.
 */
export function normaliseLanguage(raw: string | null | undefined): NoticeLanguage {
  if (!raw) return "en";
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isNoticeLanguage(base) ? base : "en";
}

export function packFor(language: NoticeLanguage): NoticeTemplatePack {
  return NOTICE_PACKS[language];
}

/* ------------------------------------------------------------------ */
/* AMOUNTS IN WORDS, WITH THE FALLBACK RECORDED                        */
/* ------------------------------------------------------------------ */

export type AmountWords = {
  words: string;
  /** ⚠️ The language the words are REALLY in. */
  wordsLanguage: NoticeLanguage;
  /** True when the figures were used because the words are not implemented. */
  fellBack: boolean;
};

/**
 * The amount in words, or the figures when we cannot say it correctly.
 *
 * ⚠️ THE FALLBACK IS THE FIGURES, NOT ENGLISH WORDS. "Rupees Four Lakh
 * Fifty Thousand Only" on an otherwise-Tamil notice is a sentence its
 * reader may not be able to check against the figures beside it, which
 * defeats the entire purpose of stating the amount twice. `₹4,50,000.00`
 * in Indian grouping is unambiguous in every Indian language and is the
 * same string a bank transfer needs.
 */
export function amountInWordsFor(
  language: NoticeLanguage,
  minor: bigint,
): AmountWords {
  const pack = packFor(language);

  if (pack.amountInWords) {
    return { words: pack.amountInWords(minor), wordsLanguage: language, fellBack: false };
  }

  return {
    words: `₹${formatPaise(minor)}`,
    // ⚠️ `en` because the digits are Western Arabic. The SQL CHECK
    // `demand_notice_documents_fallback_is_honest` requires this to differ
    // from the document's language whenever `fellBack` is true — a row
    // claiming to have fallen back into its own language is a row that
    // makes the gap unreportable.
    wordsLanguage: "en",
    fellBack: true,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE INTEREST BASIS, IN THE NOTICE'S LANGUAGE                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ASSEMBLED FROM THE SAME VALUES THE ARITHMETIC USES, IN EVERY
 * LANGUAGE. `lib/receivables/interest.ts` produces the English sentence
 * from the terms; this produces the same sentence in the buyer's
 * language, from the same terms.
 *
 * Neither is typed by a user, and that is the point: a workspace that
 * could type its own basis note would eventually have one saying "simple
 * interest" beside an accrual that compounds. Interest must not compound
 * silently, and the sentence that says so has to be generated from the
 * rule that is actually applied.
 */
export function buildInterestBasisNote(args: {
  terms: InterestTerms;
  dueDate: string;
  language: NoticeLanguage;
}): string {
  const { terms, language } = args;
  const pack = packFor(language);
  const phrases = pack.interestBasis;
  const dueDate = toCivilDay(args.dueDate);

  if (terms.rateBps <= 0) return phrases.none;

  const graceDays = Math.max(0, terms.graceDays);
  const from =
    graceDays === 0
      ? renderTemplate(phrases.fromDueDate, { dueDate })
      : terms.graceForgivesElapsedDays
        ? renderTemplate(phrases.fromGraceEnd, {
            dueDate,
            graceDays: String(graceDays),
            graceEnds: addDays(dueDate, graceDays),
          })
        : renderTemplate(phrases.graceCharged, {
            dueDate,
            graceDays: String(graceDays),
          });

  return renderTemplate(phrases.sentence, {
    rate: formatRateBps(terms.rateBps),
    rule: phrases.compounding[terms.compounding],
    from,
    count: phrases.dayCount[terms.dayCount],
    dueDate,
  });
}

/**
 * The English labels, exported so a UI can show what a setting means
 * without importing the whole pack. `COMPOUNDING_LABELS` and
 * `DAY_COUNT_LABELS` live in `interest.ts` beside the arithmetic.
 */
export { COMPOUNDING_LABELS, DAY_COUNT_LABELS };

/* ------------------------------------------------------------------ */
/* RENDERING A NOTICE                                                  */
/* ------------------------------------------------------------------ */

export type NoticeFacts = {
  language: NoticeLanguage;
  developerName: string;
  buyerName: string;
  projectName: string;
  unitLabel: string;
  noticeNumber: string;
  noticeDate: string;
  dueDate: string;
  triggerLabel: string;
  triggerAchievedOn: string;
  principalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  outstandingMinor: bigint;
  interestMinor: bigint;
  payableMinor: bigint;
  daysOverdue: number;
  interestBasisNote: string;
  contactLine: string;
  /**
   * Which amount the words describe.
   *
   * ⚠️ IT IS THE TOTAL ON A DEMAND AND THE PAYABLE FIGURE ON A CHASING
   * LETTER, because those are the amounts the recipient is being asked
   * for. Words describing a different figure to the one being demanded is
   * the failure this whole module is organised around.
   */
  wordsForMinor?: bigint;
};

export type RenderedNotice = {
  subject: string;
  body: string;
  language: NoticeLanguage;
  templateKey: string;
  templateVersion: string;
  amountInWords: string;
  wordsLanguage: NoticeLanguage;
  wordsFellBack: boolean;
};

function valuesFor(facts: NoticeFacts, words: string): NoticeValues {
  const values: Record<NoticePlaceholder, string> = {
    developerName: facts.developerName,
    buyerName: facts.buyerName,
    projectName: facts.projectName,
    unitLabel: facts.unitLabel,
    noticeNumber: facts.noticeNumber,
    noticeDate: facts.noticeDate,
    dueDate: facts.dueDate,
    triggerLabel: facts.triggerLabel,
    triggerAchievedOn: facts.triggerAchievedOn,
    principalAmount: `₹${formatPaise(facts.principalMinor)}`,
    taxAmount: `₹${formatPaise(facts.taxMinor)}`,
    totalAmount: `₹${formatPaise(facts.totalMinor)}`,
    amountInWords: words,
    outstandingAmount: `₹${formatPaise(facts.outstandingMinor)}`,
    interestAmount: `₹${formatPaise(facts.interestMinor)}`,
    payableAmount: `₹${formatPaise(facts.payableMinor)}`,
    interestBasis: facts.interestBasisNote,
    daysOverdue: String(facts.daysOverdue),
    contactLine: facts.contactLine,
  };
  return values;
}

/** ⭐ The demand itself. */
export function renderDemandNotice(
  facts: NoticeFacts,
  mode: RenderMode = "text",
): RenderedNotice {
  const pack = packFor(facts.language);
  const words = amountInWordsFor(facts.language, facts.wordsForMinor ?? facts.totalMinor);
  const rendered = renderNotice(pack.demand, valuesFor(facts, words.words), mode);

  return {
    ...rendered,
    language: facts.language,
    templateKey: "demand_notice",
    templateVersion: pack.version,
    amountInWords: words.words,
    wordsLanguage: words.wordsLanguage,
    wordsFellBack: words.fellBack,
  };
}

/** ⭐ One rung of the dunning ladder. */
export function renderDunningLetter(
  stage: DunningStage,
  facts: NoticeFacts,
  mode: RenderMode = "text",
): RenderedNotice {
  const pack = packFor(facts.language);
  const words = amountInWordsFor(
    facts.language,
    facts.wordsForMinor ?? facts.payableMinor,
  );
  const rendered = renderNotice(pack.stages[stage], valuesFor(facts, words.words), mode);

  return {
    ...rendered,
    language: facts.language,
    templateKey: `dunning_${stage}`,
    templateVersion: pack.version,
    amountInWords: words.words,
    wordsLanguage: words.wordsLanguage,
    wordsFellBack: words.fellBack,
  };
}

/* ------------------------------------------------------------------ */
/* SELF-CHECK                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ VALIDATE EVERY PACK AT ONCE.
 *
 * Run by `tests/security/receivables.test.ts`. A typo in a Telugu
 * template fails the suite rather than a buyer's notice on the last day
 * of a month — and because the check is over ALL packs, a placeholder
 * added to English and forgotten in the other five is caught in the same
 * assertion.
 */
export function assertAllPacks(): void {
  for (const language of SUPPORTED_LANGUAGES) {
    assertTemplatePack(NOTICE_PACKS[language]);
  }
}

/** Which languages can state an amount in words. Drives a settings hint. */
export function languagesWithAmountWords(): NoticeLanguage[] {
  return SUPPORTED_LANGUAGES.filter((lang) => NOTICE_PACKS[lang].amountInWords !== null);
}

export { NOTICE_PLACEHOLDERS };
