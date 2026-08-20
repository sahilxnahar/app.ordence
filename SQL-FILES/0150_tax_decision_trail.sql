-- ############################################################################
-- 0150 — WHICH RATE, WHICH RULE, WHICH PLACE OF SUPPLY, AND WHY
--        (Wave 15 / Track E — GST, TDS and statutory correctness)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- -------------------
-- 0146 made a rate pin mean this tenant's rate. 0147 made a line's money
-- recompute from the rate the line names. Between them a line is now
-- internally honest — and an accountant asked to defend it still cannot.
--
-- 🔴 THE DOCUMENT RECORDS THE ANSWER AND NOT THE REASONING. A line says
-- `tax_rate_bps = 1800`, `igst_minor = 18000`, `place_of_supply_code = '29'`.
-- It does not say:
--
--     · why 29 and not 27 — the recipient's registered address? the place of
--       performance? immovable property? Each is a different sub-section of
--       s.12, and the officer's first question is which one;
--     · which notification put 998314 at 18% on that date;
--     · whether reverse charge was considered and rejected, or never
--       considered;
--     · who or what decided, and with which version of the engine.
--
-- ⚠️ AND THE FACTS THAT PRODUCED THE ANSWER MOVE. `sales_invoices` already
-- stores `place_of_supply_code` and `place_of_supply_basis` precisely because
-- deriving them on read "re-splits every historical CGST/SGST into IGST the day
-- a delivery address moves" (0049). That argument is correct and it stops one
-- step short: the BASIS is a 40-character string with no statutory reference,
-- no explanation, and nothing tying it to the rate that was chosen alongside
-- it. Six months later, in an assessment, nobody can reconstruct the decision
-- — they can only re-derive it from today's master data and hope it matches.
--
-- ⭐ SO THIS IS A DECISION LOG, NOT A CACHE. Nothing reads it to compute
-- anything. It exists to be READ BY A HUMAN under audit, and its one hard
-- property is that it cannot contain a figure the tax engine could not have
-- produced. An audit trail that can record an arithmetic the engine never
-- performed is not a trail; it is a second, unchecked, copy of the numbers.
--
-- WHAT THIS FILE DOES NOT DO
-- --------------------------
-- It does not populate itself. Nothing writes `tax_decisions` today, exactly
-- as nothing writes `hsn_sac_rate_id` today (0146 §5, 0147 §6). The coverage
-- view in §5 therefore opens at zero, and it REPORTS A NUMBER. It does not
-- assert a floor, and §5 says at length why.
--
-- IS THERE DATA LOSS? No. One new table, one trigger on it, one view. No
-- existing row is read, changed or removed.
--
-- RUN ORDER: after 0147, whose `gst_apply_rate_bps()` and `gst_cgst_share()`
-- this file calls and must not restate. After 0122, 0125 and 0126, whose
-- coverage sweeps this file calls rather than copying their DO blocks.
--
-- ⚠️ NO FILE-LEVEL `BEGIN`/`COMMIT`. The Neon console sends each statement on
-- its own connection and the migration gate refuses a file containing either.
-- Every statement below is independently idempotent.
-- ############################################################################


-- ############################################################################
-- SECTION 0 — THE ARITHMETIC THIS FILE REFUSES TO REWRITE
-- ############################################################################
--
-- 🔴 IF `gst_apply_rate_bps` OR `gst_cgst_share` IS MISSING, STOP HERE. The
-- trigger in §3 calls both. Creating it against a database that lacks them
-- produces a trigger that raises `undefined_function` on the first insert —
-- which is a failure, but months later and worded as a bug rather than as a
-- missing migration.
--
-- ⚠️ AND UNDER NO CIRCUMSTANCES DOES THIS FILE DEFINE ITS OWN. 0147 §1 spent a
-- page justifying ONE extra implementation of half-up rounding, on the grounds
-- that it is a transcription of two primitives from `lib/billing/money.ts` and
-- that §5 there proves the two agree on sixteen cases. A third implementation
-- would have no such justification, and the audit trail disagreeing with the
-- document by one paisa is the single most expensive way this table could fail.

DO $$
DECLARE
  v_missing text := '';
BEGIN
  IF to_regprocedure('gst_apply_rate_bps(bigint, integer)') IS NULL THEN
    v_missing := v_missing || ' gst_apply_rate_bps(bigint,integer)';
  END IF;
  IF to_regprocedure('gst_cgst_share(bigint)') IS NULL THEN
    v_missing := v_missing || ' gst_cgst_share(bigint)';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION
      '0150 REFUSED: the rounding primitives this file recomputes against do '
      'not exist:%. They are created by 0147. Run 0147 first. Do not write '
      'replacements here — a third implementation of half-up rounding is how '
      'the audit trail comes to disagree with the document by one paisa.',
      v_missing
      USING ERRCODE = '42883';
  END IF;

  RAISE NOTICE
    '0150 §0: gst_apply_rate_bps() and gst_cgst_share() are present. The '
    'recompute check will use 0147''s arithmetic and not its own.';
END
$$;


-- ############################################################################
-- SECTION 1 — THE TABLE
-- ############################################################################
--
-- ⭐ IT IS KEYED TO A LINE POLYMORPHICALLY, AND THAT IS A COMPROMISE WITH ITS
-- COST WRITTEN DOWN. Five tables carry a GST split — `sales_invoice_lines`,
-- `sales_credit_note_lines`, `sales_order_lines`, `invoice_lines`,
-- `purchase_invoice_lines`. Five decision tables, one per line table, would
-- give real foreign keys and no `document_table` column. It would also give
-- five copies of the recompute trigger and five copies of every query an
-- accountant runs, which is the shape 0146 §3 had to unpick after it produced
-- two guards that counted the same thing differently.
--
-- ⚠️ THE COST IS THAT `document_line_id` HAS NO FOREIGN KEY AND CANNOT HAVE
-- ONE. A decision can therefore outlive its line. Two things reduce that to
-- something an auditor can work with rather than pretending it away:
--   · `document_table` is CHECKed against the five, so the reference is at
--     least resolvable — it can never name a table that does not exist;
--   · the decision carries the FIGURES, the DATE and the `hsn_sac_rate_id`, so
--     it remains readable and re-checkable on its own after the line is gone,
--     which for an audit log is arguably the point.
-- The gap is real. It is listed in §6 rather than buried.
--
-- ⚠️ AND EVEN A NON-POLYMORPHIC FK WOULD NOT HAVE BEEN A COMPOSITE ONE:
-- `sales_invoice_lines` has no `UNIQUE (id, tenant_id)` — only its primary key
-- — so the 0146 pin could not be applied to it today without altering a table
-- this file does not own. The rate pin below IS composite, because
-- `hsn_sac_rates` has carried `UNIQUE (id, tenant_id)` since 0021.

