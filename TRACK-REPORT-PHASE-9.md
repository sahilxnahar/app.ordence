# TRACK-REPORT — Phase 9, source adapters

Against **`v1.84.1-alpha`**, the tree shipped inside the brief's zip. Thirteen
files: nine new under `lib/import/profiles/`, two edited under
`lib/import/sources/`, one migration, one test suite.

**Every claim below is followed by the command that produced it and the output
that would have differed if it were false.**

---

## 0. 🔴 Read this first: what is NOT proved

**No profile in this delivery has been validated against a real export.** Not
one file that came out of a Busy, Marg, Zoho Books, QuickBooks or Xero
installation was available. The six systems' profiles were written from those
systems' published export documentation.

That is not a footnote in this report — it is a **required member on every
profile**, it is on the customer's screen, and it is a number the gate prints
on every run:

```
$ npx tsx -e 'checkSourceProfiles(SOURCE_PROFILES)'   → census
 "profiles": 7,
 "exports": 29,
 "headerSpellings": 156,
 "reachableExports": 25,
 "validatedAgainstRealExport": 0,
```

`describeProfileDetection` puts the sentence into `SourceTable.notes`, which
the wizard already renders:

```
$ npx vitest run --project=ui tests/ui/import-profiles.test.ts
 ✓ 🔴 the `notValidated` sentence reaches the notes, not just the type
```

reading, for a recognised Zoho file:

> ⚠️ Zoho Books profile written from published documentation, not validated
> against a real export. Zoho lets an organisation choose its own date format,
> so the yyyy-mm-dd prior below is the default rather than a guarantee. What
> Ordence knows about Zoho Books is a starting point, not a guarantee — check
> the first few rows of the preview against your own screen before committing.

**Per system:**

| system | validated against | not validated |
|---|---|---|
| **Tally** | the Tally envelope fixture in `tests/ui/import-sources.test.ts` (written at v1.74.0-alpha, for the reader, not for this profile), and `lib/tally/parse.ts`, which the live integration runs against real installations | no spreadsheet export from a Tally installation. The XLSX/CSV header spellings and the `1-Apr-2026` date prior are from documented display exports |
| **Busy** | — | everything. Written from published export layouts |
| **Marg** | — | everything, and the batch/expiry spellings differ between the pharma and general-trade editions; only pharma is recorded |
| **Zoho Books** | — | everything. The `yyyy-mm-dd` prior is Zoho's default, not a guarantee |
| **QuickBooks** | — | everything. The day-first prior is a judgement about which edition our customers run, not something Intuit states |
| **Xero** | — | everything. Xero writes the organisation's chosen date format |
| **generic** | `tests/ui/import-mapping.test.ts`, `tests/ui/csv-import.test.ts` — both predate this phase | nothing to validate: it carries no spellings and no priors, deliberately |

⚠️ **A profile tested against its own fixture is verified by a floor**, so no
test in this delivery does that. The 65 cases test the RULES by induction, the
subordination rule by measurement, the readers against inputs whose right
answer is arithmetic (`13/02/2026` is day-first because there is no thirteenth
month), and the Tally reader against an envelope built to the shape Tally
writes rather than to the shape the code expects.

---

## 1. The tree, confirmed before anything was written

```
$ npx tsc --noEmit                 → exit 0
$ npm run gates:static             → 27/27 passed
$ npm run check:import-contract
✅ 6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
```

Six entities, two waves. The right tree.

---

## 2. Where it stands now

| | before | after |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `npm run gates:static` | 27/27 | **25/27** — `check:migrations` and `check:track-ownership`, both numbering, both explained in §7 |
| `npm run check:import-contract` | 6 entities, 2 waves | **identical** |
| `npx vitest run --project=ui` | 209 files · 6,707 tests · 2 failed | **210 files · 6,772 tests · 3 failed** |
| `npm run check:import-sources` (gate 20) | pass | **pass** — 4 formats, unchanged |
| `npm run check:sealed-grants` (migration lint) | 154 migrations | **155 migrations**, still `✅ every numbered migration verifies itself, scopes its writes, and asserts exactly` |
| `SQL-FILES/0275` against PostgreSQL 16 | — | **applied, twice, verifications green; four induced failures refused** |

**The two pre-existing test failures are pre-existing.** Measured on a pristine
unzip of `ordence-DEPLOY-v1.84.1-alpha.zip` with no Phase 9 files in it:

