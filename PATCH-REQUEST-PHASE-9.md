# PATCH-REQUEST-PHASE-9 — what Phase 9 needed outside its ownership block

**Base `v1.84.1-alpha`. Phase 9, source adapters.** Block: `lib/import/sources/**`,
`lib/import/profiles/**`, SQL `0275`–`0284`.

Every item below is a change Phase 9 could have made and did not, because the
file belongs to another stream. They are ordered by consequence, not by size.

**Nothing here blocks the Phase 9 zip from being applied.** §1, §7 and §8 change
what the phase is worth; §2 to §6 are the wiring it is waiting on. §9 is the
one ownership deviation in the delivery, declared.

Every claim below is followed by the command that produced it.

---

## 1. 🔴 A column NAMED for a thing beats a column that CONTAINS it — and `lib/import/proposal.ts` says the opposite

**File:** `lib/import/proposal.ts` (Track M1). Four lines.

### The measurement

```
SCORE.EXACT_HEADER    1.00
SCORE.ALIAS           0.95
SCORE.DECISIVE_SHAPE  0.90     ← "Every value is unmistakably this thing.
                                  Stronger than a good name."
AUTO_COMMIT_THRESHOLD 0.90
```

The comment on `DECISIVE_SHAPE` and the number under it disagree, and in
`candidatesFor` the exact-header and alias branches `return` **before the value
evidence is looked at at all**.

The file this produces is the one `lib/import/shapes.ts` opens by describing —
a column headed `GSTIN` that holds PANs, next to a column called `F7` that
holds the real GSTINs:

```
tests/ui/import-profiles.test.ts
  🔴 and the CANONICAL heading already does the same thing, before any profile
```

measured against `gst-parties` exactly as M1 ships it:

| headings | who wins `gstin` | basis | confidence |
|---|---|---|---|
| `Legal name`, `GSTIN`, `F7` | **`GSTIN` — the PAN column** | `exact-header` | 1.00 |
| `Legal name`, `GST Identification Number (GSTIN)`, `F7` | `F7` — the real GSTINs | `value-shape` | 0.90 |

⚠️ **1.00 is at `AUTO_COMMIT_THRESHOLD`.** A workspace with auto-commit on
migrates four hundred parties with their PAN in the GSTIN column, with nothing
on screen saying it was a guess.

**This is not Phase 9's doing and Phase 9 has not worked around it.** It is
reported because writing the profile priors is what surfaced it.

### What Phase 9 needs, which is the smaller half of the same change

Profile header spellings must be scored **strictly below `DECISIVE_SHAPE`**.
They are not merged into `ImportColumn.aliases`, and this is why:

```
tests/ui/import-profiles.test.ts
  🔴 THE HAZARD: the same spelling merged into `aliases` inverts that
```

With `"GST Identification Number (GSTIN)"` appended to that column's `aliases`
— the one-line implementation — the PAN column wins with `basis: "alias"`. One
alias is one exposure; merging the profiles would add **156 spellings across
seven systems** at 0.95.

### The patch

In `lib/import/proposal.ts`, add the band and the source:

```ts
export const SCORE = Object.freeze({
  EXACT_HEADER: 1.0,
  ALIAS: 0.95,
  DECISIVE_SHAPE: 0.9,
  /**
   * ⭐ PHASE 9. A spelling a RECOGNISED SOURCE SYSTEM uses for this
   * column. Better than two headings sharing a word; strictly worse than
   * every value in the column being unmistakably this thing, and — as a
   * consequence that matters more — strictly below AUTO_COMMIT_THRESHOLD,
   * so a column mapped only on a profile's say-so always needs a person.
   */
  PROFILE_HEADER: 0.85,
  TOKEN_CONTAINMENT: 0.7,
  MODEL_ONLY: 0.55,
  TOKEN_OVERLAP: 0.4,
});
```

and a fourth evidence source in `ProposeOptions`, checked after `alias` and
before the value shape:

