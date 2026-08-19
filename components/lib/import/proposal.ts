/**
 * Ordence — ⭐⭐⭐ PROPOSING A MAPPING, AND DECIDING WHETHER TO TRUST IT
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE QUESTION THIS FILE ANSWERS IS NOT "WHAT IS THE MAPPING"
 * ══════════════════════════════════════════════════════════════════════
 * It is **"how sure are we, and sure enough for what"**.
 *
 * A mapper that always produces an answer is easy and useless: the answer
 * is always confident, the customer clicks through it, and the first time
 * it is wrong their supplier's PAN is in the GSTIN column of four hundred
 * records and nothing anywhere said it was a guess.
 *
 * So every proposed column carries a CONFIDENCE and a BASIS — the
 * sentence saying WHY — and the plan carries an overall confidence that
 * decides what the product is allowed to do without a human:
 *
 *   below the threshold   propose only. Nothing is written. The person
 *                         confirms or corrects each column.
 *   at or above it        eligible for auto-commit, IF the workspace has
 *                         turned that on, AND the entity permits it.
 *
 * ⚠️ AND SOME THINGS ARE NEVER ELIGIBLE WHATEVER THE SCORE. An opening
 * trial balance is a human decision about the customer's own books —
 * `lib/import/opening.ts` already refuses one that does not balance, and
 * this refuses one that no person looked at. A machine that is 99% sure
 * about an opening balance is a machine that is wrong about somebody's
 * books one time in a hundred, permanently, at the point where every
 * subsequent figure derives from it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE INDEPENDENT SOURCES OF EVIDENCE, SCORED SEPARATELY
 * ══════════════════════════════════════════════════════════════════════
 *   ① the HEADER            normalised, aliased, tokenised
 *   ② the VALUES            `lib/import/shapes.ts` — what the column IS
 *   ③ (optionally) a MODEL  `server/import/ai-mapper.ts`
 *
 * ③ is merged here and can never override ② where ② is decisive. A model
 * that says `F3` is the GSTIN when every value in F3 is an email address
 * loses, and the disagreement is REPORTED rather than resolved silently —
 * because a model and a regex disagreeing is exactly the case a human
 * should look at.
 *
 * ⚠️ PURE. No network, no database, no clock. The AI half lives on the
 * server and hands its opinion in as data.
 */

import type { ImportColumn, ImportEntityDefinition } from "./types";
import { normaliseHeader } from "./mapping";
import { evidenceFor, SHAPE_SUGGESTS, type ColumnEvidence } from "./shapes";

/* ------------------------------------------------------------------ */
/* SCORES                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THESE ARE ORDERED CERTAINTIES, NOT TUNED WEIGHTS. Each one is a
 * different KIND of evidence and the number says how much that kind can
 * ever be worth on its own:
 */
export const SCORE = Object.freeze({
  /** The header is exactly the canonical one. Nothing beats this. */
  EXACT_HEADER: 1.0,
  /** The header is a spelling we have seen in the wild and wrote down. */
  ALIAS: 0.95,
  /** Every value is unmistakably this thing. Stronger than a good name. */
  DECISIVE_SHAPE: 0.9,
  /** The header contains the column's words, or vice versa. */
  TOKEN_CONTAINMENT: 0.7,
  /** A model proposed it and nothing contradicts it. */
  MODEL_ONLY: 0.55,
  /** Some words overlap. Weak, and it says so. */
  TOKEN_OVERLAP: 0.4,
});

/**
 * 🔴 THE LINE. A plan below this is proposed and never committed without
 * a person, whatever the workspace has switched on.
 *
 * ⚠️ IT IS DELIBERATELY HIGH. The cost of a wrong auto-commit is a
 * customer's master data silently wrong in a way they discover months
 * later; the cost of a false negative is one screen of confirmation. Those
 * are not comparable, so the threshold is set where a false negative is
 * the failure that happens.
 */
export const AUTO_COMMIT_THRESHOLD = 0.9;

/* ------------------------------------------------------------------ */
/* TOKENS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ SPLIT ON CASE CHANGES AS WELL AS SEPARATORS. `CustNm` and `cust_nm`
 * must produce the same tokens.
 *
 * 🔴 AND THE ACRONYM RULE IS SEPARATE, BECAUSE THE OBVIOUS ONE MISSES IT.
 * `([a-z0-9])([A-Z])` splits `CustNm` and does NOT split `GSTNo` — the
 * boundary there is between two capitals, and the result is the single
 * unusable token `gstno`, which matches nothing. Indian accounting
 * exports are full of exactly that shape: `GSTNo`, `PANNo`, `HSNCode`,
 * `IFSCCode`. The second rule finds the last capital of a run that is
 * followed by a lower-case letter, which is where the next word starts.
 */
