/**
 * Ordence — ⭐ Tally XML Construction
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic. No database, no `server-only`, no dependencies.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHY THIS IS ITS OWN FILE AND WHY IT IS THE FIRST ONE WRITTEN
 * ══════════════════════════════════════════════════════════════════════
 * Every value in a Tally export is a name somebody typed: a vendor called
 * "Shah & Sons", a project called "Phase-II <East>", a narration
 * containing an apostrophe, a ledger called "Duties & Taxes" — which is
 * TALLY'S OWN NAME FOR ONE OF ITS PRIMARY GROUPS, so the very first
 * ampersand arrives from Tally itself.
 *
 * ⚠️ WHAT HAPPENS IF ONE IS NOT ESCAPED IS THE POINT.
 *
 * `<LEDGERNAME>Shah & Sons</LEDGERNAME>` is not well-formed XML. Tally's
 * importer does not answer with a parse error against a line number. It
 * answers with one of:
 *
 *   • "0 vouchers imported" and no explanation, or
 *   • ⭐ a PARTIAL import — everything up to the bad character, then
 *     silence. The accountant sees "412 vouchers created", is satisfied,
 *     and the remaining 300 of March are simply not there.
 *
 * The second is worse than a rejection by a wide margin, because a
 * rejection is a Tuesday afternoon and a partial import is discovered at
 * the year end by a turnover figure that will not tie out.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FIVE CHARACTERS ARE NOT THE WHOLE JOB
 * ══════════════════════════════════════════════════════════════════════
 * XML 1.0 §2.2 defines the legal character set, and it EXCLUDES almost
 * every C0 control character: only tab (0x09), line feed (0x0A) and
 * carriage return (0x0D) are permitted. A NUL, a vertical tab or a 0x1B
 * escape in a name produces a document no conforming parser will accept,
 * and they get into real data constantly — a paste out of a PDF, a
 * barcode scanner, a CSV written by an accounting package from 1998.
 *
 * ⭐ SO CONTROL CHARACTERS ARE REMOVED, NOT ESCAPED. `&#x1B;` is *also*
 * illegal in XML 1.0 — the numeric reference does not rescue a character
 * that is not in the document character set, which is the mistake a
 * "just escape everything" implementation makes. There is no way to
 * carry them, so they are dropped and the removal is reported.
 *
 * ⚠️ AND THE ORDER OF THE REPLACEMENTS MATTERS. `&` MUST be replaced
 * first: escaping `<` to `&lt;` and then escaping ampersands would turn
 * it into `&amp;lt;`, and the accountant's file would contain the literal
 * text "&lt;" where a "<" was meant. Every "escape" bug in every codebase
 * is one of these two, and it is why `escapeXmlText` is a single
 * expression with a fixed order rather than a chain a future edit can
 * reorder.
 */

/* ------------------------------------------------------------------ */
/* CHARACTER LEGALITY                                                  */
/* ------------------------------------------------------------------ */

/**
 * Characters XML 1.0 forbids outright, whatever you do to them.
 *
 * C0 except tab/LF/CR, plus DEL and the C1 range (which is legal in XML
 * but arrives as mojibake often enough to be worth dropping), plus the
 * two permanently-unassigned noncharacters U+FFFE and U+FFFF, plus lone
 * surrogates — which `String` allows and UTF-8 cannot encode.
 */
const FORBIDDEN_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type SanitiseResult = {
  value: string;
  /** How many characters had to be dropped. Zero is the normal case. */
  removed: number;
};

/**
 * ⭐ Remove what XML cannot carry, and say how much was removed.
 *
 * ⚠️ THE COUNT IS RETURNED RATHER THAN LOGGED because the caller is the
 * one that knows whose name it was. "Removed 1 illegal character from a
 * ledger name" is a warning nobody can act on; "the vendor ledger
 * 'Sahyadri Cement' contained a control character, which has been
 * removed" is one they can.
 */
