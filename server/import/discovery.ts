/**
 * Ordence — ⭐⭐⭐ WHAT IS IN THIS FOLDER
 * Version: v1.84.1-alpha · Phase 3
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * A customer arrives with a folder. Twenty exports out of a system being
 * switched off on Friday, named `Ledger.xlsx`, `Master1.csv`,
 * `report(3).csv`. Nothing in the product tells them which is which, so
 * they guess — and the guesses are what generate the support load.
 *
 * `lib/import/shapes.ts` already solves the hard half of this. It detects
 * GSTINs, PANs, IFSCs, HSNs, pincodes, dates and money **from the VALUES,
 * not the header**, precisely because the files customers actually export
 * have headers like `F1 F2 F3` and `Cust_Nm Cust_GST_No`.
 *
 * ⭐ DISCOVERY IS THAT MACHINERY POINTED AT A FOLDER INSTEAD OF A FILE.
 * Given twenty unlabelled files, say which entity each one probably is,
 * with the evidence, and let the customer correct it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PURE. NO DATABASE, NO NETWORK, NO CLOCK, NO `node:` IMPORT.
 * ══════════════════════════════════════════════════════════════════════
 * Only the FOLDER READ needs the server. Turning bytes into
 * `CsvRecord[]` is `lib/import/sources/`' job and already happens in the
 * browser; everything below decides, and deciding is pure for the same
 * reason `lib/import/plan.ts` is: it runs in the wizard's preview, in
 * this process during a run, and in a test with no Postgres, and all
 * three reach the same verdict about the same folder.
 *
 * 🔴 SO THIS FILE MUST NOT GAIN `import "server-only"`, AND THE MOMENT IT
 * NEEDS TO IT HAS STOPPED BEING THE DECISION LAYER. `PATCH-REQUEST-PHASE-3.md`
 * asks for it to be re-homed under `lib/import/` at integration, which is
 * where a pure module belongs; it is here because Phase 3 owns
 * `server/import/discovery.ts` and owns nothing under `lib/import/`.
 * `tests/ui/import-discovery-pure.test.ts` runs it in jsdom with no
 * database configured, which is the executable form of this paragraph.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ORDER OF AUTHORITY, AND IT IS NOT NEGOTIABLE
 * ══════════════════════════════════════════════════════════════════════
 *   ① THE VALUES     `lib/import/shapes.ts`. What the column IS.
 *   ② THE HEADER     normalised, aliased, tokenised.
 *   ③ THE MODEL      an opinion, handed in as data, capped below ①.
 *   ④ THE FILE NAME  a TIE-BREAK ONLY. See `FILENAME_IS_A_TIE_BREAK`.
 *
 * ⚠️ ④ IS THE ONE PEOPLE GET WRONG, BECAUSE IT IS THE ONE A HUMAN USES
 * FIRST. A file called `Ledger.xlsx` full of company names and domains is
 * a company list somebody renamed, and a classifier that lets the name
 * win imports it into the chart of accounts. The name never moves a
 * candidate past another on evidence; it only settles a draw.
 */

import {
  proposeMapping,
  tokenise,
  type ModelProposal,
  type ProposalBasis,
} from "@/lib/import/proposal";
import {
  EVIDENCE_SAMPLE_ROWS,
  SHAPE_SUGGESTS,
  evidenceFor,
  type ColumnEvidence,
  type ValueShape,
} from "@/lib/import/shapes";
import { MAX_IMPORT_ROWS } from "@/lib/import/plan";
import { resolveImportOrder, type ImportOrderResult } from "@/lib/import/contract/graph";
import type { CsvRecord } from "@/lib/import/csv";
import type { ContractedImportEntity, ImportColumn } from "@/lib/import/types";

/* ------------------------------------------------------------------ */
/* THE THRESHOLDS                                                      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CLASSIFICATION CONFIDENCE IS NOT MAPPING CONFIDENCE, AND USING ONE
 *    FOR THE OTHER PUT EVERY `F1 F2 F3` FILE IN THE UNASSIGNED PILE
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS WRITTEN DOWN BECAUSE THE FIRST DRAFT DID IT AND THE FIRST
 * RUN CAUGHT IT.
 *
 * `overallConfidence` in `lib/import/proposal.ts` returns 0 when any
 * REQUIRED column is unmatched, and it is right to: a mapping missing a
 * required column cannot be committed. But "which entity is this file"
 * and "can this file be imported as it stands" are different questions.
 * A file headed `F1 F2 F3 F4` whose second column is 100% GSTINs is
 * unmistakably a GST party list AND has no matched `Legal name` — so
 * scoring it 0 files the one case this whole module exists for under
 * "nothing matches".
 *
 *   CLASSIFICATION asks: do the VALUES in this file confirm the claims
 *                        this entity makes about them?
 *   MAPPING asks:        is every required column pointed at something?
 *
 * The second is reported (`missingRequired`) and shown to the customer as
 * the next screen's work. It does not decide what the file IS.
 *
 * ⚠️ AND THESE ARE PRODUCT DECISIONS, NOT TUNED WEIGHTS, AND NEITHER IS
 * A COVERAGE FLOOR IN THE SENSE `scripts/check-sealed-grants.mjs` refuses.
 * `AUTO_COMMIT_THRESHOLD` is the same kind of number and is set the same
 * way: where a false negative — "we could not tell, please choose" — is
 * the failure that happens, because the other failure is a customer's
 * invoices silently loaded into the wrong table.
 */
