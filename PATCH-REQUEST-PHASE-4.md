# PATCH-REQUEST-PHASE-4

Repo `app.ordence`, build **v1.85.0-alpha**. Track **PHASE-4, entities: crm**.

Everything below is in a file Phase 4 does not own. Each patch is
paste-ready and has been applied and compiled in this phase's working
tree — `npx tsc --noEmit` exits 0 and `npm run gates:static` reports
**28/28** with all of them in place. Nothing here is speculative.

Patches 1–4 are **required**: without them the two entities this phase
delivers are unreachable, which is the "built, offered, unreachable"
defect the whole programme exists to stop. Patch 5 is required before any
phase ships a migration. Patches 6–7 are the two entities Phase 4 could
not build, handed to whoever owns those files.

---

## 1. `lib/import/types.ts` — two destinations in, one debt marker out

### 1a. Add the destinations to `ImportTableKey`

Find the end of the union (it currently ends `| "stock_movements";`) and
replace that line with:

```ts
  | "stock_movements"
  /**
   * ⭐⭐ PHASE 4 — THE CRM DESTINATIONS.
   *
   * `contacts` was `PendingImportTableKey`'s only member: M1 wrote the
   * entity, the write path had no branch for it, and the type was the
   * debt marker saying so. `server/import/writers/crm/contacts.ts` is
   * that branch, so the debt is paid and the marker is deleted rather
   * than emptied — an empty union is an invitation to add to it.
   */
  | "contacts"
  | "leads";
```

⚠️ **This is the line that makes patch 2 mandatory.** `IMPORT_WRITERS` is
a `Record` over this union, so adding a member without a writer is a
compile error at `server/import/writers/registry.ts`. That is the design;
do not silence it.

### 1b. Narrow `ImportProvenancePolicy.targets`

```ts
  targets: readonly ImportTableKey[];
```

(It currently reads `readonly (ImportTableKey | PendingImportTableKey)[]`.
The union member existed only so the worked example could name a
destination that did not exist.)

### 1c. Delete `PendingImportTableKey` and `PendingImportEntity`

Delete the whole block beginning

```
/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A DESTINATION THE WRITE PATH CANNOT REACH YET
```

down to and including

```ts
export type PendingImportEntity = Omit<ContractedImportEntity, "table"> & {
  table: PendingImportTableKey;
};
```

M1's own words: *"THIS TYPE IS A DEBT MARKER, NOT AN EXTENSION POINT …
the goal is for it to be empty."* It had one member and that member is
now a real destination, so the type goes rather than becoming an empty
union somebody adds to next quarter.

After 1c, `grep -rn "PendingImport" --include=*.ts .` returns nothing.

---

## 2. `server/import/writers/registry.ts` — two entries

Add the imports beside the existing ones:

```ts
import { contactsWriter } from "./crm/contacts";
import { leadsWriter } from "./crm/leads";
```

and the two members:

```ts
export const IMPORT_WRITERS: Record<ImportTableKey, ImportWriter> = {
  companies: companiesWriter,
  gst_parties: gstPartiesWriter,
  transactions: transactionsWriter,
  sales_invoices: salesInvoicesWriter,
  vendor_ledger_entries: vendorLedgerEntriesWriter,
  stock_movements: stockMovementsWriter,
  contacts: contactsWriter,
  leads: leadsWriter,
};
```

Both writers declare `writeRow` and not `writeFile`, so the registry's
module-load check passes. Verified: `npm run check:writer-registry` still
proves the property by induction with these in place.

---

## 3. `lib/import/entities.ts` — one import, one spread

```ts
import { CRM_IMPORT_ENTITIES } from "./entities-crm";
```

and inside `ALL_IMPORT_ENTITIES`:

```ts
export const ALL_IMPORT_ENTITIES = {
  ...IMPORT_ENTITIES,
  ...CRM_IMPORT_ENTITIES,
  ...openingWithContracts,
} as const satisfies Record<string, ContractedImportEntity>;
```

