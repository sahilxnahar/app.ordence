#!/usr/bin/env node
/**
 * Ordence , GATE 27: A TRACK MAY ONLY WRITE INSIDE ITS OWN BLOCK
 * Version: v1.82.0-alpha - Infra wave 14
 *
 * WHY
 * ---
 * Waves 14 to 16 run seven tracks in parallel against one repository.
 * Ownership is exclusive and is written down in `track-ownership.json`.
 *
 * A RULE NOBODY CAN CHECK IS A SUGGESTION. Every coordination rule in
 * this project that had no gate behind it drifted within two waves.
 * This is the gate.
 *
 * IT ALSO CHECKS THE MAP ITSELF. Two tracks owning the same path, or two
 * tracks whose SQL blocks overlap, is the same defect one level up, and
 * would not otherwise surface until two zips collided at integration.
 *
 * USAGE
 *   node scripts/check-track-ownership.mjs
 *       validate the map only. This is what CI runs.
 *
 *   node scripts/check-track-ownership.mjs --tree
 *       validate SQL-FILES on disk: every migration above the legacy
 *       high-water mark must fall inside exactly one track's block.
 *
 *   node scripts/check-track-ownership.mjs --track A --files list.txt
 *       validate a delivered track. `list.txt` is one repo-relative path
 *       per line, which is what `unzip -Z1 ordence-track-A.zip` prints.
 *
 * EXIT  0 fine   1 violation   78 EX_CONFIG (map unreadable)
 */
import fs from "node:fs";
import path from "node:path";

const MAP_PATH = path.join(import.meta.dirname, "track-ownership.json");

let MAP;
try {
  MAP = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
} catch (err) {
  console.error("check:track-ownership , cannot read " + MAP_PATH + ": " + err.message);
  process.exit(78);
}

/**
 * ANCHORED AT BOTH ENDS. An unanchored regex makes `lib/cache/**` match
 * `server/lib/cache/x.ts`, silently handing one track another track's
 * files, which is the exact failure this gate exists to prevent.
 */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:[^/]*/)*"; }
        else { out += ".*"; }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += /[.+^${}()|[\]\\?]/.test(c) ? "\\" + c : c;
  }
  return new RegExp("^" + out + "$");
}

/** A track may carve a hole in its own broad glob, lending it elsewhere. */
function excluded(track, file) {
  return (track.excludes || []).some((e) => globToRegExp(e).test(file) ||
    file.startsWith(e.replace(/\/?\*+.*$/, "") + "/"));
}

const problems = [];
const entries = Object.entries(MAP.tracks);

// 1. The map must not contradict itself.
for (let i = 0; i < entries.length; i++) {
  const [aL, a] = entries[i];
  for (const s of MAP.shared) {
    if (!a.ownsShared && a.paths.some((p) => globToRegExp(p).test(s))) {
      problems.push("track " + aL + ' claims shared file "' + s + '", owned by integration only');
    }
  }
  for (let j = i + 1; j < entries.length; j++) {
    const [bL, b] = entries[j];
    for (const pa of a.paths) {
      for (const pb of b.paths) {
        if (excluded(a, pb) || excluded(b, pa)) continue;
        const ra = globToRegExp(pa), rb = globToRegExp(pb);
        const rootA = pa.replace(/\/?\*+.*$/, ""), rootB = pb.replace(/\/?\*+.*$/, "");
        const probeA = pa.includes("*") ? rootA + "/__probe__.ts" : pa;
        const probeB = pb.includes("*") ? rootB + "/__probe__.ts" : pb;
        if (rootA && rootB && (ra.test(probeB) || rb.test(probeA))) {
          problems.push("tracks " + aL + " and " + bL + ' both claim: "' + pa + '" vs "' + pb + '"');
        }
      }
    }
    if (a.sql && b.sql && a.sql[0] <= b.sql[1] && b.sql[0] <= a.sql[1]) {
      problems.push("tracks " + aL + " and " + bL + " have overlapping SQL blocks: " +
        a.sql.join("-") + " and " + b.sql.join("-"));
    }
  }
}

/**
 * 2. The tree, if asked. `check:migrations` already refuses duplicates
 * and gaps. What it cannot know is that 0140 belongs to track C and
 * nobody else, so a migration landing in someone else's block reads as
 * perfectly well-formed until two waves collide.
 */
