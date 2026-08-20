/**
 * Ordence — ⭐⭐⭐ WHICH SYSTEM THIS FILE CAME OUT OF, AND HOW SURE
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS RETURNS, AND WHAT IT DELIBERATELY DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * It returns an IDENTIFICATION and a set of PRIORS. It does not return a
 * column mapping, it does not touch `lib/import/proposal.ts`, and there
 * is nothing here a caller could mistake for a decision about what a
 * column means.
 *
 * That is the subordination rule made structural rather than promised:
 *
 *   • `lib/import/shapes.ts` decides what a COLUMN is, from its values.
 *   • This file decides what the FILE is, from its header row.
 *   • The two answer different questions, so the second cannot overrule
 *     the first — there is no channel between them through which it
 *     could.
 *
 * ⚠️ WHERE THEY DO MEET IS `priors.ts`, and that file carries the score
 * band and the measurement showing what happens if the band is ignored.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FILE NAME NEVER CREATES A MATCH
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/sources/index.ts` opens with the reason: a file name is a
 * claim by whoever renamed it, and the bytes win. The same holds one
 * level up. `tally-export.csv` full of Zoho column headings is a Zoho
 * export somebody renamed, and reading it as Tally because of its name
 * would apply Tally's date prior — `1-Apr-2026` — to a column of
 * `2026-04-01`, where it explains nothing and the resolution comes back
 * unreadable.
 *
 * ⭐ SO THE FILE NAME CONTRIBUTES NOTHING TO THE SCORE. It is consulted
 * for exactly one purpose: breaking a tie between two matches that the
 * HEADERS scored equally, and when it does that the sentence says so.
 */

import { normaliseHeader } from "../mapping";
import { DETECTABLE_PROFILES, FALLBACK_PROFILE } from "./registry";
import type { ProfileExport, SourceProfile } from "./types";

/**
 * 🔴 TWO, NOT ONE. A one-header signature fires on any file containing
 * that word — `Name`, `Date`, `Amount` — and a confident wrong prior is
 * worse than an honest absent one, because the absent one leaves the
 * generic path exactly as good as it was.
 */
export const MIN_SIGNATURE_HEADERS = 2;

/**
 * ⚠️ TWO THIRDS RATHER THAN ALL, AND THE REASON IS VERSIONS. Systems add
 * and remove columns between releases; a signature that had to match
 * completely would stop recognising Zoho Books the first time Zoho adds a
 * column to `Contacts.csv`, and the profile would silently become dead
 * data that still looks alive. Combined with the floor above, a
 * three-header signature needs two of its three.
 */
export const MIN_SIGNATURE_SHARE = 2 / 3;

export type ProfileMatch = {
  readonly profileKey: string;
  readonly profileLabel: string;
  readonly exportId: string;
  readonly exportTitle: string;
  /** Matched signature headers over total, 0..1. Headers only. */
  readonly score: number;
  readonly matched: readonly string[];
  readonly missing: readonly string[];
  /** The file-name fragment that agreed, if one did. Never scored. */
  readonly fileNameMatched: string | null;
};

export type ProfileDetectionBasis =
  /**
   * 🔴 THE BYTES SAID SO, WHICH IS STRONGER THAN ANY HEADER ROW.
   * `detectFormat` recognises a Tally envelope from the file's own
   * markup — `<ENVELOPE>`, `<TALLYMESSAGE>` — and a file that IS a Tally
   * XML export came out of Tally. No column heading is needed and none
   * can contradict it.
   */
  | "file-bytes"
  /** The header row identified one export and nothing tied with it. */
  | "signature"
  /** Two matches tied on headers and the file name told them apart. */
  | "signature-and-file-name"
  /** ⚠️ Two matches tied and nothing broke it. The fallback is used. */
  | "ambiguous"
  /** Nothing scored high enough. The ordinary generic path. */
  | "no-match"
  | "no-headers";

export type ProfileDetection = {
  /** ⭐ Always a profile. The fallback IS an answer — see `catalogue.ts`. */
  readonly profile: SourceProfile;
  /** The export that was recognised, or null when the fallback is in use. */
  readonly match: ProfileMatch | null;
  readonly runnersUp: readonly ProfileMatch[];
  readonly basis: ProfileDetectionBasis;
  readonly why: string;
};