```
$ cd base && npx vitest run --project=ui tests/ui/opening-balances.test.ts tests/ui/assemble-wave.test.ts
 FAIL  assemble-wave > REFUSES a delivery that turns the gates red, and NAMES the gate
       AssertionError: expected 78 to be 1
 FAIL  opening-balances > resolves through the same allowlist as everything else
       AssertionError: expected { key: 'opening-trial-balance', …(19) } to be { …(18) }
 Tests  2 failed | 60 passed
```

Same two assertions, same values, on a tree this phase has never touched.
`6,772 − 6,707 = 65`, which is exactly `tests/ui/import-profiles.test.ts`.
The third failure is `check:track-ownership --tree` and is §7.

---

## 3. What a profile is, and what stops it becoming a parser

A profile is a record of five facts about one accounting package: the header
spellings it writes, the date format it writes, how it represents a negative
amount, what it calls its files, and which of its exports corresponds to which
Ordence entity. **`lib/import/profiles/catalogue.ts` contains no functions and
its header says it must not acquire any.**

Everything that runs is generic over every profile and does not get larger when
the eighth system is added:

```
lib/import/profiles/types.ts       324   the shape, and why each member is required
lib/import/profiles/catalogue.ts   909   ⭐ the seven systems, DATA ONLY
lib/import/profiles/registry.ts     78   the one map
lib/import/profiles/detect.ts      351   which system this file came out of
lib/import/profiles/dates.ts       411   which date format, and who decided
lib/import/profiles/amounts.ts     341   how a negative is written, and who decided
lib/import/profiles/priors.ts      290   what a profile may contribute, and how much
lib/import/profiles/check.ts       398   the rules, run against the map
lib/import/profiles/index.ts        79
```

**Zero new npm dependencies.** Not asserted — counted, against a pristine
unzip of the base:

```
$ cmp base/package.json tree/package.json
package.json IDENTICAL                      ← byte for byte

$ node -e 'compare package-lock.json'
base pkgs 1344 now 1344
added []
removed []
deps equal: true
```

`package-lock.json` differs in one place, `"version"`, which `npm install`
synced from `1.63.0-alpha` to `1.84.1-alpha`. It is not in the delivery.

The XLSX reader, the zip reader and the DEFLATE implementation were written
rather than installed, deliberately; this phase's date and amount readers are
the same decision. Nothing here calls `Intl`, `Date` arithmetic beyond a UTC
round-trip, or a locale table.

### The rule the whole phase is under, made structural

> ⚠️ Do not let a profile overrule a shape detector. A profile raises a prior;
> the values settle it.

Three mechanisms, none of which is a promise:

1. **`detectProfile` returns no field assignments.** It answers "what is this
   FILE"; `shapes.ts` answers "what is this COLUMN". There is no channel
   between them through which the first could overrule the second.
2. **Every prior is resolved by testing it against the file's own values.**
   `resolveCivilDateFormat` and `resolveNegativeStyle` only ever consult a
   prior among formats that already explain **every** sampled value. A profile
   claiming month-first for a column containing `13/02/2026` never reaches the
   tie-break: that format was eliminated by that value.
3. **The result says who decided.** `settledBy` is `"values"` or
   `"profile-prior"`, and a `profile-prior` carries a `caution` that reaches
   the screen.

```
 ✓ 🔴 a day above 12 settles the order against any profile
 ✓ ⚠️ without such a value there is a real tie, and no profile means no answer
 ✓ ⚠️ the profile breaks that tie AND the answer is labelled as assumed
 ✓ ⭐ and says nothing when the two readings give the same days
```

The third case, in full — a column of `01/02/2026`, `03/04/2026`, `05/06/2026`
read under a month-first prior:

> This column has been read as month-first with slashes (04/01/2026) because
> that is what the source system this file was recognised as writes.
> **Nothing in this column proves that.** "01/02/2026" is also a real date read
> as day-first with slashes (01/04/2026). Check one date against your own
> records before committing.

⚠️ **The prior in that case is written out in the test, not taken from a
profile.** The question is what the resolver does with a prior; pinning it to
whichever order the QuickBooks profile carries would make the case fail the day
somebody revises that judgement. The profile end of the same behaviour is
measured separately through `resolveColumnFormats`:
`✓ 🔴 and an ambiguous one always does, naming the system that decided it`.

