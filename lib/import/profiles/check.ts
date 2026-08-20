/**
 * Ordence — ⭐⭐ THE PROFILE REGISTRY CHECKS ITSELF
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A CHECKER AND NOT JUST TYPES
 * ══════════════════════════════════════════════════════════════════════
 * `SourceProfile` gets TypeScript to insist that every member is present.
 * It cannot insist that any of them is TRUE. Every one of these is
 * type-correct and wrong, and each one has a specific consequence:
 *
 *   · `destination: { kind: "entity", entity: "sales-invoices" }`
 *     — a route to an entity that does not exist. `writeRow` dispatches
 *       with `if` chains, so it COMPILES and falls through at runtime.
 *       This is the hazard `contract/worked-example.ts` keeps `contacts`
 *       out of `ALL_IMPORT_ENTITIES` to avoid, one layer further out.
 *
 *   · `{ spelling: "GSTIN", field: "gstinNumber" }` on `gst-parties`
 *     — a field that entity does not have. The prior is handed to a
 *       mapper that has no column to put it against, so it silently does
 *       nothing and the profile still reads as covering that column.
 *
 *   · `missingRequired: []` on a Tally trial balance
 *     — the export has no account-code column and no as-at date, and
 *       claiming otherwise is how "supported" comes to mean "fails on
 *       the first row".
 *
 *   · `signature: ["Name"]`
 *     — fires on every file ever exported. A confident wrong prior,
 *       where an absent one would have left the generic path intact.
 *
 *   · two exports with the same signature
 *     — a permanent tie, which `detectProfile` resolves by refusing to
 *       choose. Recognising nothing, forever, while looking complete.
 *
 * ⭐ AND THE THIRD ONE IS CHECKED IN BOTH DIRECTIONS, which is the part
 * that keeps working. A `missingRequired` that only had to be a SUBSET of
 * what is truly missing would go on reading as complete the day an entity
 * gains a required column. It must be EXACTLY the computed set.
 *
 * ⚠️ PURE. No filesystem, no database. The SQL list is passed IN by the
 * caller — `tests/ui/import-profiles.test.ts` reads the migration and
 * hands it over — so this file can run in the browser bundle it is part
 * of. Same division as `lib/import/contract/check.ts`.
 */

import { ALL_IMPORT_ENTITIES } from "../entities";
import { normaliseHeader } from "../mapping";
import { CIVIL_DATE_FORMATS } from "./dates";
import { NEGATIVE_STYLES } from "./amounts";
import { MIN_SIGNATURE_HEADERS } from "./detect";
import type { SourceProfile } from "./types";

export type ProfileProblem = {
  readonly profile: string;
  /** The export or member at fault, for grouping. */
  readonly where: string;
  /** What is wrong, and what breaks because of it. Written for a reader. */
  readonly problem: string;
};

export type ProfileCheckResult = {
  readonly ok: boolean;
  readonly problems: readonly ProfileProblem[];
  /** Printed on success. A gate that says only "OK" reads green having read nothing. */
  readonly census: {
    readonly profiles: number;
    readonly exports: number;
    readonly headerSpellings: number;
    readonly reachableExports: number;
    readonly validatedAgainstRealExport: number;
    /** How many mapped exports are short of a required column, and which. */
    readonly exportsMissingRequired: readonly string[];
  };
};

export type ProfileCheckOptions = {
  /**
   * The values inside `import_runs_source_profile_known`, read from
   * `SQL-FILES/0275_*.sql` by the caller. Omitted, that comparison is
   * skipped and the result SAYS SO rather than passing quietly.
   */
  readonly sqlProfileKeys?: readonly string[];
};

/**
 * ⚠️ EVERY PROBLEM, NOT THE FIRST — the discipline
 * `lib/import/contract/check.ts` set. A checker that stops at the first
 * fault turns a five-minute fix into five CI rounds.
 */
