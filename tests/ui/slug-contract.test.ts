/**
 * Ordence — ⭐⭐⭐ THE SLUG CONTRACT (the anti-drift test)
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE TEST THAT MAKES THE REFACTOR HOLD
 * ══════════════════════════════════════════════════════════════════════
 * `lib/slug.ts` and `SQL-FILES/0091_slug_authority.sql` state the same
 * three rules twice, in two languages, and the whole point of 0091 was
 * that the previous two statements of the reserved list had drifted by
 * eight names in each direction — silently, for as long as nobody
 * happened to provision one of them.
 *
 * ⚠️ THE FIX WAS NEVER "KEEP THEM IN SYNC". Discipline is what produced
 *    the drift. The fix is that a divergence FAILS SOMETHING. This file
 *    is that something, and it asserts the three statements that would
 *    each be silent if wrong:
 *
 *      1. the reserved list      — set equality, BOTH directions
 *      2. the shape              — SLUG_PATTERN vs `tenants_slug_shape`
 *      3. the confusable fold    — foldSlug() vs the generated column
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE SQL IS PARSED STATEMENT BY STATEMENT AND NOT WITH A REGEX
 *    OVER THE WHOLE FILE
 * ══════════════════════════════════════════════════════════════════════
 * A drift guard elsewhere in this project matched `ALTER TABLE` and
 * `ADD COLUMN` independently across the whole text and cheerfully
 * reported a column on the wrong table, because the two fragments it
 * matched came from two different statements. A regex over a file has no
 * idea where one statement stops.
 *
 * So `statementsOf()` below is a real (small) lexer: it understands line
 * comments, block comments, single-quoted literals with '' escaping,
 * quoted identifiers and — the one that actually matters here —
 * dollar-quoted bodies, because every `DO $$ ... $$` block in 0091 is
 * full of semicolons that are not statement boundaries. Each assertion
 * then names the ONE statement it is about and fails if there is not
 * exactly one.
 *
 * ⚠️ AND WHY COMMENTS ARE STRIPPED. 0091's header quotes the very
 *    expressions asserted here. An earlier guard in this project matched
 *    its own warning text and passed while the code beneath it was wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE REAL BUG THE FOLD SECTION EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * The first version of the migration wrote `translate(x, '01l', 'oli')`,
 * mapping `1` to `l` instead of to `i`. It looked right and it read
 * right, and under it `zedbui1ders` and `zedbuilders` fold to DIFFERENT
 * strings — so the impostor walked straight past
 * `tenants_slug_fold_unique` and would have held a certificate one glyph
 * away from a real customer's.
 *
 * ⭐ SO THE FOLD IS NOT COMPARED AS TEXT. The SQL expression is EXTRACTED
 *    from 0091 and EXECUTED — by a tiny interpreter for the two functions
 *    it uses, with PostgreSQL's own semantics — over a table of inputs,
 *    and the result is compared against `foldSlug()`. Reintroducing
 *    'oli' changes what the interpreter computes and the two stop
 *    agreeing. Changing `foldSlug()` alone does the same.
 *
 *    The expected values in `FOLD_ORACLE` were captured by running that
 *    same expression against a real PostgreSQL 16.13 (a throwaway
 *    cluster in /tmp, never Neon), so a mistake made identically in the
 *    interpreter AND in `foldSlug()` cannot cancel out.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RESERVED_SLUGS, SLUG_PATTERN, foldSlug, reservedCategory } from "@/lib/slug";

const SQL_DIR = join(__dirname, "..", "..", "SQL-FILES");

/**
 * ⚠️ THE RESERVED LIST IS SEEDED ACROSS MORE THAN ONE MIGRATION, AND READING
 *    ONLY 0091 WOULD MAKE THIS TEST LIE IN THE MOST EXPENSIVE DIRECTION.
 *
 * `0091` seeded 71 names from first principles. `0092` added `clkmail`, `clk`
 * and `clk2` after reading the actual DNS zone, and more will follow: 0091's
 * own header says the list is a TABLE precisely so it can grow by INSERT
 * rather than by ALTER.
 *
 * If this file kept reading 0091 alone, then the day someone correctly added
 * a name to `lib/slug.ts` and to a new migration, the comparison below would
 * report the TypeScript side as having a name "0091 does not seed" and fail a
 * change that was right. A test that fails on correct work gets deleted, and
 * then nothing catches the drift it existed for.
 *
 * ⭐ So: every migration that seeds `reserved_slugs` is read, in numeric
 *    order, and the union is compared.
 *
 * ⭐ AND THIS MAKES THE SHAPE AND FOLD ASSERTIONS STRICTLY STRONGER, NOT
 *    WEAKER. `theOneStatement()` now demands exactly one definition of
 *    `tenants_slug_shape` and one of the fold expression ACROSS EVERY
 *    MIGRATION, not merely within 0091. A later file that redefined either
 *    one — the exact way the two reserved lists came to disagree — now fails
 *    here instead of shipping.
 */
