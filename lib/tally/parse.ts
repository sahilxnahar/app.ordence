/**
 * Ordence — ⭐ Reading Tally's Own XML
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic. No dependencies — deliberately.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A HAND-WRITTEN PARSER RATHER THAN AN XML LIBRARY
 * ══════════════════════════════════════════════════════════════════════
 * Two reasons, and the second is the real one.
 *
 *   1. This file eats a document a customer uploaded. A general XML
 *      parser is a general XML parser: it resolves DOCTYPEs, expands
 *      entities and — depending on configuration nobody audits — reads
 *      files off the server. XXE and the billion-laughs expansion are
 *      both attacks on the PARSER, not on the application, and the
 *      cheapest way not to have them is not to have a general parser.
 *      ⭐ Nothing below ever expands a custom entity, follows a DOCTYPE
 *      or looks at anything outside the string it was given.
 *
 *   2. ⚠️ TALLY'S OUTPUT IS NOT ALWAYS WELL-FORMED. Its exports carry
 *      raw `&` in narrations on several builds, `&#4;` field separators
 *      inside names, and occasionally an unclosed tag at the end of a
 *      truncated export. A strict parser refuses the whole document; the
 *      accountant is then told their file is invalid, which is true and
 *      completely useless. This one recovers, records what it could not
 *      read in `warnings`, and reconciles what it could.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT A GENERAL XML PARSER. It handles the
 * subset Tally emits: elements, text, attributes, CDATA and comments. It
 * does not do namespaces, processing instructions beyond the declaration,
 * or mixed content. Anything else is skipped and reported rather than
 * guessed at.
 */

import { decodeXmlEntities } from "./xml";
import { fromTallyDate, parseTallyAmount } from "./amounts";

/* ------------------------------------------------------------------ */
/* THE TREE                                                            */
/* ------------------------------------------------------------------ */

export type ParsedNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: ParsedNode[];
};

export type ParseWarning = {
  code: string;
  message: string;
  detail?: string;
};

export type ParseResult = {
  root: ParsedNode | null;
  warnings: ParseWarning[];
};

/**
 * ⚠️ A BUDGET, NOT AN ASSUMPTION. A ten-megabyte day book from a busy
 * company is normal; a hundred-megabyte one is somebody's whole history
 * and will take the request down. The limit is enforced by the caller
 * (`server/tally/importer.ts`); this depth limit is the parser's own
 * protection against a pathological nesting that would otherwise blow the
 * stack — except it does not recurse, so it simply refuses to go deeper.
 */
const MAX_DEPTH = 64;

/**
 * ⭐ ITERATIVE, NOT RECURSIVE. A recursive descent parser on attacker-
 * supplied nesting is a stack overflow, which in Node is a process
 * crash and not a catchable error.
 */
