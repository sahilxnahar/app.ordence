/**
 * Ordence — ⭐⭐ THE SAME MAN, THREE TIMES, IN ONE AFTERNOON
 * Version: v1.10.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM, IN THE FORM IT ACTUALLY ARRIVES
 * ══════════════════════════════════════════════════════════════════════
 * One person enquires three times in a week, through three channels,
 * and lands in the system as:
 *
 *     +91 98765 43210      (from the website form)
 *     098765 43210         (typed by the receptionist)
 *     9876543210           (from a marketplace feed)
 *
 * ⚠️ A duplicate check on the stored text finds **nothing**. Three
 * leads, three follow-ups, three salespeople ringing the same man in
 * one afternoon, and he concludes the firm is a shambles, which on this
 * evidence it is.
 *
 * ⭐ AND IT IS WORSE THAN EMBARRASSING. Three leads from one enquiry
 * inflates every conversion figure the business runs on, and the source
 * that produced the duplicate gets credit three times over.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE WILL NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It will not merge anything automatically, and it will not block a
 * second enquiry.
 *
 * ⚠️ A genuine second enquiry from the same person six months later is a
 * real lead. Refusing it teaches the salesman to type a fake number,
 * which destroys the data the check depends on. So this SURFACES the
 * match, with its strength and its reason, and a person decides.
 */

export class DedupeError extends Error {}

/* ------------------------------------------------------------------ */
/* NORMALISATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ INDIAN MOBILE NUMBERS, REDUCED TO THE TEN DIGITS THAT IDENTIFY THEM.
 *
 * 🔴 The last ten digits, not the first ten. `+919876543210` and
 * `09876543210` and `919876543210` all end in the same ten, and taking
 * from the front gets two of the three wrong.
 *
 * ⚠️ This is deliberately not a full international phone library. It is
 * the rule that works for the country this product is built for, and it
 * is the same rule the generated column in 0061 applies so the two can
 * never disagree.
 */
export function normalisePhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return digits.slice(-10);
}

/**
 * ⚠️ LOWERCASED AND TRIMMED, AND NOTHING CLEVER.
 *
 * 🔴 Deliberately NOT stripping dots from the local part or anything
 * after a plus sign. Those are Gmail conventions, not email standards:
 * on many corporate mail servers `a.sharma@` and `asharma@` are two
 * different people, and merging them would be worse than missing a
 * duplicate.
 */
export function normaliseEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** ⭐ For comparing names: case, punctuation and honorifics removed. */
export function normaliseName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|shri|smt|sri|m\/s|messrs)\b\.?/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* THE MATCH                                                           */
/* ------------------------------------------------------------------ */

export type DuplicateStrength = "certain" | "likely" | "possible";

export type Candidate = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** For the message: "enquired 4 months ago". */
  createdOn?: string | null;
};

export type DuplicateMatch = {
  id: string;
  strength: DuplicateStrength;
  /** What actually matched, in words a salesperson can act on. */
  reason: string;
  matchedOn: readonly ("phone" | "email" | "name")[];
};

/**
 * ⭐⭐ FIND WHAT THIS ENQUIRY MIGHT ALREADY BE.
 *
 * 🔴 THE STRENGTHS MEAN DIFFERENT THINGS AND THE SCREEN TREATS THEM
 *    DIFFERENTLY.
 *
 *   certain  — same phone, or same email. One identifier, exactly
 *              equal. Show it before the lead is saved.
 *   likely   — same normalised name AND some other signal.
 *   possible — same name only. Worth a look, never worth a merge on
 *              its own, because in a country of this size a shared name
 *              is not evidence of anything.
 *
 * ⚠️ NAME ALONE IS NEVER MORE THAN `possible`. Ten thousand people are
 * called Rajesh Kumar and a product that merges on name will quietly
 * destroy real records.
 */
