/**
 * Ordence — ⭐⭐⭐ WHICH RULES, AND THEREFORE WHICH FORM NUMBER
 * Version: v1.48.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FORM NUMBER IS NOT A CONSTANT AND PRETENDING IT IS COSTS MONEY
 * ══════════════════════════════════════════════════════════════════════
 * "Form A" is the employee register under the Ease of Compliance to
 * Maintain Registers under various Labour Laws Rules, 2017. It is also
 * something else entirely under the Karnataka Shops and Commercial
 * Establishments Rules, under the Contract Labour Rules, and under the
 * Central Rules made under the Code on Wages, 2019 — which renumbered
 * the lot again. A product that prints "Form A" at the top of a page
 * because a developer in one State once saw it there is handing an
 * inspector a document that cites the wrong rule.
 *
 * ⚠️ AND THE PENALTY IS NOT FOR THE HEADING. It is for not maintaining
 * the register the applicable rules require. A confidently mislabelled
 * document is evidence that the employer believed it had complied, which
 * is worse than a plainly-labelled printout of the same rows.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ SO THE NUMBERING IS DATA, AND THE DEFAULT IS SILENCE
 * ══════════════════════════════════════════════════════════════════════
 * A rule set is a row in `RULE_SETS`. A register asks it for a form
 * number and gets `null` unless that rule set genuinely carries one in
 * this table. `null` prints as "Form number not stated — enter the form
 * number under the rules that apply to you", which is the same policy
 * this whole batch runs on: a named blank beats a plausible wrong value.
 *
 * 🔴 THERE IS EXACTLY ONE RULE SET HERE WITH FORM NUMBERS IN IT, and
 * that is deliberate rather than lazy. The 2017 combined-register rules
 * are the one set whose lettering (A employees, B wages, C loans and
 * recoveries, D attendance) is reproduced identically across every
 * State because the rules themselves are central and consolidating. For
 * the Code on Wages Central Rules, the OSH Central Rules and any given
 * State's Shops Act rules, the numbering differs, has been amended, and
 * in several States is still being notified. Encoding a guess for those
 * would be the exact defect the paragraph above describes.
 *
 * ⚠️ `confidence` IS ON THE ROW AND IT IS SHOWN TO THE USER. Nothing in
 * this file is a legal opinion; it is a lookup table that says how sure
 * it is, and the screen repeats that sentence rather than hiding it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE MULTI-STATE TRAP, WHICH IS THE REAL FINDING
 * ══════════════════════════════════════════════════════════════════════
 * `employees.work_state_code` is per employee, not per workspace — a
 * Bengaluru company with three people in Mumbai owes Maharashtra
 * professional tax for those three, which is why the column exists. The
 * same fact governs registers: the register an inspector in Mumbai asks
 * for is maintained under Maharashtra's rules, for the establishment in
 * Maharashtra, and it does not contain the Bengaluru staff.
 *
 * ONE register covering three States is not a register under any of
 * them. `statesRepresented()` exists so the document can say so on its
 * face instead of quietly stapling three establishments together.
 */

/* ------------------------------------------------------------------ */
/* THE REGISTERS THIS PRODUCT KNOWS ABOUT                              */
/* ------------------------------------------------------------------ */

export type RegisterKind =
  | "employee_register"
  | "wage_register"
  | "attendance_register"
  | "leave_with_wages_register"
  | "loans_and_advances_register";

export const REGISTER_KINDS: readonly RegisterKind[] = [
  "employee_register",
  "wage_register",
  "attendance_register",
  "leave_with_wages_register",
  "loans_and_advances_register",
];

