/**
 * Ordence — ⭐⭐⭐ FILLING IN A TEMPLATE META ALREADY APPROVED
 * Version: v1.14.0-alpha
 *
 * Pure. No clock, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS NOT `lib/receivables/render.ts`, AND BOTH SHOULD EXIST
 * ══════════════════════════════════════════════════════════════════════
 * That one renders a legal notice from our own wording, in five
 * languages, and refuses when a placeholder has no value.
 *
 * 🔴 THIS ONE FILLS IN A TEMPLATE **META OWNS**. The wording was
 * approved by them, the placeholders are `{{1}}`, `{{2}}` in their
 * numbering, and the constraints are theirs: an exact parameter count,
 * no newlines in a parameter, no leading or trailing whitespace.
 *
 * ⚠️ THE FAILURE MODES ARE DIFFERENT, WHICH IS WHY MERGING THEM WOULD BE
 * WRONG. Ours is "the notice has a hole in it". Theirs is "the API
 * refuses the send", and the message that did not go is a payment
 * reminder somebody was relying on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY CHECK HERE HAPPENS BEFORE THE SEND, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * Meta rejects a malformed parameter list at the API. Discovering that
 * at send time means the reminder did not go out, the run is marked
 * failed, and somebody has to work out which of four hundred messages
 * was the bad one.
 *
 * ⭐ A refusal here names the parameter and the reason, before anything
 * is attempted.
 */

export class TemplateParameterError extends Error {
  readonly remedy: string;
  readonly position: number | null;

  constructor(message: string, remedy: string, position: number | null = null) {
    super(message);
    this.name = "TemplateParameterError";
    this.remedy = remedy;
    this.position = position;
  }
}

/**
 * ⚠️ META'S OWN LIMIT ON A TEXT PARAMETER. Longer is refused outright.
 */
export const MAX_PARAMETER_LENGTH = 1024;

/**
 * 🔴 COUNTS THE HIGHEST PLACEHOLDER, NOT HOW MANY THERE ARE.
 *
 * ⚠️ `{{1}} … {{3}}` with no `{{2}}` needs THREE parameters, not two.
 * Counting occurrences produces a list one short, which the API refuses
 * with a message about parameter counts that names no parameter.
 */
export function variableCountOf(body: string): number {
  let highest = 0;
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest;
}

/**
 * ⚠️ META'S OWN FORMATTING RULES FOR A TEMPLATE BODY, checked here so a
 * template is refused when it is written rather than when it is
 * submitted and rejected hours later.
 */
export interface BodyProblem {
  readonly problem: string;
  readonly remedy: string;
}