export function tokenise(header: string): string[] {
  return header
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/** Words that carry no signal in a column heading. */
const STOP_WORDS = new Set([
  "the", "a", "of", "for", "in", "on", "at", "to", "col", "column", "field",
  "value", "data", "info", "detail", "details",
]);

/**
 * ⚠️ A SMALL, EXPLICIT SYNONYM TABLE — NOT A STEMMER. A stemmer collapses
 * `billing` and `bill`, which is right, and also `party` and `part`,
 * which is not. These are the abbreviations Indian accounting exports
 * actually use, written down where they can be read and argued with.
 */
const SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  nm: "name", nam: "name", nme: "name",
  cust: "customer", custmr: "customer", cst: "customer",
  vend: "vendor", vndr: "vendor", supp: "supplier", suppl: "supplier",
  co: "company", comp: "company", org: "company", firm: "company", party: "company",
  no: "number", num: "number", nos: "number",
  amt: "amount", amnt: "amount", val: "amount", value: "amount",
  qty: "quantity", qnty: "quantity",
  dt: "date", dte: "date",
  addr: "address", add: "address",
  ph: "phone", tel: "phone", mob: "mobile", cell: "mobile", contact: "phone",
  mail: "email", eml: "email",
  gst: "gstin", gstno: "gstin", gstnumber: "gstin", tin: "gstin",
  pincode: "postal", pin: "postal", zip: "postal",
  acc: "account", acct: "account", ac: "account", ledger: "account",
  dr: "debit", cr: "credit",
  inv: "invoice", bill: "invoice",
  desc: "description", descr: "description", narration: "description",
});

function canonical(token: string): string {
  return SYNONYMS[token] ?? token;
}

function canonicalTokens(header: string): Set<string> {
  return new Set(tokenise(header).map(canonical));
}

/* ------------------------------------------------------------------ */
/* THE PROPOSAL                                                        */
/* ------------------------------------------------------------------ */

export type ProposalBasis =
  | "exact-header"
  | "alias"
  | "value-shape"
  | "token-containment"
  | "token-overlap"
  | "model"
  | "none";

export type ColumnProposal = {
  readonly field: string;
  readonly header: string;
  readonly required: boolean;
  /** Index into the file's header row, or -1 when nothing was proposed. */
  readonly sourceIndex: number;
  readonly sourceHeader: string | null;
  readonly confidence: number;
  readonly basis: ProposalBasis;
  /** One sentence a non-technical person can read and check. */
  readonly why: string;
  /** Other candidates worth showing in the picker, best first. */
  readonly alternatives: readonly { sourceIndex: number; sourceHeader: string; confidence: number }[];
  /**
   * 🔴 SET WHEN A MODEL AND THE VALUES DISAGREE. Never resolved silently:
   * this is the case a human should look at.
   */
  readonly conflict?: string;
};

export type MappingProposal = {
  readonly entityKey: string;
  readonly columns: readonly ColumnProposal[];
  readonly sourceHeaders: readonly string[];
  readonly unmappedSourceHeaders: readonly string[];
  /** The weakest link among the required columns. See `overallConfidence`. */
  readonly confidence: number;
  readonly missingRequired: readonly string[];
  /** Sentences that must be read before anything is committed. */
  readonly cautions: readonly string[];
  readonly usedModel: boolean;
};

/** What a model proposed, as data. `server/import/ai-mapper.ts` produces it. */
export type ModelProposal = Readonly<Record<string, string>>;

export type ProposeOptions = {
  /** Rows under the header, for `lib/import/shapes.ts`. */
  readonly sampleRows?: readonly (readonly string[])[];
  readonly model?: ModelProposal;
};

function describeShape(evidence: ColumnEvidence): string {
  if (!evidence.shape) return "no single recognisable pattern";
  const percent = Math.round(evidence.share * 100);
  return `${percent}% of its values look like a ${evidence.shape.replace(/_/g, " ")}`;
}

/**
 * ⭐⭐⭐ THE FUNCTION.
 */
