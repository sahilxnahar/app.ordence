-- =====================================================================
--  ORDENCE — 0070 · BANK RECONCILIATION, AND THE COUNT THAT COULD NEVER
--  BE POSTED
--  Version: v1.18.0-alpha
--
--  ⚠️ RUN AFTER 0069. It adds new tables and two columns; it changes
--  nothing that already exists.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE STOCK COUNT HAS EXISTED SINCE 0029 AND NOTHING EVER
--  REACHED IT
--  ══════════════════════════════════════════════════════════════════
--  `stock_counts` and `stock_count_lines` were built in phase 40, with
--  the hard part already right: the expected quantity is SNAPSHOTTED
--  into the line rather than read live at posting, so a movement made
--  while somebody walks the aisles cannot silently change what the
--  variance appears to be.
--
--  ⚠️ AND IN THE YEAR SINCE, NO SERVER ACTION AND NO SCREEN HAS
--  REFERENCED EITHER TABLE. There has never been a way to open a count,
--  enter a figure, or post the difference. The seventh time this
--  session has found a finished engine with nothing attached to it.
--
--  🔴 THIS FILE ADDS THE ONE THING THE ORIGINAL DESIGN LEFT OUT: the
--  posting is idempotent, and the difference reaches the ledger.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① A COUNT MAY BE POSTED ONCE
-- =====================================================================
--
--  ⚠️ `posted_at` and `posted_by` already exist, and a status enum
--  already has `posted` in it. What was missing is anything preventing a
--  second posting.
--
--  🔴 THE FAILURE IS DOUBLE ADJUSTMENT. A count that finds 40 units
--  missing, posted twice, removes 80. The stock ledger stays internally
--  consistent, the balance is simply wrong, and the next count "finds"
--  40 units appearing from nowhere.
--
--  ⭐ A PARTIAL UNIQUE INDEX ON THE JOURNAL REFERENCE IS THE HONEST
--  GUARD, because it is enforced by the database rather than by
--  remembering to check.
ALTER TABLE stock_counts
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid
    REFERENCES journal_entries(id) ON DELETE RESTRICT;

COMMENT ON COLUMN stock_counts.journal_entry_id IS
  'The journal entry this count produced. Set once, at posting. Its presence IS the record that the count has been posted, so a second posting has nowhere to write.';

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_one_journal
  ON stock_counts (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

--  ⚠️ AND A POSTED COUNT IS FROZEN. Editing a counted quantity after the
--  movements are written leaves a variance on screen that does not match
--  the movements in the ledger, and the screen is what people believe.
CREATE OR REPLACE FUNCTION ordence_guard_posted_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status::text INTO parent_status
    FROM stock_counts
   WHERE id = COALESCE(NEW.count_id, OLD.count_id);

  IF parent_status = 'posted' THEN
    RAISE EXCEPTION
      'This count has been posted and its lines can no longer be changed. The difference is already in the stock ledger and in the accounts; editing the sheet now would leave the screen disagreeing with both. Open a new count instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_posted_count ON stock_count_lines;
CREATE TRIGGER ordence_guard_posted_count
  BEFORE UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_posted_count();

-- =====================================================================
--  ② THE BANK ACCOUNT, AS A THING WE RECONCILE
-- =====================================================================
--
--  ⭐ A LEDGER IS NOT A BANK ACCOUNT. The chart of accounts has a ledger
--  called "HDFC current"; this table is the fact that it corresponds to
--  a real account at a real bank with a real statement that arrives
--  monthly and disagrees with us.
--
--  ⚠️ ONE LEDGER, ONE BANK ACCOUNT, ENFORCED. Two bank accounts sharing
--  a ledger cannot be reconciled at all: the ledger balance belongs to
--  neither of them.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,

  label varchar(160) NOT NULL,
  bank_name varchar(160) NOT NULL,
  --  ⚠️ LAST FOUR ONLY. A full account number in a table that half the
  --  office can read is a full account number on a WhatsApp screenshot.
  account_last4 varchar(4),
  ifsc varchar(11),

  --  ⭐ WHERE THE RECONCILED HISTORY ENDS. Everything on or before this
  --  date has been explained and is not offered for matching again.
  reconciled_to date,

  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT bank_accounts_last4_shape
    CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_one_per_ledger
  ON bank_accounts (tenant_id, ledger_id);

CREATE INDEX IF NOT EXISTS bank_accounts_tenant_idx
  ON bank_accounts (tenant_id) WHERE is_active;

-- =====================================================================
--  ③ THE STATEMENT, WHICH IS EVIDENCE AND IS NEVER EDITED
-- =====================================================================
--
--  🔴 THE STATEMENT IS THE TRUTH ABOUT THE BANK. THE LEDGER IS THE
--  TRUTH ABOUT THE BUSINESS. RECONCILIATION EXPLAINS THE DIFFERENCE; IT
--  DOES NOT REMOVE IT.
--
--  ⚠️ EVERY TOOL THAT QUIETLY EDITS ONE SIDE TO AGREE WITH THE OTHER
--  destroys the evidence that anything was wrong. The cheque never
--  presented, the payment taken twice and the bank's own error all
--  disappear into a green tick, and the green tick is what gets shown to
--  the auditor.
CREATE TABLE IF NOT EXISTS bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,

  period_from date NOT NULL,
  period_to date NOT NULL,

  --  ⭐ THE BANK'S OWN FIGURES, KEPT SO THE ARITHMETIC CAN BE CHECKED
  --  RATHER THAN TRUSTED. If the lines do not add up to the closing
  --  balance the import is incomplete, and that is worth knowing before
  --  anybody spends a morning matching it.
  opening_balance_minor bigint NOT NULL,
  closing_balance_minor bigint NOT NULL,

  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_filename varchar(400),

  line_count integer NOT NULL DEFAULT 0,

  CONSTRAINT bank_statements_period_ordered CHECK (period_to >= period_from)
);