function scoreExport(
  profile: SourceProfile,
  entry: ProfileExport,
  present: ReadonlySet<string>,
  fileName: string | undefined,
): ProfileMatch | null {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const header of entry.signature) {
    if (present.has(normaliseHeader(header))) matched.push(header);
    else missing.push(header);
  }

  if (matched.length < MIN_SIGNATURE_HEADERS) return null;
  const score = matched.length / entry.signature.length;
  if (score < MIN_SIGNATURE_SHARE) return null;

  const lowered = (fileName ?? "").toLowerCase();
  const hint =
    lowered === ""
      ? null
      : ([...entry.fileNameHints, ...profile.fileNameHints].find((h) => lowered.includes(h)) ??
        null);

  return {
    profileKey: profile.key,
    profileLabel: profile.label,
    exportId: entry.id,
    exportTitle: entry.title,
    score,
    matched,
    missing,
    fileNameMatched: hint,
  };
}

/**
 * ⭐⭐⭐ THE FUNCTION. Pure: a header row, a name, an answer.
 */
export function detectProfile(
  headerRow: readonly string[],
  options: {
    readonly fileName?: string;
    /**
     * ⭐ SET WHEN THE FILE'S OWN BYTES ALREADY IDENTIFIED THE SYSTEM.
     * `readSource` passes `"tally"` for a file `detectFormat` read as a
     * Tally envelope. ⚠️ It is a PROFILE KEY and not a free string: an
     * unknown key falls through to ordinary detection rather than
     * inventing a profile, because a caller's typo must not become a
     * system Ordence claims to support.
     */
    readonly knownProfile?: string;
  } = {},
): ProfileDetection {
  if (options.knownProfile !== undefined) {
    const known = DETECTABLE_PROFILES.find((p) => p.key === options.knownProfile);
    if (known) {
      return {
        profile: known,
        match: null,
        runnersUp: [],
        basis: "file-bytes",
        why:
          `This file is a ${known.label} export — that was read from the file's own markup ` +
          `rather than from its column headings, so nothing about its name or its columns can ` +
          `contradict it.`,
      };
    }
  }

  const present = new Set(
    headerRow.map((h) => normaliseHeader(h)).filter((h) => h !== ""),
  );

  if (present.size === 0) {
    return {
      profile: FALLBACK_PROFILE,
      match: null,
      runnersUp: [],
      basis: "no-headers",
      why: "This file has no column headings, so there is nothing to recognise a source system from.",
    };
  }

  const matches: ProfileMatch[] = [];
  for (const profile of DETECTABLE_PROFILES) {
    for (const entry of profile.exports) {
      const match = scoreExport(profile, entry, present, options.fileName);
      if (match) matches.push(match);
    }
  }

  matches.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);

  if (matches.length === 0) {
    return {
      profile: FALLBACK_PROFILE,
      match: null,
      runnersUp: [],
      basis: "no-match",
      why:
        `None of the ${DETECTABLE_PROFILES.length} source systems Ordence knows matched this ` +
        `file's column headings, so it is being read on the headings themselves and on what the ` +
        `values look like.`,
    };
  }

  const best = matches[0]!;
  /**
   * ⚠️ A TIE IS ONLY A TIE ACROSS DIFFERENT PROFILES. Two exports of the
   * SAME system scoring alike is not a problem to report — a Zoho
   * contacts file feeds both the `companies` and the `gst-parties`
   * destinations, on purpose, and both carry the same date and negative
   * priors because they are the same system.
   */
  const tied = matches.filter(
    (m) => m.score === best.score && m.matched.length === best.matched.length,
  );
  const tiedProfiles = new Set(tied.map((m) => m.profileKey));
  const runnersUp = matches.slice(1, 4);

  const describe = (m: ProfileMatch) =>
    `${m.matched.length} of ${m.matched.length + m.missing.length} headings that identify a ` +
    `${m.profileLabel} export (${m.matched.map((h) => `"${h}"`).join(", ")})`;

  if (tiedProfiles.size === 1) {
    return {
      profile: profileOf(best.profileKey),
      match: best,
      runnersUp,
      basis: "signature",
      why:
        `This file was recognised as ${best.profileLabel} — ${best.exportTitle}. It has ` +
        `${describe(best)}.`,
    };
  }

  /**
   * 🔴 A TIE BETWEEN TWO SYSTEMS. The file name is allowed to break it
   * and nothing else is — see the header. If exactly one of the tied
   * matches has a name that agrees, that one wins and the sentence says
   * the name is why.
   */
  const named = tied.filter((m) => m.fileNameMatched !== null);
  const namedProfiles = new Set(named.map((m) => m.profileKey));

  if (named.length > 0 && namedProfiles.size === 1) {
    const winner = named[0]!;
    return {
      profile: profileOf(winner.profileKey),
      match: winner,
      runnersUp: tied.filter((m) => m !== winner).slice(0, 3),
      basis: "signature-and-file-name",
      why:
        `This file's headings match ${[...tiedProfiles].length} source systems equally ` +
        `(${[...new Set(tied.map((m) => m.profileLabel))].join(", ")}). It was read as ` +
        `${winner.profileLabel} because its name contains "${winner.fileNameMatched}". ` +
        `⚠️ A file name is a claim by whoever saved it — check the first few rows.`,
    };
  }

  /**
   * ⚠️ NOBODY WINS, AND THAT IS REPORTED RATHER THAN RESOLVED. Picking
   * either one would apply a date order and a negative convention on the
   * strength of a coin flip. The fallback carries no priors, so the
   * generic path is exactly as good as it was before this phase existed.
   */
  return {
    profile: FALLBACK_PROFILE,
    match: null,
    runnersUp: tied.slice(0, 4),
    basis: "ambiguous",
    why:
      `This file's headings match ${tiedProfiles.size} source systems equally well ` +
      `(${[...new Set(tied.map((m) => m.profileLabel))].join(", ")}) and its name does not say ` +
      `which. Nothing has been assumed about its date order or how it writes a negative — those ` +
      `are read from the values instead.`,
  };
}