export function proposeMapping(
  entity: ImportEntityDefinition,
  sourceHeaders: readonly string[],
  options: ProposeOptions = {},
): MappingProposal {
  const sampleRows = options.sampleRows ?? [];
  const evidence = sourceHeaders.map((_, index) =>
    evidenceFor(sampleRows.map((row) => row[index] ?? "")),
  );

  const normalisedSources = sourceHeaders.map((h) => normaliseHeader(h));
  const tokenisedSources = sourceHeaders.map((h) => canonicalTokens(h));

  type Candidate = { index: number; confidence: number; basis: ProposalBasis; why: string };

  const candidatesFor = (column: ImportColumn): Candidate[] => {
    const canonicalHeader = normaliseHeader(column.header);
    const aliasSet = new Set((column.aliases ?? []).map((a) => normaliseHeader(a)));
    const columnTokens = canonicalTokens(column.header);
    const fieldTokens = canonicalTokens(column.field);
    for (const token of fieldTokens) columnTokens.add(token);

    const out: Candidate[] = [];

    sourceHeaders.forEach((sourceHeader, index) => {
      const normalised = normalisedSources[index]!;
      const tokens = tokenisedSources[index]!;
      const shapeEvidence = evidence[index]!;

      if (normalised === canonicalHeader) {
        out.push({
          index,
          confidence: SCORE.EXACT_HEADER,
          basis: "exact-header",
          why: `"${sourceHeader}" is exactly this column's name.`,
        });
        return;
      }
      if (aliasSet.has(normalised)) {
        out.push({
          index,
          confidence: SCORE.ALIAS,
          basis: "alias",
          why: `"${sourceHeader}" is a spelling Ordence recognises for this column.`,
        });
        return;
      }

      /**
       * ⭐ ② THE VALUES. This runs even when the header said nothing,
       * which is the entire reason a file of `F1 F2 F3` is importable.
       */
      const suggests = shapeEvidence.shape ? SHAPE_SUGGESTS[shapeEvidence.shape] : [];
      const shapeMatches =
        suggests.includes(column.field) ||
        suggests.includes(column.kind) ||
        suggests.some((s) => column.field.toLowerCase().includes(s.toLowerCase()));

      if (shapeMatches && shapeEvidence.shape) {
        out.push({
          index,
          confidence: SCORE.DECISIVE_SHAPE,
          basis: "value-shape",
          why:
            `"${sourceHeader}" was matched on its contents rather than its name — ` +
            `${describeShape(shapeEvidence)}.`,
        });
        return;
      }

      if (tokens.size > 0 && columnTokens.size > 0) {
        const shared = [...tokens].filter((t) => columnTokens.has(t));
        if (shared.length === 0) return;
        const containment =
          shared.length === Math.min(tokens.size, columnTokens.size) &&
          Math.min(tokens.size, columnTokens.size) > 0;
        const overlap = shared.length / Math.max(tokens.size, columnTokens.size);
        out.push({
          index,
          confidence: containment
            ? SCORE.TOKEN_CONTAINMENT
            : SCORE.TOKEN_OVERLAP * Math.max(0.5, overlap),
          basis: containment ? "token-containment" : "token-overlap",
          why:
            `"${sourceHeader}" and "${column.header}" share ` +
            `${shared.length === 1 ? `the word "${shared[0]}"` : `the words ${shared.map((s) => `"${s}"`).join(", ")}`}.`,
        });
      }
    });

    return out.sort((a, b) => b.confidence - a.confidence);
  };

  /**
   * ⚠️ ONE SOURCE COLUMN CANNOT FEED TWO FIELDS, AND THE ASSIGNMENT IS
   * GREEDY BY CONFIDENCE RATHER THAN BY COLUMN ORDER. A file with `Name`
   * and `Company Name` would otherwise give `Name` to whichever entity
   * column happens to be declared first, and the customer's contact name
   * ends up as the company name in half the rows.
   */
  const all = entity.columns.map((column) => ({ column, candidates: candidatesFor(column) }));
  const claimed = new Map<number, string>();
  const chosen = new Map<string, Candidate>();

  const ranked = all
    .flatMap(({ column, candidates }) => candidates.map((c) => ({ column, c })))
    .sort((a, b) => b.c.confidence - a.c.confidence);

  for (const { column, c } of ranked) {
    if (chosen.has(column.field)) continue;
    if (claimed.has(c.index)) continue;
    chosen.set(column.field, c);
    claimed.set(c.index, column.field);
  }

  /* ------------------------------------------------------------- */
  /* ③ THE MODEL, MERGED — AND NEVER ALLOWED TO WIN AGAINST ②      */
  /* ------------------------------------------------------------- */

  const cautions: string[] = [];
  const conflicts = new Map<string, string>();

  if (options.model) {
    for (const [field, sourceHeader] of Object.entries(options.model)) {
      const column = entity.columns.find((c) => c.field === field);
      if (!column) continue;
      const index = sourceHeaders.findIndex((h) => h === sourceHeader);
      if (index < 0) {
        cautions.push(
          `The suggestion named a column "${sourceHeader}" that is not in this file. It was ignored.`,
        );
        continue;
      }

      const existing = chosen.get(field);

      if (existing && existing.index === index) {
        /**
         * ⭐ AGREEMENT IS NOT A CONFIDENCE BOOST. Two methods agreeing
         * feels like more evidence and mostly is not — the model saw the
         * same header string the matcher did, so they are not
         * independent. It is recorded in the sentence and nowhere else.
         */
        continue;
      }

      if (existing && existing.confidence >= SCORE.DECISIVE_SHAPE) {
        /** 🔴 ② WINS, AND THE DISAGREEMENT IS SURFACED. */
        conflicts.set(
          field,
          `The AI suggestion put "${sourceHeader}" here. Ordence used "${sourceHeaders[existing.index]}" ` +
            `instead, because ${existing.why.replace(/^"[^"]*" /, "").replace(/\.$/, "")}. ` +
            `Check this one before committing.`,
        );
        continue;
      }

      if (claimed.has(index) && claimed.get(index) !== field) {
        conflicts.set(
          field,
          `The AI suggestion put "${sourceHeader}" here, and Ordence has already used that column ` +
            `for "${entity.columns.find((c) => c.field === claimed.get(index))?.header}". Only one ` +
            `of the two can be right.`,
        );
        continue;
      }

      if (!existing || existing.confidence < SCORE.MODEL_ONLY) {
        if (existing) claimed.delete(existing.index);
        chosen.set(field, {
          index,
          confidence: SCORE.MODEL_ONLY,
          basis: "model",
          why:
            `"${sourceHeader}" was suggested by the AI mapper. Nothing in the column's name or ` +
            `its contents confirms it, so please check this one.`,
        });
        claimed.set(index, field);
      }
    }
  }

  /* ------------------------------------------------------------- */

  const columns: ColumnProposal[] = entity.columns.map((column) => {
    const pick = chosen.get(column.field);
    const alternatives = candidatesFor(column)
      .filter((c) => c.index !== pick?.index)
      .slice(0, 3)
      .map((c) => ({
        sourceIndex: c.index,
        sourceHeader: sourceHeaders[c.index]!,
        confidence: c.confidence,
      }));

    const conflict = conflicts.get(column.field);

    return {
      field: column.field,
      header: column.header,
      required: column.required,
      sourceIndex: pick?.index ?? -1,
      sourceHeader: pick ? sourceHeaders[pick.index]! : null,
      confidence: pick?.confidence ?? 0,
      basis: pick?.basis ?? "none",
      why: pick?.why ?? `Nothing in this file looks like "${column.header}".`,
      alternatives,
      ...(conflict ? { conflict } : {}),
    };
  });

  const missingRequired = columns
    .filter((c) => c.required && c.sourceIndex < 0)
    .map((c) => c.header);

  const unmappedSourceHeaders = sourceHeaders.filter((_, index) => !claimed.has(index));

  if (unmappedSourceHeaders.length > 0) {
    cautions.push(
      `${unmappedSourceHeaders.length} column${unmappedSourceHeaders.length === 1 ? "" : "s"} in ` +
        `your file ${unmappedSourceHeaders.length === 1 ? "was" : "were"} not used: ` +
        `${unmappedSourceHeaders.slice(0, 8).join(", ")}` +
        `${unmappedSourceHeaders.length > 8 ? ", …" : ""}. Nothing in them will be imported.`,
    );
  }
  for (const conflict of conflicts.values()) cautions.push(conflict);

  return {
    entityKey: entity.key,
    columns,
    sourceHeaders: [...sourceHeaders],
    unmappedSourceHeaders,
    confidence: overallConfidence(columns),
    missingRequired,
    cautions,
    usedModel: Boolean(options.model),
  };
}