export function findDuplicates(args: {
  incoming: Candidate;
  existing: readonly Candidate[];
  /** Cap the list so a screen stays readable. */
  limit?: number;
}): DuplicateMatch[] {
  const inPhone = normalisePhone(args.incoming.phone);
  const inEmail = normaliseEmail(args.incoming.email);
  const inName = normaliseName(args.incoming.name);

  const out: DuplicateMatch[] = [];

  for (const c of args.existing) {
    if (c.id === args.incoming.id) continue;

    const cPhone = normalisePhone(c.phone);
    const cEmail = normaliseEmail(c.email);
    const cName = normaliseName(c.name);

    const matched: ("phone" | "email" | "name")[] = [];
    /** ⚠️ An empty normalised value matches nothing. Two blanks are not a pair. */
    if (inPhone !== "" && inPhone === cPhone) matched.push("phone");
    if (inEmail !== "" && inEmail === cEmail) matched.push("email");
    if (inName !== "" && inName === cName) matched.push("name");

    if (matched.length === 0) continue;

    const hasIdentifier = matched.includes("phone") || matched.includes("email");
    const strength: DuplicateStrength = hasIdentifier
      ? "certain"
      : matched.includes("name") && matched.length > 1
        ? "likely"
        : "possible";

    out.push({
      id: c.id,
      strength,
      matchedOn: matched,
      reason: describe(matched, c, strength),
    });
  }

  /** Strongest first, so the one worth acting on is at the top. */
  const rank: Record<DuplicateStrength, number> = {
    certain: 0,
    likely: 1,
    possible: 2,
  };
  out.sort((a, b) => rank[a.strength] - rank[b.strength] || (a.id < b.id ? -1 : 1));

  const limit = args.limit ?? 10;
  return out.slice(0, limit);
}

function describe(
  matched: readonly string[],
  c: Candidate,
  strength: DuplicateStrength,
): string {
  const who = c.name ? `"${c.name}"` : "an existing record";
  const when = c.createdOn ? `, first recorded ${c.createdOn}` : "";
  if (matched.includes("phone") && matched.includes("email")) {
    return `Same phone and same email as ${who}${when}. This is almost certainly the same person.`;
  }
  if (matched.includes("phone")) {
    return `Same phone number as ${who}${when}, once the country code and spacing are stripped.`;
  }
  if (matched.includes("email")) {
    return `Same email address as ${who}${when}.`;
  }
  if (strength === "possible") {
    return `Same name as ${who}${when}, and nothing else matches. A shared name is not evidence on its own.`;
  }
  return `Matches ${who}${when}.`;
}

/* ------------------------------------------------------------------ */
/* MERGING                                                             */
/* ------------------------------------------------------------------ */

export type MergeVerdict = {
  allowed: boolean;
  reason: string;
};

/**
 * 🔴 A MERGE IS A DECISION, AND SOME MERGES ARE NOT AVAILABLE.
 *
 * ⚠️ A lead that has already converted into a booking, an order or a
 * customer is not a duplicate to be folded away. Merging it would
 * detach a real document from the record that explains where it came
 * from, and the accounting would still be right while the story became
 * unreadable.
 */
export function canMerge(args: {
  /** The one being folded away. */
  sourceHasConverted: boolean;
  sourceIsAlreadyMerged: boolean;
  sourceId: string;
  targetId: string;
  strength: DuplicateStrength;
}): MergeVerdict {
  if (args.sourceId === args.targetId) {
    return { allowed: false, reason: "A record cannot be merged into itself." };
  }
  if (args.sourceIsAlreadyMerged) {
    return {
      allowed: false,
      reason:
        "This has already been merged into something else. Merging it again would produce a chain nobody can follow back.",
    };
  }
  if (args.sourceHasConverted) {
    return {
      allowed: false,
      reason:
        "This enquiry has already turned into real business, so it is not a duplicate to be folded away. Merging it would detach an order or a booking from the record explaining where it came from. Link the two instead.",
    };
  }
  if (args.strength === "possible") {
    return {
      allowed: false,
      reason:
        "The only thing these two have in common is the name, and a shared name is not evidence. Confirm the phone or the email before merging anything.",
    };
  }
  return {
    allowed: true,
    reason:
      "The identifiers match and nothing has been raised against this enquiry yet. It can be folded into the other one, which keeps the older record and its history.",
  };
}