export function parseXml(source: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const stack: ParsedNode[] = [];
  let root: ParsedNode | null = null;

  let index = 0;
  const length = source.length;

  while (index < length) {
    const open = source.indexOf("<", index);

    if (open === -1) {
      appendText(stack, source.slice(index));
      break;
    }

    if (open > index) appendText(stack, source.slice(index, open));

    /* --- ⚠️ The constructs that are SKIPPED, not honoured. -------- */

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      index = end === -1 ? length : end + 3;
      continue;
    }

    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const raw = source.slice(open + 9, end === -1 ? length : end);
      // ⚠️ CDATA is NOT entity-decoded. `&amp;` inside CDATA is the
      // literal five characters, and decoding it would corrupt a vendor
      // genuinely called "A&amp;B Traders" — which is what a firm that
      // has already been through one bad integration is called.
      appendRawText(stack, raw);
      index = end === -1 ? length : end + 3;
      continue;
    }

    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open);
      index = end === -1 ? length : end + 2;
      continue;
    }

    if (source.startsWith("<!", open)) {
      // ⭐ A DOCTYPE. SKIPPED ENTIRELY AND NEVER PROCESSED. This is the
      // XXE defence: no external entity is fetched because no DOCTYPE is
      // read. An internal subset defining entities is likewise ignored,
      // so a billion-laughs bomb expands to nothing.
      if (/^<!DOCTYPE/i.test(source.slice(open, open + 9))) {
        warnings.push({
          code: "doctype_ignored",
          message:
            "The file declares a DOCTYPE, which has been ignored. Custom " +
            "entities are never expanded — an XML file that needs them to be " +
            "read is a file that can read this server's own disk.",
        });
      }
      const end = source.indexOf(">", open);
      index = end === -1 ? length : end + 1;
      continue;
    }

    /* --- A closing tag ------------------------------------------- */

    if (source.startsWith("</", open)) {
      const end = source.indexOf(">", open);
      if (end === -1) {
        warnings.push({
          code: "unterminated_close",
          message: "A closing tag runs off the end of the file. The file is truncated.",
        });
        break;
      }
      const name = source.slice(open + 2, end).trim();
      const top = stack[stack.length - 1];
      if (!top) {
        warnings.push({
          code: "stray_close",
          message: `A </${name}> appears with nothing open.`,
        });
      } else if (top.tag !== name) {
        /**
         * ⚠️ MISMATCHED TAGS ARE UNWOUND, NOT REFUSED. Tally truncates
         * an export when a report times out, which leaves exactly this.
         * Unwinding to the matching ancestor keeps every complete voucher
         * before the break — and the vouchers before the break are the
         * ones the reconciliation needs.
         */
        const depth = findOpenIndex(stack, name);
        if (depth === -1) {
          warnings.push({
            code: "unmatched_close",
            message: `A </${name}> does not match any open element and was ignored.`,
          });
        } else {
          warnings.push({
            code: "implicit_close",
            message:
              `<${top.tag}> was still open when </${name}> arrived — the file is ` +
              `not well-formed and has been recovered by closing it. Anything ` +
              `inside it may be incomplete.`,
          });
          stack.length = depth;
        }
      } else {
        stack.pop();
      }
      index = end + 1;
      continue;
    }

    /* --- An opening tag ------------------------------------------ */

    const end = findTagEnd(source, open);
    if (end === -1) {
      warnings.push({
        code: "unterminated_open",
        message: "An opening tag runs off the end of the file. The file is truncated.",
      });
      break;
    }

    const rawTag = source.slice(open + 1, end);
    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const parsed = parseTag(body);

    if (!parsed) {
      warnings.push({
        code: "unreadable_tag",
        message: "An element could not be read and was skipped.",
        detail: rawTag.slice(0, 80),
      });
      index = end + 1;
      continue;
    }

    const node: ParsedNode = {
      tag: parsed.name,
      attrs: parsed.attrs,
      text: "",
      children: [],
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    // ⚠️ A second root element is not an error worth refusing over —
    // some Tally exports concatenate two envelopes. It is recorded and
    // attached to the first, so nothing is silently dropped.
    else {
      root.children.push(node);
      warnings.push({
        code: "multiple_roots",
        message:
          "The file contains more than one top-level element — usually two " +
          "concatenated exports. They have been read as one.",
      });
    }

    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) {
        warnings.push({
          code: "too_deep",
          message:
            `The file nests more than ${MAX_DEPTH} levels deep, which no Tally ` +
            `export does. The remainder has not been read.`,
        });
        break;
      }
      stack.push(node);
    }

    index = end + 1;
  }

  if (stack.length > 0) {
    warnings.push({
      code: "unclosed_elements",
      message:
        `${stack.length} element(s) were never closed. The file is truncated — ` +
        `Tally does this when a report times out mid-export. Everything before ` +
        `the break has been read.`,
    });
  }

  return { root, warnings };
}

function appendText(stack: ParsedNode[], raw: string): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (raw.trim().length === 0 && top.children.length > 0) return;
  top.text += decodeXmlEntities(raw);
}

function appendRawText(stack: ParsedNode[], raw: string): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  top.text += raw;
}

function findOpenIndex(stack: ParsedNode[], name: string): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.tag === name) return i;
  }
  return -1;
}

/**
 * ⚠️ THE `>` INSIDE AN ATTRIBUTE VALUE IS WHY THIS IS NOT `indexOf(">")`.
 * `<LEDGER NAME="A > B">` is legal XML and a naive scan cuts the tag in
 * half — producing an element named `LEDGER NAME="A ` and losing the
 * ledger entirely.
 */
function findTagEnd(source: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i;
  }
  return -1;
}

const TAG_NAME = /^([A-Za-z_][A-Za-z0-9_.:-]*)/;
const ATTRIBUTE = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseTag(body: string): { name: string; attrs: Record<string, string> } | null {
  const nameMatch = TAG_NAME.exec(body.trim());
  if (!nameMatch) return null;
  const name = nameMatch[1] ?? "";

  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(body)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? "";
    if (key) attrs[key.toUpperCase()] = decodeXmlEntities(value);
  }

  return { name: name.toUpperCase(), attrs };
}