CREATE TABLE IF NOT EXISTS public.tax_decisions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ── WHAT WAS DECIDED ABOUT ────────────────────────────────────────────
    document_table    varchar(40) NOT NULL,
    document_line_id  uuid NOT NULL,
    -- ⭐ THE PARENT DOCUMENT, DENORMALISED ON PURPOSE. "Show me the reasoning
    -- for invoice X" is the question actually asked, and answering it by
    -- joining back to a line table chosen at runtime from a string column is
    -- not a query anybody wants to write during an assessment.
    document_id       uuid NOT NULL,
    line_no           integer,

    decided_at        timestamptz NOT NULL DEFAULT now(),
    -- ⚠️ THE DOCUMENT'S OWN DATE, NOT THE DECISION'S. The rate in force on the
    -- document's date is the rate that governs (0147 §C2). A decision taken in
    -- August about a March invoice must be judged against March.
    document_date     date NOT NULL,

    -- ── PLACE OF SUPPLY: WHICH SUB-SECTION, AND WHY ───────────────────────
    place_of_supply_code        varchar(2),
    -- The machine-readable rule that was applied, e.g. 'recipient_registered',
    -- 'immovable_property', 'performance', 'goods_delivery'. Matches the
    -- vocabulary already in sales_invoices.place_of_supply_basis.
    place_of_supply_basis       varchar(40),
    -- ⭐ THE COLUMN AN OFFICER ACTUALLY ASKS FOR: 'IGST Act s.12(3)(a)'.
    -- A basis without a statutory reference is a label; with one it is a
    -- citation somebody can look up and disagree with, which is the whole
    -- point of writing it down.
    statutory_ref               varchar(80),
    -- Free text, in the tenant's own words. The facts that made the rule
    -- apply: whose address, which site, where performed.
    place_of_supply_explanation text,

    -- ── WHICH RATE, FROM WHERE ────────────────────────────────────────────
    hsn_sac_code      varchar(10),
    hsn_sac_rate_id   uuid,
    rate_bps          integer NOT NULL,
    cess_rate_bps     integer NOT NULL DEFAULT 0,
    -- e.g. 'Notification 11/2017-Central Tax (Rate), Sl. No. 3(ii)'.
    notification_ref  varchar(160),
    -- Copied from the rate period, not joined. Same argument as every other
    -- captured-at-issue column in this schema: closing the period next year
    -- must not restate what this decision says was in force.
    rate_effective_from date,
    rate_effective_to   date,

    -- ── HOW IT WAS TREATED ────────────────────────────────────────────────
    -- ⚠️ `cgst_utgst` IS A SEPARATE VALUE FROM `cgst_sgst` AND SHARES ITS
    -- COLUMNS. In a Union Territory without a legislature the second half is
    -- UTGST under the UTGST Act, not SGST — a different statute, a different
    -- return field — and the amount lands in `sgst_minor` because no line
    -- table in this product has a `utgst_minor` column to mirror. Recording
    -- the KIND is what makes the amount interpretable; that is the entire
    -- reason this column is not a boolean.
    tax_kind          varchar(12) NOT NULL,
    is_reverse_charge boolean NOT NULL DEFAULT false,
    -- Which limb of s.9(3)/9(4) or Notification 13/2017 applied,
    -- e.g. 'notified_service', 'unregistered_supplier', 'import_of_service'.
    reverse_charge_basis varchar(40),

    -- ── THE MONEY, WHICH §3 REFUSES TO ACCEPT UNLESS IT RECOMPUTES ────────
    -- ⚠️ NO NON-NEGATIVE CHECK ON `taxable_value_minor`, DELIBERATELY. A credit
    -- note line is negative and its decision is the negative of the same
    -- reasoning; `gst_apply_rate_bps` is symmetric about zero precisely so
    -- that stays exact (0147 §1).
    taxable_value_minor bigint NOT NULL,
    cgst_minor          bigint NOT NULL DEFAULT 0,
    sgst_minor          bigint NOT NULL DEFAULT 0,
    igst_minor          bigint NOT NULL DEFAULT 0,
    cess_minor          bigint NOT NULL DEFAULT 0,

    -- ── WHO DECIDED ───────────────────────────────────────────────────────
    -- ⭐ NOT NULL, AND NOT DEFAULTED. "Which version of the engine produced
    -- this" is the question asked the day a rounding bug is found, and it is
    -- unanswerable across a corpus if the column was allowed to be blank. A
    -- default would let a caller that does not know its own version write one
    -- anyway, which is the same failure wearing a value.
    engine_version    varchar(20) NOT NULL,
    -- A user id, a job name, 'import:tally', 'manual-override:<user>'. Free
    -- text because the set of deciders is not closed and a FK to `users` would
    -- refuse a decision taken by a scheduled job.
    decided_by        varchar(120),

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- ⭐ SO ANOTHER TABLE CAN PIN A DECISION WITH A COMPOSITE KEY, the way
    -- 0146 had to retrofit onto four line tables that shipped without it.
    -- Free now; an ALTER, a backfill and an argument later.
    CONSTRAINT tax_decisions_id_tenant_key UNIQUE (id, tenant_id),

    -- ⚠️ ONE CURRENT DECISION PER LINE. A second row for the same line is not
    -- a second opinion, it is an ambiguity: an auditor reading two decisions
    -- for one line cannot tell which one the document was raised under. A
    -- revised decision REPLACES this row; the previous version is recoverable
    -- from `change_log`, which §4 attaches.
    CONSTRAINT tax_decisions_one_per_line UNIQUE (tenant_id, document_table, document_line_id),

    -- ⚠️ THE FIVE TABLES THAT CARRY A GST SPLIT, ENUMERATED. Without this,
    -- `document_table` is a free-text column that can name a table that has
    -- never existed, and the reference is unresolvable rather than merely
    -- unenforced. The list is the same five 0147 attaches its recompute
    -- trigger to; if a sixth ever carries a split, it belongs in both.
    CONSTRAINT tax_decisions_document_table_known CHECK (
        document_table IN ('sales_invoice_lines', 'sales_credit_note_lines',
                           'sales_order_lines', 'invoice_lines',
                           'purchase_invoice_lines')
    ),

    CONSTRAINT tax_decisions_tax_kind_known CHECK (
        tax_kind IN ('igst', 'cgst_sgst', 'cgst_utgst')
    ),

    -- Matches `hsn_sac_rates_rate_sane` and `hsn_sac_rates_cess_sane` from
    -- 0021. A decision recording a rate the rate master could not hold is a
    -- decision about nothing.
    CONSTRAINT tax_decisions_rate_sane CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    CONSTRAINT tax_decisions_cess_sane CHECK (cess_rate_bps >= 0 AND cess_rate_bps <= 100000),

    CONSTRAINT tax_decisions_period_sane CHECK (
        rate_effective_to IS NULL OR rate_effective_from IS NULL
        OR rate_effective_to > rate_effective_from
    ),

    -- ⚠️ THE PIN IS COMPOSITE. Single-column is the exact form 0021 spent a
    -- page explaining is not enough and 0146 had to retrofit onto four tables:
    -- referential integrity runs as the referenced table's owner with row
    -- security OFF, so a single-column FK happily resolves a rate row the
    -- writing session cannot even SELECT. ON DELETE RESTRICT because the rate
    -- row is the evidence of what was decided.
    CONSTRAINT tax_decisions_rate_same_tenant
        FOREIGN KEY (hsn_sac_rate_id, tenant_id)
        REFERENCES hsn_sac_rates (id, tenant_id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.tax_decisions IS
    'Why a line was taxed the way it was: which place of supply and under '
    'which sub-section, which rate and under which notification, whether '
    'reverse charge applied, and which engine version decided. Read by humans '
    'under audit; nothing computes from it. §3''s trigger refuses any row whose '
    'money does not recompute from its own taxable value and rate. 0150.';

COMMENT ON COLUMN public.tax_decisions.statutory_ref IS
    'The provision relied on, e.g. ''IGST Act s.12(3)(a)''. A basis without a '
    'citation is a label; with one it is something an officer can look up.';
COMMENT ON COLUMN public.tax_decisions.tax_kind IS
    'igst | cgst_sgst | cgst_utgst. In a Union Territory the second half is '
    'UTGST under a different Act and lands in sgst_minor because no line table '
    'has a utgst_minor column. Recording the kind is what makes the amount '
    'interpretable.';
COMMENT ON COLUMN public.tax_decisions.engine_version IS
    'NOT NULL and undefaulted: "which version produced this" is the question '
    'asked the day a rounding bug is found, and a blank makes it unanswerable.';

-- "Show me the reasoning behind every line of invoice X."
CREATE INDEX IF NOT EXISTS tax_decisions_document_idx
    ON public.tax_decisions (tenant_id, document_table, document_id);

-- "Show me every decision in the period under assessment."
CREATE INDEX IF NOT EXISTS tax_decisions_date_idx
    ON public.tax_decisions (tenant_id, document_date);


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ⚠️ FORCE, NOT JUST ENABLE. `ENABLE ROW LEVEL SECURITY` alone does not apply
-- to the table's OWNER, and the application connects as the owner. Every
-- tenant-shaped table in this product is FORCEd for that reason, and a new one
-- that is merely ENABLEd is a table with no isolation at all in production
-- while looking correct in the catalogue.
--
-- The policy is the pair used by `sales_invoices` and `sales_invoice_lines`,
-- the tables this one describes — read within the tenant or under platform
-- scope, write only within the tenant. Not a variant: a decision log whose
-- visibility rules differ from the documents it explains is a log that can be
-- read by somebody who cannot read the invoice.

ALTER TABLE public.tax_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_decisions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_decisions_tenant_isolation ON public.tax_decisions;
CREATE POLICY tax_decisions_tenant_isolation
    ON public.tax_decisions
    USING      ((tenant_id = app_current_tenant_id()) OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 3 — A ROW THE ENGINE COULD NOT HAVE PRODUCED IS NOT A TRAIL
-- ############################################################################
--
-- ⭐ THIS IS THE ONLY REASON THE TABLE IS SAFE TO BELIEVE. An audit log that
-- accepts arbitrary numbers is a second, unchecked copy of the document — and
-- worse than none, because it reads like corroboration. Every row must
-- recompute from its OWN `taxable_value_minor`, `rate_bps`, `cess_rate_bps`
-- and `tax_kind`, using 0147's primitives and nothing else.
--
-- ⚠️ IT DOES NOT CHECK THE DECISION AGAINST THE LINE. Comparing
-- `tax_decisions.igst_minor` to `sales_invoice_lines.igst_minor` would need a
-- dynamic lookup into one of five tables and would refuse the legitimate case
-- where a decision is written to record that the document is WRONG. What is
-- enforced is that the decision is internally computable; whether the document
-- followed it is a report, and §5 is where that report starts.
--
-- ⚠️ SECURITY INVOKER. Unlike 0147's line trigger, this one reads no other
-- table — every input is on the row in front of it. There is nothing RLS could
-- blind, so there is no reason to escalate, and a SECURITY DEFINER function
-- that does not need to be one is a privilege-escalation surface bought for
-- nothing.

CREATE OR REPLACE FUNCTION enforce_tax_decision_recomputes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_exp_tax  bigint;
  v_exp_cgst bigint;
  v_exp_sgst bigint;
  v_exp_igst bigint;
  v_exp_cess bigint;
BEGIN
  -- ⭐ THE HEAD IS READ FROM `tax_kind`, NOT INFERRED FROM WHICH AMOUNT IS
  -- NON-ZERO. 0147's line trigger has to infer it, because a line table has no
  -- column saying which head was chosen — which means a line with the correct
  -- rate and every amount at zero is ambiguous there and needs a special case.
  -- Here the decision states its own treatment, so an all-zero row at 18% is
  -- simply wrong and is refused without a special case.
  v_exp_tax := gst_apply_rate_bps(NEW.taxable_value_minor, NEW.rate_bps);

  IF NEW.tax_kind = 'igst' THEN
    v_exp_igst := v_exp_tax;
    v_exp_cgst := 0;
    v_exp_sgst := 0;
  ELSE
    -- cgst_sgst and cgst_utgst split identically. They differ in which Act the
    -- second half is charged under, not in the arithmetic.
    v_exp_igst := 0;
    v_exp_cgst := gst_cgst_share(v_exp_tax);
    -- ⚠️ THE REMAINDER, NOT A SECOND ROUNDING. Halving the rate and rounding
    -- each half separately turns ₹18.01 of tax into ₹9.01 + ₹9.01 and the
    -- decision stops adding up. 0147 §1 makes the same point about the same
    -- primitive.
    v_exp_sgst := v_exp_tax - v_exp_cgst;
  END IF;

  IF NEW.cgst_minor <> v_exp_cgst
     OR NEW.sgst_minor <> v_exp_sgst
     OR NEW.igst_minor <> v_exp_igst THEN
    RAISE EXCEPTION
      'This tax decision does not recompute. A taxable value of % paise at % '
      'bps treated as % is % paise of tax, which is CGST %, SGST %, IGST %. '
      'The decision records CGST %, SGST %, IGST %. A decision log that can '
      'hold a figure the engine could not have produced is not evidence of '
      'anything — it is a second copy of the numbers with nobody checking it.',
      NEW.taxable_value_minor, NEW.rate_bps, NEW.tax_kind, v_exp_tax,
      v_exp_cgst, v_exp_sgst, v_exp_igst,
      NEW.cgst_minor, NEW.sgst_minor, NEW.igst_minor
      USING ERRCODE = '23514';
  END IF;

  -- ⚠️ AD VALOREM CESS ONLY. A specific-rate cess (tobacco, pan masala) is
  -- charged per unit and cannot be represented by `cess_rate_bps` at all — the
  -- same gap 0147 §A records against the line tables, inherited here because
  -- this table mirrors their columns. See §6.
  v_exp_cess := gst_apply_rate_bps(NEW.taxable_value_minor, NEW.cess_rate_bps);
  IF NEW.cess_minor <> v_exp_cess THEN
    RAISE EXCEPTION
      'This tax decision does not recompute its cess. A taxable value of % '
      'paise at % bps of cess is % paise; the decision records %.',
      NEW.taxable_value_minor, NEW.cess_rate_bps, v_exp_cess, NEW.cess_minor
      USING ERRCODE = '23514';
  END IF;

  -- ⭐ A PINNED RATE PERIOD MUST COVER THE DOCUMENT'S OWN DATE, and must agree
  -- with the rate the decision says was applied. This is the same rule 0147 §C
  -- enforces on a line, and it matters more here: the whole purpose of the row
  -- is to say WHICH period the figure came from. A pin that points at a period
  -- not covering the document's date looks like provenance and is the opposite.
  -- ⚠️ The copied `rate_effective_*` columns are checked, not re-read from
  -- `hsn_sac_rates` — reading the master here would make the trigger's verdict
  -- depend on data that is allowed to change afterwards, and 0146 already
  -- refuses to move a period out from under a document that used it.
  IF NEW.rate_effective_from IS NOT NULL
     AND NEW.document_date < NEW.rate_effective_from THEN
    RAISE EXCEPTION
      'This decision is for a document dated % but cites a rate period '
      'beginning %. The rate in force on the document''s own date is the one '
      'that governs.',
      NEW.document_date, NEW.rate_effective_from
      USING ERRCODE = '23514';
  END IF;

  IF NEW.rate_effective_to IS NOT NULL
     AND NEW.document_date >= NEW.rate_effective_to THEN
    RAISE EXCEPTION
      'This decision is for a document dated % but cites a rate period that '
      'closed on %. Citing a superseded period as the authority for a later '
      'document is the failure this column exists to make visible.',
      NEW.document_date, NEW.rate_effective_to
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_tax_decision_recomputes() IS
    'Refuses a tax_decisions row whose money does not recompute from its own '
    'taxable value, rate, cess rate and tax_kind, using 0147''s '
    'gst_apply_rate_bps() and gst_cgst_share(). 0150.';

DROP TRIGGER IF EXISTS tax_decisions_recomputes ON public.tax_decisions;
CREATE TRIGGER tax_decisions_recomputes
    BEFORE INSERT OR UPDATE ON public.tax_decisions
    FOR EACH ROW EXECUTE FUNCTION enforce_tax_decision_recomputes();


-- ############################################################################
-- SECTION 4 — THE THREE TRIGGERS EVERY TENANT TABLE IN THIS PRODUCT GETS
-- ############################################################################
--
-- ⭐ CALLED, NOT COPIED. 0122 exists because seventeen module files each
-- carried their own copy of 0017's attach block, and the eighteenth (0085)
-- shipped without one — five tables that silently never synced. Its own
-- comment says a module migration should CALL the sweep instead. So this file
-- calls all three sweeps rather than writing `CREATE TRIGGER` three times:
--
--   · `attach_change_log_triggers()`  (0122) — without it, a tax decision
--     written on the laptop is simply not there on the desktop, and nothing
--     reports a problem because a table with no trigger produces no rows.
--     It is also what makes a REPLACED decision recoverable, which is the
--     justification for `tax_decisions_one_per_line` above.
--   · `attach_updated_at_triggers()`  (0126) — the table has `updated_at`.
--   · `attach_impersonation_guards()` (0125) — the table has `tenant_id`, so
--     a support engineer under impersonation must not be able to delete from
--     it.
--
-- ⚠️ THE SWEEPS ARE DISCOVERY-BASED AND IDEMPOTENT, so this is safe to re-run
-- and will also pick up anything else that has arrived uncovered. Each returns
-- the tables it touched; only this one is expected.

DO $$
DECLARE
  v_logged   text[];
  v_touched  text[];
  v_guarded  text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_logged FROM attach_change_log_triggers() t;

  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_touched FROM attach_updated_at_triggers() t;

  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_guarded FROM attach_impersonation_guards() t;

  RAISE NOTICE
    '0150 §4: change recorder attached to [%]; updated_at attached to [%]; '
    'impersonation delete guard attached to [%].',
    array_to_string(v_logged,  ', '),
    array_to_string(v_touched, ', '),
    array_to_string(v_guarded, ', ');
END
$$;


-- ############################################################################
-- SECTION 5 — THE COVERAGE VIEW, WHICH REPORTS A NUMBER
-- ############################################################################
--
-- 🔴 THERE IS NO `count(*) >= N THEN 'PASS'` IN THIS FILE AND THERE MUST NEVER
-- BE ONE. This codebase shipped a coverage check written exactly that way — a
-- property that had to hold on 303 tables, asserted as `count(*) >= 10`. It
-- passed at 48. It would have passed at 10. It reported green for months while
-- 255 tables were uncovered, and every reader of that green treated the
-- question as closed.
--
-- ⭐ THE LESSON IS NOT "PICK A BIGGER N". It is that a THRESHOLD on a coverage
-- question converts a number into a boolean, and the boolean is what gets read.
-- So this view emits the count and the complement and nothing else. There is
-- no verdict column, no `status`, no `PASS`, and no `ok` boolean for a
-- dashboard to latch onto — because the honest answer today is ZERO PERCENT
-- and a well-chosen threshold could hide that just as easily as a badly-chosen
-- one.
--
-- ⚠️ `security_invoker = true`, WITHOUT WHICH THIS IS A CROSS-TENANT LEAK. A
-- view runs as its OWNER by default and the owner's RLS does not apply, so an
-- aggregate over every tenant's invoice lines would be returned to whoever
-- asked. Same requirement, same reason, as every view since 0008 §1.
--
-- ⚠️ AND IT IS SCOPED TO `sales_invoice_lines` ONLY, deliberately. That is the
-- table GSTR-1 is built from and the one an assessment starts at. The other
-- four are a UNION away and are NOT added here, because a single blended
-- "coverage %" across five tables with five different lifecycles is precisely
-- the number that reads as reassuring and answers nothing.

DROP VIEW IF EXISTS public.tax_decision_gaps;

CREATE VIEW public.tax_decision_gaps
WITH (security_invoker = true) AS
SELECT
    l.tenant_id,
    -- Lines that actually charged something. A nil-rated or exempt line has
    -- nothing to explain, and counting it as a gap would inflate the
    -- denominator with rows that need no decision.
    count(*)::bigint AS lines_carrying_tax,
    count(*) FILTER (WHERE d.id IS NOT NULL)::bigint AS lines_with_decision,
    -- 🔴 READ THIS ONE. It is the number of taxed lines on outward supplies
    -- for which this workspace cannot say which rate, which rule, or which
    -- place of supply was applied. Today it equals lines_carrying_tax,
    -- because nothing writes tax_decisions yet.
    count(*) FILTER (WHERE d.id IS NULL)::bigint AS lines_without_decision
FROM sales_invoice_lines l
LEFT JOIN tax_decisions d
       ON d.tenant_id        = l.tenant_id
      AND d.document_table   = 'sales_invoice_lines'
      AND d.document_line_id = l.id
WHERE l.cgst_minor <> 0 OR l.sgst_minor <> 0
   OR l.igst_minor <> 0 OR l.cess_minor <> 0
GROUP BY l.tenant_id;

COMMENT ON VIEW public.tax_decision_gaps IS
    'Per tenant: how many taxed sales_invoice_lines rows have no tax_decisions '
    'row. A NUMBER, with no threshold and no verdict column, because this '
    'codebase shipped a coverage check written count(*) >= 10 for a property '
    'needing to hold on 303 tables and it passed at 48. 0150.';

DO $$
DECLARE
  v_tenants  bigint;
  v_taxed    bigint;
  v_explained bigint;
BEGIN
  SELECT count(*), coalesce(sum(lines_carrying_tax), 0),
         coalesce(sum(lines_with_decision), 0)
    INTO v_tenants, v_taxed, v_explained
    FROM tax_decision_gaps;

  -- ⚠️ A NOTICE, NOT AN ASSERTION. Nothing populates this table yet, so any
  -- floor asserted here would be a floor of zero, which is a check that cannot
  -- fail — the exact shape 0147 §6 and 0146 §5 both refused to write.
  RAISE NOTICE
    '0150 §5: % workspace(s) have taxed outward-supply lines; % such line(s) '
    'in total, of which % carry a recorded tax decision. This is reported as a '
    'number and is asserted against nothing.',
    v_tenants, v_taxed, v_explained;
END
$$;


-- ############################################################################
-- SECTION 6 — SELF-VERIFICATION: ATTEMPT THE WRITES, DO NOT ASK THE CATALOGUE
-- ############################################################################
--
-- ⭐ EVERY REFUSAL BELOW IS PROVEN BY ATTEMPTING THE WRITE. `SELECT count(*)
-- FROM pg_trigger WHERE tgname = 'tax_decisions_recomputes'` proves a name was
-- registered; it does not prove the trigger refuses anything, and that is the
-- distance this codebase has been bitten by 23 times.
--
-- The whole probe is one sub-block ended by a sentinel exception, so every row
-- it wrote is discarded. plpgsql variables are not transactional, so the
-- verdicts survive and the assertions below read them.
--
-- ⚠️ `v_ran` IS ASSERTED FIRST. A fixture insert failing for an unrelated
-- reason leaves every `r_*` flag reading false, and a "did it refuse?"
-- assertion can be made to pass on a probe that never happened.
--
-- ⚠️ FIVE OF THE THIRTEEN CHECKS ASSERT THAT A CORRECT ROW IS ACCEPTED. A
-- trigger that refuses everything passes every refusal test.

DO $$
DECLARE
  v_t     uuid := gen_random_uuid();
  v_t2    uuid := gen_random_uuid();
  v_co    uuid := gen_random_uuid();
  v_code  uuid := gen_random_uuid();
  v_code2 uuid := gen_random_uuid();
  v_rate  uuid := gen_random_uuid();
  v_rate2 uuid := gen_random_uuid();
  v_old   uuid := gen_random_uuid();
  v_doc   uuid := gen_random_uuid();
  v_line1 uuid := gen_random_uuid();

  v_ran            boolean := false;
  r_wrong_igst     boolean := false;
  r_wrong_head     boolean := false;
  r_even_split     boolean := false;
  r_wrong_cess     boolean := false;
  r_zero_money     boolean := false;
  r_bad_table      boolean := false;
  r_bad_kind       boolean := false;
  r_two_decisions  boolean := false;
  r_cross_tenant   boolean := false;
  r_stale_period   boolean := false;
  a_igst           boolean := false;
  a_odd_paisa      boolean := false;
  a_utgst          boolean := false;
  a_credit_note    boolean := false;
  a_exempt         boolean := false;
  v_err            text := '';
BEGIN
  BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_t,  'org_0150_a_' || substr(v_t::text, 1, 8),
            '0150-probe-a-' || substr(v_t::text, 1, 8),  '0150 probe A', 'active'),
           (v_t2, 'org_0150_b_' || substr(v_t2::text, 1, 8),
            '0150-probe-b-' || substr(v_t2::text, 1, 8), '0150 probe B', 'active');
    INSERT INTO companies (id, tenant_id, name) VALUES (v_co, v_t, '0150 probe customer');

    INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code,  v_t,  '998314', 'sac', '0150 probe'),
           (v_code2, v_t2, '998314', 'sac', '0150 probe');

    INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps,
                               effective_from, effective_to)
    VALUES (v_old,   v_t,  v_code,  1200, 0, DATE '2017-07-01', DATE '2019-04-01'),
           (v_rate,  v_t,  v_code,  1800, 0, DATE '2019-04-01', NULL),
           (v_rate2, v_t2, v_code2, 1800, 0, DATE '2019-04-01', NULL);

    /* ── REFUSALS ─────────────────────────────────────────────────────── */

    -- 1. ₹1,000 at 18% recorded as one paisa of IGST — 0147's PROOF 1, in the
    --    audit trail instead of on the document.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'igst', 100000, 1, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_wrong_igst := true;
    END;

    -- 2. tax_kind says cgst_sgst, the money says IGST.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'cgst_sgst', 100000, 18000, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_wrong_head := true;
    END;

    -- 3. ⭐ THE ODD PAISA, SPLIT EVENLY. 10005 at 18% is 1800.9 → 1801, which
    --    splits 901/900. Recording 900/900 loses a paisa and 901/901 invents
    --    one; both are the arithmetic nobody notices until a return does not
    --    foot. Rounding twice is the natural way to write it and it is wrong.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, cgst_minor, sgst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'cgst_sgst', 10005, 900, 900, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_even_split := true;
    END;

    -- 4. Cess that does not follow from the cess rate recorded beside it.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, cess_rate_bps, tax_kind, taxable_value_minor, igst_minor,
         cess_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 1200, 'igst', 100000, 18000, 1, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_wrong_cess := true;
    END;

    -- 5. A rate named and no money at all. On a line table this case is
    --    ambiguous and 0147 needs a special case for it; here tax_kind states
    --    the treatment, so it is simply wrong.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'igst', 100000, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_zero_money := true;
    END;

    -- 6. A document_table that is not one of the five.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'demand_notices', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'igst', 100000, 18000, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_bad_table := true;
    END;

    -- 7. A tax_kind outside the three.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'vat', 100000, 18000, '0150-probe');
    EXCEPTION WHEN check_violation THEN r_bad_kind := true;
    END;

    -- 8. Two decisions for one line. An auditor reading both cannot tell which
    --    one the document was raised under.
    INSERT INTO tax_decisions
      (tenant_id, document_table, document_line_id, document_id, document_date,
       rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
    VALUES (v_t, 'sales_invoice_lines', v_line1, v_doc, DATE '2026-08-19',
            1800, 'igst', 100000, 18000, '0150-probe');
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', v_line1, v_doc, DATE '2026-08-19',
              1200, 'igst', 100000, 12000, '0150-probe');
    EXCEPTION WHEN unique_violation THEN r_two_decisions := true;
    END;

    -- 9. A decision in tenant A citing tenant B's rate row. The composite key
    --    is the only thing that refuses this: referential integrity runs with
    --    row security OFF, so a single-column FK would resolve it happily.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         hsn_sac_rate_id, rate_bps, tax_kind, taxable_value_minor, igst_minor,
         engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              v_rate2, 1800, 'igst', 100000, 18000, '0150-probe');
    EXCEPTION WHEN foreign_key_violation THEN r_cross_tenant := true;
    END;

    -- 10. A 2026 document citing a period that closed in 2019.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         hsn_sac_rate_id, rate_bps, tax_kind, taxable_value_minor, igst_minor,
         rate_effective_from, rate_effective_to, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              v_old, 1200, 'igst', 100000, 12000,
              DATE '2017-07-01', DATE '2019-04-01', '0150-probe');
    EXCEPTION WHEN check_violation THEN r_stale_period := true;
    END;

    /* ── ACCEPTANCES ──────────────────────────────────────────────────── */

    -- 11. The full, correct, well-cited inter-state decision. If this is
    --     refused the table is unusable and every refusal above is noise.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, line_no,
         document_date, place_of_supply_code, place_of_supply_basis,
         statutory_ref, place_of_supply_explanation,
         hsn_sac_code, hsn_sac_rate_id, rate_bps, notification_ref,
         rate_effective_from, tax_kind, taxable_value_minor, igst_minor,
         engine_version, decided_by)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, 1,
              DATE '2026-08-19', '29', 'recipient_registered',
              'IGST Act s.12(2)(a)',
              'Recipient is registered; place of supply is the location of the '
              'recipient, Karnataka. Supplier is in Maharashtra, so inter-state.',
              '998314', v_rate, 1800,
              'Notification 11/2017-Central Tax (Rate), Sl. No. 3(ii)',
              DATE '2019-04-01', 'igst', 100000, 18000,
              '0150-probe', 'probe@ordence');
      a_igst := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [11] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 12. ⭐ THE ODD PAISA, SPLIT CORRECTLY: 1801 → 901 / 900. The mirror of
    --     check 3. A `cgst = sgst` constraint would refuse this CORRECT row.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, cgst_minor, sgst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              1800, 'cgst_sgst', 10005, 901, 900, '0150-probe');
      a_odd_paisa := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [12] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 13. A Union Territory decision. Same arithmetic, different Act for the
    --     second half, and the row says so.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         place_of_supply_code, statutory_ref, rate_bps, tax_kind,
         taxable_value_minor, cgst_minor, sgst_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              '26', 'UTGST Act s.7', 1800, 'cgst_utgst', 100000, 9000, 9000,
              '0150-probe');
      a_utgst := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [13] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 14. A credit note's decision: the exact negative of the same reasoning.
    --     A non-negative CHECK on taxable_value_minor would have refused this.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
      VALUES (v_t, 'sales_credit_note_lines', gen_random_uuid(), v_doc,
              DATE '2026-08-19', 1800, 'igst', -100000, -18000, '0150-probe');
      a_credit_note := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [14] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 15. An exempt supply: nil rate, no tax, and a citation for WHY it is
    --     exempt — which is the decision an officer is most likely to test.
    BEGIN
      INSERT INTO tax_decisions
        (tenant_id, document_table, document_line_id, document_id, document_date,
         statutory_ref, notification_ref, rate_bps, tax_kind,
         taxable_value_minor, engine_version)
      VALUES (v_t, 'sales_invoice_lines', gen_random_uuid(), v_doc, DATE '2026-08-19',
              'CGST Act s.11(1)', 'Notification 12/2017-Central Tax (Rate)',
              0, 'igst', 100000, '0150-probe');
      a_exempt := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [15] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    v_ran := true;
    RAISE EXCEPTION '0150_PROBE_ROLLBACK' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> '0150_PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_ran THEN
    RAISE EXCEPTION
      '0150 FAILED: the verification probe did not reach its own last line, so '
      'every verdict it recorded is meaningless. Do not read this as a pass. '
      'Errors collected: %', v_err;
  END IF;

  IF NOT r_wrong_igst THEN
    RAISE EXCEPTION '0150 FAILED: a decision recording ₹1,000 at 18%% as one paisa of IGST was accepted.';
  END IF;
  IF NOT r_wrong_head THEN
    RAISE EXCEPTION '0150 FAILED: a decision declaring tax_kind=cgst_sgst while recording IGST was accepted.';
  END IF;
  IF NOT r_even_split THEN
    RAISE EXCEPTION '0150 FAILED: an odd total tax of 1801 paise split 900/900 was accepted. A paisa was lost and the trail is one rounding away from the document.';
  END IF;
  IF NOT r_wrong_cess THEN
    RAISE EXCEPTION '0150 FAILED: a cess amount that does not follow from the cess rate beside it was accepted.';
  END IF;
  IF NOT r_zero_money THEN
    RAISE EXCEPTION '0150 FAILED: a decision naming an 18%% rate and recording no tax at all was accepted.';
  END IF;
  IF NOT r_bad_table THEN
    RAISE EXCEPTION '0150 FAILED: a decision naming a document_table outside the five line tables was accepted.';
  END IF;
  IF NOT r_bad_kind THEN
    RAISE EXCEPTION '0150 FAILED: a decision naming a tax_kind outside the three was accepted.';
  END IF;
  IF NOT r_two_decisions THEN
    RAISE EXCEPTION '0150 FAILED: two current decisions were accepted for one line.';
  END IF;
  IF NOT r_cross_tenant THEN
    RAISE EXCEPTION '0150 FAILED: a decision in tenant A citing tenant B''s rate row was accepted. The rate pin is not composite.';
  END IF;
  IF NOT r_stale_period THEN
    RAISE EXCEPTION '0150 FAILED: a 2026 document citing a rate period that closed in 2019 was accepted as its authority.';
  END IF;

  IF NOT (a_igst AND a_odd_paisa AND a_utgst AND a_credit_note AND a_exempt) THEN
    RAISE EXCEPTION
      '0150 FAILED: a CORRECT decision was refused. inter_state=% odd_paisa=% '
      'union_territory=% credit_note=% exempt=%. Errors:%. A control that '
      'refuses correct rows is worse than the gap it closed.',
      a_igst, a_odd_paisa, a_utgst, a_credit_note, a_exempt, v_err;
  END IF;

  RAISE NOTICE
    '0150 PASS: ten wrong decisions were ATTEMPTED and REFUSED (IGST that does '
    'not recompute, a head disagreeing with tax_kind, an odd tax split 900/900, '
    'a cess that does not follow its rate, a rate naming no money, an unknown '
    'document_table, an unknown tax_kind, a second decision for one line, a '
    'cross-tenant rate citation, and a superseded rate period cited for a 2026 '
    'document) and five correct decisions were ATTEMPTED and ACCEPTED '
    '(inter-state fully cited, the odd paisa 901/900, a Union Territory split, '
    'a credit note''s negative, and an exempt supply at nil rate). All probe '
    'rows were rolled back and nothing was left behind.';