export function checkTemplateBody(body: string): BodyProblem[] {
  const problems: BodyProblem[] = [];
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    problems.push({
      problem: "The template has no text.",
      remedy: "Write the message the recipient will see.",
    });
    return problems;
  }

  // ⚠️ A message may not begin or end with a variable.
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(trimmed)) {
    problems.push({
      problem: "The message starts with a variable.",
      remedy:
        "Put some fixed words first. Meta rejects a template that opens with a placeholder, because the recipient cannot tell who is writing.",
    });
  }
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(trimmed)) {
    problems.push({
      problem: "The message ends with a variable.",
      remedy: "Add a closing line after the last placeholder.",
    });
  }

  // ⚠️ Two variables with nothing between them.
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(trimmed)) {
    problems.push({
      problem: "Two variables sit next to each other with no words between.",
      remedy:
        "Put a word, a comma or a line of text between them. Meta reads adjacent placeholders as an attempt to smuggle arbitrary content past review.",
    });
  }

  // ⚠️ Skipped numbers.
  const count = variableCountOf(trimmed);
  for (let i = 1; i <= count; i += 1) {
    if (!new RegExp(`\\{\\{\\s*${i}\\s*\\}\\}`).test(trimmed)) {
      problems.push({
        problem: `The template uses {{${count}}} but has no {{${i}}}.`,
        remedy:
          "Number the placeholders from 1 with no gaps. A gap makes the parameter list ambiguous and the send is refused.",
      });
      break;
    }
  }

  /**
   * ⭐ TOO LITTLE FIXED TEXT FOR THE NUMBER OF PLACEHOLDERS.
   *
   * ⚠️ Meta rejects a template that is mostly variables, because it is
   * indistinguishable from a blank cheque. The threshold is not
   * published, so this WARNS rather than refuses — a rule we invented
   * must not block a template Meta would have approved.
   */
  const fixedText = trimmed.replace(/\{\{\s*\d+\s*\}\}/g, "").trim();
  if (count >= 2 && fixedText.length < count * 10) {
    problems.push({
      problem: "There is very little fixed wording around the placeholders.",
      remedy:
        "Add more of the message as fixed text. Meta rejects templates that are mostly variables. This is a warning rather than a certainty, because the exact threshold is not published.",
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* FILLING IT IN                                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 A PARAMETER MAY NOT CONTAIN A NEWLINE, A TAB, OR FOUR CONSECUTIVE
 * SPACES. Meta refuses the send outright.
 *
 * ⚠️ THIS IS THE ONE THAT BITES IN PRACTICE, because the obvious thing
 * to put in a parameter is an address, and an address in a database is
 * usually stored with newlines in it. Everything works in testing with
 * "Mumbai" and fails on the first real customer.
 *
 * ⭐ So whitespace is COLLAPSED rather than refused: a refusal here
 * would mean the payment reminder did not go because of the shape of
 * somebody's address, which is not a good enough reason.
 */
export function cleanParameter(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RenderedMessage {
  readonly body: string;
  /** The parameter array, in Meta's order, ready to send. */
  readonly parameters: readonly string[];
}

/**
 * Fills a template body for storage and for the API in one pass.
 *
 * ⚠️ THE RENDERED BODY IS KEPT ON THE SEND ROW, because a demand notice
 * is served evidence and "template X with parameters A, B" is not what
 * the buyer received. The template will have been edited by the time
 * anybody asks.
 */
export function renderTemplate(
  body: string,
  values: readonly string[],
): RenderedMessage {
  const required = variableCountOf(body);

  // 🔴 THE EXACT COUNT. Meta refuses too few AND too many.
  if (values.length !== required) {
    throw new TemplateParameterError(
      `This template needs ${required} value${required === 1 ? "" : "s"} and ${values.length} ${values.length === 1 ? "was" : "were"} supplied.`,
      required > values.length
        ? "Supply every value the template asks for. WhatsApp refuses a message with a missing parameter rather than sending it with a gap."
        : "Remove the extra values. WhatsApp refuses a message with more parameters than the approved template has places for.",
      null,
    );
  }

  const parameters: string[] = [];

  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i] ?? "";
    const cleaned = cleanParameter(raw);

    // ⚠️ AN EMPTY PARAMETER IS REFUSED BY META, and it is also almost
    // always a bug at our end: a name that was null, an amount that did
    // not format.
    if (cleaned.length === 0) {
      throw new TemplateParameterError(
        `Value ${i + 1} is empty.`,
        "WhatsApp refuses a message with a blank parameter. Supply a value, or use a different template for the case where there is nothing to say.",
        i + 1,
      );
    }

    if (cleaned.length > MAX_PARAMETER_LENGTH) {
      throw new TemplateParameterError(
        `Value ${i + 1} is ${cleaned.length} characters and the limit is ${MAX_PARAMETER_LENGTH}.`,
        "Shorten it. A long free-text field usually belongs in the portal with a link in the message, not in the message itself.",
        i + 1,
      );
    }

    parameters.push(cleaned);
  }

  let rendered = body;
  for (let i = 0; i < parameters.length; i += 1) {
    rendered = rendered.replace(
      new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"),
      parameters[i] ?? "",
    );
  }

  return { body: rendered, parameters };
}

/* ------------------------------------------------------------------ */
/* THE IDEMPOTENCY KEY                                                 */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 THE KEY IS DERIVED FROM WHAT THE MESSAGE **IS**, NOT FROM WHEN IT
 *    WAS SENT.
 *
 * ⚠️ Meta returns a message id only in the response, which is no use for
 * deciding whether to send. A random key generated per attempt makes
 * every retry a new message, and a retry after a timeout sends the same
 * payment reminder twice — the second one being the one the customer
 * complains about.
 *
 * ⭐ `demand:<id>:rung3` collides with itself, which is the whole point.
 * 0066 puts a unique index on it so the refusal is the database's, not a
 * promise in a runner.
 */
export function idempotencyKey(parts: {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly purpose: string;
  /**
   * ⚠️ ONLY WHERE A REPEAT IS GENUINELY A DIFFERENT MESSAGE. A monthly
   * statement for August is not the statement for September, so the
   * period belongs in the key. A payment reminder for rung 3 is the same
   * reminder however many times the job runs.
   */
  readonly occurrence?: string;
}): string {
  const base = `${parts.subjectType}:${parts.subjectId}:${parts.purpose}`;
  const key = parts.occurrence ? `${base}:${parts.occurrence}` : base;
  return key.slice(0, 200);
}
