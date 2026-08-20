-- ############################################################################
-- 0209 — CAN THE DATABASE ACTUALLY DO WHAT THE ENTITY SAYS ITS UNDO DOES
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE FINDING THIS FILE EXISTS FOR
-- ══════════════════════════════════════════════════════════════════════════
-- `opening-stock` declares:
--
--     reversal: { kind: "delete",
--                 escapes: "Deleting an opening stock movement changes the
--                           current quantity on hand for that item …" }
--
-- `stock_movements` carries `trg_stock_ledger_append_only`, a BEFORE DELETE
-- OR UPDATE trigger, and its function begins:
--
--     IF TG_OP = 'DELETE' THEN
--       RAISE EXCEPTION 'Stock movements cannot be deleted. … To correct it,
--       post a REVERSAL for the opposite quantity with
--       reverses_movement_id = %'
--
-- 🔴 THE DECLARED UNDO IS IMPOSSIBLE, AND HAS BEEN SINCE THE ENTITY WAS
--    WRITTEN. Not "risky", not "lossy" — refused, by the database, every
--    time, for every role. `escapes` describes in detail the consequences of
--    a deletion that cannot occur.
--
-- ⚠️ CI GATE 29 IS HAPPY WITH IT AND ALWAYS WILL BE. `checkImportContract()`
--    is pure by design — its header says so twice, and being pure is what
--    lets the wizard run it in a browser. A pure checker cannot ask
--    `pg_trigger` anything. The contract is internally coherent: `delete` is
--    a valid kind, `duplicateModes` excludes `update`, `escapes` is a
--    sentence, `because` is a sentence. Every rule passes.
--
-- ⭐ SO THIS IS THE HALF OF THE CONTRACT THAT ONLY THE DATABASE CAN CHECK,
--    and `server/import/reversal.ts` calls it BEFORE it touches anything —
--    so an entity whose undo the destination will refuse is refused up
--    front, with a sentence naming the trigger, rather than discovered one
--    row at a time as a thousand identical failures.
--
-- ⚠️ THE SECOND, INDEPENDENT REASON `delete` IS WRONG THERE. Even if the
--    append-only guard were removed, `trg_refresh_stock_balance` is AFTER
--    INSERT only. Deleting a movement would leave `stock_balances` holding
--    the opening quantity for ever — a balance no movement explains, which is
--    the exact thing `stock_movements` exists to make impossible.
--
-- ⚠️ THE REMEDY IS ONE WORD IN A FILE THIS PHASE DOES NOT OWN.
--    `lib/import/entities.ts` and `lib/import/contract/opening-policies.ts`
--    belong to track M1 / no phase. The change — `kind: "reverse-entry"`,
--    which `stock_movements` already supports through `reverses_movement_id`
--    — is written out in PATCH-REQUEST-PHASE-2.md. It is deliberately NOT
--    made here.
--
-- ══════════════════════════════════════════════════════════════════════════
-- HOW A VERDICT IS REACHED, AND WHY IT REFUSES TO GUESS
-- ══════════════════════════════════════════════════════════════════════════
-- "Does this table allow a DELETE" is not answerable from the catalogue in
-- general: a trigger function is a program. What IS answerable is "which
-- trigger functions fire on DELETE here", and every one of them in this
-- schema has already been read and classified — as an ABSOLUTE guard that
-- refuses for every role, or a CONDITIONAL one that fires only under
-- impersonation, or an ordinary bookkeeping trigger.
--
-- 🔴 AND AN UNRECOGNISED TRIGGER FUNCTION IS A REFUSAL, NOT A PASS. That is
--    the whole difference between this and a list of tables somebody wrote
--    down. A new guard attached to a destination table next quarter makes
--    this function say "I do not know what this does" — and stops the undo —
--    instead of silently classifying it as harmless.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE VERDICT FUNCTION
-- ############################################################################

DROP FUNCTION IF EXISTS public.import_destination_reversibility(text);

CREATE FUNCTION public.import_destination_reversibility(p_table text)
RETURNS TABLE (
    target_table       text,
    delete_blocked_by  text,
    update_blocked_by  text,
    unknown_guards     text[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_rel regclass;

  -- ⭐ ABSOLUTE: refuses for every role, impersonating or not, owner or not.
  -- An undo that has to go through one of these cannot.
  v_absolute text[] := ARRAY[
    'block_mutation_append_only',        -- journal_entries: the ledger
    'ordence_stock_ledger_append_only',  -- stock_movements: the stock ledger
    'prevent_security_event_delete',     -- security_events
    'refuse_audit_log_delete',           -- audit_logs
    'refuse_error_event_delete',
    'refuse_permission_denial_delete'
  ];

  -- ⭐ CONDITIONAL or ordinary: fires on the operation but does not refuse an
  -- ordinary undo run by a signed-in person in their own workspace.
  --
  -- ⚠️ `refuse_delete_under_impersonation` IS IN THIS LIST AND THAT IS A
  -- DELIBERATE, NARROW CLAIM: it refuses only when `app.impersonation_id` is
  -- set. An undo run by Ordence staff inside a customer's workspace WILL be
  -- refused by it, per row, and `server/import/reversal.ts` reports that as
  -- an ordinary blocked row with the trigger's own sentence — which is the
  -- correct outcome, not a gap.
  v_conditional text[] := ARRAY[
    'refuse_delete_under_impersonation',
    'record_change',
    'set_updated_at',
    'enforce_period_close',
    'enforce_period_close_transactions',
    'ordence_guard_closed_period',
    'sales_order_recalc_from_invoices',
    'sales_invoice_freeze_after_issue',
    'enforce_sales_invoice_irn_integrity',
    'enforce_double_entry_balance',
    'ordence_apply_serial_movement',
    'ordence_refresh_stock_balance'
  ];

  v_del_abs  text[];
  v_upd_abs  text[];
  v_unknown  text[];
BEGIN
  v_rel := to_regclass('public.' || quote_ident(p_table));
  IF v_rel IS NULL THEN
    RAISE EXCEPTION
      'import_destination_reversibility() was asked about "%", which is not a '
      'table in this database.', p_table
      USING ERRCODE = '42P01';
  END IF;

  -- tgtype bit 3 (value 8) = fires on DELETE, bit 4 (16) = on UPDATE.
  SELECT
    coalesce(array_agg(DISTINCT pr.proname) FILTER (
      WHERE (tg.tgtype::int & 8) = 8 AND pr.proname = ANY (v_absolute)), ARRAY[]::text[]),
    coalesce(array_agg(DISTINCT pr.proname) FILTER (
      WHERE (tg.tgtype::int & 16) = 16 AND pr.proname = ANY (v_absolute)), ARRAY[]::text[]),
    coalesce(array_agg(DISTINCT pr.proname) FILTER (
      WHERE NOT (pr.proname = ANY (v_absolute))
        AND NOT (pr.proname = ANY (v_conditional))), ARRAY[]::text[])
    INTO v_del_abs, v_upd_abs, v_unknown
    FROM pg_trigger tg
    JOIN pg_proc pr ON pr.oid = tg.tgfoid
   WHERE tg.tgrelid = v_rel
     AND NOT tg.tgisinternal
     AND (tg.tgtype::int & 24) <> 0;   -- fires on DELETE or UPDATE

  target_table      := p_table;
  delete_blocked_by := nullif(array_to_string(v_del_abs, ', '), '');
  update_blocked_by := nullif(array_to_string(v_upd_abs, ', '), '');
  unknown_guards    := v_unknown;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION public.import_destination_reversibility(text) IS
    'What the database will actually let an undo do to an import destination: '
    'which absolute guard, if any, refuses a DELETE or an UPDATE there, and any '
    'trigger function on it that has not been classified. An unclassified guard '
    'is returned rather than assumed harmless, so a guard attached next quarter '
    'stops an undo instead of being silently ignored. Read by '
    'server/import/reversal.ts before a reversal touches anything. SQL 0209.';


-- ############################################################################
-- SECTION 2 — THE FINDING, RECORDED WHERE `\d+` WILL SHOW IT
-- ############################################################################
--
-- ⚠️ A COMMENT, NOT A CHANGE. This file alters no data and no behaviour on
-- `stock_movements`. Wave 17's lesson applies: a control that must be "last"
-- is wrong from its second wave, and a migration that silently edited another
-- track's contract would be worse than one that records the disagreement.

COMMENT ON TRIGGER trg_stock_ledger_append_only ON public.stock_movements IS
    'Absolute append-only guard: refuses DELETE and UPDATE for every role. '
    '🔴 The import entity `opening-stock` declares reversal kind "delete", '
    'which this trigger makes impossible — CI gate 29 cannot see that because '
    'checkImportContract() is pure and never asks the database. The correct '
    'kind is "reverse-entry"; stock_movements already carries '
    'reverses_movement_id for it. See PATCH-REQUEST-PHASE-2.md and SQL 0209.';


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION — the finding is asserted, not merely described
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ IT RAISES IN BOTH DIRECTIONS, for the reason 0167 gives. If
-- `stock_movements` ever becomes deletable, the comment above is a lie and
-- this file should stop applying until somebody has re-read it. If
-- `sales_invoices` ever becomes undeletable, `opening-customer-invoices` has
-- silently acquired the same defect and nobody has noticed.

DO $$
DECLARE
  r_stock    record;
  r_invoices record;
  r_ledger   record;
BEGIN
  SELECT * INTO r_stock    FROM import_destination_reversibility('stock_movements');
  SELECT * INTO r_invoices FROM import_destination_reversibility('sales_invoices');
  SELECT * INTO r_ledger   FROM import_destination_reversibility('journal_entries');

  IF r_stock.delete_blocked_by IS NULL THEN
    RAISE EXCEPTION
      'stock_movements now allows a DELETE. The COMMENT this file writes on '
      'trg_stock_ledger_append_only says it does not, and the whole argument in '
      'PATCH-REQUEST-PHASE-2.md for changing opening-stock to "reverse-entry" '
      'rests on it. Do not delete the comment to make this pass — find out who '
      'removed the append-only guard from the stock ledger.';
  END IF;

  IF r_invoices.delete_blocked_by IS NOT NULL THEN
    RAISE EXCEPTION
      'sales_invoices is now DELETE-blocked by %. `opening-customer-invoices` '
      'declares reversal kind "delete" and has just acquired the same defect '
      'opening-stock has had since it was written.',
      r_invoices.delete_blocked_by;
  END IF;

  IF r_ledger.delete_blocked_by IS NULL THEN
    RAISE EXCEPTION
      'journal_entries now allows a DELETE. `opening-trial-balance` declares '
      '"reverse-entry" on the grounds that the ledger is append-only; if it is '
      'not, that declaration needs re-arguing rather than inheriting.';
  END IF;

  IF array_length(r_stock.unknown_guards, 1) IS NOT NULL
     OR array_length(r_invoices.unknown_guards, 1) IS NOT NULL
     OR array_length(r_ledger.unknown_guards, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Unclassified trigger function(s) on an import destination: stock_movements %, '
      'sales_invoices %, journal_entries %. Each one has to be read and added to '
      'either the absolute or the conditional list in §1 — assuming it is '
      'harmless is how a guard that blocks every undo gets ignored for a quarter.',
      r_stock.unknown_guards, r_invoices.unknown_guards, r_ledger.unknown_guards;
  END IF;

  RAISE NOTICE
    '0209: destination reversibility verified — stock_movements DELETE blocked '
    'by [%], sales_invoices DELETE open, journal_entries DELETE blocked by [%], '
    'no unclassified guards on any of the three.',
    r_stock.delete_blocked_by, r_ledger.delete_blocked_by;
END $$;