```ts
export type ProposeOptions = {
  readonly sampleRows?: readonly (readonly string[])[];
  readonly model?: ModelProposal;
  /** ⭐ PHASE 9 · `profileHeaderPriors(detection)` from lib/import/profiles. */
  readonly profilePriors?: readonly { field: string; spellings: readonly string[]; why: string }[];
};
```

```ts
      // inside candidatesFor, after the aliasSet branch:
      const prior = options.profilePriors?.find((p) => p.field === column.field);
      if (prior?.spellings.some((s) => normaliseHeader(s) === normalised)) {
        out.push({
          index,
          confidence: SCORE.PROFILE_HEADER,
          basis: "profile-header",
          why: prior.why,
        });
        return;
      }
```

`"profile-header"` joins `ProposalBasis`. `lib/import/profiles/priors.ts`
already exports the data in exactly that shape and
`PROFILE_HEADER_SCORE = 0.85` is asserted against `SCORE` in the test file, so
the two constants cannot drift apart silently.

### And the larger half, which is M1's call and not ours

Whether `EXACT_HEADER` and `ALIAS` should outrank `DECISIVE_SHAPE` at all is a
decision about M1's own evidence ordering. Phase 9 has no opinion it is
entitled to; it has a failing case, which is in the test file above.

---

## 2. ⚠️ Busy and Marg write the SIGN of an amount in a SEPARATE COLUMN, and a profile cannot say that

**File:** wherever the mapping layer lands — most likely `lib/import/plan.ts`
(M1) or `server/import/dryrun.ts` (PHASE-3). **Not** `lib/import/profiles`.

A Busy account master exports `Opening Balance` = `12500.00` with a `Dr/Cr`
column beside it saying which. `NegativeStyleKey` is a per-cell fact:
`applyNegativeStyle` sees one string and the sign is in a different cell of the
same row.

Measured today, a Busy balance column resolves as:

> No value in the first 200 of this column is negative, so how this file marks
> one did not have to be decided.

which is **true of that column** and is exactly why it matters — every credit
balance comes through positive and the opening trial balance foots to something
that is not the customer's books.

🔴 **The tempting fix is a `signColumn` member on the profile and a special
case in the coercion path, and that is the thing this phase exists not to do.**
It is a relationship between two columns, so it belongs in the layer that
already knows about more than one column at a time. Until it exists, the Busy
and Marg profiles carry a `notes` sentence telling the customer to check the
Dr/Cr column themselves, and `describeProfileDetection` puts it on the screen.

---

## 3. 🔴 Every source system exports a vendor NAME. `opening-vendor-bills` requires a vendor CODE, and says "not their name"

**File:** `lib/import/opening-entities.ts` (Track M1 / Phase 8).

`opening-vendor-bills.vendorCode` is `required: true` and its help reads:

> "The vendor's code in Ordence, such as V-0042 — **not their name**."

`opening-customer-invoices` takes `customerName`. The asymmetry is deliberate
in the entity and fatal at the file:

```
node -e '…checkSourceProfiles(SOURCE_PROFILES)…'   → census.exportsMissingRequired
  tally/bills-payable        → vendorCode
  zoho-books/vendor-balances → vendorCode
  quickbooks/unpaid-bills    → vendorCode
  xero/aged-payables         → vendorCode
```

**Four of four.** Every payables export from every system Ordence knows carries
a party name and no code. None of the four profiles maps it — mapping a name
into a code column would satisfy the header check and then write the customer's
vendor names into `vendor_code`. Left unmapped, the run is refused before any
row is read, with `describeMissingHeaders` naming the column, which is a
failure the customer can act on.

**What would fix it:** either a `vendorName` column on that entity resolved by
lookup the way `customerName` is, or an explicit statement in the entity that
opening vendor bills require the customer to add a code column by hand. Phase 9
has no view on which; it has the count.

---

## 4. ⚠️ `normaliseHeader` cannot tell `Account` from `Account #`

**File:** `lib/import/mapping.ts` (Track M1). Reported, not requested.