/**
 * 🔴 THE WEAKEST REQUIRED COLUMN, NOT THE AVERAGE.
 *
 * An average lets nine certain columns carry one guess over the line, and
 * the guess is the one that puts four hundred PANs in the GSTIN field. A
 * plan is exactly as trustworthy as its least trustworthy required column.
 *
 * ⚠️ OPTIONAL COLUMNS ARE EXCLUDED FROM THE FLOOR AND NOT FROM THE
 * CAUTIONS. A weak guess on an optional column is worth showing and is
 * not a reason to refuse a whole import — the column can simply be
 * unmapped.
 */
export function overallConfidence(columns: readonly ColumnProposal[]): number {
  const required = columns.filter((c) => c.required);
  if (required.length === 0) return 0;
  if (required.some((c) => c.sourceIndex < 0)) return 0;
  return Math.min(...required.map((c) => c.confidence));
}

/* ------------------------------------------------------------------ */
/* MAY THIS COMMIT WITHOUT A PERSON?                                   */
/* ------------------------------------------------------------------ */

export type AutoCommitPolicy =
  /** 🔴 THE DEFAULT. Nothing is ever written without somebody confirming. */
  | "propose_only"
  /** Opt-in: commit when confidence is at or above the threshold. */
  | "auto_above_threshold";

