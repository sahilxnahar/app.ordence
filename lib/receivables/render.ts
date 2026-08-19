/**
 * Ordence — ⭐ Safe Template Rendering
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O, no template engine.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS TWENTY LINES OF SUBSTITUTION AND NOT A TEMPLATE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * A demand notice interpolates a buyer's name, a project name and a unit
 * label — all of them free text a customer typed — into a document that
 * is emailed, put on a portal and printed. Every general-purpose template
 * engine that has ever been pointed at that job has produced the same
 * three failures:
 *
 *   1. ⭐⭐ INJECTION. A buyer registered as `<img src=x onerror=…>`
 *      whose name lands unescaped in an HTML notice runs script in the
 *      browser of whoever opens it — which is the developer's own
 *      collections clerk, logged in.
 *   2. ⭐ SECOND-PASS INTERPOLATION. An engine that re-scans its own
 *      output lets a value containing `{{totalAmount}}` pull in another
 *      field. On a legal notice that is one buyer's amount appearing on
 *      another's document.
 *   3. ⚠️ A PLACEHOLDER THAT SILENTLY RENDERS AS ITSELF. A notice reading
 *      "the sum of {{totalAmount}} is due" goes out, gets read, and the
 *      developer finds out from the buyer.
 *
 * So: one pass, an explicit value map, and a REFUSAL when a placeholder
 * has no value. Refusing to render is always better than rendering a
 * legal document with a hole in it — the failure is loud, in front of the
 * person about to send it, instead of quiet, in front of the recipient.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ESCAPING IS A PROPERTY OF THE OUTPUT, NOT OF THE VALUE
 * ══════════════════════════════════════════════════════════════════════
 * The same demand goes out as plain text (SMS, WhatsApp), as HTML (email,
 * portal) and as a PDF source. Escaping at the point the value is READ
 * would put `&amp;` into an SMS; escaping never would put a script tag
 * into an email. So the mode is chosen by the CALLER, per rendering, and
 * `text` mode still strips control characters — a NUL byte in a buyer's
 * name truncates the string in several PDF pipelines.
 */

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

export class TemplateRenderError extends Error {
  readonly remedy: string;
  readonly placeholder: string | null;

  constructor(message: string, remedy: string, placeholder: string | null = null) {
    super(message);
    this.name = "TemplateRenderError";
    this.remedy = remedy;
    this.placeholder = placeholder;
  }
}

/* ------------------------------------------------------------------ */
/* SANITISING                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ REMOVED, NOT ESCAPED. There is no escape sequence for U+0000 that
 * any of the three output formats agrees on, and the characters serve no
 * purpose in a name or an address. `\n`, `\r` and `\t` survive because a
 * notice has an address block in it.
 *
 * ⚠️ AND THE BIDIRECTIONAL OVERRIDES GO TOO (U+202A–U+202E, U+2066–
 * U+2069). They are invisible and they REORDER RENDERED TEXT: a name
 * carrying U+202E makes "₹5,00,000 due to Ordence" display as
 * something else entirely without changing a single visible character.
 * On a document whose whole job is stating an amount, that is not a
 * theoretical attack.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;

/** Longest value accepted in a placeholder. A name is not a novel. */
export const MAX_VALUE_LENGTH = 500;

export function sanitiseValue(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_OVERRIDES, "")
    .slice(0, MAX_VALUE_LENGTH);
}

/**
 * ⚠️ ALL FIVE, AND THE AMPERSAND FIRST.
 *
 * Escaping `<` before `&` turns `<` into `&lt;` and then into
 * `&amp;lt;`, which renders as the literal text "&lt;" on the notice.
 * The same ordering bug is called out in `lib/tally/xml.ts` — it is the
 * single most common way an escaper is written wrong, and it is wrong in
 * a way that looks like a rendering glitch rather than a security hole.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type RenderMode = "text" | "html";

/* ------------------------------------------------------------------ */
/* RENDERING                                                           */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Every placeholder a template refers to, in order of first appearance. */
export function placeholdersIn(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (key) seen.add(key);
  }
  return [...seen];
}

/**
 * Substitute `{{placeholders}}` in ONE pass.
 *
 * ⭐ ONE PASS IS THE SECURITY PROPERTY. `String.replace` with a function
 * never re-examines what the function returned, so a buyer registered as
 * `{{totalAmount}}` cannot pull another field's value into their own
 * notice: the substituted text is output, not input. The brace check at
 * the end then REFUSES the resulting document — so the attempt produces a
 * loud failure in front of the person sending it, rather than a notice
 * with `{{totalAmount}}` printed on it.
 *
 * ⚠️ A MISSING VALUE IS A REFUSAL TOO. See the file header: a notice with
 * a hole in it is worse than no notice.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  mode: RenderMode = "text",
): string {
  const missing: string[] = [];

  const rendered = template.replace(PLACEHOLDER, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const value = values[key];

    if (value === undefined || value === null) {
      missing.push(key);
      return "";
    }

    const clean = sanitiseValue(String(value));
    return mode === "html" ? escapeHtml(clean) : clean;
  });

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    throw new TemplateRenderError(
      `This notice cannot be produced: ${unique.map((k) => `"${k}"`).join(", ")} ` +
        `${unique.length === 1 ? "has" : "have"} no value.`,
      "⚠️ Refused rather than rendered. A demand notice that goes out reading " +
        '"the sum of {{totalAmount}} is due" is read by the buyer before it is ' +
        "read by anybody here, and it is a legal document. Fill in the missing " +
        "detail — usually the buyer's name, the unit or the project — and send it " +
        "again.",
      unique[0] ?? null,
    );
  }

  // ⚠️ DEFENSIVE, AND IT HAS EARNED ITS PLACE. A template written with
  // `{{ buyer-name }}` or `{{2ndSlab}}` does not match the placeholder
  // pattern at all, so it is not "missing" — it simply survives
  // substitution and is printed. This catches the braces themselves.
  if (/\{\{|\}\}/.test(rendered)) {
    throw new TemplateRenderError(
      "This notice still contains template braces after rendering, which means a " +
        "placeholder is written in a form the renderer does not recognise.",
      "Placeholders are {{likeThis}} — a letter, then letters, digits or " +
        "underscores. A hyphen or a leading digit is not matched, and the raw " +
        "text would have been printed on the notice.",
    );
  }

  return rendered;
}

/**
 * Render a whole notice — subject and body — with one value map.
 *
 * ⚠️ BOTH OR NEITHER. A subject that renders while the body refuses would
 * leave a queued email with a correct subject line and an empty document,
 * which is exactly the sort of half-sent notice somebody re-sends by hand
 * and duplicates.
 */
export function renderNotice(
  template: { subject: string; body: string },
  values: Readonly<Record<string, string>>,
  mode: RenderMode = "text",
): { subject: string; body: string } {
  return {
    // ⚠️ The subject is rendered in TEXT mode even for an HTML notice: an
    // email subject line is not markup, and `&amp;` in a subject is what
    // an inbox shows.
    subject: renderTemplate(template.subject, values, "text"),
    body: renderTemplate(template.body, values, mode),
  };
}

/**
 * Does this template refer only to placeholders we can supply?
 *
 * ⚠️ CHECKED AT BUILD AND IN THE TEST SUITE, NOT AT SEND TIME. A template
 * with a typo — `{{totalAmout}}` — is a template that refuses to render
 * for every buyer in every language, discovered on the last day of the
 * month by the person raising two hundred demands.
 */
export function unknownPlaceholders(
  template: string,
  known: readonly string[],
): string[] {
  const allowed = new Set(known);
  return placeholdersIn(template).filter((key) => !allowed.has(key));
}