function profileOf(key: string): SourceProfile {
  return DETECTABLE_PROFILES.find((p) => p.key === key) ?? FALLBACK_PROFILE;
}

/* ------------------------------------------------------------------ */
/* THE SENTENCES                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHAT THE CUSTOMER READS, AND WHERE THE HONESTY MEMBER SURFACES.
 *
 * `readSource` puts these into `SourceTable.notes`, which the wizard
 * already renders. That matters more than it looks: `validation` and
 * `missingRequired` are the two members that stop "supported" meaning
 * "will work", and a required member that never reaches a screen is a
 * comment. These are the screen.
 */
export function describeProfileDetection(detection: ProfileDetection): string[] {
  const notes: string[] = [detection.why];

  const { profile, match } = detection;

  if (!match) {
    /**
     * ⚠️ THE `notValidated` SENTENCE STILL APPLIES ON THE `file-bytes`
     * PATH. Knowing WHICH system produced a file says nothing about
     * whether this profile's spellings and priors were ever checked
     * against one, and those are the two different claims this member
     * exists to keep apart.
     */
    if (detection.basis === "file-bytes" && profile.validation.against !== "real-export") {
      notes.push(`⚠️ ${profile.validation.notValidated}`);
    }
    if (detection.basis === "no-match" || detection.basis === "file-bytes") {
      notes.push(...profile.notes);
    }
    return notes;
  }

  /** 🔴 The qualifier that must travel with the word "supported". */
  if (profile.validation.against !== "real-export") {
    notes.push(
      `⚠️ ${profile.validation.notValidated} What Ordence knows about ${profile.label} is a ` +
        `starting point, not a guarantee — check the first few rows of the preview against your ` +
        `own screen before committing.`,
    );
  }

  const entry = profile.exports.find((e) => e.id === match.exportId);
  if (entry) {
    if (entry.destination.kind === "not-yet-importable") {
      notes.push(
        `Ordence recognised this as ${profile.label}'s "${entry.title}", and cannot import it ` +
          `yet. ${entry.destination.because}`,
      );
    } else if (entry.missingRequired.length > 0) {
      notes.push(
        `⚠️ A ${profile.label} ${entry.title} has no column for ` +
          `${entry.missingRequired.map((f) => `"${f}"`).join(" or ")}, which Ordence requires. ` +
          `Add ${entry.missingRequired.length === 1 ? "that column" : "those columns"} to the ` +
          `file before uploading, or the run will be refused before any row is read.`,
      );
    }
  }

  notes.push(...profile.notes);
  return notes;
}