export function sanitiseXmlText(raw: unknown): SanitiseResult {
  const asString = raw === null || raw === undefined ? "" : String(raw);
  let removed = 0;
  const value = asString.replace(FORBIDDEN_XML_CHARS, () => {
    removed += 1;
    return "";
  });
  return { value, removed };
}

/** True when a string can be carried by XML at all. */
export function isXmlSafe(raw: string): boolean {
  return sanitiseXmlText(raw).removed === 0;
}

/* ------------------------------------------------------------------ */
/* ⭐ ESCAPING                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Escape a value for XML TEXT content.
 *
 * ⚠️ `>` IS ESCAPED EVEN THOUGH IT IS ONLY STRICTLY REQUIRED IN THE
 * SEQUENCE `]]>`. Escaping it unconditionally costs three bytes and
 * removes an entire class of "it worked until somebody wrote `]]>` in a
 * narration" — which is not hypothetical: `]]>` appears in pasted code
 * snippets and in badly-escaped data that has already been through
 * another system.
 *
 * ⚠️ AND THE QUOTES ARE ESCAPED IN TEXT TOO, not only in attributes.
 * They do not have to be. They are, because the alternative is two
 * functions whose difference is invisible at the call site, and the day
 * somebody uses the text one for an attribute is the day a party name
 * containing `"` closes the attribute early and produces XML that parses
 * into something completely different.
 */