`normaliseHeader` strips everything that is not a letter or a digit, so a
QuickBooks trial balance's `Account` and `Account #` both normalise to
`account`. Declaring them as two fields produced a real refusal from the
Phase 9 checker while this profile was being written:

```
PROBLEM quickbooks | export "trial-balance" |
  maps the heading "account" to accountName and accountCode.
  One heading cannot be two fields; whichever is read first wins and
  the other silently never matches.
```

The QuickBooks profile therefore declares `accountCode` as missing, which is
true of what Ordence can **read** even when the column is present.

⚠️ **Loosening the normaliser is not the fix.** It is aggressive on purpose and
that is load-bearing: `*ContactName` matching `contactname` is what makes Xero
exports work without the customer editing anything. This is recorded so the
next person to meet it does not "fix" the normaliser.

---

## 5. 🔴 `readVoucher` reads only `ALLLEDGERENTRIES.LIST`, and a voucher with no legs reads as balanced

**File:** `lib/tally/parse.ts`. One line.

```ts
  for (const entry of findAll(node, "ALLLEDGERENTRIES.LIST")) {
```

Tally writes `LEDGERENTRIES.LIST` for some voucher classes. A voucher whose
legs are under that element arrives with `legs: []`, `totalDebitMinor: 0n`,
`totalCreditMinor: 0n` — and **zero equals zero**, so it reads as perfectly
balanced everywhere downstream.

```
tests/ui/import-profiles.test.ts
  🔴 a voucher whose legs are under <LEDGERENTRIES.LIST> reads as balanced and is not
```

Against an envelope with three vouchers written that way, `ledger-masters`
returns a header row and nothing else. Phase 9's two new allocation views read
**both** elements, count the discrepancy and report it in a note, which is a
diagnostic rather than a fix.

**The patch:**

```ts
  for (const element of ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"] as const) {
    for (const entry of findAll(node, element)) {
      // … unchanged body …
    }
  }
```

⚠️ **`findAll` is a descendant walk, so the two element names must not nest.**
They do not in any export seen; if a future one does, the loop double-counts,
and that is worth a `seen` set at the time rather than now.

**Also worth exposing:** `parseTallyExport` discards its parse tree. Phase 9's
cost-centre and bill-wise views call `parseXml(source)` a second time to reach
the allocation lists, because `ParsedTallyLeg` models a ledger name, a
direction and an amount and allocations are below that level. Returning `root`
on `ParsedTallyExport` would remove one full pass over a file that can be ten
megabytes. Not urgent; measured as one extra O(n) walk.

---

## 6. ⚠️ Gate 30 — the profile list lives in two places and nothing compares them

**Files:** `scripts/check-import-profiles.mjs` (new), `package.json`,
`scripts/gates.mjs`, `.github/workflows/*` — all Track H.

This is gate 20's failure one column over, and `SQL-FILES/0275` says so in its
header: a profile the reader can produce and
`import_runs_source_profile_known` refuses would produce a migration that reads
the file, writes forty thousand rows and **then** fails at the run record.

`tests/ui/import-profiles.test.ts` already reads `0275`, pulls the literals out
of the constraint and compares them to the registry, in both directions. That
is a test, not a gate. The script below is the gate, written to the shape of
`scripts/check-import-contract.mjs` — it runs the real checker through `tsx`
against the real modules rather than regexing the source, and prints its census
on success.