The fourth case matters as much as the third: a column of `01/01/2026`,
`02/02/2026` is ambiguous in principle and **both readings give the same days**,
so nothing is reported. A caution that never means anything is how the one that
does gets clicked past.

---

## 4. 🔴 The bug this phase found: cancelled Tally vouchers were in every ledger total

`ledgerMasters` in `lib/import/sources/tally-read.ts` walked every voucher and
every leg. `isCancelled` was parsed by `lib/tally/parse.ts`, carried into the
voucher-summary view as a column, and **never consulted**.

A cancelled voucher in Tally is one the accountant voided. It is not in Tally's
own totals. `Total debit`, `Total credit` and `Net` per ledger are what an
accountant reads off this view to decide what to type into their opening trial
balance.

```
 ✓ counts a live voucher                                    → Acme Ltd total debit 1500.00
 ✓ 🔴 and leaves the same voucher out once it is cancelled  → Acme Ltd total debit 1000.00
 ✓ ⚠️ and says so, because a total that moved needs its explanation beside it
 ✓ 🔴 the cancelled voucher still BALANCED, which is why nothing downstream caught it
```

**The last case is the reason this was invisible.** A cancelled voucher has
equal debits and credits, so including it moved every ledger's net and left the
trial balance footing perfectly. There was no downstream check that could have
found it.

The exclusion is reported rather than silent:

> 1 cancelled voucher was left out of these totals. A cancelled voucher is one
> somebody voided; it is not in Tally's own figures either. It is named here
> because a total that moved and a voided invoice are two facts that explain
> each other.

---

## 5. Tally, deepened

Three new views, none of which posts anything — the file's existing argument
about not replaying another system's posting decisions is unchanged and its
sentence is still on every view:

```
 ✓ ⭐ every view still carries the sentence about history staying in Tally
```

### `voucher-types` — the census

One row per voucher type: how many, how many cancelled, what they foot to, and
**what Ordence does with that type**. The dispositions are a data table, not a
`switch`, for the same reason the profiles are.

🔴 **The two that matter most are the two that are not in Tally's own books.**
A Memorandum voucher and a Reversing Journal do not affect Tally's trial
balance. Their legs *are* summed into the ledger totals here, because excluding
them by NAME would be wrong the moment a company renames a voucher type — which
Tally allows and companies do. So they are counted, named, and their row says:

> 🔴 Not in Tally's own books either — a Memorandum voucher is a note. Its
> amounts ARE included in the ledger totals Ordence shows, so subtract this row
> before using them.

```
 ✓ the census names every voucher type and what Ordence does with it
 ✓ ⚠️ a voucher type nobody recognises is named as unrecognised, not waved through
```

The second case exists because "Ordence does nothing with this" reads the same
whether we recognised the type or not, which is how a customer's bespoke
voucher type gets waved through.

### `cost-centres` and `bill-wise`

One row per allocation, read from the XML tree, under their cost category and
with their bill-reference type.

⭐ **`Reference type` is the column that decides an opening balance.** `New Ref`
opens an outstanding; `Agst Ref` settles one. A migration that ignored the
difference would carry every paid invoice across as still owing.

⚠️ **These views report Tally's amounts with Tally's own sign and do not
re-derive the debit/credit rule.** That rule lives in `readVoucher`
(negative is a debit, `ISDEEMEDPOSITIVE` as the fallback) and a second copy
here is exactly the drifting model this repository has been bitten by four
times. The column heading says what the sign means instead.

```
 ✓ cost-centre allocations come out one row each, under their category
 ✓ ⭐ bill references carry the reference TYPE, which is what decides an opening balance
 ✓ ⚠️ the default view names the other two rather than hiding them
```

The last case is a string scan rather than a second parse: naming a view nobody
knows exists costs one pass over the source, and a view nobody knows about is a
view nobody chooses.

### 🔴 And a finding the new views measure

`readVoucher` reads `ALLLEDGERENTRIES.LIST` and only that. Tally writes
`LEDGERENTRIES.LIST` for some voucher classes; those vouchers arrive with zero
legs, zero totals, and **zero equals zero**, so they read as balanced.

```
 ✓ 🔴 a voucher whose legs are under <LEDGERENTRIES.LIST> reads as balanced and is not
```

The ledger view returns a header row and nothing else for such a file. The two
new views read both elements and report the count. The fix is one line in
`lib/tally/parse.ts` — `PATCH-REQUEST-PHASE-9.md` §5.

