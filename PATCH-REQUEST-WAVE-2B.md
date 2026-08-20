# PATCH-REQUEST — WAVE 2B (the undo)

Four asks. None is in `server/actions/import-reversal.ts` or
`tests/security/import-undo-action.test.ts`, which are the only two files this
chat owns. Nothing here has been applied.

---

## 1. `import_runs` should snapshot the permission, as it already snapshots the promise

**File:** SQL (new number, integration's to allocate) + `db/schema/import-runs.ts`.
**Owner:** Phase 2 / integration.

`import_runs.reversal_escapes` exists because the sentence shown to the customer
must survive an edit to the entity (SQL 0208 §0). The **permission** an undo
requires has exactly the same property and is not recorded anywhere, so
`server/actions/import-reversal.ts` has to read `ALL_IMPORT_ENTITIES` for it —
and an entity removed from the allowlist becomes un-undoable. The action fails
closed and says so; it does not guess a nearby key, because a wrong guess is a
silent downgrade of a data-protection right.

```sql
ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS undo_permissions text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.import_runs.undo_permissions IS
  'The permission keys an undo of this run requires, snapshotted when the run '
  'started — same rule as reversal_escapes. A run whose entity has since left '
  'ALL_IMPORT_ENTITIES is still undoable by the people who were allowed to '
  'undo it on the day it ran.';
```

Written by `startImportRun` from `[entity.updatePermission]` plus
`"transactions:reverse"` when `contract.reversal.kind === "reverse-entry"`, and
preferred over the registry by `permissionsForUndo()` when it is non-empty.

---

## 2. 🔴 SQL 0215 §4 and SQL 0205 §5 contradict each other, and 0215 wins

**File:** `SQL-FILES/0215_import_row_provenance.sql` §4.
**Owner:** Phase 3 (the file's author) / integration.

Both files are in the unapplied twelve and both define
`import_row_provenance`. 0205 §5 freezes every column *except* `reversed_at`
and `reversal_id` — the pair a reversal sets. 0215 §4 refuses **every** UPDATE
for **every** role, under a different trigger name, so it does not replace 0205's
rule, it fires before it. Applied as one ordered pack, **no undo of any kind
can complete**: every one is `partial`, 0 of N, `sqlstate 23001`, and the run
keeps its claim on the file forever. Proved both ways in
`tests/security/import-undo-action.test.ts` §④.

0205's rule is the correct one — it is narrower, it states the same
append-only intent, and it is the one the reversal engine was proved against.
So:

```sql
-- 0215 §4 — DELETE THE BLANKET TRIGGER; 0205 §5 already carries this rule
--           in the only form that leaves an undo possible.
DROP TRIGGER IF EXISTS import_row_provenance_no_update ON public.import_row_provenance;
DROP FUNCTION IF EXISTS public.import_row_provenance_is_append_only();
```

⚠️ If 0215 is instead kept as the authority, then `reverseImportRun` cannot mark
rows at all and the whole reversal design needs a different mechanism — that is
a redesign, not a merge conflict. Either way this must be decided **before** the
pack is sent, because with both applied the feature is inert in a way that looks
like a database fault to whoever hits it first.

---

## 3. `scripts/action-reachability-baseline.json` — one line, temporarily

**Owner:** whoever owns `scripts/`.

`npm run gates:static` goes 29/29 → 28/29 solely because nothing calls
`undoImportRun` yet: Wave 2B owns no screen. The gate is right and it must not
be silenced with an unused import. Until the undo button exists:

```diff
   "names": [
+    "server/actions/import-reversal.ts#undoImportRun",
```

and bump the recorded `orphans` count by one. **Remove it again the day a
screen calls the action** — the baseline is the list of things somebody has
decided about, not a place to park them.

---

## 4. `tests/security/import-undo-action.test.ts` is offered, not claimed

**Owner:** Track D.

`tests/security/**` is Track D's. The file is here because this is the only
directory in the repository wired to a real PostgreSQL, and a proof about an
undo that never touches one is not a proof. Two notes for whoever adopts it:

* It deliberately does **not** stub `requirePermission` / `requireAllPermissions`
  / `writeAudit`, unlike the neighbouring import suites. A permission proof that
  stubs the permission check proves the stub.
* Its `cleanupTenant()` adds `audit_logs` and `permission_denials` to the
  disable-trigger list. Both are `ON DELETE RESTRICT` plus append-only, so a
  workspace that has ever been audited or denied cannot be erased — the same
  finding as `journal_entries` (Phase 2) and `security_events` (wave 15 §4.2),
  now on the two tables every tenant has rows in. Worth its own item in the
  DPDPA erasure work.