export function checkSourceProfiles(
  profiles: Readonly<Record<string, SourceProfile>>,
  options: ProfileCheckOptions = {},
): ProfileCheckResult {
  const problems: ProfileProblem[] = [];
  const entries = Object.entries(profiles);

  let exports = 0;
  let headerSpellings = 0;
  let reachableExports = 0;
  let validatedAgainstRealExport = 0;
  const exportsMissingRequired: string[] = [];

  /* ---- the registry as a whole ---------------------------------- */

  const fallbacks = entries.filter(([, p]) => p.fallback);
  if (fallbacks.length !== 1) {
    problems.push({
      profile: "(registry)",
      where: "fallback",
      problem:
        `${fallbacks.length} profiles are marked as the fallback and exactly one must be. The ` +
        `fallback is what a file that matches nothing is read as; with none, an unrecognised ` +
        `file has no profile at all and every description of it throws. With two, which one ` +
        `answers depends on key order.`,
    });
  }

  for (const [key, profile] of entries) {
    if (key !== profile.key) {
      problems.push({
        profile: key,
        where: "key",
        problem:
          `is registered under "${key}" and calls itself "${profile.key}". The registry key is ` +
          `what lands in \`import_runs.source_profile\`; the other one is what every message ` +
          `says. Six months later those are two different migrations.`,
      });
    }
  }

  /** ⚠️ Compared against the SQL CHECK, or explicitly not compared. */
  if (options.sqlProfileKeys) {
    const sql = new Set(options.sqlProfileKeys);
    for (const [key] of entries) {
      if (!sql.has(key)) {
        problems.push({
          profile: key,
          where: "SQL CHECK constraint",
          problem:
            `is a profile this code can detect and is NOT in ` +
            `\`import_runs_source_profile_known\`. A migration read under it would read the ` +
            `file, plan it, write every row, and then fail at the run record — the customer's ` +
            `data imported, with no record of what it was read as. This is gate 20's failure ` +
            `for \`source_format\`, one column over.`,
        });
      }
    }
    for (const value of sql) {
      if (!Object.hasOwn(profiles, value)) {
        problems.push({
          profile: value,
          where: "SQL CHECK constraint",
          problem:
            `is allowed by \`import_runs_source_profile_known\` and no profile produces it. ` +
            `Either a profile was deleted and the constraint was not, or the constraint has a ` +
            `typo that will accept a value nothing can read back.`,
        });
      }
    }
  }

  /* ---- each profile --------------------------------------------- */

  const signaturesSeen = new Map<string, string>();

  for (const [, profile] of entries) {
    const at = (where: string, problem: string) =>
      problems.push({ profile: profile.key, where, problem });

    if (profile.validation.against === "real-export") validatedAgainstRealExport += 1;
    else if (profile.validation.notValidated.trim() === "") {
      at(
        "validation",
        `has not been validated against a real export and its \`notValidated\` sentence is ` +
          `empty. That sentence is what reaches the customer's screen next to the word ` +
          `"supported"; blank, the profile claims more than it has earned.`,
      );
    }
    if (profile.validation.evidence.trim() === "") {
      at("validation", "states no evidence. A validation basis nobody can check is a word.");
    }

    for (const format of profile.dateFormats) {
      if (!(CIVIL_DATE_FORMATS as readonly string[]).includes(format)) {
        at("dateFormats", `names "${format}", which no reader in \`dates.ts\` implements.`);
      }
    }
    for (const style of profile.negativeStyles) {
      if (!(NEGATIVE_STYLES as readonly string[]).includes(style)) {
        at("negativeStyles", `names "${style}", which no reader in \`amounts.ts\` implements.`);
      }
    }

    /* ---- the fallback is a different kind of thing ---------------- */

    if (profile.fallback) {
      if (
        profile.exports.length > 0 ||
        profile.dateFormats.length > 0 ||
        profile.negativeStyles.length > 0 ||
        profile.fileNameHints.length > 0
      ) {
        at(
          "fallback",
          `is the fallback and carries priors of its own. The fallback is what a file that ` +
            `matched nothing is read as, so a prior here fires on EVERY file in the product — ` +
            `including the six recognised systems, before their own profile is consulted.`,
        );
      }
      continue;
    }

    if (profile.exports.length === 0) {
      at(
        "exports",
        "describes no export. A profile with nothing to recognise can never be detected, so " +
          "everything else in it is data that looks alive and is not.",
      );
    }
    if (profile.dateFormats.length === 0) {
      at(
        "dateFormats",
        "names no date format. Then it can never break a tie between day-first and month-first, " +
          "which is the single ambiguity a profile is most useful for.",
      );
    }
    if (profile.negativeStyles.length === 0) {
      at("negativeStyles", "names no way of writing a negative.");
    }

    /* ---- each export ---------------------------------------------- */

    for (const entry of profile.exports) {
      exports += 1;
      headerSpellings += entry.headers.length;
      const where = `export "${entry.id}"`;

      if (entry.signature.length < MIN_SIGNATURE_HEADERS) {
        at(
          where,
          `has a ${entry.signature.length}-heading signature and needs at least ` +
            `${MIN_SIGNATURE_HEADERS}. One heading fires on any file containing that word, and a ` +
            `confident wrong prior is worse than an absent one.`,
        );
      }

      const normalised = entry.signature.map((h) => normaliseHeader(h));
      if (new Set(normalised).size !== normalised.length) {
        at(
          where,
          `has two signature headings that normalise to the same string, so the signature is ` +
            `shorter than it looks and the share threshold is measured against a number that is ` +
            `not real.`,
        );
      }

      /** ⚠️ A tie nothing can break is a profile that never wins. */
      const fingerprint = [...normalised].sort().join("|");
      const owner = signaturesSeen.get(fingerprint);
      if (owner) {
        at(
          where,
          `has the same signature as ${owner}. \`detectProfile\` refuses to choose between two ` +
            `systems that tie, so both of these are unreachable — recognised as nothing, ` +
            `forever, while reading as supported.`,
        );
      } else {
        signaturesSeen.set(fingerprint, `${profile.key}/${entry.id}`);
      }

      const spellings = entry.headers.map((h) => normaliseHeader(h.spelling));
      const byNormalised = new Map<string, Set<string>>();
      entry.headers.forEach((header, index) => {
        const norm = spellings[index]!;
        byNormalised.set(norm, (byNormalised.get(norm) ?? new Set()).add(header.field));
      });
      for (const [norm, fields] of byNormalised) {
        if (fields.size > 1) {
          at(
            where,
            `maps the heading "${norm}" to ${[...fields].join(" and ")}. One heading cannot be ` +
              `two fields; whichever is read first wins and the other silently never matches.`,
          );
        }
      }

      /* ---- the destination ---------------------------------------- */

      if (entry.destination.kind === "entity") {
        const entity = (ALL_IMPORT_ENTITIES as Record<string, unknown>)[entry.destination.entity];
        if (!Object.hasOwn(ALL_IMPORT_ENTITIES, entry.destination.entity) || !entity) {
          at(
            where,
            `names the entity "${entry.destination.entity}", which is not in ` +
              `\`ALL_IMPORT_ENTITIES\`. The write path dispatches with \`if\` chains, so an ` +
              `unhandled destination compiles cleanly and falls through at runtime: this export ` +
              `would be offered to the customer and go nowhere.`,
          );
          continue;
        }

        reachableExports += 1;
        const definition = entity as {
          columns: readonly { field: string; required: boolean }[];
        };
        const fields = new Set(definition.columns.map((c) => c.field));

        for (const header of entry.headers) {
          if (!fields.has(header.field)) {
            at(
              where,
              `maps "${header.spelling}" to the field "${header.field}", which ` +
                `"${entry.destination.entity}" does not have. This is what a rename on the ` +
                `entity side looks like from here, and the prior it produces would be handed to ` +
                `a mapper with no column to put it against.`,
            );
          }
        }

        /**
         * 🔴 EXACTLY, IN BOTH DIRECTIONS. See the header.
         */
        const covered = new Set(entry.headers.map((h) => h.field));
        const computed = definition.columns
          .filter((c) => c.required && !covered.has(c.field))
          .map((c) => c.field)
          .sort();
        const declared = [...entry.missingRequired].sort();

        const overclaimed = declared.filter((f) => !computed.includes(f));
        const understated = computed.filter((f) => !declared.includes(f));

        if (understated.length > 0) {
          exportsMissingRequired.push(`${profile.key}/${entry.id}`);
          at(
            where,
            `does not declare ${understated.map((f) => `"${f}"`).join(", ")} in ` +
              `\`missingRequired\`, and "${entry.destination.entity}" requires ` +
              `${understated.length === 1 ? "it" : "them"} while this export has no column for ` +
              `${understated.length === 1 ? "it" : "them"}. Undeclared, the customer is told ` +
              `this export is supported and finds out at upload.`,
          );
        } else if (declared.length > 0) {
          exportsMissingRequired.push(`${profile.key}/${entry.id} → ${declared.join(", ")}`);
        }

        if (overclaimed.length > 0) {
          at(
            where,
            `declares ${overclaimed.map((f) => `"${f}"`).join(", ")} as missing and this export ` +
              `does have ${overclaimed.length === 1 ? "a column" : "columns"} for ` +
              `${overclaimed.length === 1 ? "it" : "them"}. A stale warning trains the customer ` +
              `to edit a file that did not need editing, and to ignore the next one.`,
          );
        }
      } else {
        if (Object.hasOwn(ALL_IMPORT_ENTITIES, entry.destination.plannedEntity)) {
          at(
            where,
            `is marked \`not-yet-importable\` and its planned entity ` +
              `"${entry.destination.plannedEntity}" now EXISTS in \`ALL_IMPORT_ENTITIES\`. The ` +
              `phase that built it did not come back. The customer is being told Ordence cannot ` +
              `take a file it can take.`,
          );
        }
        if (entry.destination.because.trim() === "") {
          at(
            where,
            "cannot be imported and does not say why. That sentence is the whole of what the " +
              "customer gets; without it the answer is a shrug.",
          );
        }
        if (entry.missingRequired.length > 0) {
          at(
            where,
            "declares missing required fields against a destination that is not an entity. " +
              "There is nothing to compute that list from, so it cannot be checked and will " +
              "drift.",
          );
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    census: {
      profiles: entries.length,
      exports,
      headerSpellings,
      reachableExports,
      validatedAgainstRealExport,
      exportsMissingRequired,
    },
  };
}
