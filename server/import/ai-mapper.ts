import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE AI HALF OF THE MAPPER, AND ITS LEASH
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THE MODEL IS FOR, AND WHAT IT IS NOT FOR
 * ══════════════════════════════════════════════════════════════════════
 * It is for the case `lib/import/proposal.ts` cannot reach on its own: a
 * header that is a word rather than a pattern, in a language or an
 * abbreviation nobody wrote into the synonym table. `Party ka naam`.
 * `Bezeichnung`. `Cust_Nm_1`.
 *
 * 🔴 IT IS NOT THE MAPPER. It contributes ONE opinion, as data, to a
 * function that already has two others, and `proposeMapping` gives it
 * `SCORE.MODEL_ONLY` — below every deterministic basis — precisely so a
 * confident sentence cannot outrank a measured fact. A model saying `F3`
 * is the GSTIN when every value in F3 is an email address loses, and the
 * disagreement is shown to the person rather than resolved.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS SENT, AND WHAT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * HEADERS ARE SENT. VALUES ARE NOT.
 *
 * The obvious implementation pastes five sample rows in, because that is
 * what makes a model good at this. Those five rows are five real
 * customers' names, phone numbers and GSTINs, sent to a third party
 * during a MIGRATION — which is the exact moment a workspace has the most
 * data and the least idea what the product does with it.
 *
 * ⭐ The values are already handled: `lib/import/shapes.ts` reads them
 * locally, in this process, and produces a SHAPE — "15 characters, 92% of
 * them GSTIN-formatted". That description is sent. The data is not.
 *
 * ⚠️ `sensitivity: "open"` FOLLOWS FROM THAT AND IS NOT A SHORTCUT. It is
 * accurate only because nothing tenant-identifying is in the prompt, and
 * `assertPromptIsHeadersOnly` below fails loudly if that ever stops being
 * true — a check, not a comment.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND IT RUNS ON THE WORKSPACE'S OWN KEY — 0115
 * ══════════════════════════════════════════════════════════════════════
 * Through `tenantChatCompletion`, so a workspace on `byo_required` uses
 * its own key or is refused with a sentence about a key only they can
 * add. A migration is exactly where a new workspace would otherwise spend
 * a lot of somebody else's AI budget in one afternoon.
 */

import { z } from "zod";

import { tenantChatCompletion } from "@/server/ai/chat";
import { evidenceFor, type ColumnEvidence } from "@/lib/import/shapes";
import type { ImportEntityDefinition } from "@/lib/import/types";
import type { ModelProposal } from "@/lib/import/proposal";

export class PromptLeakError extends Error {
  constructor(found: string) {
    super(
      `The import mapping prompt was about to include a value from the customer's file ` +
        `(${found}). Nothing has been sent. Only column headings and statistical descriptions of ` +
        `the columns may leave this process during an import.`,
    );
    this.name = "PromptLeakError";
  }
}

export type AiMappingOutcome = {
  /** Field → source header. Empty when the model was not used or refused. */
  readonly proposal: ModelProposal;
  readonly used: boolean;
  /** Present when the model could not be used. Shown to the person. */
  readonly refusal?: string;
  /** Whose key answered. Recorded on the proposal row. */
  readonly credentialSource?: "platform" | "tenant";
};

/**
 * ⚠️ A DESCRIPTION OF A COLUMN, WITH NO VALUE FROM IT.
 *
 * 🔴 `longest` AND `distinct` ARE COUNTS, NOT CONTENT. That distinction
 * is the whole basis on which this prompt is safe to send.
 */
function describeColumn(header: string, evidence: ColumnEvidence): string {
  const parts = [
    evidence.shape
      ? `${Math.round(evidence.share * 100)}% of values match the pattern of a ${evidence.shape.replace(/_/g, " ")}`
      : "no single recognisable pattern",
    `${evidence.distinct} distinct values in ${evidence.sampled} sampled`,
    `${evidence.blanks} blank`,
    `longest ${evidence.longest} characters`,
  ];
  return `- "${header}": ${parts.join("; ")}`;
}

/**
 * 🔴 THE CHECK THAT MAKES THE HEADER'S CLAIM ENFORCEABLE.
 *
 * ⚠️ IT SCANS THE ASSEMBLED PROMPT, not the inputs, because the failure
 * being prevented is a future edit that adds sample rows to the prompt
 * builder — at which point every input is still "just a header" and the
 * prompt is not.
 */
export function assertPromptIsHeadersOnly(
  prompt: string,
  sampleValues: readonly string[],
): void {
  for (const value of sampleValues) {
    const trimmed = value.trim();
    /** Short values collide with ordinary words. Anything real is longer. */
    if (trimmed.length < 6) continue;
    if (prompt.includes(trimmed)) throw new PromptLeakError(`"${trimmed.slice(0, 20)}…"`);
  }
}