/* ------------------------------------------------------------------ */
/* NAVIGATION                                                          */
/* ------------------------------------------------------------------ */

/** Every descendant with this tag, in document order. */
export function findAll(node: ParsedNode | null, tag: string): ParsedNode[] {
  if (!node) return [];
  const wanted = tag.toUpperCase();
  const found: ParsedNode[] = [];
  const queue: ParsedNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.tag === wanted) found.push(current);
    queue.push(...current.children);
  }
  return found;
}

/** The first DIRECT child with this tag. */
export function child(node: ParsedNode, tag: string): ParsedNode | null {
  const wanted = tag.toUpperCase();
  return node.children.find((c) => c.tag === wanted) ?? null;
}

export function childText(node: ParsedNode, tag: string): string | null {
  const found = child(node, tag);
  if (!found) return null;
  const value = found.text.trim();
  return value.length === 0 ? null : value;
}

/* ------------------------------------------------------------------ */
/* ⭐ TALLY VOUCHERS                                                    */
/* ------------------------------------------------------------------ */

export type ParsedTallyLeg = {
  ledgerName: string;
  isDebit: boolean;
  /** Paise, unsigned. The sign Tally sent has been converted to a direction. */
  amountMinor: bigint;
};

export type ParsedTallyVoucher = {
  /** ⭐ Ours if we exported it; absent for a voucher posted in Tally. */
  remoteId: string | null;
  /** Tally's own alter key. Theirs. */
  voucherKey: string | null;
  voucherType: string;
  voucherNumber: string | null;
  /** ISO `YYYY-MM-DD`, or null when their date could not be read. */
  voucherDate: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  isCancelled: boolean;
  legs: ParsedTallyLeg[];
  /** Sum of the debit legs. Equal to the credits on any voucher Tally holds. */
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
};

export type ParsedTallyExport = {
  companyName: string | null;
  vouchers: ParsedTallyVoucher[];
  warnings: ParseWarning[];
};

/**
 * ⭐ Read a Tally day-book export.
 *
 * ⚠️ A VOUCHER THAT CANNOT BE READ BECOMES A WARNING, NOT AN EXCEPTION.
 * Dropping the whole file because one voucher of two thousand has an
 * unreadable date turns a reconciliation into a support ticket. Reading
 * 1,999 and naming the one is a reconciliation with a footnote.
 */
export function parseTallyExport(source: string): ParsedTallyExport {
  const { root, warnings } = parseXml(source);
  const vouchers: ParsedTallyVoucher[] = [];

  const companyName =
    (root ? findAll(root, "SVCURRENTCOMPANY")[0]?.text.trim() : null) ||
    (root ? findAll(root, "CMPNAME")[0]?.text.trim() : null) ||
    null;

  for (const node of findAll(root, "VOUCHER")) {
    const parsed = readVoucher(node, warnings);
    if (parsed) vouchers.push(parsed);
  }

  return { companyName: companyName || null, vouchers, warnings };
}

