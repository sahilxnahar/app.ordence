/**
 * Ordence — ⭐ XML TEXT, AND THE CHARACTERS THAT ARE NOT ALLOWED TO EXIST
 * Version: v1.73.0-alpha - Wave 5
 *
 * =======================================================================
 * 🔴 THE BUG THIS PREVENTS IS NOT "&" — IT IS 0x00 THROUGH 0x1F
 * =======================================================================
 * Every XML writer escapes `&`, `<` and `>`. Almost none strip the C0
 * control characters, and XML 1.0 s 2.2 forbids all of them except TAB,
 * LF and CR. One 0x1F pasted into a customer note - and pasted data
 * carries them routinely, out of PDFs, out of Word, off a POS terminal -
 * produces an XLSX or a DOCX that opens as "the file is corrupt and
 * cannot be repaired". The whole export, not the one cell.
 *
 * ⚠️ AND THE SURROGATE HALVES DO THE SAME. A lone high surrogate, which is
 * what you get when text was truncated by BYTE length through an emoji or
 * a Devanagari conjunct, is not a character at all.
 *
 * ⭐ SO THIS STRIPS THEM AND COUNTS THEM. The count reaches the export
 * notes: a cell that lost an invisible control byte is fine, and a
 * customer whose file silently differs from their screen is owed the
 * sentence.
 *
 * =======================================================================
 * ⚠️ WHY THE COUNTER IS AN OBJECT AND NOT A MODULE VARIABLE
 * =======================================================================
 * A module-level `let stripped = 0` is shared by every request in the
 * same Node process. Two exports running concurrently would report each
 * other's counts, and the note on a clean file would say characters were
 * removed from it. One escaper per render; no shared state.
 */

/**
 * XML 1.0 s 2.2: everything below 0x20 except TAB (09), LF (0A) and CR
 * (0D); the two permanently unassigned code points; and unpaired
 * surrogates.
 */
const ILLEGAL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export class XmlEscaper {
  /** How many code points were removed as unrepresentable. */
  stripped = 0;

  text(value: string): string {
    const cleaned = value.replace(ILLEGAL, () => {
      this.stripped += 1;
      return "";
    });
    return cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Attribute values additionally need the quote and a literal CR escaped. */
  attr(value: string): string {
    return this.text(value).replace(/"/g, "&quot;").replace(/\r/g, "&#13;");
  }

  /** The sentence for the export notes, or null when nothing was removed. */
  note(): string | null {
    if (this.stripped === 0) return null;
    return (
      `${this.stripped} character${this.stripped === 1 ? "" : "s"} could not be represented in ` +
      `this format and ${this.stripped === 1 ? "was" : "were"} removed. These are control ` +
      `characters that carry no meaning and usually arrive with pasted text; leaving them in ` +
      `produces a file that will not open at all.`
    );
  }
}