if (process.argv.includes("--tree")) {
  const dir = path.join(import.meta.dirname, "..", "SQL-FILES");
  const owners = new Map();
  for (const [L, t] of entries) {
    if (!t.sql) continue;
    /** A track may hold more than one range; H holds a used block and a reserve. */
    for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
      for (let n = lo; n <= hi; n++) owners.set(n, L);
    }
  }
  let seen = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d{4})_.+\.sql$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n <= MAP.legacyMaxSql) continue;
    seen++;
    if (!owners.has(n)) {
      problems.push("SQL-FILES/" + name + " uses " + m[1] + ", which is in no track's block");
    }
  }
  if (problems.length === 0) {
    console.log("OK SQL blocks , " + seen + " post-" + MAP.legacyMaxSql + " migration(s), all inside an allocated block");
  }
}

// 3. A delivered track, if one was named.
const argv = process.argv.slice(2);
const trackFlag = argv.indexOf("--track");
const filesFlag = argv.indexOf("--files");
let checkedFiles = 0;
let letter = null;

if (trackFlag !== -1) {
  letter = (argv[trackFlag + 1] || "").toUpperCase();
  const track = MAP.tracks[letter];
  if (!track) { console.error('check:track-ownership , unknown track "' + letter + '"'); process.exit(78); }
  if (filesFlag === -1) { console.error("check:track-ownership , --track needs --files"); process.exit(78); }

  const files = fs.readFileSync(argv[filesFlag + 1], "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.endsWith("/"));

  const owned = track.paths.map(globToRegExp);
  const ALWAYS_ALLOWED = [/^TRACK-REPORT\.md$/, new RegExp("^PATCH-REQUEST-" + letter + "\\.md$")];

  for (const f of files) {
    checkedFiles++;
    if (ALWAYS_ALLOWED.some((r) => r.test(f))) continue;
    /**
     * The three shared files belong to integration. `ownsShared` is what
     * makes that concrete on delivery, not merely on map validation ,
     * the first version checked it in one place and not the other, which
     * is the same declared-and-unenforced shape this repo keeps growing.
     */
    if (track.ownsShared && MAP.shared.includes(f)) continue;
    /**
     * An explicit, argued exception recorded in the map. Editing an
     * already-applied migration is normally forbidden; it is permitted
     * only where the file ABORTS the sequence, because then no later file
     * can repair it , the pipeline never reaches one.
     */
    if ((track.repairsInPlace ?? []).includes(f)) continue;
    /** Paths any track may deliver. Drills are inert by name. */
    if ((MAP.anyTrack ?? []).some((g) => globToRegExp(g).test(f))) continue;
    /**
     * SQL-FILES IS OWNED BY NUMBER, NOT BY DIRECTORY. Six tracks ship
     * migrations into one folder. Owning the folder would mean owning
     * everyone's migrations, so the block is the unit of ownership.
     */
    const m = /^SQL-FILES\/(\d{4})_/.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (!track.sql) {
        problems.push("track " + letter + " delivered " + f + " but has no SQL block allocated");
      } else if (n < track.sql[0] || n > track.sql[1]) {
        problems.push("track " + letter + " delivered " + f + ", outside its block " + track.sql.join(" to "));
      }
      continue;
    }
    /**
     * An unnumbered file in SQL-FILES , a VERIFY, a DRILL, a read-only
     * checker , is an ordinary owned path. The first version refused
     * them outright, which made my own delivery illegal.
     */
    if (excluded(track, f) || !owned.some((r) => r.test(f))) {
      problems.push("track " + letter + " wrote outside its ownership: " + f);
    }
  }
}

if (problems.length > 0) {
  console.error("check:track-ownership , violations:\n");
  for (const p of problems) console.error("  x " + p);
  console.error("\n" + problems.length + " violation(s).");
  process.exit(1);
}

if (process.argv.includes("--tree") && !letter) process.exit(0);

console.log(letter
  ? "OK track " + letter + ": " + checkedFiles + " delivered files, all inside its block"
  : "OK ownership map consistent , " + entries.length + " tracks, no overlapping paths or SQL blocks");