export const DISCOVERY_FLOOR = 0.7;

/**
 * 🔴 AND A MARGIN, WHICH IS THE PART A SINGLE THRESHOLD MISSES.
 *
 * `companies` and `gst-parties` both read a file of names, addresses and
 * phone numbers, and both will score well on one. Picking the higher of
 * two nearly equal scores is picking by rounding error, and the customer
 * is shown a confident answer produced by a coin toss. Below this margin
 * the answer is "these two both fit, choose", which is true and useful.
 */
export const DISCOVERY_MARGIN = 0.08;

/**
 * 🔴 THE FILE NAME IS A TIE-BREAK AND NOTHING ELSE.
 *
 * It is deliberately not a number added to a score: a weight, however
 * small, is a weight somebody raises later "because names are usually
 * right". Affinity is computed, reported, and consulted only when two
 * candidates are already level on evidence AND on distinctiveness.
 */
export const FILENAME_IS_A_TIE_BREAK = true;

/** The bases that come from what the column IS rather than what it is called. */
const VALUE_BASES: ReadonlySet<ProposalBasis> = new Set<ProposalBasis>(["value-shape"]);

/**
 * The bases that are a CLAIM ABOUT the column rather than a reading OF it,
 * and can therefore be contradicted by what the column contains.
 *
 * 🔴 `model` IS IN THIS SET AND THAT IS THE POINT OF THE SET.
 * `lib/import/proposal.ts` reports a conflict when a model disagrees with
 * a DECISIVE shape that already won the column. It cannot report one when
 * nothing else claimed the field: the model takes it at `SCORE.MODEL_ONLY`,
 * unopposed, and the values that flatly refute it are never consulted.
 * That is exactly the sentence in `shapes.ts` — *"a model saying `F3` is
 * the GSTIN when every value in F3 is an email address does not get to be
 * right"* — and it is the case discovery has to catch, because a
 * classification is chosen once for a whole file.
 *
 * ⚠️ `value-shape` IS DELIBERATELY ABSENT. A claim the values themselves
 * made cannot be contradicted by the same values.
 */
const CLAIM_BASES: ReadonlySet<ProposalBasis> = new Set<ProposalBasis>([
  "exact-header",
  "alias",
  "model",
]);

/* ------------------------------------------------------------------ */
/* WHAT A FILE IS, BEFORE ANYBODY KNOWS WHAT IT IS                     */
/* ------------------------------------------------------------------ */

/**
 * One file out of the folder, already turned into records.
 *
 * ⚠️ RECORDS, NOT BYTES, AND THAT IS THE WHOLE OF WHY THIS MODULE IS
 * PURE. `lib/import/sources/` turns CSV, XLSX, JSON and Tally XML into
 * `CsvRecord[]`, in the browser, before anything server-side runs. A
 * discovery that took a path would need a filesystem, and a discovery
 * that needed a filesystem could not run in the wizard.
 */
export type DiscoveredFile = {
  /** As the customer's folder spells it, extension and all. */
  readonly name: string;
  /** Header first, exactly as `parseCsv` produces. */
  readonly records: readonly CsvRecord[];
};

/**
 * ⭐ A DETECTOR HIT THAT SUPPORTS A CANDIDATE. This is the evidence, and
 * it is the reason the answer is checkable rather than trusted: every
 * sentence discovery shows a customer can be traced back to one of these,
 * and every one of them is a count of values rather than an opinion about
 * a name.
 */
export type ShapeWitness = {
  readonly field: string;
  readonly columnHeader: string;
  readonly sourceHeader: string;
  readonly sourceIndex: number;
  readonly shape: ValueShape;
  /** Share of the NON-BLANK sampled values carrying that shape. */
  readonly share: number;
  readonly sampled: number;
  /**
   * ⚠️ WHETHER THE HEADING AGREED. Two methods agreeing is NOT more
   * evidence — `lib/import/proposal.ts` argues that at length and is
   * right, because the matcher and the model both read the same header
   * string. It is recorded because the customer reading the screen wants
   * to know whether the software worked this out or merely believed a
   * label, and `values-alone` is the case this module exists for.
   */
  readonly confirmedBy: "values-alone" | "values-and-heading";
};