END
$$;


-- ############################################################################
-- SECTION 7 — THE ISOLATION AND COVERAGE ASSERTIONS THAT ARE NOT WRITES
-- ############################################################################
--
-- ⚠️ THESE THREE ARE CATALOGUE CHECKS AND THAT IS STATED RATHER THAN DISGUISED.
-- §6 proves every refusal by attempting the write, which is the standard this
-- wave holds itself to. RLS is the one property that cannot be proven that way
-- from inside a migration: the migration runs as the table's owner or as a
-- superuser, and a superuser bypasses row security unconditionally, so a
-- "cross-tenant read was refused" probe here would prove nothing about the
-- application's session. Switching to `ordence_app` is not an option either —
-- that role does not exist on every deployment, and a control that depends on a
-- GRANT is inert in production, where the app connects as the owner.
--
-- ⭐ WHAT IS PROVEN BY WRITE IS THE PART THAT MATTERS MOST FOR INTEGRITY:
-- check 9 in §6 attempted a cross-tenant rate citation and it was REFUSED.
-- What is asserted from the catalogue below is that RLS is enabled, FORCEd,
-- and carries the same policy expression as the tables this one explains.
-- `tests/security/rls.test.ts` is where a real second session proves the rest.

DO $$
DECLARE
  v_enabled  boolean;
  v_forced   boolean;
  v_using    text;
  v_check    text;
  v_invoker  boolean;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'tax_decisions';

  IF NOT COALESCE(v_enabled, false) OR NOT COALESCE(v_forced, false) THEN
    RAISE EXCEPTION
      '0150 FAILED: tax_decisions has row security enabled=%, forced=%. ENABLE '
      'without FORCE does not apply to the table''s OWNER, and the application '
      'connects as the owner — which means no isolation at all in production '
      'while the catalogue looks correct.',
      v_enabled, v_forced;
  END IF;

  SELECT pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
    INTO v_using, v_check
    FROM pg_policy p
   WHERE p.polrelid = 'public.tax_decisions'::regclass
     AND p.polname  = 'tax_decisions_tenant_isolation';

  IF v_using IS DISTINCT FROM '((tenant_id = app_current_tenant_id()) OR app_platform_scope())'
     OR v_check IS DISTINCT FROM '(tenant_id = app_current_tenant_id())' THEN
    RAISE EXCEPTION
      '0150 FAILED: the tenant isolation policy on tax_decisions is not the '
      'house pattern. USING is [%] and WITH CHECK is [%]. A decision log whose '
      'visibility rules differ from the documents it explains can be read by '
      'somebody who cannot read the invoice.',
      COALESCE(v_using, '<missing>'), COALESCE(v_check, '<missing>');
  END IF;

  -- ⚠️ A VIEW WITHOUT security_invoker RUNS AS ITS OWNER AND RLS DOES NOT
  -- APPLY. `tax_decision_gaps` aggregates every tenant's invoice lines, so
  -- without this it hands a per-tenant breakdown of the whole database to
  -- whoever asks. Same requirement, same reason, as every view since 0008 §1.
  SELECT 'security_invoker=true' = ANY (c.reloptions)
    INTO v_invoker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'tax_decision_gaps';

  IF NOT COALESCE(v_invoker, false) THEN
    RAISE EXCEPTION
      '0150 FAILED: tax_decision_gaps does not run with security_invoker, so '
      'it aggregates every tenant''s invoice lines and returns the breakdown '
      'to any caller.';
  END IF;

  RAISE NOTICE
    '0150 §7 PASS: tax_decisions has row security ENABLED and FORCED with the '
    'same isolation policy as sales_invoices, and tax_decision_gaps runs with '
    'security_invoker so its aggregate is the caller''s own workspace.';