```js
#!/usr/bin/env node
/**
 * Ordence — GATE 30: THE SOURCE PROFILES AGREE WITH THE SCHEMA AND THE SQL
 * Version: v1.84.1-alpha · Phase 9, wired by Track H
 *
 * Five places, the same discipline as gate 20:
 *   ① lib/import/profiles/registry.ts   → SOURCE_PROFILES, the one map
 *   ② lib/import/profiles/check.ts      → the rules, run against it
 *   ③ SQL-FILES/0275_*.sql              → the CHECK constraint
 *   ④ db/schema/import-runs.ts          → the Drizzle mirror (see §8)
 *   ⑤ tests/ui/import-profiles.test.ts  → a file somebody actually read
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "lib/import/profiles/registry.ts";
const CHECK = "lib/import/profiles/check.ts";
const SQL = "SQL-FILES/0275_import_runs_source_profile.sql";

for (const f of [REGISTRY, CHECK, SQL]) {
  if (!existsSync(f)) {
    console.error(`🔴 check:import-profiles , ${f} is missing.`);
    console.error("   This gate reads the real registry through the real checker.");
    process.exit(1);
  }
}

/** ⚠️ Comments stripped, so a key mentioned only in prose cannot satisfy the list. */
const sql = readFileSync(SQL, "utf8").replace(/^\s*--[^\n]*$/gm, " ");
const constraint =
  /ADD CONSTRAINT\s+import_runs_source_profile_known\s+CHECK\s*\(([\s\S]*?)\)\);/.exec(sql);
if (!constraint) {
  console.error(`🔴 import_runs_source_profile_known not found in ${SQL}.`);
  process.exit(1);
}
const sqlProfileKeys = [...constraint[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);

const dir = mkdtempSync(join(tmpdir(), "ordence-profiles-"));
const runner = join(dir, "run.ts");
writeFileSync(
  runner,
  `import { SOURCE_PROFILES } from "${process.cwd()}/lib/import/profiles/registry";\n` +
    `import { checkSourceProfiles } from "${process.cwd()}/lib/import/profiles/check";\n` +
    `const r = checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys: ${JSON.stringify(sqlProfileKeys)} });\n` +
    `console.log(JSON.stringify(r));\n`,
);
const proc = spawnSync("npx", ["tsx", runner], { encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });

if (proc.status !== 0) {
  console.error("🔴 check:import-profiles , the registry could not be loaded.");
  console.error(proc.stderr);
  process.exit(1);
}

const result = JSON.parse(proc.stdout.trim().split("\n").pop());

if (!result.ok) {
  console.error("\n⛔ check:import-profiles failed\n");
  for (const p of result.problems) console.error(`  • ${p.profile} · ${p.where} , ${p.problem}\n`);
  process.exit(1);
}

/** ⭐ A floor that refuses a suspiciously empty read, as gate 29 does. */
if (result.census.profiles < 2 || result.census.exports < 5) {
  console.error(
    `🔴 check:import-profiles read ${result.census.profiles} profile(s) and ` +
      `${result.census.exports} export(s). That is fewer than any real registry, so this is a ` +
      `gate reporting a green it did not earn.`,
  );
  process.exit(1);
}

console.log(
  `✅ check:import-profiles\n` +
    `   ${result.census.profiles} profiles, ${result.census.exports} exports, ` +
    `${result.census.headerSpellings} header spellings.\n` +
    `   ${result.census.reachableExports} exports reach an entity in ALL_IMPORT_ENTITIES.\n` +
    `   ${result.census.validatedAgainstRealExport} validated against a real export.\n` +
    `   ${result.census.exportsMissingRequired.length} exports are short of a required column:\n` +
    result.census.exportsMissingRequired.map((s) => `     ${s}`).join("\n"),
);
```

⚠️ **The `validatedAgainstRealExport` line is on stdout every run on purpose.**
It reads `0` today. When somebody sends us a real Busy export and that number
becomes `1`, the change is in the CI log where anybody can see it.

`package.json`: `"check:import-profiles": "node scripts/check-import-profiles.mjs"`,
plus the manifest entry `check:gate-coverage` expects.

---

## 7. ⚠️ `shapes.ts` does not recognise `1-Apr-2026` as a date, which is what Tally and Busy write

**File:** `lib/import/shapes.ts` (Track M1). One regex.

```ts
const CIVIL_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
```

Digits only. A column of `1-Apr-2026` has **no dominant shape at all**, so
`evidenceFor` reports `shape: null`, `SHAPE_SUGGESTS` contributes nothing, and
`proposeMapping` never gets value evidence for the date column of the two
systems most Ordence customers are leaving.