export function isRegisterKind(value: unknown): value is RegisterKind {
  return typeof value === "string" && (REGISTER_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* RULE SETS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ `commonly-cited` means the lettering is reproduced the same way
 * wherever these rules are applied, and we are willing to print it.
 * `not-encoded` means this table does not carry a number for that rule
 * set and the document will say so rather than borrow one.
 */
export type FormConfidence = "commonly-cited" | "not-encoded";

export interface RuleSet {
  readonly id: string;
  readonly label: string;
  /** The instrument, spelt out, so the reader can go and check it. */
  readonly citation: string;
  /**
   * ⚠️ `null` means "the rules themselves claim to apply generally".
   * A non-empty list narrows it, and the document warns when the
   * workforce spans States the chosen rule set does not cover.
   */
  readonly stateCodes: readonly string[] | null;
  readonly confidence: FormConfidence;
  /** Only the entries this table is willing to stand behind. */
  readonly forms: Readonly<Partial<Record<RegisterKind, string>>>;
  readonly note: string;
}

export const RULE_SETS: readonly RuleSet[] = [
  /**
   * ⭐⭐ THE DEFAULT, AND IT NAMES NOTHING.
   *
   * 🔴 A DROPDOWN WHOSE FIRST ENTRY IS A REAL RULE SET IS A DROPDOWN
   * NOBODY CHANGES. Whatever sits at the top gets printed on every
   * register in the workspace, for every State, forever, because it
   * rendered without an error the first time. Making the default the
   * one that prints no form number at all means the first register
   * anybody generates visibly asks to be told which rules apply — and
   * an unanswered question on the page is recoverable, where a wrong
   * citation on a filed document is not.
   */
  {
    id: "unstated",
    label: "Rules not stated",
    citation:
      "No instrument selected. The rows are drawn from your own records; the heading cites nothing.",
    stateCodes: null,
    confidence: "not-encoded",
    forms: {},
    note:
      "Pick the rules your establishment is registered under. Until you do, the register prints its columns and its figures and states no form number, which is honest and is not a substitute for choosing.",
  },

  /**
   * ⭐ THE ONE SET THIS FILE CARRIES NUMBERS FOR.
   *
   * The 2017 rules exist precisely to collapse dozens of overlapping
   * registers under the older Acts into a common five, and the lettering
   * travels with them. Where an employer maintains combined registers
   * under these rules, A / B / C / D are what an inspector expects.
   *
   * ⚠️ MAINTAINING THEM DOES NOT DISCHARGE EVERY STATE OBLIGATION. Some
   * State Shops Acts still require their own forms alongside. The note
   * says so on the document rather than in a developer's head.
   */
  {
    id: "ease-of-compliance-2017",
    label: "Combined registers (Ease of Compliance Rules, 2017)",
    citation:
      "Ease of Compliance to Maintain Registers under various Labour Laws Rules, 2017 (Ministry of Labour and Employment).",
    stateCodes: null,
    confidence: "commonly-cited",
    forms: {
      employee_register: "Form A",
      wage_register: "Form B",
      loans_and_advances_register: "Form C",
      attendance_register: "Form D",
    },
    note:
      "These rules consolidate the registers required under several central labour laws. Your State's Shops and Commercial Establishments Rules may still require their own forms in addition — confirm before you rely on these alone.",
  },

  /**
   * ⚠️ THE NEW CODES, AND THEIR NUMBERS ARE DELIBERATELY ABSENT.
   *
   * The Code on Wages, 2019 subsumes the Payment of Wages Act, the
   * Minimum Wages Act, the Payment of Bonus Act and the Equal
   * Remuneration Act, and the Central Rules made under it prescribe
   * their own register forms. State rules under the Code are being
   * notified separately and on their own timetables, and they do not all
   * agree with the Central numbering.
   *
   * 🔴 THIS IS EXACTLY WHERE A HARDCODED GUESS WOULD LAND, so there is
   * no guess here. The rows are the same rows; the heading says which
   * Code it is under and asks for the number.
   */
  {
    id: "code-on-wages-central-2021",
    label: "Code on Wages — Central Rules",
    citation:
      "Code on Wages, 2019, read with the Central Rules made under it. Register forms are prescribed by the Rules and are renumbered from the older Acts.",
    stateCodes: null,
    confidence: "not-encoded",
    forms: {},
    note:
      "The Code renumbers the registers and States are notifying their own rules under it separately. This table does not carry those numbers, so none is printed. Enter the form number from the rules notified for your State.",
  },

  {
    id: "osh-central-2020",
    label: "Occupational Safety, Health and Working Conditions Code — Central Rules",
    citation:
      "Occupational Safety, Health and Working Conditions Code, 2020, read with the Central Rules made under it.",
    stateCodes: null,
    confidence: "not-encoded",
    forms: {},
    note:
      "The OSH Code subsumes the Factories Act, the Contract Labour Act and the Shops-adjacent establishment laws for covered establishments. Its register forms differ from both the 2017 combined registers and the Code on Wages rules; none is printed here.",
  },

  /**
   * ⭐ A STATE ENTRY THAT EXISTS TO CARRY THE WARNING, NOT A NUMBER.
   *
   * Every State's Shops and Commercial Establishments Rules prescribe
   * their own register forms, they were made at different times, most
   * have been amended, and several have been superseded in part by rules
   * under the new Codes. There is no single answer to encode.
   */
  {
    id: "state-shops-act",
    label: "State Shops and Commercial Establishments Rules",
    citation:
      "The Shops and Commercial Establishments Act and Rules of the State in which the establishment is registered.",
    stateCodes: null,
    confidence: "not-encoded",
    forms: {},
    note:
      "Form numbering under the Shops Acts is State-specific and frequently amended. One establishment registration means one State; a register covering staff in several States is not a register under any of them.",
  },
];

export function ruleSetById(id: string): RuleSet {
  return RULE_SETS.find((r) => r.id === id) ?? RULE_SETS[0]!;
}

/** The default, spelt out so nothing has to know it is index zero. */
export const DEFAULT_RULE_SET_ID = "unstated";

/**
 * 🔴 THE ONE FUNCTION THAT DECIDES WHETHER A FORM NUMBER IS PRINTED.
 *
 * ⚠️ IT RETURNS `null` AND NOT `""`. An empty string renders as a blank
 * heading that looks like a layout bug; `null` is a value the renderer
 * has to make a decision about, and the decision it makes is to print
 * the sentence that asks for the number.
 */
export function formNumberFor(ruleSetId: string, kind: RegisterKind): string | null {
  return ruleSetById(ruleSetId).forms[kind] ?? null;
}

/* ------------------------------------------------------------------ */
/* THE MULTI-STATE CHECK                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Distinct, sorted, uppercase, blanks dropped.
 *
 * ⚠️ A MISSING STATE CODE IS NOT A STATE. `work_state_code` is NOT NULL
 * on `employees`, but rows arriving from an import can carry whitespace,
 * and counting "  " as a fourth State would produce a warning nobody can
 * act on. It is dropped here and reported as a gap by the register that
 * needs it.
 */
export function statesRepresented(codes: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = (raw ?? "").trim().toUpperCase();
    if (code.length === 0) continue;
    seen.add(code);
  }
  return [...seen].sort();
}

/**
 * 🔴 THE WARNING A MULTI-STATE WORKFORCE MUST CARRY ON THE DOCUMENT.
 *
 * Returns `null` when there is nothing to say — one State, or none
 * recorded at all, which is a different problem reported elsewhere.
 */
export function multiStateWarning(states: readonly string[]): string | null {
  if (states.length <= 1) return null;
  return (
    `These rows cover employees in ${states.length} States (${states.join(", ")}). ` +
    "A register is maintained by an establishment under the rules of the State it is registered in, " +
    "and an inspector in one State is entitled to the register for that State's establishment only. " +
    "Filter to one State before you print this, or print one register per State."
  );
}

/**
 * ⚠️ THE SENTENCE THAT GOES UNDER EVERY HEADING, WHATEVER THE RULE SET.
 * It is generated rather than typed into each register so that the
 * caveat cannot be present on three documents and missing on the fourth.
 */
export function citationLine(ruleSetId: string, kind: RegisterKind): string {
  const rules = ruleSetById(ruleSetId);
  const form = formNumberFor(ruleSetId, kind);
  if (form === null) {
    return (
      `${rules.citation} Form number not stated — this product does not carry the numbering for ` +
      "these rules and will not guess one. Enter the form number from the rules that apply to your establishment."
    );
  }
  return `${form}, under ${rules.citation}`;
}