function readVoucher(
  node: ParsedNode,
  warnings: ParseWarning[],
): ParsedTallyVoucher | null {
  const voucherNumber = childText(node, "VOUCHERNUMBER");
  const rawDate = childText(node, "DATE");
  const voucherDate = rawDate ? fromTallyDate(rawDate) : null;

  if (rawDate && !voucherDate) {
    warnings.push({
      code: "unreadable_date",
      message:
        `The date on voucher ${voucherNumber ?? "(unnumbered)"} could not be ` +
        `read. It has been kept without one, so it will reconcile on its ` +
        `reference and not on its date.`,
      detail: rawDate,
    });
  }

  const legs: ParsedTallyLeg[] = [];
  let totalDebitMinor = 0n;
  let totalCreditMinor = 0n;

  /**
   * 🔴 BOTH ELEMENTS. Tally writes `LEDGERENTRIES.LIST` for some voucher
   * classes, and reading only `ALLLEDGERENTRIES.LIST` gave those vouchers
   * `legs: []`, `totalDebitMinor: 0n`, `totalCreditMinor: 0n` , and ZERO
   * EQUALS ZERO, so they read as perfectly balanced everywhere downstream.
   *
   * ⚠️ THAT IS WHY NOTHING CAUGHT IT. A voucher with no legs passes every
   * balance check there is; the ledger view simply returned a header row
   * and nothing else for such a file. Found by Phase 9, whose new
   * allocation views read both elements and could see the discrepancy.
   *
   * ⚠️ `findAll` IS A DESCENDANT WALK, so these two names must not nest.
   * They do not in any export seen. If a future one does, this loop
   * double-counts, and the answer then is a `seen` set keyed on the node ,
   * not now, when it would be a guard against nothing.
   */
  for (const element of ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"] as const)
  for (const entry of findAll(node, element)) {
    const ledgerName = childText(entry, "LEDGERNAME");
    const rawAmount = childText(entry, "AMOUNT");
    if (!ledgerName || !rawAmount) continue;

    let signed: bigint;
    try {
      signed = parseTallyAmount(rawAmount);
    } catch (err) {
      warnings.push({
        code: "unreadable_amount",
        message:
          `An amount on voucher ${voucherNumber ?? "(unnumbered)"} could not be ` +
          `read and has been left out of the totals. The reconciliation will ` +
          `report this voucher as differing.`,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    /**
     * ⭐⭐ TALLY'S SIGN, TURNED BACK INTO A DIRECTION.
     *
     * ⚠️ A NEGATIVE AMOUNT IS A DEBIT. `ISDEEMEDPOSITIVE` says the same
     * thing and is present on most builds — but not all, and not on
     * hand-edited files. The SIGN is authoritative and the flag is the
     * fallback, because the sign is what Tally's own totals are computed
     * from.
     */
    const flag = childText(entry, "ISDEEMEDPOSITIVE");
    const isDebit = signed !== 0n ? signed < 0n : flag?.toLowerCase() === "yes";
    const amountMinor = signed < 0n ? -signed : signed;

    legs.push({ ledgerName, isDebit, amountMinor });
    if (isDebit) totalDebitMinor += amountMinor;
    else totalCreditMinor += amountMinor;
  }

  return {
    remoteId: node.attrs.REMOTEID ?? childText(node, "REMOTEID"),
    voucherKey: node.attrs.VCHKEY ?? childText(node, "VOUCHERKEY"),
    voucherType:
      node.attrs.VCHTYPE ?? childText(node, "VOUCHERTYPENAME") ?? "Unknown",
    voucherNumber,
    voucherDate,
    partyLedgerName:
      childText(node, "PARTYLEDGERNAME") ?? childText(node, "PARTYNAME"),
    narration: childText(node, "NARRATION"),
    isCancelled: (childText(node, "ISCANCELLED") ?? "No").toLowerCase() === "yes",
    legs,
    totalDebitMinor,
    totalCreditMinor,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ TALLY'S IMPORT RESPONSE                                           */
/* ------------------------------------------------------------------ */

export type TallyImportResponse = {
  created: number | null;
  altered: number | null;
  ignored: number | null;
  errors: number | null;
  lastVoucherId: string | null;
  /** Any `<LINEERROR>` Tally reported. The only thing that names WHAT failed. */
  lineErrors: string[];
};

/**
 * ⭐ READ WHAT TALLY SAID, WHICH IS NOT AN HTTP STATUS.
 *
 * ⚠️ A TALLY IMPORT THAT FAILED COMPLETELY RETURNS HTTP 200. The socket
 * is happy; the import is not. The counts inside the response body are
 * the only truth, and "CREATED 0 / ERRORS 0" is a perfectly cheerful
 * response that imported nothing at all — usually because the company
 * name did not match any open company.
 */
export function parseImportResponse(source: string): TallyImportResponse {
  const { root } = parseXml(source);
  const number = (tag: string): number | null => {
    const found = root ? findAll(root, tag)[0] : null;
    if (!found) return null;
    const value = Number.parseInt(found.text.trim(), 10);
    return Number.isFinite(value) ? value : null;
  };

  return {
    created: number("CREATED"),
    altered: number("ALTERED"),
    ignored: number("IGNORED"),
    errors: number("ERRORS"),
    lastVoucherId: (root ? findAll(root, "LASTVCHID")[0]?.text.trim() : null) ?? null,
    lineErrors: findAll(root, "LINEERROR")
      .map((n) => n.text.trim())
      .filter((t) => t.length > 0),
  };
}