const SEED_FILES = readdirSync(SQL_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .filter((f) => /INSERT\s+INTO\s+public\.reserved_slugs/i.test(readFileSync(join(SQL_DIR, f), "utf8")));

const SOURCE = SEED_FILES.map((f) => readFileSync(join(SQL_DIR, f), "utf8")).join("\n\n");

/* ================================================================== */
/* A VERY SMALL SQL LEXER                                              */
/* ================================================================== */

/**
 * Split `source` into top-level statements, with comments removed and
 * string literals preserved byte for byte.
 *
 * ⚠️ Dollar quoting is the reason this exists. `DO $$ BEGIN ... ; ... END $$;`
 *    is ONE statement containing several semicolons, and a naive
 *    `split(";")` shreds it into fragments that then match each other's
 *    keywords.
 */
function statementsOf(source: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = source.length;
  const dollarTag = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;

  const flush = () => {
    const trimmed = buf.replace(/\s+/g, " ").trim();
    if (trimmed) out.push(trimmed);
    buf = "";
  };

  while (i < n) {
    const ch = source[i];
    const two = source.slice(i, i + 2);

    if (two === "--") {
      while (i < n && source[i] !== "\n") i += 1;
      buf += " ";
      continue;
    }

    if (two === "/*") {
      let depth = 0;
      while (i < n) {
        if (source.slice(i, i + 2) === "/*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (source.slice(i, i + 2) === "*/") {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      buf += " ";
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += quote;
      i += 1;
      while (i < n) {
        if (source[i] === quote && source[i + 1] === quote) {
          buf += quote + quote;
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          buf += quote;
          i += 1;
          break;
        }
        buf += source[i];
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      dollarTag.lastIndex = i;
      const tag = dollarTag.exec(source)?.[0];
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += source.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ";") {
      flush();
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

const STATEMENTS = statementsOf(SOURCE);

/** The statements matching `pattern`. Every assertion names exactly one. */
function statementsMatching(pattern: RegExp): string[] {
  return STATEMENTS.filter((s) => pattern.test(s));
}

/**
 * The single statement matching `pattern`.
 *
 * ⚠️ It THROWS on zero or on more than one, rather than taking the first.
 *    "The first statement that mentions slug_fold" is how a guard ends up
 *    asserting something true about a statement it was not asked about.
 */
function theOneStatement(pattern: RegExp, what: string): string {
  const hits = statementsMatching(pattern);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one statement for ${what}, found ${hits.length}. ` +
        `A second one means the rule is stated twice and one copy can drift.`,
    );
  }
  return hits[0];
}

/** Undo SQL's '' escaping inside a single-quoted literal. */
const unquote = (literal: string) => literal.replace(/''/g, "'");

/** The substring between `open` and its matching close paren, starting at `from`. */
function balanced(text: string, from: number): string {
  const open = text.indexOf("(", from);
  if (open === -1) throw new Error("no opening parenthesis");
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'" && text[i + 1] === "'") i += 1;
      else if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced parentheses");
}

/* ================================================================== */
/* 1. THE RESERVED LIST                                                */
/* ================================================================== */

/**
 * Every slug seeded into `reserved_slugs`, read out of the INSERT
 * statements themselves.
 *
 * ⚠️ THE COLUMN LIST IS CHECKED, NOT ASSUMED. Taking "the first value in
 *    each tuple" is only the slug for as long as the column list starts
 *    with `slug`. If someone reorders it, this must fail rather than
 *    quietly start comparing category names.
 */
/**
 * ⚠️ THE SEEDS MOVED INSIDE `DO $seed$ ... $seed$;` BLOCKS AND THIS PARSER HAD
 *    TO FOLLOW THEM. `0091`'s seed INSERTs are wrapped so they can set
 *    `app.platform_scope` in the same statement, because on a RE-RUN the table
 *    already has FORCE ROW LEVEL SECURITY and a bare INSERT is refused.
 *
 * ⭐ WHEN THAT HAPPENED, THIS FILE FAILED RATHER THAN PASSING VACUOUSLY, which
 *    is the whole reason the "finds the seeding statements at all" guard
 *    exists. `statementsOf()` treats a dollar-quoted body as opaque (correctly
 *    , it is full of semicolons that are not statement boundaries), so the
 *    top-level scan found ZERO INSERTs. An empty parse compared against an
 *    empty set would have reported perfect agreement between 71 TypeScript
 *    names and nothing at all.
 *
 * So: scan top-level statements, and ALSO scan inside every dollar-quoted
 * body. A seed is a seed wherever it is written.
 */
function dollarQuotedBodies(source: string): string[] {
  const out: string[] = [];
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source)) !== null) {
    const tag = m[0];
    const close = source.indexOf(tag, m.index + tag.length);
    if (close === -1) break;
    out.push(source.slice(m.index + tag.length, close));
    open.lastIndex = close + tag.length;
  }
  return out;
}

function seededReservedSlugs(): { slugs: string[]; statements: number } {
  const nested = dollarQuotedBodies(SOURCE)
    .flatMap((body) => statementsOf(body))
    .filter((st) => /^INSERT\s+INTO\s+public\.reserved_slugs\b/i.test(st));

  const inserts = [
    ...statementsMatching(/^INSERT\s+INTO\s+public\.reserved_slugs\b/i),
    ...nested,
  ];
  const slugs: string[] = [];

  for (const statement of inserts) {
    const columns = balanced(statement, statement.search(/reserved_slugs/i))
      .split(",")
      .map((c) => c.trim().toLowerCase());
    if (columns[0] !== "slug") {
      throw new Error(
        `reserved_slugs INSERT does not start with the slug column (got ${columns[0]}). ` +
          `This parser reads the first value of every tuple as the slug.`,
      );
    }

    const valuesAt = statement.search(/\bVALUES\b/i);
    if (valuesAt === -1) throw new Error("reserved_slugs INSERT with no VALUES clause");

    /**
     * ⚠️ THE TUPLE LIST ENDS AT `ON CONFLICT`, AND THAT IS NOT PEDANTRY.
     *    `ON CONFLICT (slug) DO NOTHING` is a parenthesised group too. A
     *    scanner that just walks to the end of the statement reads it as
     *    one more tuple and reports a reserved name called "slug".
     */
    const conflictAt = statement.search(/\bON\s+CONFLICT\b/i);
    const clause = statement.slice(valuesAt, conflictAt === -1 ? undefined : conflictAt);

    // Walk the tuple list, respecting quoting, and take the first literal
    // of each tuple.
    let i = 0;
    while (i < clause.length) {
      if (clause[i] !== "(") {
        i += 1;
        continue;
      }
      const tuple = balanced(clause, i);
      const first = /^\s*'((?:[^']|'')*)'/.exec(tuple);
      if (!first) throw new Error(`reserved_slugs tuple has no quoted slug: ${tuple.slice(0, 40)}`);
      slugs.push(unquote(first[1]));
      i += tuple.length + 2;
    }
  }

  return { slugs, statements: inserts.length };
}

describe("0091 — the reserved list in SQL and the reserved list in TypeScript are the same set", () => {
  const { slugs, statements } = seededReservedSlugs();
  const fromSql = new Set(slugs);
  const fromTs = RESERVED_SLUGS;

  it("finds the seeding statements at all, so an empty parse cannot pass as agreement", () => {
    /**
     * ⚠️ THE FAILURE MODE THIS CLOSES. A parser that silently finds
     *    nothing compares the empty set with the empty set and reports
     *    perfect agreement. Both sides must be non-trivially populated
     *    before any comparison below means anything.
     */
    expect(statements).toBeGreaterThan(0);
    expect(slugs.length).toBeGreaterThan(50);
    expect(fromTs.size).toBeGreaterThan(50);
  });

  it("seeds no name twice — ON CONFLICT DO NOTHING would swallow the duplicate", () => {
    const seen = new Set<string>();
    const duplicated = slugs.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
    expect(
      duplicated,
      `these names are inserted more than once in 0091: ${duplicated.join(", ")}. ` +
        `ON CONFLICT (slug) DO NOTHING hides it, so the count silently disagrees with the list.`,
    ).toEqual([]);
  });

  it("🔴 names nothing the database does not also reserve", () => {
    const missingFromSql = [...fromTs].filter((s) => !fromSql.has(s)).sort();
    expect(
      missingFromSql,
      `RESERVED_SLUGS in lib/slug.ts contains ${missingFromSql.length} name(s) that ` +
        `0091 does not seed into reserved_slugs: ${missingFromSql.join(", ")}. ` +
        `The database is the enforcer: a name listed only in TypeScript is not reserved at all, ` +
        `and provisioning through any other path will mint it.`,
    ).toEqual([]);
  });

  it("🔴 reserves nothing the form will still offer", () => {
    const missingFromTs = [...fromSql].filter((s) => !fromTs.has(s)).sort();
    expect(
      missingFromTs,
      `0091 seeds ${missingFromTs.length} name(s) that RESERVED_SLUGS in lib/slug.ts does not ` +
        `list: ${missingFromTs.join(", ")}. The signup form will accept them, the user will fill ` +
        `in everything else, and the INSERT will then raise P0091.`,
    ).toEqual([]);
  });

  /**
   * ⚠️ THIS ASSERTED `toBe(71)` AND THAT WAS WRONG, IN THE SPECIFIC WAY THIS
   *    PROJECT KEEPS GETTING WRONG.
   *
   * 71 was the count on the day 0091 shipped. `0092` then correctly added
   * `clkmail`, `clk` and `clk2` after reading the real DNS zone, both sides
   * agreed at 74, the two set-equality assertions above passed, and THIS one
   * failed. It failed a change that was right, and it taught nothing when it
   * did: the number 71 was never the property, it was the incidental shape of
   * the list on one afternoon.
   *
   * Three tests in this codebase have already had to be rewritten for pinning
   * a shape rather than a property. This was the fourth.
   *
   * ⭐ THE PROPERTY IS: the two sides are the same size, and both are
   *    non-trivially populated so that an empty parse cannot pass as
   *    agreement. The floor is a floor, not a count, and it is deliberately
   *    far below the real total so that adding names never touches it.
   */
  it("is the same number of names on both sides, and not a trivially small number", () => {
    expect(fromSql.size).toBe(fromTs.size);
    expect(fromSql.size).toBeGreaterThanOrEqual(60);
  });

  it("every reserved name is lowercase, as reserved_slugs_lowercase requires", () => {
    const notLower = [...fromSql].filter((s) => s !== s.toLowerCase());
    expect(notLower, `these rows would fail reserved_slugs_lowercase: ${notLower.join(", ")}`).toEqual([]);
  });

  it("every reserved name is placed in a category, so nothing joins the list unexplained", () => {
    /**
     * The category is why the name is there. A flat list invites someone
     * to delete an entry that looks harmless — `pop`, say, or `ci`.
     */
    const uncategorised = [...fromTs].filter((s) => reservedCategory(s) === null);
    expect(uncategorised, `no category in lib/slug.ts for: ${uncategorised.join(", ")}`).toEqual([]);
  });

  it("keeps the certificate-issuance names, which are the ones that look deletable", () => {
    /**
     * 🔴 NOT TIDINESS. `postmaster`, `hostmaster`, `webmaster` and
     *    `abuse` are addresses a certificate authority accepts as proof
     *    of domain control. A tenant holding one, with mail on it, can
     *    have a certificate issued for a name under our domain.
     */
    for (const name of ["abuse", "hostmaster", "postmaster", "webmaster"]) {
      expect(fromSql.has(name), `${name} is no longer reserved in 0091`).toBe(true);
      expect(fromTs.has(name), `${name} is no longer reserved in lib/slug.ts`).toBe(true);
    }
  });
});

/* ================================================================== */
/* 2. THE SHAPE                                                        */
/* ================================================================== */

describe("0091 — SLUG_PATTERN is the same regex as tenants_slug_shape", () => {
  const statement = theOneStatement(/ADD CONSTRAINT tenants_slug_shape/i, "tenants_slug_shape");

  it("⚠️ constrains `tenants`, and the table name is read from the SAME statement", () => {
    /**
     * This is the assertion that a whole-file regex gets wrong. `ALTER
     * TABLE public.tenants` and `ADD CONSTRAINT tenants_slug_shape` must
     * be the same statement, not two fragments that happen to both
     * appear in a 600-line file.
     */
    expect(statement).toMatch(/ALTER TABLE public\.tenants ADD CONSTRAINT tenants_slug_shape/i);
  });

  it("🔴 is character for character the TypeScript pattern", () => {
    const literal = /CHECK\s*\(\s*slug\s*~\s*'((?:[^']|'')*)'\s*\)/i.exec(statement);
    expect(literal, "no CHECK (slug ~ '...') found in the tenants_slug_shape statement").not.toBeNull();

    const sqlRegex = unquote(literal![1]);
    expect(
      sqlRegex,
      `tenants_slug_shape and SLUG_PATTERN have diverged.\n` +
        `  SQL:        ${sqlRegex}\n` +
        `  TypeScript: ${SLUG_PATTERN.source}\n` +
        `The form now accepts something the database refuses, or refuses something it accepts.`,
    ).toBe(SLUG_PATTERN.source);
  });

  it("⚠️ carries no flags — `i` in TypeScript alone would accept `Acme` the CHECK refuses", () => {
    expect(SLUG_PATTERN.flags).toBe("");
  });

  it("⚠️ is anchored at both ends in both languages", () => {
    /** PostgreSQL's `~` is a SEARCH. Without the anchors it matches a
     *  legal substring of an illegal slug and the CHECK stops checking. */
    expect(SLUG_PATTERN.source.startsWith("^")).toBe(true);
    expect(SLUG_PATTERN.source.endsWith("$")).toBe(true);
  });

  it("🔴 the lowercase CHECK is present, on `tenants`, in one statement", () => {
    /**
     * This is the constraint that closes a LIVE duplicate: `Acme` and
     * `acme` both answer to acme.ordence.com once the Host header is
     * lowercased, and which one wins is whichever the query returns
     * first.
     */
    const lower = theOneStatement(/ADD CONSTRAINT tenants_slug_lowercase/i, "tenants_slug_lowercase");
    expect(lower).toMatch(/ALTER TABLE public\.tenants ADD CONSTRAINT tenants_slug_lowercase/i);
    expect(lower).toMatch(/CHECK\s*\(\s*slug = lower\(slug\)\s*\)/i);
  });
});

/* ================================================================== */
/* 3. THE CONFUSABLE FOLD                                              */
/* ================================================================== */

/* ---- a tiny interpreter for the two functions the fold uses ------- */

type Node =
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "literal"; value: string }
  | { kind: "column"; name: string };

/**
 * Parse the fold expression. Deliberately tiny and deliberately STRICT:
 * an unknown function or an unexpected token throws, so an expression
 * this test cannot faithfully evaluate fails loudly instead of being
 * approximated.
 */
function parseExpression(source: string): Node {
  let i = 0;
  const skip = () => {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  };

  function parse(): Node {
    skip();
    if (source[i] === "'") {
      i += 1;
      let value = "";
      while (i < source.length) {
        if (source[i] === "'" && source[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          i += 1;
          break;
        }
        value += source[i];
        i += 1;
      }
      return { kind: "literal", value };
    }

    const word = /[A-Za-z_][A-Za-z0-9_.]*/y;
    word.lastIndex = i;
    const name = word.exec(source)?.[0];
    if (!name) throw new Error(`cannot parse fold expression at offset ${i}: ${source.slice(i, i + 20)}`);
    i += name.length;
    skip();

    if (source[i] !== "(") return { kind: "column", name };

    i += 1;
    const args: Node[] = [];
    for (;;) {
      args.push(parse());
      skip();
      if (source[i] === ",") {
        i += 1;
        continue;
      }
      if (source[i] === ")") {
        i += 1;
        break;
      }
      throw new Error(`unexpected token in fold expression at offset ${i}`);
    }
    return { kind: "call", name: name.toLowerCase(), args };
  }

  const node = parse();
  skip();
  if (i !== source.length) throw new Error(`trailing input in fold expression: ${source.slice(i)}`);
  return node;
}

/** PostgreSQL `replace()`: literal, non-overlapping, left to right. */
function pgReplace(subject: string, from: string, to: string): string {
  if (from === "") return subject;
  let out = "";
  let i = 0;
  while (i < subject.length) {
    if (subject.startsWith(from, i)) {
      out += to;
      i += from.length;
      continue;
    }
    out += subject[i];
    i += 1;
  }
  return out;
}

/**
 * PostgreSQL `translate()`: single pass, first occurrence in `from`
 * wins, and a character whose index in `from` is beyond the end of `to`
 * is DELETED rather than kept.
 */
function pgTranslate(subject: string, from: string, to: string): string {
  let out = "";
  for (const ch of subject) {
    const at = from.indexOf(ch);
    if (at === -1) out += ch;
    else if (at < to.length) out += to[at];
  }
  return out;
}

function evaluate(node: Node, slug: string): string {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "column": {
      // `slug`, `NEW.slug` and `t.slug` are the same column in the three
      // places 0091 writes this expression.
      if (/(^|\.)slug$/i.test(node.name)) return slug;
      throw new Error(`fold expression reads an unexpected column: ${node.name}`);
    }
    case "call": {
      const args = node.args.map((a) => evaluate(a, slug));
      if (node.name === "replace" && args.length === 3) return pgReplace(args[0], args[1], args[2]);
      if (node.name === "translate" && args.length === 3) return pgTranslate(args[0], args[1], args[2]);
      throw new Error(`fold expression uses ${node.name}/${node.args.length}, which this test cannot evaluate`);
    }
  }
}

/* ---- pull the three copies of the expression out of 0091 ---------- */

const generatedColumnStatement = theOneStatement(/ADD COLUMN slug_fold/i, "the slug_fold generated column");

/** `GENERATED ALWAYS AS (<expr>) STORED`, with the parens balanced. */
function generatedExpression(statement: string): string {
  const at = statement.search(/GENERATED ALWAYS AS/i);
  if (at === -1) throw new Error("slug_fold is not GENERATED ALWAYS AS anything");
  return balanced(statement, at).trim();
}

const FOLD_SQL = generatedExpression(generatedColumnStatement);
const FOLD_AST = parseExpression(FOLD_SQL);

/** Every input the fold is drilled over. */
const FOLD_INPUTS = [
  "zedbui1ders",
  "zed-builders",
  "zedbuilders",
  "arnazon-traders",
  "amazon-traders",
  "0rdence",
  "ordence",
  "acme-corp",
  "acmecorp",
  "ka-rnataka",
  "karnataka",
  "vvipro",
  "wipro",
  "a-b-c",
  "l1l1",
  "0l1o",
  "rnrn",
  "vvvv",
  "vvv",
  "rnvv0l1",
  "tata-steel",
  "tatasteel",
  "1000",
  "o0o0",
  "iiii",
  "abc",
  "a1b2c3",
  "-nope-",
  "rn",
  "vv",
  "0",
  "l",
  "1",
  "hyphen--double",
  "trailing-rn",
] as const;

/**
 * ⭐ THE INDEPENDENT ORACLE.
 *
 * These are the values PostgreSQL 16.13 actually produced for the
 * expression in 0091, captured by executing it against a throwaway
 * cluster. They are here so that the SAME mistake made in both the
 * interpreter above and in `foldSlug()` cannot cancel out and report
 * agreement.
 */
const FOLD_ORACLE: Record<string, string> = {
  "zedbui1ders": "zedbuiiders",
  "zed-builders": "zedbuiiders",
  "zedbuilders": "zedbuiiders",
  "arnazon-traders": "amazontraders",
  "amazon-traders": "amazontraders",
  "0rdence": "ordence",
  "ordence": "ordence",
  "acme-corp": "acmecorp",
  "acmecorp": "acmecorp",
  "ka-rnataka": "kamataka",
  "karnataka": "kamataka",
  "vvipro": "wipro",
  "wipro": "wipro",
  "a-b-c": "abc",
  "l1l1": "iiii",
  "0l1o": "oiio",
  "rnrn": "mm",
  "vvvv": "ww",
  "vvv": "wv",
  "rnvv0l1": "mwoii",
  "tata-steel": "tatasteei",
  "tatasteel": "tatasteei",
  "1000": "iooo",
  "o0o0": "oooo",
  "iiii": "iiii",
  "abc": "abc",
  "a1b2c3": "aib2c3",
  "-nope-": "nope",
  "rn": "m",
  "vv": "w",
  "0": "o",
  "l": "i",
  "1": "i",
  "hyphen--double": "hyphendoubie",
  "trailing-rn": "traiiingm",
};

describe("0091 — foldSlug() computes what the generated column computes", () => {
  it("⚠️ finds the generated column on `tenants`, from the SAME statement", () => {
    expect(generatedColumnStatement).toMatch(/ALTER TABLE public\.tenants ADD COLUMN slug_fold/i);
    expect(generatedColumnStatement).toMatch(/STORED/i);
  });

  it("drills at least 25 inputs, including every confusable class", () => {
    expect(FOLD_INPUTS.length).toBeGreaterThanOrEqual(25);
    for (const required of [
      "zedbui1ders",
      "zed-builders",
      "arnazon-traders",
      "amazon-traders",
      "0rdence",
      "ordence",
      "acme-corp",
      "acmecorp",
      "ka-rnataka",
      "vvipro",
    ]) {
      expect(FOLD_INPUTS as readonly string[]).toContain(required);
    }
  });

  it.each(FOLD_INPUTS)("agrees with the SQL expression on %s", (input) => {
    const fromSql = evaluate(FOLD_AST, input);
    expect(
      foldSlug(input),
      `foldSlug() and 0091 disagree on "${input}".\n` +
        `  SQL expression: ${FOLD_SQL}\n` +
        `A slug that folds differently in the two places is a slug the availability ` +
        `check clears and tenants_slug_fold_unique then refuses — or worse, one both allow.`,
    ).toBe(fromSql);
  });

  it.each(FOLD_INPUTS)("matches what PostgreSQL 16 really returned for %s", (input) => {
    expect(foldSlug(input)).toBe(FOLD_ORACLE[input]);
    expect(evaluate(FOLD_AST, input)).toBe(FOLD_ORACLE[input]);
  });

  /**
   * 🔴 THE BUG, RE-ARMED.
   *
   * `translate(x, '01l', 'oli')` maps `1` to `l` rather than to `i`.
   * Under it `zedbui1ders` and `zedbuilders` land on different folds and
   * the impostor is accepted. This test rebuilds that variant from the
   * REAL expression — changing only `translate`'s third argument — and
   * asserts the difference, so the drill above is demonstrably capable
   * of catching it rather than merely believed to be.
   */
  it("🔴 would catch the '01l' → 'oli' mapping that let zedbui1ders through", () => {
    const buggy = withTranslateTarget(FOLD_AST, "oli");
    expect(evaluate(buggy, "zedbui1ders")).not.toBe(evaluate(buggy, "zedbuilders"));
    expect(evaluate(FOLD_AST, "zedbui1ders")).toBe(evaluate(FOLD_AST, "zedbuilders"));
    expect(foldSlug("zedbui1ders")).toBe(foldSlug("zedbuilders"));
  });

  it("collapses each confusable pair onto one namespace", () => {
    const pairs: Array<[string, string]> = [
      ["acme-corp", "acmecorp"],
      ["0rdence", "ordence"],
      ["arnazon-traders", "amazon-traders"],
      ["ka-rnataka", "karnataka"],
      ["vvipro", "wipro"],
      ["zedbui1ders", "zedbuilders"],
    ];
    for (const [a, b] of pairs) {
      expect(foldSlug(a), `${a} and ${b} must occupy one namespace`).toBe(foldSlug(b));
    }
  });

  it("does not collapse names that are genuinely different", () => {
    /** The fold is a real cost — it must not be a bigger one than stated. */
    expect(foldSlug("acme-corp")).not.toBe(foldSlug("acme-corps"));
    expect(foldSlug("tatasteel")).not.toBe(foldSlug("tatasteels"));
  });

  it("🔴 the three copies of the expression inside 0091 are the same expression", () => {
    /**
     * The generated column, the trigger's `v_fold`, and the SECTION 6
     * backfill each spell the fold out. If the backfill drifts, every
     * pre-existing tenant gets a history row whose fold does not match
     * its own column, and the 365-day retention check silently narrows.
     */
    const guard = theOneStatement(/CREATE OR REPLACE FUNCTION public\.ordence_guard_tenant_slug/i, "the guard function");
    const guardAt = guard.search(/v_fold\s*:=\s*translate\s*\(/i);
    expect(guardAt, "the guard no longer computes v_fold with translate()").toBeGreaterThan(-1);

    const backfill = theOneStatement(
      /INSERT INTO public\.tenant_slug_history \(tenant_id, slug, slug_fold, claimed_at\)/i,
      "the history backfill",
    );
    const backfillAt = backfill.search(/\btranslate\s*\(/i);
    expect(backfillAt, "the SECTION 6 backfill no longer computes a fold").toBeGreaterThan(-1);

    for (const [label, source, at] of [
      ["the guard trigger", guard, guardAt],
      ["the SECTION 6 backfill", backfill, backfillAt],
    ] as const) {
      const ast = parseExpression(`translate(${balanced(source, at)})`);
      for (const input of FOLD_INPUTS) {
        expect(
          evaluate(ast, input),
          `${label} folds "${input}" differently from the generated column`,
        ).toBe(evaluate(FOLD_AST, input));
      }
    }
  });
});

/** A copy of `node` with the innermost `translate`'s third argument replaced. */
function withTranslateTarget(node: Node, target: string): Node {
  if (node.kind !== "call") return node;
  if (node.name === "translate" && node.args.length === 3) {
    return { kind: "call", name: node.name, args: [node.args[0], node.args[1], { kind: "literal", value: target }] };
  }
  return { kind: "call", name: node.name, args: node.args.map((a) => withTranslateTarget(a, target)) };
}

/* ================================================================== */
/* 4. THE INDEXES AND THE TRIGGER EXIST AT ALL                         */
/* ================================================================== */

describe("0091 — the boundary is still the database", () => {
  it("keeps a UNIQUE index on the folded column", () => {
    const index = theOneStatement(/CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_fold_unique/i, "tenants_slug_fold_unique");
    expect(index).toMatch(/ON public\.tenants \(slug_fold\)/i);
  });

  it("🔴 the guard is SECURITY DEFINER with a pinned search_path", () => {
    /**
     * A guard that reads its tables through RLS FAILS OPEN: the lookup
     * returns zero rows, the guard concludes "not reserved", and the
     * refusal silently becomes a permission. SECURITY DEFINER without a
     * pinned search_path is the other half — a shadowed
     * `reserved_slugs` reads as an empty list.
     */
    const guard = theOneStatement(/CREATE OR REPLACE FUNCTION public\.ordence_guard_tenant_slug/i, "the guard function");
    expect(guard).toMatch(/SECURITY DEFINER/i);
    expect(guard).toMatch(/SET search_path = public, pg_temp/i);
  });

  it("raises a distinct SQLSTATE for each refusal, so nothing has to parse English", () => {
    const guard = theOneStatement(/CREATE OR REPLACE FUNCTION public\.ordence_guard_tenant_slug/i, "the guard function");
    for (const code of ["P0091", "P0092", "P0093"]) {
      expect(guard, `the guard no longer raises ${code}`).toMatch(new RegExp(`ERRCODE = '${code}'`));
    }
  });

  it("fires BEFORE INSERT OR UPDATE OF slug on tenants", () => {
    const trigger = theOneStatement(/CREATE TRIGGER ordence_guard_tenant_slug/i, "the guard trigger");
    expect(trigger).toMatch(/BEFORE INSERT OR UPDATE OF slug ON public\.tenants/i);
    expect(trigger).toMatch(/FOR EACH ROW/i);
  });
});