/**
 * 🔴 THE HEADER SAYS ONE THING AND THE COLUMN CONTAINS ANOTHER.
 *
 * `lib/import/shapes.ts` opens by naming this case: a column HEADED
 * "GSTIN" that turns out to hold PANs. `proposeMapping` scores an exact
 * header above a decisive shape and is right to for MAPPING — the
 * customer can see the mapping and fix it in one click.
 *
 * ⚠️ IT IS THE WRONG WEIGHTING FOR CLASSIFICATION. A file whose headings
 * name an entity and whose VALUES contradict them is not strong evidence
 * for that entity; it is a file somebody has relabelled, and it is the
 * single most expensive thing to get wrong in a folder of twenty. So a
 * contradiction is surfaced, and it costs the candidate the witness it
 * would otherwise have earned.
 */
export type Contradiction = {
  readonly field: string;
  readonly sourceHeader: string;
  readonly claimedBy: "exact-header" | "alias" | "model";
  readonly shape: ValueShape;
  readonly share: number;
  readonly sentence: string;
};

export type EntityCandidate = {
  readonly entity: string;
  readonly label: string;
  /**
   * ⭐ THE SHARE OF THIS ENTITY'S CHECKABLE CLAIMS THAT THE FILE'S VALUES
   * CONFIRMED. See `DISCOVERY_FLOOR` for why this is not
   * `overallConfidence`.
   *
   * ⚠️ A COLUMN WHOSE HEADER LIES IS IN THE DENOMINATOR AND NOT IN THE
   * NUMERATOR, WHICH IS THE WHOLE ARITHMETIC OF THE CONTRADICTION RULE.
   * A heading that says GSTIN over a column of email addresses is a claim
   * this entity made and failed, so it costs exactly what a claim that
   * failed should cost. No separate penalty, no zeroing rule, nothing to
   * tune — and therefore nothing to soften later.
   */
  readonly confidence: number;
  /**
   * The two sides of that fraction, kept so a person can check it. A
   * ratio with no counts behind it is a number nobody can argue with.
   */
  readonly checkableClaims: number;
  /**
   * ⭐ HOW MANY OF THIS FILE'S DECISIVE SHAPES POINT AT THIS ENTITY AND
   * AT NO OTHER CANDIDATE. This is what separates two entities that can
   * both read a list of names.
   */
  readonly distinctiveness: number;
  /** ④. Reported always, consulted only on a draw. See `FILENAME_IS_A_TIE_BREAK`. */
  readonly filenameAffinity: number;
  readonly witnesses: readonly ShapeWitness[];
  readonly contradictions: readonly Contradiction[];
  readonly missingRequired: readonly string[];
  /** One sentence a non-technical person can read and check. */
  readonly why: string;
};

export type FileDiscovery = {
  readonly name: string;
  readonly headers: readonly string[];
  readonly dataRows: number;
  /** Set when the file could not be looked at at all. `candidates` is then empty. */
  readonly unreadable: string | null;
  /** Best first. Every entity that could read the file, including weak ones. */
  readonly candidates: readonly EntityCandidate[];
  /** The entity key, or null when discovery declines to choose. */
  readonly chosen: string | null;
  readonly decidedBy: "evidence" | "correction" | null;
  /** Present exactly when `chosen` is null. Says which of the two reasons. */
  readonly undecided: string | null;
  /** Things worth saying that are not a decision. Never empty of meaning. */
  readonly notes: readonly string[];
};

export type EntityCollision = {
  readonly entity: string;
  readonly files: readonly string[];
};

export type FolderDiscovery = {
  readonly files: readonly FileDiscovery[];
  /**
   * ⭐ THE ORDER, FROM THE CONTRACT, OVER THE ENTITIES ACTUALLY FOUND.
   * Not over all six: a customer who has no supplier file must not be
   * told to load one first. `resolveImportOrder` takes the subset for
   * exactly this reason.
   */
  readonly order: ImportOrderResult;
  /**
   * ⚠️ REPORTED, NOT REFUSED. Two files landing on `companies` is
   * ordinary — a customer list and a supplier list are both companies —
   * and refusing it would refuse the commonest real folder there is.
   * What is NOT ordinary is not being told, because the second file
   * silently updating records the first created is a support call.
   */
  readonly collisions: readonly EntityCollision[];
  /** Files discovery declined to place. The customer's list of decisions. */
  readonly unassigned: readonly string[];
};

export type DiscoveryOptions = {
  /**
   * 🔴 THE CUSTOMER'S CORRECTIONS, KEYED BY FILE NAME, AND VALIDATED
   * AGAINST THE ALLOWLIST RATHER THAN TRUSTED.
   *
   * ⚠️ THE KEY ARRIVES FROM A BROWSER. `isImportEntityKey` exists because
   * `ENTITIES[input.entity]` on an unchecked string is one prototype
   * lookup away from returning `Object.prototype.constructor`; a
   * correction is the same string from the same place. Membership is
   * checked against the map that was passed in — never `Object.hasOwn`
   * on a bare object literal, and never a dynamic index.
   *
   * `null` means "the customer said this file is not one of ours", which
   * is a decision and is recorded as one.
   */
  readonly corrections?: Readonly<Record<string, string | null>>;
  /**
   * ③, per file. `server/import/ai-mapper.ts` produces one of these and
   * has a written leash; nothing here loosens it. The opinion enters
   * through `proposeMapping`, which already refuses to let a model
   * override a decisive shape, and it can never create a witness — a
   * witness is a count of values.
   */
  readonly model?: Readonly<Record<string, ModelProposal>>;
};