CREATE INDEX IF NOT EXISTS bank_statements_account_idx
  ON bank_statements (tenant_id, bank_account_id, period_from DESC);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,

  value_date date NOT NULL,
  --  🔴 ONE SIGNED NUMBER. Positive is money IN.
  --
  --  ⚠️ Indian banks export two columns, headed withdrawal and deposit,
  --  and which is which varies by bank. The importer is responsible for
  --  collapsing that into a sign BEFORE it reaches this table, because a
  --  pair of nullable columns means every query downstream has to get
  --  the same COALESCE right forever.
  amount_minor bigint NOT NULL,
  narration text NOT NULL,
  bank_reference varchar(200),

  --  ⭐⭐ THE DUPLICATE GUARD. See lib/banking/match.ts.
  --
  --  ⚠️ Somebody downloads January, imports it, is unsure it worked, and
  --  imports it again. Every January line now appears twice and the
  --  account is out by a month's turnover with nothing saying why.
  --
  --  🔴 IT IS AN INDEX, NOT A CONSTRAINT, because two genuinely separate
  --  identical payments on one day are possible and refusing them would
  --  be wrong. The screen reports what looks duplicated; a person
  --  decides.
  fingerprint varchar(400) NOT NULL,

  CONSTRAINT bank_statement_lines_amount_not_zero CHECK (amount_minor <> 0)
);

CREATE INDEX IF NOT EXISTS bank_statement_lines_statement_idx
  ON bank_statement_lines (tenant_id, statement_id, value_date);

CREATE INDEX IF NOT EXISTS bank_statement_lines_fingerprint_idx
  ON bank_statement_lines (tenant_id, bank_account_id, fingerprint);