Found while gating Phase 9's date resolver on
`evidence.shape === "civil_date"`, which silently never fired for a Tally file.
Phase 9's resolver no longer depends on it — `resolveCivilDateFormat` requires
a format that explains **every** value, which is a stricter test than a 90%
dominant shape — but `proposeMapping` still does.

**The patch:**

```ts
/** `1-Apr-2026`, `15 Dec 25`. Tally, Busy and Xero all write it. */
const MONTH_NAME_DATE = /^\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-/ ]\d{2,4}$/i;
```

added to `TESTS` next to `civil_date`, mapping to the same `"civil_date"`
shape so `SHAPE_SUGGESTS` needs no change.

⚠️ **It must sit before `INTEGER` and after `ISO_DATE`**, for the reason that
file already gives: the specific tests run first or every code column looks
like a number.

---

## 8. The wiring `source_profile` needs to reach the run record

**Files:** `db/schema/import-runs.ts` (Track I, lent to M2 / PHASE-2),
`server/import/runs.ts` (PHASE-2), `server/actions/import.ts` (PHASE-1),
`components/settings/import-wizard.tsx` (PHASE-10).

`SQL-FILES/0275` adds the column and the constraint. Nothing writes it yet, and
a column nothing writes is a column that reads as NULL forever while looking
like it works.

**`db/schema/import-runs.ts`** — the Drizzle mirror, which `drizzle-kit`
generates from and would otherwise drop:

```ts
    sourceProfile: varchar("source_profile", { length: 20 }),
```

and, beside the existing `import_runs_source_format_known` check:

```ts
    importRunsSourceProfileKnown: check(
      "import_runs_source_profile_known",
      sql`${t.sourceProfile} IS NULL OR ${t.sourceProfile} IN ('tally', 'busy', 'marg', 'zoho-books', 'quickbooks', 'xero', 'generic')`,
    ),
```

**`server/import/runs.ts`** — `sourceProfile: args.sourceProfile ?? null` on the
insert, and on the read-back beside `sourceFormat`.

**`server/actions/import.ts`** — the browser sends it, so it is validated
against the registry and not against a string:

```ts
import { SOURCE_PROFILE_KEYS } from "@/lib/import/profiles";
// …
  sourceProfile: z.enum(SOURCE_PROFILE_KEYS).optional(),
```

⚠️ **`z.enum` over the registry keys, never `z.string()`.** The key arrives from
a browser and ends up in a lookup; `isSourceProfileKey` is `Object.hasOwn` on
the one map for the same reason.

**`components/settings/import-wizard.tsx`** — two things:

```ts
      setSourceProfile(table.profile.profile.key);   // readSource already returns it
```

and the Tally view picker, which is the part with no UI at all today:

```tsx
import { TALLY_VIEWS, TALLY_VIEW_LABELS } from "@/lib/import/sources";
// … when sourceFormat === "tally-xml", a <select> over TALLY_VIEWS,
//    re-reading the file with { tallyView } on change.
```

🔴 **`voucher-summary` has had no UI since v1.74.0-alpha and this phase adds
three more views in the same condition.** Measured:

```
$ grep -rn "tallyView" --include=*.tsx --include=*.ts app server components
(no callers)
```

That is this codebase's characteristic defect and Phase 9 has made it four
times worse rather than better. The views are reachable through
`readSource(bytes, { tallyView })` and are exercised by twelve cases in
`tests/ui/import-profiles.test.ts`; nothing a customer can click reaches them.
`TALLY_VIEWS` and `TALLY_VIEW_LABELS` are exported ready to render, and the
default view now emits a note naming the other two when the file actually
contains cost-centre or bill-wise data — so the gap is at least visible from
inside the product.

---

## 9. Ownership: one declared deviation, and the map does not merge as written

### 9.1 `tests/ui/import-profiles.test.ts` is in Track H's block