/* ------------------------------------------------------------------ */
/* ① THE VALUES                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which entity-column kinds a shape is evidence for, as the shape table
 * already states it. Extracted so the contradiction rule and the
 * distinctiveness count read the SAME table `proposeMapping` reads.
 *
 * ⚠️ NO SECOND TABLE. A hand-written "field → expected shape" map here
 * would be a second model of the same fact, and this repository has been
 * bitten four times by exactly that. Everything below is derived from
 * `SHAPE_SUGGESTS`.
 */
function shapeSupportsColumn(shape: ValueShape, column: ImportColumn): boolean {
  const suggests = SHAPE_SUGGESTS[shape];
  return (
    suggests.includes(column.field) ||
    suggests.includes(column.kind) ||
    suggests.some((s) => column.field.toLowerCase().includes(s.toLowerCase()))
  );
}

/**
 * 🔴 IS THIS A FIELD WHOSE VALUES CAN BE CHECKED AT ALL?
 *
 * A `name` column has no expected shape — every string is a plausible
 * name — so a name column full of anything is never a contradiction. A
 * `gstin` column is checkable, and a checkable field whose column
 * decisively holds something else is the case worth stopping on.
 *
 * ⚠️ DERIVED BY ASKING THE SHAPE TABLE, not by listing the checkable
 * fields. The list would drift the first time a shape was added.
 */