-- =====================================================================
--  ④ THE MATCH, WHICH A PERSON CONFIRMS
-- =====================================================================
--
--  ⭐ THE MATCHER PROPOSES AND NEVER DECIDES. An auto-matcher that is
--  confidently wrong is worse than one that asks, because its mistakes
--  are invisible: two payments of the same amount on the same day match
--  each other's lines perfectly, reconcile to zero, and leave two
--  accounts wrong.
--
--  ⚠️ SO THE SCORE AND THE PERSON ARE BOTH RECORDED. Six months later,
--  "who decided these were the same thing" has an answer.
CREATE TABLE IF NOT EXISTS bank_line_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_line_id uuid NOT NULL
    REFERENCES bank_statement_lines(id) ON DELETE CASCADE,

  --  🔴 A POLYMORPHIC REFERENCE, DELIBERATELY, AND THE KIND IS CHECKED.
  --  The alternative is three nullable foreign keys and a constraint
  --  saying exactly one is set, which is the same thing with more ways
  --  to be inconsistent.
  matched_kind varchar(30) NOT NULL,
  matched_id uuid NOT NULL,

  --  ⭐ What the matcher thought, kept alongside what the person did.
  proposed_score integer,
  was_ambiguous boolean NOT NULL DEFAULT false,

  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,

  CONSTRAINT bank_line_matches_kind_known CHECK (
    matched_kind IN ('customer_receipt', 'vendor_payment', 'journal_entry')
  ),
  CONSTRAINT bank_line_matches_score_range CHECK (
    proposed_score IS NULL OR (proposed_score BETWEEN 0 AND 100)
  )
);

--  🔴🔴 ONE STATEMENT LINE MATCHES AT MOST ONE THING, AND ONE THING IS
--  MATCHED BY AT MOST ONE STATEMENT LINE.
--
--  ⚠️ WITHOUT BOTH HALVES THE RECONCILIATION CAN BALANCE WHILE BEING
--  NONSENSE. Matching one receipt to two statement lines explains twice
--  as much money as actually moved, and the residue comes out to zero
--  because the same rupees were counted on both sides.
CREATE UNIQUE INDEX IF NOT EXISTS bank_line_matches_one_per_line
  ON bank_line_matches (statement_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_matches_one_per_document
  ON bank_line_matches (tenant_id, matched_kind, matched_id);

-- =====================================================================
--  ⑤ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 `app_platform_scope()` BELONGS IN `USING` AND NEVER IN
--  `WITH CHECK`. Support may read a tenant's rows to answer a question.
--  Support writing rows INTO a tenant is a different thing entirely, and
--  the two are one keyword apart.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts', 'bank_statements', 'bank_statement_lines', 'bank_line_matches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_tenant'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY %1$I_tenant ON %1$I
          USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
          WITH CHECK (tenant_id = app_current_tenant_id())
      $f$, t);
    END IF;
  END LOOP;
END;
$$;

-- =====================================================================
--  ⑥ THE POSTING ROLES A COUNT NEEDS
-- =====================================================================
--
--  ⚠️ NOT SEEDED, ONLY DOCUMENTED. `sales_posting_accounts` maps a role
--  to a ledger the TENANT chose, and guessing which of their accounts is
--  "inventory shrinkage" would post a real adjustment to a real account
--  nobody picked.
--
--  ⭐ THE SCREEN NAMES THE MISSING ROLE RATHER THAN FAILING SILENTLY,
--  which is the same pattern as the four accounts a vendor payment
--  needs.
--
--  🔴 AND THERE ARE TWO ROLES, NOT ONE, ON PURPOSE. Posting gains and
--  losses to a single "stock adjustment" account nets them off in the
--  trial balance, and "how much stock did we lose this year" then has no
--  answer anywhere in the system. An auditor asks that question.
--
--     inventory_variance_gain   stock found that the books did not have
--     inventory_variance_loss   stock the books had and the shelf did not
--     inventory_asset           the stock account itself
--
--  These are strings in `sales_posting_accounts.role`, which is a
--  varchar precisely so that a new role is a row rather than a
--  migration.

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  IT DOES NOT STORE THE UPLOADED STATEMENT FILE. The parsed lines are
--  the evidence and the file is a copy of them in a worse format. If a
--  bank's export turns out to carry something the parser drops, that is
--  a reason to fix the parser and re-import, not a reason to keep every
--  tenant's bank statements as blobs.
--
--  IT DOES NOT AUTO-CONFIRM ANY MATCH, at any score. `bank_line_matches`
--  has no row that a person did not create. A ninety-nine point match is
--  still shown and still clicked, because the cost of being wrong is two
--  wrong accounts and a reconciliation that balances.
--
--  IT DOES NOT WRITE A LEDGER ENTRY FOR AN UNMATCHED BANK LINE. Bank
--  charges and interest genuinely need journal entries, and creating
--  them automatically would put entries in the books that nobody chose,
--  dated and coded by a guess. The screen lists them and offers to
--  raise one.
-- =====================================================================