⚠️ **Spread into `ALL_IMPORT_ENTITIES`, not into `IMPORT_ENTITIES`.**
`IMPORT_ENTITIES` is typed by the two seed entities and is what the
general picker enumerates; `ALL_IMPORT_ENTITIES` is the allowlist
`isImportEntityKey` guards. Spreading here is what makes `"contacts"` and
`"leads"` members of `AnyImportEntityKey` — and `CRM_IMPORT_ENTITIES` is
declared `as const satisfies`, so the key literals survive the spread.

After this, gate 29 reads **8 entities in 2 waves**:

```
wave 0: companies, gst-parties, leads, opening-stock, opening-trial-balance
wave 1: contacts, opening-customer-invoices, opening-vendor-bills
```

---

## 4. `lib/import/contract/` — retire the worked example

**4a.** Delete `lib/import/contract/worked-example.ts`.

**4b.** In `lib/import/contract/index.ts`, delete the line

```ts
export { CONTACTS_WORKED_EXAMPLE } from "./worked-example";
```

`grep -rn "WORKED_EXAMPLE\|worked-example" --include=*.ts --include=*.tsx --include=*.mjs .`
returns nothing else — the file has exactly one consumer.

🔴 **Read §2 of `TRACK-REPORT.md` before deleting it.** The worked example
contains a defect that the finished entity had to fix, and the fix is the
most useful thing this phase learned. The reference version, copied by
five other phases, links no contact to any company and reports success.

---

## 5. `scripts/track-ownership.json` — the phases file does not merge as written

🔴 **Applying `track-ownership-phases.json` verbatim turns
`npm run check:track-ownership` red with 28 violations, and the first
phase to ship a migration turns `npm run check:migrations` red with 15
more.** Both were measured, not predicted.

The three causes:

1. **The wave-19 M-tracks are still in the file with their paths.**
   `M2` claims `server/import/**`, which contains every phase's writers
   and `server/import/runs.ts`; `PHASE-1` claims
   `server/import/writers/**`, which contains every entity phase's
   subdirectory. 20 of the 28 violations are this.
2. **The M-tracks' SQL blocks overlap the phase blocks.** `M2` holds
   200–206 against `PHASE-1`'s 200–204 and `PHASE-2`'s 205–214; **`M7`
   holds 219–222 and `M8` holds 223–226, which sit inside `PHASE-4`'s
   220–229.** 8 violations.
3. **0181–0195 is reserved by nobody.** The file's own `_comment` says
   *"H keeps 0166-0168 … and holds 0181-0195 for later"*, but `H`'s entry
   reads `"sql": [166, 168]`. Nothing notices while the highest file is
   0168. The moment any phase ships a numbered migration above 0180 —
   Phase 4's 0227 is the first — `check:migrations` reports 15 missing
   numbers, none of them the shipping phase's fault.

### The reconciliation that was measured green

`PATCH-REQUEST-PHASE-4-track-ownership.json` in this zip is the whole
file, ready to drop in. It differs from the naive merge in four ways:

| change | why |
|---|---|
| `M2`–`M8` removed | Their work has landed and is now owned by `PHASE-1`…`PHASE-10`. Two tracks owning one path is the thing this gate exists to refuse. |
| `M1` kept, `paths` emptied, `sql` 196–199 kept | M1's own migration (the provenance sidecar, SQL 0196) is not in this tree yet. Its numbers stay reserved; its files now belong to the phases. |
| `H-HOLD` added, `sql` 181–195, no paths | Records the hold the `_comment` already describes. `sql` is a single `[start, end]` pair, so a second block needs a second entry. |
| `PHASE-1` gains `excludes` for the five entity subdirectories | The phases file's own `_comment` asks for this: *"PHASE-1 must exclude those subdirectories once they exist."* |

Verified with that file in place:

```
$ npm run check:track-ownership
OK SQL blocks , 34 post-128 migration(s), all inside an allocated block

$ npm run check:migrations
✅ Migrations contiguous — 156 files, 0001…0228 (6 documented historical gaps). Next number: 0229.
```

⚠️ **Phase 4 did not rely on this being accepted.** Its two migrations are
numbered **0227** and **0228** — inside its own block and outside both
`M7`'s 219–222 and `M8`'s 223–226 — so they are safe whichever way
integration resolves the overlap.

---

## 6. `activities` is one file-move away, and the move is not Phase 4's

