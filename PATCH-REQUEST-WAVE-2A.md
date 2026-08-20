# PATCH REQUEST — Wave 2A (the migration wizard), v1.89.0-alpha

Four things this wave needed in files it does not own. Nothing here was
edited by Wave 2A; every item is written as the exact change, so it can be
applied without re-deriving it.

Ownership for this wave was: `components/settings/import-wizard.tsx`,
`app/(crm)/settings/import/**`, `components/import/**`.

---

## §1 — Track M8: the control totals. `server/import/` (not owned)

**What is missing.** Screen ③ (`/settings/import/cutover`) is built and
renders any set of reconciliation lines it is given. It can measure ONE
thing from what exists today: the row census per run (`expectedRows`
declared before the first chunk, against `rowsWritten + rowsSkipped +
rowsFailed` accounted for afterwards).

It cannot measure the line the screen was designed around:

> Debtors — your trial balance 4,81,200 · invoices imported 4,79,800 ·
> **difference 1,400 short**

That needs the opening trial balance read back and the imported
sub-ledgers footed against it over the provenance sidecar. No function in
`server/import/` does it, so the screen renders that line as
`not-checked` with the reason, and `cutoverVerdict` therefore refuses to
report the migration as tying. **This is deliberate and it is the correct
behaviour until §1 lands** — but it means one honest amber line is
standing in for the real measurement.

**The function this screen is waiting for.** One server action; the
component needs no change beyond building lines from it.

```ts
// server/import/reconcile.ts
export type ControlTotal = {
  readonly key: string;            // "debtors" | "creditors" | "stock" | "trial-balance"
  readonly label: string;          // "Debtors"
  readonly currency: string;       // the workspace's functional currency
  /** From the customer's own opening trial balance. `null` when they gave none. */
  readonly declared: bigint | null;
  /** Footed over rows this workspace imported, via `import_row_provenance`. */
  readonly imported: bigint | null;
  /** 🔴 REQUIRED WHEN EITHER IS `null`. Why it could not be measured. */
  readonly unmeasuredBecause: string | null;
};

export async function reconcileMigration(tenantId: string): Promise<readonly ControlTotal[]>;
```

🔴 **Two members that must not be collapsed.** `declared: null` and
`declared: 0n` are different facts — "they gave us no opening trial
balance" against "their debtors are nil" — and a single `number` with a
zero default would make the cutover screen green for the workspace that
supplied nothing at all. `components/import/reconciliation.tsx` models the
same distinction as two shapes (`measured` / `not-checked`) rather than as
a nullable number, for the same reason and with a test that induces it.

⚠️ **The footing must go through the provenance sidecar, not through
timestamps.** "Rows created between these two times" catches every row the
customer's staff typed by hand during the migration window, and a
migration takes hours while the office does not stop. This is the same
argument `lib/import/types.ts` makes for provenance existing at all.

**Wiring, once it exists** — in
`app/(crm)/settings/import/cutover/page.tsx`, replace the single
`CONTROL_TOTALS` constant with a map over `reconcileMigration()`:

```ts
const totals = await getMigrationControlTotals();      // the action wrapping it
const moneyLines: ReconciliationLine[] = totals.map((t) => ({
  key: t.key,
  label: t.label,
  unit: { kind: "money", currency: t.currency },
  declaredLabel: "your trial balance",
  importedLabel: "imported and footed",
  measure:
    t.declared !== null && t.imported !== null
      ? { kind: "measured", declared: t.declared, imported: t.imported }
      : { kind: "not-checked", why: t.unmeasuredBecause ?? "This was not measured." },
}));
```

---

## §2 — `duplicateRule` for `companies` and `gst-parties`. `lib/import/entities.ts` (not owned)

**Why this is a request and not an edit.** `lib/import/types.ts` says, of
`ImportEntityDefinition.duplicateRule`:

> ⚠️ IT LIVES ON THE ENTITY BECAUSE THE ALTERNATIVE IS A TERNARY IN A
> COMPONENT. `components/settings/import-wizard.tsx` has exactly that —
> `entityKey === "companies" ? "…domain…" : "…GSTIN…"` — so every entity
> added after the second one is described to the customer as a GST party.

Wave 2A deleted that ternary, because with eighteen entities in the picker
it described sixteen of them wrongly at the moment the customer decides
what happens to their data. Sixteen entities declare `duplicateRule` and
the screen reads it. **The two that do not are `companies` and
`gst-parties`** — the two whose sentences the ternary was carrying — so
those two entities now show no matching rule at all, which is a loss.

**The patch.** In `lib/import/entities.ts`, add one member to each
definition. The strings are the ternary's own text, unchanged:

```ts
// companiesEntity
duplicateRule:
  "Two rows are the same company when they have the same domain — or, where " +
  "there is no domain, the same name.",

// gstPartiesEntity
duplicateRule:
  "Two rows are the same party when they have the same GSTIN and are both " +
  "customers or both vendors — or, where there is no GSTIN, the same legal name.",
```

**And the test that goes with it.** `tests/ui/csv-import.test.ts:815`,
"the wizard names the key and warns about the name fallback", asserts that
those sentences appear in the WIZARD'S SOURCE. They no longer can: they
are entity data now. That test turns red under this wave — see the track
report, §"What is red and why". The replacement asserts the property that
actually matters, and it is stronger, because it covers all eighteen
entities rather than two:

```ts
it("names the matching key for every entity, from the entity", () => {
  for (const [key, entity] of Object.entries(ALL_IMPORT_ENTITIES)) {
    expect(entity.duplicateRule, `${key} has no duplicateRule`).toBeTruthy();
  }
  expect(ALL_IMPORT_ENTITIES.companies.duplicateRule).toContain("same domain");
  expect(ALL_IMPORT_ENTITIES["gst-parties"].duplicateRule).toContain("same GSTIN");
  /* And the wizard reads it rather than choosing it. */
  expect(WIZARD).toContain("entity.duplicateRule");
  expect(WIZARD).not.toMatch(/entityKey === "companies"/);
});
```

⚠️ Applying §2 without the test change leaves that assertion red; applying
the test change without §2 leaves the two entities silent on the screen.
They are one patch.

---

## §3 — `abandoned` has no caller. `server/import/runs.ts`, `server/actions/import.ts` (not owned)

`finishImportRun` takes `abandoned?: boolean` and writes the run status
`"abandoned"` — "set when the person walked away rather than the run
failing". The only caller in the product was this wizard, and it read:

```ts
await endRun({ runId, ...(stopped ? { abandoned: false } : {}) });
```

Both branches are `false` (the second by the schema default), so
`abandoned: true` has never been sent by anything, and the `"abandoned"`
status is unreachable. Wave 2A removed the dead ternary and now sends
`endRun({ runId })`; it deliberately did **not** start sending `true`,
because the code path that would set it is the one still running — a
failed chunk is a failure, not a change of mind, and labelling it
"abandoned" would relabel every broken migration as somebody walking away.

**What is actually needed** is a caller from the browser-leaves path: a
`navigator.sendBeacon`-style endpoint (a server action cannot be relied on
during `beforeunload`), or a sweeper that marks runs abandoned after they
have been silent for N minutes. Both live outside `components/` — hence
this note rather than an implementation. Until one exists, either delete
the member or accept that it is declared and unenforced; the third option,
having the wizard claim it, is the one that must not be taken.

---

## §4 — New file outside the declared ownership: `tests/ui/import-wave2a.test.tsx`

The brief requires every claim proven. Wave 2A adds ONE new test file and
edits none. It touches no existing suite and no existing file's
assertions. Flagged here because `tests/` was not in the ownership list.


---

## §5 — Collision with Wave 2D: one `Figure`, not two. `components/ui/figure.tsx` (not owned, not in this tree)

Wave 2D (delivered the same day, `ORDENCE-WAVE-2D-v1.89.0-alpha.zip`) adds
`components/ui/figure.tsx`, which re-exports the same
`lib/receivables/numbers.ts` grouping. That file is **not in
`ordence-DEPLOY-v1.89.0-alpha.zip`**, so Wave 2A could not import it and
built `components/import/figures.tsx` against the library directly.

Both delegate to the same implementation, so there is no disagreement at
any magnitude — the duplication is the `<Figure>` SPAN and the
`formatCount` wrapper, not the arithmetic.

**When the two waves are integrated**, in this order:

1. Keep `lib/receivables/numbers.ts` as the single grouper. Both files
   already do.
2. In `components/import/figures.tsx`, replace the local `Figure` span and
   the `groupIndian` re-export with `export { Figure, groupIndian } from
   "@/components/ui/figure";`, keeping `formatMinorIndian` — it is the only
   one of the six formatters that reads the exponent from the CURRENCY, and
   `formatPaise`'s hard-coded `100n` is wrong for JPY (0), KWD/BHD/OMR/JOD/
   TND/LYD/IQD (3) and CLF/UYW (4).
3. `tests/ui/import-wave2a.test.tsx` asserts identity with the library, so
   it will keep passing through that move — and will fail if step 1 is ever
   undone.

⚠️ Wave 2D's `PATCH-REQUEST-WAVE-2D.md` §C asks for sample values under
each column in the import wizard. **That is delivered here** — three of the
customer's own values, following the override, in
`components/import/mapping-review.tsx`. §C can be closed.