function isCheckableField(column: ImportColumn): boolean {
  for (const shape of Object.keys(SHAPE_SUGGESTS) as ValueShape[]) {
    if (shape === "blank") continue;
    if (shapeSupportsColumn(shape, column)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* ④ THE FILE NAME                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE THREE THINGS REAL EXPORT FILENAMES CARRY, STRIPPED IN ORDER.
 *
 *   `report(3).csv`  → a browser's duplicate-download suffix
 *   `Master1.csv`    → a sequence number somebody typed
 *   `Ledger.xlsx`    → an extension
 *
 * What is left is the only part that could mean anything, and usually it
 * means nothing — which is the finding, not a failure.
 */
export function filenameTokens(name: string): readonly string[] {
  const withoutExtension = name.replace(/\.[a-z0-9]{1,5}$/i, "");
  const withoutCopySuffix = withoutExtension.replace(/[\s_-]*\(\d+\)\s*$/, "");
  const withoutTrailingDigits = withoutCopySuffix.replace(/\d+$/, "");
  return tokenise(withoutTrailingDigits);
}

/**
 * A number between 0 and 1, never added to a score. See
 * `FILENAME_IS_A_TIE_BREAK`.
 */
function filenameAffinity(name: string, entity: ContractedImportEntity): number {
  const fileTokens = new Set(filenameTokens(name));
  if (fileTokens.size === 0) return 0;

  const entityTokens = new Set<string>([
    ...tokenise(entity.key.replace(/-/g, " ")),
    ...tokenise(entity.label),
    ...tokenise(entity.noun.one),
    ...tokenise(entity.noun.many),
  ]);
  if (entityTokens.size === 0) return 0;

  let shared = 0;
  for (const token of fileTokens) if (entityTokens.has(token)) shared += 1;
  return shared / fileTokens.size;
}

/* ------------------------------------------------------------------ */
/* ONE FILE AGAINST ONE ENTITY                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ "a email" AND "a integer" ARE WHAT THE OBVIOUS VERSION PRINTS, and
 * these sentences are read by a customer deciding what happens to their
 * own data. A classifier that cannot spell is a classifier nobody trusts
 * about anything harder.
 */
function describeShape(shape: ValueShape): string {
  const words = shape.replace(/_/g, " ");
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

function considerEntity(
  file: DiscoveredFile,
  headers: readonly string[],
  sampleRows: readonly (readonly string[])[],
  evidence: readonly ColumnEvidence[],
  entity: ContractedImportEntity,
  model: ModelProposal | undefined,
): EntityCandidate {
  const proposal = proposeMapping(entity, headers, {
    sampleRows,
    ...(model ? { model } : {}),
  });

  const witnesses: ShapeWitness[] = [];
  const contradictions: Contradiction[] = [];
  /**
   * 🔴 THE DENOMINATOR. Every claim this entity made that the VALUES
   * could have confirmed or refuted — no more and no less.
   *
   * ⚠️ A CLAIM ON A COLUMN WITH NO VALUES AT ALL IS NOT COUNTED. An
   * entirely blank optional column confirms nothing and refutes nothing,
   * and putting it in the denominator would let a customer's empty
   * `Pincode` column drag a correct classification below the floor.
   *
   * ⚠️ A CLAIM ON A FREE-TEXT FIELD IS NOT COUNTED EITHER. No column of
   * values can confirm that a string is a company NAME, so counting a
   * `name` field would punish every entity that has one — which is all
   * of them.
   */
  let checkableClaims = 0;

  for (const proposed of proposal.columns) {
    if (proposed.sourceIndex < 0) continue;
    const column = entity.columns.find((c) => c.field === proposed.field);
    if (!column) continue;

    const columnEvidence = evidence[proposed.sourceIndex];
    if (!columnEvidence) continue;
    const shape = columnEvidence.shape;
    const nonBlank = columnEvidence.sampled - columnEvidence.blanks;

    if (!isCheckableField(column) || nonBlank === 0) continue;
    checkableClaims += 1;

    if (shape && shapeSupportsColumn(shape, column)) {
      witnesses.push({
        field: proposed.field,
        columnHeader: column.header,
        sourceHeader: proposed.sourceHeader ?? "",
        sourceIndex: proposed.sourceIndex,
        shape,
        share: columnEvidence.share,
        sampled: columnEvidence.sampled,
        confirmedBy: VALUE_BASES.has(proposed.basis) ? "values-alone" : "values-and-heading",
      });
      continue;
    }

    /*
     * 🔴 SOMETHING CLAIMED A CHECKABLE FIELD AND THE VALUES SAY OTHERWISE.
     * See `Contradiction` and `CLAIM_BASES`.
     */
    if (shape && CLAIM_BASES.has(proposed.basis)) {
      contradictions.push({
        field: proposed.field,
        sourceHeader: proposed.sourceHeader ?? "",
        claimedBy: proposed.basis as "exact-header" | "alias" | "model",
        shape,
        share: columnEvidence.share,
        sentence:
          `"${proposed.sourceHeader}" was put forward as the "${column.header}" of a ` +
          `${entity.noun.one}${proposed.basis === "model" ? " by the AI mapper" : ""}, but ` +
          `${Math.round(columnEvidence.share * 100)}% of its values are ` +
          `${describeShape(shape)}. The heading and the contents disagree, and the ` +
          `contents are the part that can be counted.`,
      });
    }
  }

  const confidence = checkableClaims === 0 ? 0 : witnesses.length / checkableClaims;

  return {
    entity: entity.key,
    label: entity.label,
    confidence,
    checkableClaims,
    distinctiveness: 0, // filled in by the folder pass, which can see the others
    filenameAffinity: filenameAffinity(file.name, entity),
    witnesses,
    contradictions,
    missingRequired: proposal.missingRequired,
    why: describeCandidate(entity, confidence, checkableClaims, witnesses, contradictions),
  };
}

function describeCandidate(
  entity: ContractedImportEntity,
  confidence: number,
  checkableClaims: number,
  witnesses: readonly ShapeWitness[],
  contradictions: readonly Contradiction[],
): string {
  if (checkableClaims === 0) {
    return (
      `Nothing in this file could be checked against ${entity.label.toLowerCase()}. ` +
      `Any column that matched did so on its heading alone, and a heading is a name ` +
      `rather than a measurement.`
    );
  }
  if (witnesses.length === 0) {
    return (
      contradictions[0]?.sentence ??
      `${checkableClaims} column${checkableClaims === 1 ? "" : "s"} in this file ` +
        `${checkableClaims === 1 ? "was" : "were"} matched to something ` +
        `${entity.label.toLowerCase()} can check, and none of ` +
        `${checkableClaims === 1 ? "it" : "them"} held what it should.`
    );
  }
  const first = witnesses[0]!;
  const rest = witnesses.length - 1;
  return (
    `${Math.round(first.share * 100)}% of the values under "${first.sourceHeader}" ` +
    `are ${describeShape(first.shape)}, which is what ${entity.label.toLowerCase()} ` +
    `call "${first.columnHeader}"` +
    (rest > 0
      ? `, and ${rest} other column${rest === 1 ? "" : "s"} checked out too` +
        (contradictions.length > 0
          ? `, while ${contradictions.length} did not`
          : ``)
      : contradictions.length > 0
        ? `, while ${contradictions.length} other column${contradictions.length === 1 ? "" : "s"} did not`
        : ``) +
    `. ${witnesses.length} of ${checkableClaims} checkable column` +
    `${checkableClaims === 1 ? "" : "s"} confirmed by ${confidence === 1 ? "their" : "its"} ` +
    `contents — ${Math.round(confidence * 100)}%.`
  );
}

/* ------------------------------------------------------------------ */
/* ONE FILE                                                            */
/* ------------------------------------------------------------------ */

function readFile(
  file: DiscoveredFile,
  entities: Readonly<Record<string, ContractedImportEntity>>,
  model: ModelProposal | undefined,
): {
  readonly headers: readonly string[];
  readonly dataRows: number;
  readonly unreadable: string | null;
  readonly evidence: readonly ColumnEvidence[];
  readonly candidates: EntityCandidate[];
  readonly notes: string[];
} {
  const [header, ...dataRecords] = file.records;
  const notes: string[] = [];

  if (!header) {
    return {
      headers: [],
      dataRows: 0,
      unreadable: "This file has no rows in it at all, so there is nothing to look at.",
      evidence: [],
      candidates: [],
      notes,
    };
  }

  const headers = header.cells;

  if (dataRecords.length === 0) {
    return {
      headers,
      dataRows: 0,
      unreadable:
        "This file has a header row and no data rows under it. Discovery reads the " +
        "VALUES, so a file with no values cannot be classified — not even wrongly.",
      evidence: [],
      candidates: [],
      notes,
    };
  }

  /*
   * ⚠️ THE SAME SAMPLE SIZE THE MAPPER USES, AND FROM THE SAME CONSTANT.
   * A discovery drawing on 200 rows and a mapping drawing on 50 would
   * disagree about the same column, and the customer would see one
   * screen contradict the next.
   */
  const sampleRows = dataRecords.slice(0, EVIDENCE_SAMPLE_ROWS).map((r) => r.cells);
  const evidence = headers.map((_, index) =>
    evidenceFor(sampleRows.map((row) => row[index] ?? "")),
  );

  if (dataRecords.length > MAX_IMPORT_ROWS) {
    notes.push(
      `This file has ${dataRecords.length} rows and one import takes at most ` +
        `${MAX_IMPORT_ROWS}. It will have to be split before it can be loaded — ` +
        `discovery says so now rather than at the end of the upload.`,
    );
  }

  const blankHeaders = headers.filter((h) => h.trim() === "").length;
  if (blankHeaders > 0) {
    notes.push(
      `${blankHeaders} column${blankHeaders === 1 ? " has" : "s have"} no heading. ` +
        `Their contents were still read — that is the point of reading values — but ` +
        `nothing can be said about what they were called.`,
    );
  }

  const candidates = Object.values(entities).map((entity) =>
    considerEntity(file, headers, sampleRows, evidence, entity, model),
  );

  return {
    headers,
    dataRows: dataRecords.length,
    unreadable: null,
    evidence,
    candidates,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* ② DISTINCTIVENESS — computed across the candidates, not within one  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ HOW MANY OF THIS FILE'S DECISIVE SHAPES POINT AT ONE ENTITY ONLY.
 *
 * ⚠️ IT CANNOT BE COMPUTED INSIDE `considerEntity`, WHICH IS WHY IT IS
 * HERE. "Distinctive" is a statement about the other candidates: a GSTIN
 * column is worth a great deal when one entity has a `gstin` field and
 * the rest do not, and worth nothing at all when three of them do.
 */
function scoreDistinctiveness(
  evidence: readonly ColumnEvidence[],
  entities: Readonly<Record<string, ContractedImportEntity>>,
  candidates: readonly EntityCandidate[],
): Map<string, number> {
  const scores = new Map<string, number>(candidates.map((c) => [c.entity, 0]));

  const shapesPresent = new Set<ValueShape>();
  for (const column of evidence) if (column.shape) shapesPresent.add(column.shape);

  for (const shape of shapesPresent) {
    const claimants: string[] = [];
    for (const candidate of candidates) {
      const entity = entities[candidate.entity];
      if (!entity) continue;
      if (entity.columns.some((column) => shapeSupportsColumn(shape, column))) {
        claimants.push(candidate.entity);
      }
    }
    /* Exactly one claimant is what "distinctive" means. */
    if (claimants.length === 1) {
      const only = claimants[0]!;
      scores.set(only, (scores.get(only) ?? 0) + 1);
    }
  }

  return scores;
}

/* ------------------------------------------------------------------ */
/* THE CHOICE                                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 DECLINING TO CHOOSE IS A RESULT, AND IT HAS TWO DIFFERENT REASONS
 *    WHICH MUST NOT BE COLLAPSED INTO ONE SENTENCE.
 *
 *   NOTHING FITS      no entity can read the file. The customer's next
 *                     action is to check they exported the right thing.
 *   TWO THINGS FIT    two entities fit and neither is clear of the other.
 *                     The customer's next action is to pick one.
 *
 * "Could not determine the type of this file" covers both and helps with
 * neither.
 */
function chooseFrom(ranked: readonly EntityCandidate[]): {
  chosen: string | null;
  undecided: string | null;
} {
  const best = ranked[0];

  /*
   * 🔴 THE HARD GATE, AND IT IS NOT THE FLOOR. At least ONE column must
   * have been confirmed by its CONTENTS. An entity whose every match came
   * from a heading is an entity chosen because somebody typed a word, and
   * this module exists precisely because the words are `F1 F2 F3`.
   */
  if (!best || best.witnesses.length === 0) {
    const lied = ranked.find((c) => c.contradictions.length > 0);
    if (lied) {
      return {
        chosen: null,
        undecided:
          `${lied.contradictions[0]!.sentence} Nothing else in this file was confirmed ` +
          `by its contents either, so Ordence will not place it. Open it and check ` +
          `which column is which.`,
      };
    }
    return {
      chosen: null,
      undecided:
        "No column in this file holds anything Ordence recognises — no GSTIN, PAN, " +
        "IFSC, HSN, pincode, date or amount. Either it is not one of the lists this " +
        "migration needs, or every column in it is free text, in which case somebody " +
        "has to say what it is.",
    };
  }

  if (best.confidence < DISCOVERY_FLOOR) {
    return {
      chosen: null,
      undecided:
        `The closest match is ${best.label.toLowerCase()}, and only ` +
        `${best.witnesses.length} of its ${best.checkableClaims} checkable columns ` +
        `held what they should — ${Math.round(best.confidence * 100)}%, below the ` +
        `${Math.round(DISCOVERY_FLOOR * 100)}% Ordence acts on without being told. ` +
        `${best.why}`,
    };
  }

  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.witnesses.length > 0 &&
    best.confidence - runnerUp.confidence < DISCOVERY_MARGIN &&
    best.witnesses.length === runnerUp.witnesses.length &&
    best.distinctiveness === runnerUp.distinctiveness &&
    best.filenameAffinity === runnerUp.filenameAffinity
  ) {
    return {
      chosen: null,
      undecided:
        `${best.label} and ${runnerUp.label} both fit this file and nothing separates ` +
        `them — ${Math.round(best.confidence * 100)}% against ` +
        `${Math.round(runnerUp.confidence * 100)}%, on the same number of confirmed ` +
        `columns. Picking the higher of two numbers this close would be picking by ` +
        `rounding error. Choose one.`,
    };
  }

  return { chosen: best.entity, undecided: null };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE FUNCTION                                                   */
/* ------------------------------------------------------------------ */

export function discoverFolder(
  files: readonly DiscoveredFile[],
  entities: Readonly<Record<string, ContractedImportEntity>>,
  options: DiscoveryOptions = {},
): FolderDiscovery {
  const corrections = options.corrections ?? {};
  const models = options.model ?? {};

  const results: FileDiscovery[] = [];

  for (const file of files) {
    const model = Object.hasOwn(models, file.name) ? models[file.name] : undefined;
    const read = readFile(file, entities, model);
    const notes = [...read.notes];

    if (read.unreadable) {
      results.push({
        name: file.name,
        headers: read.headers,
        dataRows: read.dataRows,
        unreadable: read.unreadable,
        candidates: [],
        chosen: null,
        decidedBy: null,
        undecided: read.unreadable,
        notes,
      });
      continue;
    }

    const distinctiveness = scoreDistinctiveness(read.evidence, entities, read.candidates);
    const withDistinctiveness = read.candidates.map((candidate) => ({
      ...candidate,
      distinctiveness: distinctiveness.get(candidate.entity) ?? 0,
    }));

    /*
     * ⚠️ THE SORT IS THE ORDER OF AUTHORITY, WRITTEN OUT. Confidence
     * first, then distinctiveness, then — and only then — the file name,
     * then the key so two identical candidates do not swap places
     * between two runs and make the screen redraw itself.
     */
    const ranked = [...withDistinctiveness].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        /*
         * ⚠️ THE ABSOLUTE COUNT, AND IT IS NOT REDUNDANT WITH THE RATIO
         * ABOVE. Three columns out of three and one out of one are both
         * 100%, and the first is three independent measurements while the
         * second is one. A trial balance confirmed by its date, its debits
         * AND its credits should not be a coin toss against an entity that
         * merely also has a date column.
         */
        b.witnesses.length - a.witnesses.length ||
        b.distinctiveness - a.distinctiveness ||
        b.filenameAffinity - a.filenameAffinity ||
        a.entity.localeCompare(b.entity),
    );

    let { chosen, undecided } = chooseFrom(ranked);
    let decidedBy: "evidence" | "correction" | null = chosen ? "evidence" : null;

    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE CUSTOMER'S CORRECTION WINS — AND IS CHECKED FIRST
     * ══════════════════════════════════════════════════════════════
     * ⚠️ MEMBERSHIP IN THE MAP THAT WAS PASSED IN, NOT `entities[key]`
     * ON A STRING FROM A BROWSER. See `DiscoveryOptions.corrections`.
     */
    if (Object.hasOwn(corrections, file.name)) {
      const correction = corrections[file.name] ?? null;
      if (correction === null) {
        chosen = null;
        decidedBy = "correction";
        undecided = "You said this file is not one of the lists to import.";
      } else if (Object.hasOwn(entities, correction)) {
        if (chosen !== correction) {
          const overruled = ranked.find((c) => c.entity === correction);
          notes.push(
            chosen
              ? `You changed this from ${
                  ranked.find((c) => c.entity === chosen)?.label ?? chosen
                } to ${entities[correction]?.label ?? correction}. ` +
                `The evidence Ordence read is still shown above` +
                (overruled && overruled.confidence <= 0
                  ? `, and it did not support this choice — which is recorded, not argued with.`
                  : `.`)
              : `You chose ${entities[correction]?.label ?? correction} for a file ` +
                `Ordence would not place on its own.`,
          );
        }
        chosen = correction;
        decidedBy = "correction";
        undecided = null;
      } else {
        /*
         * 🔴 AN UNKNOWN KEY IS REFUSED, NOT IGNORED. Ignoring it would
         * leave the customer looking at a screen that says one thing
         * and a run that does another.
         */
        notes.push(
          `"${correction}" is not something Ordence can import, so the correction was ` +
            `refused and this file is still unassigned. Nothing has been loaded.`,
        );
        chosen = null;
        decidedBy = null;
        undecided =
          `A correction named "${correction}", which is not an entity this product ` +
          `has. The file is unassigned.`;
      }
    }

    if (chosen) {
      const winner = ranked.find((c) => c.entity === chosen);
      if (winner) {
        for (const contradiction of winner.contradictions) notes.push(contradiction.sentence);
        /*
         * ⭐ THE OTHER HALF OF THE CLASSIFICATION/MAPPING SPLIT. See
         * `DISCOVERY_FLOOR`. Knowing WHAT the file is does not mean it
         * can be loaded as it stands, and saying so here is what stops
         * the customer meeting the problem for the first time as a
         * refusal at the end of an upload.
         */
        if (winner.missingRequired.length > 0) {
          notes.push(
            `This is ${winner.label.toLowerCase()}, and ` +
              `${winner.missingRequired.join(", ")} still ` +
              `${winner.missingRequired.length === 1 ? "has" : "have"} no column. ` +
              `Discovery reads values and ${winner.missingRequired.length === 1 ? "that column holds" : "those columns hold"} ` +
              `text no detector can recognise, so you will be asked to point at ` +
              `${winner.missingRequired.length === 1 ? "it" : "them"} before this file can be loaded.`,
          );
        }
      }
    }

    results.push({
      name: file.name,
      headers: read.headers,
      dataRows: read.dataRows,
      unreadable: null,
      candidates: ranked,
      chosen,
      decidedBy,
      undecided,
      notes,
    });
  }

  /* ---- the folder-level answers ------------------------------- */

  const byEntity = new Map<string, string[]>();
  for (const result of results) {
    if (!result.chosen) continue;
    const list = byEntity.get(result.chosen) ?? [];
    list.push(result.name);
    byEntity.set(result.chosen, list);
  }

  const collisions: EntityCollision[] = [...byEntity.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([entity, names]) => ({ entity, files: [...names].sort() }))
    .sort((a, b) => a.entity.localeCompare(b.entity));

  return {
    files: results,
    order: resolveImportOrder(entities, [...byEntity.keys()].sort()),
    collisions,
    unassigned: results.filter((r) => !r.chosen).map((r) => r.name),
  };
}

/* ------------------------------------------------------------------ */
/* THE SUMMARY THE WIZARD PRINTS                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE FUNCTION RATHER THAN A TERNARY IN A COMPONENT, for the reason
 * `duplicateRule` gives on `ImportEntityDefinition`: a sentence built in
 * a component is a sentence that describes the second entity as the
 * first. This one is pure and testable, and the wizard renders it.
 */
export function describeFolder(discovery: FolderDiscovery): string {
  const placed = discovery.files.filter((f) => f.chosen).length;
  const total = discovery.files.length;

  const head =
    `${placed} of ${total} file${total === 1 ? "" : "s"} recognised` +
    (discovery.unassigned.length > 0
      ? `. ${discovery.unassigned.length} still need${discovery.unassigned.length === 1 ? "s" : ""} a decision: ${discovery.unassigned.join(", ")}.`
      : `.`);

  if (!discovery.order.ok) {
    return (
      `${head} The load order could not be worked out: ${discovery.order.problem} ` +
      `(${discovery.order.entities.join(", ")}).`
    );
  }

  if (discovery.order.steps.length === 0) return head;

  const waves = new Map<number, string[]>();
  for (const step of discovery.order.steps) {
    const list = waves.get(step.wave) ?? [];
    list.push(step.entity);
    waves.set(step.wave, list);
  }
  const order = [...waves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, keys]) => `${wave + 1}. ${keys.join(", ")}`)
    .join("   ");

  return (
    `${head} Load them in ${discovery.order.waves} ` +
    `${discovery.order.waves === 1 ? "stage" : "stages"} — ${order} — ` +
    `anything in one stage may be loaded in any order.`
  );
}