---

## 6. `SQL-FILES/0275`, executed rather than read

The column records **what Ordence believed the file was**, which
`source_format` and `source_name` do not say. `generic` is a value, not a NULL:
"Ordence looked and recognised no source system" and "nothing ever looked" are
different facts about a migration.

**Executed against PostgreSQL 16.13**, on `import_runs` created from `0117`:

```
$ psql -v ON_ERROR_STOP=1 -f SQL-FILES/0275_import_runs_source_profile.sql
NOTICE:  Phase 9: import_runs.source_profile is nullable varchar and lists all 7 profiles.
NOTICE:  Phase 9: import_runs_source_profile_known refuses 'zoho', accepts 'zoho-books' and accepts NULL.
exit 0

$ # again, on the same database
exit 0                      ← idempotent

$ # and on a database that has never seen the column
 count 0                    ← before
NOTICE:  … lists all 7 profiles.
NOTICE:  … refuses 'zoho', accepts 'zoho-books' and accepts NULL.
 source_profile | character varying | 20 | YES
```

### 🔴 A trap found only by executing

The first draft declared `found text[]` in the verification block. **plpgsql has
a special variable of that name**, set by every `SELECT INTO`, and declaring one
shadows it:

```
ERROR:  argument of NOT must be type boolean, not type text[]
LINE 1: NOT FOUND
CONTEXT:  PL/pgSQL function inline_code_block line 23 at IF
```

The file creates cleanly. It fails only when applied — in a console, by hand.
It is `listed` now, and the reason is in the file.

### The verification refuses, proven by induction

A gate proven only by passing is not proven. All four induced, all four
refused:

| induced | refused with |
|---|---|
| constraint dropped | `import_runs_source_profile_known is missing. Without it the run record accepts any string, and a typo in a profile key becomes a source system nobody notices.` |
| `'xero'` left out of the list | `… does not list the profiles this migration was written for. Missing: xero. Unexpected: (none).` |
| column made `NOT NULL` | `… It must stay nullable: NULL is how a run that happened before 0275 says that nothing ever looked, which is a different fact from the "generic" profile …` |
| **right names, enforces nothing** (`… IN (…) OR true`) | block ③ **passes** — the seven names are all there. Block ④ refuses: `import_runs_source_profile_known ACCEPTED the value 'zoho' … The constraint exists and enforces nothing.` |

⭐ **The fourth row is why there are two blocks.** Block ③ proves a constraint
exists and spells seven names; it cannot prove the predicate rejects anything.
Block ④ takes the real predicate out of `pg_get_constraintdef` — not a
hand-written copy, which would agree until the day the constraint changed — puts
it on a temp table and shows it refusing `'zoho'`, accepting `'zoho-books'` and
accepting `NULL`. A predicate that refuses everything is just as broken as one
that refuses nothing and reads the same from outside.

---

## 7. The two red gates are both numbering, and both resolve at integration

```
$ npm run gates:static
  🔴  check:track-ownership      two parallel tracks claiming one path, or a
                                 migration landing in another track's number block
  🔴  check:migrations           duplicate or out-of-sequence SQL files
  25/27 passed  ·  2 FAILED
```

Both are the same fact: **the phases map has not been merged.**
`scripts/track-ownership.json` in this tree still describes waves 14–19, where
the highest allocated number is 0226 and `lib/import/sources/**` belongs to
track M6. `0275` is in nobody's block, so `--tree` refuses it and
`check:migrations` sees 63 gaps.

🔴 **And merging `track-ownership-phases.json` as the file instructs makes it
worse, measured — 28 violations.** The phases map is a *replacement* for M2–M8,
not an addition, and `PHASE-1` needs the `excludes` its own `_comment` asks for.
With that corrected merge:

```
$ node scripts/check-track-ownership.mjs
OK ownership map consistent , 21 tracks, no overlapping paths or SQL blocks
$ node scripts/check-track-ownership.mjs --tree
OK SQL blocks , 33 post-128 migration(s), all inside an allocated block
$ node scripts/check-migrations.mjs
❌ 15 problem(s)   ← exactly 0181–0195, and not this phase's
```

Those fifteen are Track H's own reserve block, and they are a disagreement
between two readers of one map: `check-migrations.mjs` reserves from `t.sql`
only, `check-track-ownership.mjs` reserves from `t.sql` **and** `t.sqlAlso`.
One line fixes it, and then:

```
✅ Migrations contiguous — 155 files, 0001…0275 (6 documented historical gaps). Next number: 0276.
```

Full working in `PATCH-REQUEST-PHASE-9.md` §9.

### Ownership of the delivery itself

```
$ node scripts/check-track-ownership.mjs --track PHASE-9 --files phase9-files.txt
  x track PHASE-9 wrote outside its ownership: tests/ui/import-profiles.test.ts
1 violation(s).
```

**One deviation, declared.** `vitest.config.ts` collects `tests/ui/**` and
nothing else; a suite outside it is not a suite that fails but one that is never
collected — "indistinguishable from a test that passes", in that file's own
words. The alternative was to ship no test. `PATCH-REQUEST-PHASE-9.md` §9.1.

---

## 8. What this phase found in other people's files

Eight items, all in `PATCH-REQUEST-PHASE-9.md`, in order of consequence:

1. 🔴 **A column NAMED for a thing beats a column that CONTAINS it.**
   `SCORE.EXACT_HEADER` is 1.00 and `SCORE.DECISIVE_SHAPE` is 0.90, and the
   header branch returns before the values are looked at. A file whose column
   is called `GSTIN` and holds PANs wins against one that holds real GSTINs,
   at confidence 1.00 — which is *at* `AUTO_COMMIT_THRESHOLD`. The comment on
   `DECISIVE_SHAPE` says "Stronger than a good name"; the number says
   otherwise. Both directions measured in the test file. **This is why profile
   spellings are not merged into `aliases`** — that would extend the same
   behaviour to 156 spellings at 0.95.
2. ⚠️ **Busy and Marg put the sign of an amount in a separate column**, which a
   per-cell `NegativeStyleKey` cannot express. Reported rather than worked
   around: the fix belongs in the layer that sees more than one column.
3. 🔴 **Four of four payables exports carry a vendor NAME**, and
   `opening-vendor-bills.vendorCode` says "not their name". None of the four
   profiles maps it, so those runs are refused before a row is read rather than
   writing names into a code column.
4. ⚠️ **`normaliseHeader` cannot tell `Account` from `Account #`** — found by
   this phase's own checker refusing the QuickBooks profile.
5. 🔴 **`readVoucher` reads only `ALLLEDGERENTRIES.LIST`** (§5 above).
6. ⚠️ **Gate 30**, written out in full, ready to drop into `scripts/`.
7. ⚠️ **`shapes.ts` does not recognise `1-Apr-2026` as a date** — which is what
   Tally and Busy write. Found by gating this phase's date resolver on
   `evidence.shape === "civil_date"` and watching it never fire for a Tally
   file. The resolver no longer depends on it; `proposeMapping` still does.
8. ⚠️ **The wiring `source_profile` needs**, and the fact that
   `voucher-summary` has had no UI since v1.74.0-alpha — a gap this phase has
   made **four times worse**, since it adds three more views nothing a customer
   can click will reach. Stated rather than hidden; `TALLY_VIEWS` and
   `TALLY_VIEW_LABELS` are exported ready to render.

---

## 9. What is still not true

- **Six of the seven profiles have never been shown a real export.** §0. This
  is the single most important sentence in the delivery.
- **Nothing writes `import_runs.source_profile` yet.** The column and its
  constraint exist and are proven; the writer is PATCH §8. A column nothing
  writes reads as NULL forever while looking like it works.
- **Profile header priors reach nothing.** `profileHeaderPriors` produces the
  data and `describeProfileDetection` puts a sentence on the screen, but
  `proposeMapping` does not take them until PATCH §1 lands. That is deliberate:
  the only way to wire them today would be through `aliases`, and §1 measures
  what that does.
- **The three new Tally views have no UI**, along with `voucher-summary`, which
  has had none since v1.74.0-alpha. PATCH §8.
- **No `not-yet-importable` export can be imported** — chart of accounts and
  items, five exports across three systems. That is the point of the member:
  `check.ts` refuses one whose planned entity now exists, so the phase that
  builds it cannot forget to come back.
- **`resolveNegativeStyle` has no "the readings disagree" branch**, because
  with these five conventions there is no such case. That is measured over
  every marker shape rather than assumed:
  `✓ ⭐ no two conventions that both explain a value ever read it differently`.
  A sixth convention that broke the property would fail that case, which is why
  it exists.