export function escapeXmlText(raw: unknown): string {
  const { value } = sanitiseXmlText(raw);
  // ⚠️ THE ORDER IS LOAD-BEARING. `&` first, always. See the header.
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape for an attribute value. Identical to the text escaper by
 * deliberate choice — see the note above. Kept as a separate NAME so a
 * reader at the call site can see which context was intended.
 */
export function escapeXmlAttribute(raw: unknown): string {
  return escapeXmlText(raw);
}

/**
 * ⭐ Decode the entities Tally's own exports contain.
 *
 * ⚠️ THIS IS THE OTHER HALF OF THE ROUND TRIP AND IT IS EASY TO GET
 * SUBTLY WRONG. `&amp;lt;` must decode to the literal text `&lt;`, NOT to
 * `<` — one pass, left to right, never repeated. A decoder that loops
 * until nothing changes turns a vendor genuinely named "A&amp;B" into
 * "A&B" on the first pass and then does nothing further, which is right;
 * but the same loop turns the ESCAPED form of "A&lt;B" into "A<B", which
 * is a value the source never contained. Single pass, and the test
 * round-trips a name containing every one of them.
 */
export function decodeXmlEntities(raw: string): string {
  return raw.replace(
    /&(?:amp|lt|gt|quot|apos|#(\d+)|#[xX]([0-9a-fA-F]+));/g,
    (match, decimal?: string, hex?: string) => {
      if (decimal !== undefined) {
        return codePointOrEmpty(Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return codePointOrEmpty(Number.parseInt(hex, 16));
      }
      switch (match) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default:
          return match;
      }
    },
  );
}

/**
 * ⚠️ A NUMERIC REFERENCE TO AN ILLEGAL CHARACTER IS DROPPED, NOT
 * DECODED. `&#0;` is not a legal XML 1.0 document to begin with; turning
 * it into a NUL would put a character into our database that we would
 * then be unable to export again.
 */
function codePointOrEmpty(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  const char = String.fromCodePoint(code);
  return sanitiseXmlText(char).value;
}

/* ------------------------------------------------------------------ */
/* NODES                                                               */
/* ------------------------------------------------------------------ */

/**
 * A node in the document.
 *
 * ⚠️ `text` AND `children` ARE MUTUALLY EXCLUSIVE BY CONVENTION and the
 * renderer prefers `children`. Tally's format never mixes them, and a
 * builder that produced both would be describing a document Tally cannot
 * read.
 */
export type TallyXmlNode = {
  tag: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  text?: string | null;
  children?: TallyXmlNode[];
  /**
   * ⭐ Emit the tag even when the text is empty.
   *
   * ⚠️ NOT THE SAME AS OMITTING IT. Tally treats an ABSENT
   * `<NARRATION>` as "leave whatever is there" on an ALTER and an EMPTY
   * one as "clear it" — so the difference between the two decides
   * whether re-exporting a voucher whose narration was deleted actually
   * deletes it in Tally, or silently keeps the old text forever.
   */
  keepEmpty?: boolean;
};

/** Convenience constructor for a leaf. Returns null when there is nothing to say. */
export function leaf(
  tag: string,
  value: string | number | null | undefined,
  options?: { keepEmpty?: boolean },
): TallyXmlNode | null {
  if (value === null || value === undefined) {
    return options?.keepEmpty ? { tag, text: "", keepEmpty: true } : null;
  }
  const text = String(value);
  if (text.length === 0 && !options?.keepEmpty) return null;
  return { tag, text, keepEmpty: options?.keepEmpty };
}

/** Drop the nulls a chain of `leaf()` calls produces. */
export function compact(nodes: Array<TallyXmlNode | null | undefined>): TallyXmlNode[] {
  return nodes.filter((n): n is TallyXmlNode => n !== null && n !== undefined);
}

/* ------------------------------------------------------------------ */
/* RENDERING                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ TALLY'S TAG NAMES ARE UPPER-CASE AND CONTAIN DOTS —
 * `ALLLEDGERENTRIES.LIST`, `BILLALLOCATIONS.LIST`. A dot is a legal XML
 * name character, but a tag name is NOT escaped by anything here, so it
 * is validated instead: a tag built from user input would be an
 * injection point that no amount of text escaping would close.
 */
const VALID_TAG = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export class InvalidXmlTagError extends Error {
  constructor(tag: string) {
    super(
      `"${tag}" is not a usable XML tag name. Tag names are built by this ` +
        `codebase and never from data — a tag taken from user input would be an ` +
        `injection point that escaping the TEXT does nothing about.`,
    );
    this.name = "InvalidXmlTagError";
  }
}

export type RenderOptions = {
  /** Two spaces per level. Off produces the smallest file. */
  indent?: boolean;
};

export function renderNode(
  node: TallyXmlNode,
  options: RenderOptions = {},
  depth = 0,
): string {
  if (!VALID_TAG.test(node.tag)) throw new InvalidXmlTagError(node.tag);

  const pad = options.indent ? "  ".repeat(depth) : "";
  const eol = options.indent ? "\n" : "";
  const attrs = renderAttributes(node.attrs);

  const children = node.children ?? [];
  if (children.length > 0) {
    const inner = children
      .map((child) => renderNode(child, options, depth + 1))
      .join(eol);
    return `${pad}<${node.tag}${attrs}>${eol}${inner}${eol}${pad}</${node.tag}>`;
  }

  const text = node.text ?? "";
  if (text.length === 0 && !node.keepEmpty) {
    // ⚠️ A self-closing tag. Tally accepts it, and it is not the same as
    // an empty pair — see `keepEmpty` on the node type.
    return `${pad}<${node.tag}${attrs}/>`;
  }
  return `${pad}<${node.tag}${attrs}>${escapeXmlText(text)}</${node.tag}>`;
}

function renderAttributes(
  attrs: TallyXmlNode["attrs"],
): string {
  if (!attrs) return "";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (!VALID_TAG.test(name)) throw new InvalidXmlTagError(name);
    parts.push(` ${name}="${escapeXmlAttribute(value)}"`);
  }
  return parts.join("");
}

/**
 * ⭐ The document, with its declaration.
 *
 * ⚠️ UTF-8, DECLARED. Tally's own exports are frequently ISO-8859-1 and
 * its importer honours the declaration, so declaring the encoding we
 * actually emit is what makes a Devanagari project name or a ₹ sign in a
 * narration survive the trip. An undeclared file is read as the machine's
 * default codepage, which on an accounts-room Windows desktop is not
 * UTF-8 and produces names full of question marks — cosmetic-looking,
 * and it forks the ledger master on the next import because the name no
 * longer matches.
 */
export function renderDocument(root: TallyXmlNode, options: RenderOptions = {}): string {
  const body = renderNode(root, options, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>${options.indent ? "\n" : ""}${body}`;
}