END
$$;


-- ############################################################################
-- SECTION 8 — WHAT THIS FILE DELIBERATELY LEAVES OPEN
-- ############################################################################
--
-- ⚠️ NOTHING WRITES IT YET, AND NO FLOOR IS ASSERTED. `tax_decision_gaps`
-- opens at 100% uncovered and §5 reports that as a number. The temptation to
-- add `HAVING lines_without_decision = 0 THEN 'PASS'` is the whole reason §5's
-- comment is as long as it is.
--
-- ⚠️ `document_line_id` HAS NO FOREIGN KEY AND CANNOT HAVE ONE while the table
-- is polymorphic across five line tables. A decision can outlive its line.
-- `document_table` being CHECKed keeps the reference resolvable and the
-- decision carries enough of its own facts to be re-checked after the line is
-- gone, but the dangling row is real. Closing it properly needs either five
-- tables or a `UNIQUE (id, tenant_id)` on all five line tables plus five
-- conditional FKs, and `sales_invoice_lines` does not have that key today.
--
-- ⚠️ THE DECISION IS NOT COMPARED TO THE LINE. §3 proves the decision is
-- internally computable, not that the document followed it. A trigger that
-- looked the line up would need a dynamic read into one of five tables and
-- would refuse the legitimate case where a decision records that the document
-- is WRONG. The comparison belongs in a report, and `tax_decision_gaps` is
-- where that report starts — it currently answers "is there a decision at all",
-- which is the question that has a non-zero answer today.
--
-- ⚠️ AD VALOREM CESS ONLY. `cess_rate_bps` cannot express a specific-rate cess
-- (tobacco, pan masala), which is charged per unit. Inherited from the line
-- tables this mirrors; 0147 §6 records the same gap against them. Adding
-- `cess_per_unit_minor` here while no line table has it would let the trail
-- describe a charge the document cannot make.
--
-- ⚠️ `is_reverse_charge` AND `reverse_charge_basis` ARE RECORDED, NOT ENFORCED.
-- Under reverse charge the money still recomputes — the supplier shows the tax
-- and does not collect it — so §3 applies unchanged. What is NOT checked is
-- that the flag agrees with the parent document's `is_reverse_charge`, for the
-- same reason the figures are not compared to the line: it is a cross-table
-- read into one of five tables, and a disagreement is a finding to report
-- rather than a row to refuse.
--
-- ⚠️ `place_of_supply_code` IS NOT VALIDATED AGAINST A STATE-CODE REGISTRY.
-- Neither is `sales_invoices.place_of_supply_code`, which is the column this
-- one mirrors. Fixing it in the audit trail alone would mean the trail could
-- refuse to describe a document the product will happily raise.
-- ############################################################################