```
$ node scripts/check-track-ownership.mjs --track PHASE-9 --files phase9-files.txt
  x track PHASE-9 wrote outside its ownership: tests/ui/import-profiles.test.ts
1 violation(s).
```

**One violation, and it is the whole list.** Every other delivered file is
inside `lib/import/sources/**`, `lib/import/profiles/**` or SQL `0275`.

`vitest.config.ts` collects `tests/ui/**/*.test.{ts,tsx}` and nothing else. A
suite outside that directory is not a suite that fails — it is a suite that is
never collected, which that file's own header calls "indistinguishable from a
test that passes". The alternative was to ship no test, and the brief's
standard is that a profile verified by its own fixture is verified by a floor.

### 9.2 🔴 Merging `track-ownership-phases.json` as written turns gate 27 red

```
$ node scripts/check-track-ownership.mjs      # with the phases map merged in as instructed
check:track-ownership , violations:
  x tracks M2 and PHASE-1 both claim: "server/import/**" vs "server/import/writers/**"
  x tracks M2 and PHASE-1 have overlapping SQL blocks: 200-206 and 200-204
  x tracks M6 and PHASE-9 both claim: "lib/import/sources/**" vs "lib/import/sources/**"
  … 28 violations
```

The phases map is a **replacement** for M2–M8, not an addition: PHASE-9 is M6,
PHASE-1..PHASE-8 are M2..M5's work re-cut, and the SQL blocks 200–299 sit on
top of M2–M8's 200–226. M1 has landed and does not collide.

The merge that works, measured:

```
$ python3 - <<'EOF'
  drop tracks M2 M3 M4 M5 M6 M7 M8
  add  every track from track-ownership-phases.json
  add  "excludes" to PHASE-1 for the five per-phase writer subdirectories
       (the phases file's own _comment asks for this; the map does not encode it)
EOF
$ node scripts/check-track-ownership.mjs
OK ownership map consistent , 21 tracks, no overlapping paths or SQL blocks
$ node scripts/check-track-ownership.mjs --tree
OK SQL blocks , 33 post-128 migration(s), all inside an allocated block
```

### 9.3 ⚠️ `check-migrations.mjs` and `check-track-ownership.mjs` read the same map differently

`reservedNumbers()` in `scripts/check-migrations.mjs`:

```js
      for (let n = t.sql[0]; n <= t.sql[1]; n++) {
```

`check-track-ownership.mjs --tree`:

```js
    for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
```

**One reads `sqlAlso`, the other does not.** Track H's own reserve block
`0181`–`0195` is therefore fifteen "missing migrations" to one checker and a
properly allocated block to the other. It has been latent since wave 18 because
nothing had been numbered above `0168`; `0275` surfaces it.

Measured, with the corrected merge from §9.2 in place:

```
$ node scripts/check-migrations.mjs
::error::Missing migration 0181 … ::error::Missing migration 0195
❌ Migration numbering FAILED — 15 problem(s).      # exactly 0181–0195

$ # with reservedNumbers() reading sqlAlso, one line:
✅ Migrations contiguous — 155 files, 0001…0275 (6 documented historical gaps). Next number: 0276.
   171 numbers reserved for parallel tracks, 138 still unused.
```

**The patch,** in `scripts/check-migrations.mjs`:

```js
      for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
        for (let n = lo; n <= hi; n++) {
          reserved.set(n, `reserved for track ${letter} (${t.name}) during waves 14 to 16`);
        }
      }
```

⭐ **Phase 3 reported this independently**, from the other end of the same
block: any migration numbered 0196 or above makes `check:migrations` report the
same fifteen phantom files, which is every one of Phases 1–10. Two phases
finding one defect from opposite directions is the strongest argument for
fixing it before the next merge rather than after.

🔴 **Do not close this with `KNOWN_GAPS` instead.** That list means "never
written and never will be"; a reservation is the opposite claim, and putting
one there would make the gate lie about the exact fault it exists for. The same
argument is already recorded in `OPTIONAL-migration-reservations.md`.