export const AUTO_COMMIT_POLICIES = ["propose_only", "auto_above_threshold"] as const;
export const DEFAULT_AUTO_COMMIT_POLICY: AutoCommitPolicy = "propose_only";

export function parseAutoCommitPolicy(value: unknown): AutoCommitPolicy {
  return (AUTO_COMMIT_POLICIES as readonly string[]).includes(value as string)
    ? (value as AutoCommitPolicy)
    : DEFAULT_AUTO_COMMIT_POLICY;
}

export type AutoCommitVerdict = {
  readonly allowed: boolean;
  /** Always present. When allowed, it is what the audit record says. */
  readonly reason: string;
};

/**
 * ⭐⭐⭐ THE DECISION, IN ONE PLACE.
 *
 * ⚠️ FOUR SEPARATE REFUSALS AND EACH ONE IS ITS OWN SENTENCE, because
 * "auto-commit is not available" tells a customer nothing about which of
 * the four things to change.
 */
export function mayAutoCommit(
  proposal: MappingProposal,
  entity: ImportEntityDefinition,
  policy: AutoCommitPolicy,
): AutoCommitVerdict {
  if (policy !== "auto_above_threshold") {
    return {
      allowed: false,
      reason:
        "This workspace reviews every mapping before it is imported. Nothing has been written. " +
        "Turn on automatic import in Settings → Import if you want high-confidence files to go " +
        "straight through.",
    };
  }

  /**
   * 🔴 THE ENTITY VETO, AND IT OVERRIDES THE SCORE. See the file header:
   * an opening balance is a decision about the customer's own books.
   */
  if (neverAutoCommit(entity)) {
    return {
      allowed: false,
      reason:
        `"${entity.label}" is always confirmed by a person, whatever the confidence. It sets the ` +
        `starting position of your books, and every figure after it is derived from it. A mapping ` +
        `that is 99% right here is wrong about somebody's books one time in a hundred, ` +
        `permanently.`,
    };
  }

  if (proposal.missingRequired.length > 0) {
    return {
      allowed: false,
      reason:
        `Nothing in this file matches ${proposal.missingRequired.join(", ")}, which ` +
        `${proposal.missingRequired.length === 1 ? "is" : "are"} required.`,
    };
  }

  if (proposal.confidence < AUTO_COMMIT_THRESHOLD) {
    const weakest = [...proposal.columns]
      .filter((c) => c.required)
      .sort((a, b) => a.confidence - b.confidence)[0];
    return {
      allowed: false,
      reason:
        `The least certain required column is "${weakest?.header}", matched to ` +
        `"${weakest?.sourceHeader}" at ${Math.round((weakest?.confidence ?? 0) * 100)}% ` +
        `confidence. ${weakest?.why} Ordence commits automatically only at ` +
        `${Math.round(AUTO_COMMIT_THRESHOLD * 100)}% or above.`,
    };
  }

  if (proposal.columns.some((c) => c.conflict)) {
    return {
      allowed: false,
      reason:
        "The AI suggestion and the file's own contents disagree about at least one column. That " +
        "is exactly the case a person should look at, so this one will not go through on its own.",
    };
  }

  return {
    allowed: true,
    reason:
      `Every required column matched at ${Math.round(proposal.confidence * 100)}% confidence or ` +
      `above, with no disagreement between the file's contents and the suggested mapping.`,
  };
}

/**
 * 🔴 THE ENTITIES A MACHINE MAY NEVER COMMIT ALONE.
 *
 * ⚠️ DERIVED FROM `atomic`, NOT FROM A SECOND LIST. An entity is written
 * as one indivisible document precisely when it is an opening position —
 * the trial balance is the case — and a second list of names would drift
 * from the first the day somebody adds an entity.
 */
export function neverAutoCommit(entity: ImportEntityDefinition): boolean {
  return Boolean(entity.atomic);
}