`server/actions/activities.ts` holds `logSchema`, which is the right
schema: it carries the subject-type allowlist, the 500-character summary
limit, the "say which way it went" rule for contact kinds and the
no-future-dates rule.

🔴 **It cannot be imported.** The file is `"use server"`, and its first
paragraph says why that matters: *"EVERY EXPORT IS AN ASYNC FUNCTION. A
`"use server"` file that exports anything else publishes it as an RPC
endpoint reachable by anyone on the internet."* Exporting the schema to
let the importer reach it would do exactly that.

**The patch, for the owner of `server/actions/activities.ts` and
`lib/validators/`:** move the schema, do not copy it.

```ts
// lib/validators/work.ts  (new file, or an existing validators module)
export const SUBJECT_TYPES = [ /* …unchanged… */ ] as const;
export const CONTACT_KINDS = ["call", "email", "whatsapp", "sms", "visit"] as const;
export const logActivitySchema = z.object({ /* …the current logSchema, unchanged… */ });
```

```ts
// server/actions/activities.ts
import { logActivitySchema, CONTACT_KINDS } from "@/lib/validators/work";
// const logSchema = …  ← delete; `logSchema.parse(input)` becomes
//                          `logActivitySchema.parse(input)`
```

⚠️ **Two things must move with it, or the importer would validate more
loosely than the form.** The direction rule and the future-date rule are
currently `if` statements in the action, not in the schema —
`createLeadRefined` is the precedent for expressing that kind of rule as
a refinement so both callers get it. Whoever moves the schema should
decide which of the two shapes the product wants; Phase 4 has no standing
to decide it, and building the entity against a schema that carries
neither rule would have shipped an importer that writes calls with nobody
knowing who rang whom.

Once that lands, `activities` is a small entity: the destination table
exists, its `external_ref` + `source_name` unique index is a natural key
better than anything the CRM entities have, and the interesting decision
is `dependsOn` — an activity is logged against a subject, so it depends
hard on whatever the subject is, which is the first entity in this
product whose dependency is *polymorphic*. That is worth its own thought
and probably its own lookup kind.

---

## 7. `deals` needs a schema that a human writes for the FORM, not for the importer

`grep -rn "dealSchema\|DealSchema" --include=*.ts --include=*.tsx .`
returns **nothing**. There is no create schema, no update schema, and no
form. `server/actions/deals.ts` contains one export and it is a read; the
only deal write in the product is `ordence_update_deal_stage` in
`server/mcp/dispatch.ts`, which parses nothing and casts a raw string
straight into the enum:

```ts
stage: requireString(args, "stage") as "lead" | "qualified" | …
```

🔴 **Phase 4 declined to write one**, on the phase brief's own step 1 and
rule 6. A schema written for an importer is not the schema the form uses;
it is a second model of what a deal is, and the moment somebody builds
the deal form the two disagree, silently, in the direction of the bulk
path being looser.

**What the owner of `deals` needs to settle first**, because each one
changes the entity:

* **The money.** `deals.amount` is `numeric(15,2)` — *rupees* — while
  everything built since is `bigint` minor units. `server/actions/deals.ts`
  converts to paise by string arithmetic and hands totals to the client
  as strings, with a comment saying `JSON.stringify` throws on a bigint.
  An importer must not be the thing that decides which convention wins.
* **`currency`.** The column exists, defaults to `INR`, and nothing
  constrains it. Minor units are not universally two decimals (JPY 0;
  KWD, BHD, OMR, JOD, TND, LYD, IQD 3; CLF, UYW 4), and the import
  coercion layer is fixed at two. A deals file with a `currency` column
  is a file the current coercion cannot read correctly.
* **`probability` versus `stage`.** `server/actions/deals.ts` computes a
  `probabilityConflict` for rows where the two disagree and calls it one
  of the four things that quietly corrupt the pipeline number. An
  importer that accepts both columns from a spreadsheet is a way to
  create ten thousand of those in one upload; a schema is where that
  rule belongs.
* **The natural key.** A deal has no unique column at all. Title +
  company is the only candidate and it is weak — "Renewal" against
  "Acme" is a title three salespeople will use — so `update` may not be
  offerable at all, which decides the reversal policy.

Until those are decided, an entity for `deals` would be a picker entry
that writes money into a column under a convention nobody chose.