const responseSchema = z.object({
  mappings: z.array(
    z.object({
      field: z.string(),
      sourceHeader: z.string(),
    }),
  ),
});

export async function proposeMappingWithAi(args: {
  readonly tenantId: string;
  readonly entity: ImportEntityDefinition;
  readonly sourceHeaders: readonly string[];
  readonly sampleRows: readonly (readonly string[])[];
}): Promise<AiMappingOutcome> {
  const { tenantId, entity, sourceHeaders, sampleRows } = args;

  const descriptions = sourceHeaders
    .map((header, index) =>
      describeColumn(header, evidenceFor(sampleRows.map((row) => row[index] ?? ""))),
    )
    .join("\n");

  const targets = entity.columns
    .map((c) => `- ${c.field} ("${c.header}", ${c.kind}${c.required ? ", required" : ""}): ${c.help}`)
    .join("\n");

  const prompt =
    `A customer is migrating data into an Indian ERP. Match the columns of their file to the ` +
    `fields of the "${entity.label}" record.\n\n` +
    `THEIR COLUMNS (headings and statistical descriptions only — no values are shown to you, ` +
    `deliberately):\n${descriptions}\n\n` +
    `OUR FIELDS:\n${targets}\n\n` +
    `Rules:\n` +
    `1. Only map a column when the heading or the described pattern genuinely supports it.\n` +
    `2. Leave a field out entirely rather than guessing. An omission is corrected in one click; ` +
    `a wrong guess is discovered months later.\n` +
    `3. Use each of their columns at most once.\n` +
    `4. Headings may be in Hindi, Marathi, Gujarati, Tamil or an abbreviation. Translate rather ` +
    `than skip.\n\n` +
    `Reply with JSON only: {"mappings":[{"field":"...","sourceHeader":"..."}]}`;

  /** 🔴 Enforced, not asserted in a comment. */
  assertPromptIsHeadersOnly(prompt, sampleRows.flat());

  const response = await tenantChatCompletion({
    tenantId,
    feature: "import_mapping",
    /**
     * ⚠️ `open` IS ACCURATE HERE AND WOULD NOT BE IF A SINGLE SAMPLE ROW
     * WERE ADDED. See the header, and the check above.
     */
    sensitivity: "open",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You map spreadsheet columns to database fields for a data migration. You never invent " +
          "a mapping you cannot justify from the heading or the described pattern. You reply " +
          "with JSON and nothing else.",
      },
      { role: "user", content: prompt },
    ],
  });

  if (!response.ok) {
    return { proposal: {}, used: false, refusal: response.reason };
  }

  const text = typeof response.result.message.content === "string"
    ? response.result.message.content
    : "";

  /**
   * ⚠️ MODELS FENCE JSON IN MARKDOWN WHATEVER THEY ARE TOLD. Stripping
   * the fence is one line; not stripping it is a mapping that silently
   * never arrives and looks like the model being unhelpful.
   */
  const json = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = responseSchema.safeParse(JSON.parse(json));
  } catch {
    return {
      proposal: {},
      used: false,
      refusal:
        "The AI mapper replied with something that was not a mapping, so nothing from it was " +
        "used. The mapping below comes from your column headings and the shape of your data.",
      credentialSource: response.credentialSource,
    };
  }

  if (!parsed.success) {
    return {
      proposal: {},
      used: false,
      refusal: "The AI mapper's reply did not have the expected shape and was ignored.",
      credentialSource: response.credentialSource,
    };
  }

  /**
   * ⚠️ FILTERED AGAINST THE REAL LISTS BEFORE IT GOES ANY FURTHER. A
   * model naming a field that does not exist, or a column that is not in
   * the file, is routine; letting either through would put an
   * unrecognised key into the proposal and the mismatch would surface as
   * something else entirely, three functions away.
   */
  const fields = new Set(entity.columns.map((c) => c.field));
  const headers = new Set(sourceHeaders);
  const proposal: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  for (const mapping of parsed.data.mappings) {
    if (!fields.has(mapping.field)) continue;
    if (!headers.has(mapping.sourceHeader)) continue;
    /** Rule 3, enforced rather than requested. */
    if (usedHeaders.has(mapping.sourceHeader)) continue;
    if (proposal[mapping.field]) continue;
    proposal[mapping.field] = mapping.sourceHeader;
    usedHeaders.add(mapping.sourceHeader);
  }

  return {
    proposal,
    used: Object.keys(proposal).length > 0,
    credentialSource: response.credentialSource,
  };
}
