-- =====================================================================
--  0055 — BATCH, EXPIRY, SERIAL AND GOODS RETURNED
--  Ordence · v1.4.0-alpha · Engine 8b
-- =====================================================================
--
--  ⭐⭐ WHAT WAS ACTUALLY MISSING, AND IT IS NOT "A BATCH FIELD"
--  ------------------------------------------------------------------
--  `stock_movements` has HAD `batch_no`, `serial_no` and `expiry_date`
--  since 0029. They are three free-text strings on a ledger row, and
--  that is the whole problem:
--
--  🔴 THE SAME BATCH CAN CARRY TWO DIFFERENT EXPIRY DATES. Two people
--     receive the same lot a week apart and type 03/2027 and 03/2028.
--     Nothing refuses it. The expiry report then shows both, and which
--     one is right is decided by whichever row the query happened to
--     read. For a pharmacy, a food distributor or a paint dealer, that
--     is the single figure the whole category exists for.
--
--  🔴 `tracking_mode = 'serial'` WAS A LABEL WITH NOTHING BEHIND IT.
--     An item could be declared serial-tracked and then receive fifty
--     units with no serial numbers at all.
--
--  🔴 AND THERE WAS NO WAY TO ANSWER "WHERE IS INVERTER SN-4471".
--     A serial existed only as a string on movements. Nothing said who
--     has it now, when it shipped, or when its warranty ends — which is
--     every question a solar installer or an equipment dealer is asked.
--
--  ⚠️ SO THIS MIGRATION DOES NOT ADD FIELDS. It adds the MASTERS those
--  strings should always have pointed at, and a trigger that makes the
--  existing code paths populate them without being rewritten.
-- =====================================================================


-- =====================================================================
--  ① THE BATCH MASTER
-- =====================================================================
--  🔴 ONE ROW PER (ITEM, BATCH NUMBER). THAT UNIQUE KEY *IS* THE FIX.
--
--  The expiry date stops being a property of a movement and becomes a
--  property of the batch — which is what it always was in the physical
--  world. A carton has one printed expiry, however many times it is
--  received, split, transferred or returned.
CREATE TABLE IF NOT EXISTS stock_batches (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    stock_item_id       uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,

    batch_no            varchar(100) NOT NULL,
    /** The manufacturer's own lot code, when it differs from ours. */
    supplier_batch_no   varchar(100),

    manufacture_date    date,
    expiry_date         date,

    /**
     * ⚠️ THE FIRST TIME WE SAW IT, not the last. Ageing is measured from
     * when the stock arrived; overwriting this on each receipt would
     * make an old lot look new every time a carton of it was moved.
     */
    first_received_at   timestamptz NOT NULL DEFAULT now(),

    /**
     * 🔴 `quarantined` AND `recalled` ARE NOT DECORATION.
     *
     * Expired stock that merely carries a flag is still in
     * `stock_balances.quantity_on_hand`, which means it is still
     * available to promise and a picker will still be sent to it. The
     * status is checked by the trigger below, on the way OUT.
     */
    status              varchar(20) NOT NULL DEFAULT 'active',

    /** Why it was quarantined, recalled or written off. */
    status_note         text,
    status_changed_at   timestamptz,
    status_changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT stock_batches_status_known CHECK (
        status IN ('active', 'quarantined', 'expired', 'recalled', 'written_off')
    ),
    -- ⚠️ Goods that expire before they are made is a typed date, and it
    -- is always the year that was typed wrong. Refused rather than
    -- stored, because an expiry in the past on a fresh receipt sends
    -- good stock to quarantine.
    CONSTRAINT stock_batches_expiry_after_manufacture CHECK (
        expiry_date IS NULL OR manufacture_date IS NULL
        OR expiry_date > manufacture_date
    ),
    CONSTRAINT stock_batches_batch_no_present CHECK (length(btrim(batch_no)) > 0)
);

-- 🔴 THE KEY THAT MAKES ONE BATCH MEAN ONE THING.
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_item_batch_unique
    ON stock_batches (tenant_id, stock_item_id, batch_no);

-- The hot query: what expires in the next 90 days.
CREATE INDEX IF NOT EXISTS stock_batches_expiry_idx
    ON stock_batches (tenant_id, expiry_date)
    WHERE expiry_date IS NOT NULL AND status IN ('active', 'quarantined');
CREATE INDEX IF NOT EXISTS stock_batches_status_idx
    ON stock_batches (tenant_id, status);


-- ⚠️ ADDED, NOT REPLACING. `stock_movements.batch_no` stays exactly
-- where it is — every existing query keeps working — and `batch_id`
-- is filled in beside it by the trigger below.
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES stock_batches(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS stock_movements_batch_id_idx
    ON stock_movements (tenant_id, batch_id) WHERE batch_id IS NOT NULL;


-- =====================================================================
--  ② THE TRIGGER THAT MAKES THE OLD CODE CORRECT WITHOUT REWRITING IT
-- =====================================================================
--  ⭐ THIS IS THE DESIGN DECISION OF THE WHOLE MIGRATION.
--
--  Every existing call site that inserts a stock movement with a
--  `batch_no` continues to compile, continues to run, and now silently
--  acquires a real batch master row. Nothing had to be found and
--  changed, which means nothing could be MISSED being found and changed.
--
--  ⚠️ AND IT IS A `BEFORE` TRIGGER NAMED `trg_link_stock_batch`, so it
--  fires before `trg_validate_stock_movement` — "l" sorts before "v".
--  That ordering is deliberate: the batch must exist before the
--  validation that may reject the movement, or a rejected movement would
--  leave a batch row behind it.
CREATE OR REPLACE FUNCTION ordence_link_stock_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  item   RECORD;
  b      RECORD;
  clean  varchar(100);
BEGIN
  SELECT * INTO item FROM stock_items WHERE id = NEW.stock_item_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- ⚠️ Left to trg_validate_stock_movement to report.
  END IF;

  clean := NULLIF(btrim(COALESCE(NEW.batch_no, '')), '');

  /* --- §1  A DECLARED TRACKING MODE MUST ACTUALLY BE HONOURED ------ */
  --
  -- ⚠️ SCOPED TO ITEMS THAT OPTED IN. `tracking_mode` defaults to
  -- 'none', so nothing already in this database changes behaviour. An
  -- item somebody deliberately marked batch-tracked is a different
  -- matter: receiving it without a batch number makes a recall
  -- impossible, and a recall is the entire reason the mode exists.
  IF item.tracking_mode = 'batch'
     AND clean IS NULL
     AND NEW.reason::text IN ('purchase_receipt','sales_return','transfer_in',
                              'production_output','opening_balance') THEN
    RAISE EXCEPTION
      '"%" is batch-tracked, so this receipt needs a batch number. Without one the stock cannot be recalled, and a recall is the reason the item was marked batch-tracked in the first place.',
      item.name
      USING ERRCODE = 'raise_exception';
  END IF;

  IF item.tracking_mode = 'serial'
     AND NEW.serial_no IS NULL
     AND NEW.reason::text IN ('purchase_receipt','sales_return','transfer_in',
                              'production_output','opening_balance') THEN
    RAISE EXCEPTION
      '"%" is serial-tracked, so every unit needs its own serial number. Receiving % units on one row makes it impossible to say later which of them is at which customer.',
      item.name, NEW.quantity
      USING ERRCODE = 'raise_exception';
  END IF;

  IF clean IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.batch_no := clean;

  SELECT * INTO b
    FROM stock_batches
   WHERE tenant_id = NEW.tenant_id
     AND stock_item_id = NEW.stock_item_id
     AND batch_no = clean;

  IF NOT FOUND THEN
    INSERT INTO stock_batches (
      tenant_id, stock_item_id, batch_no, expiry_date, first_received_at, created_by
    ) VALUES (
      NEW.tenant_id, NEW.stock_item_id, clean, NEW.expiry_date,
      COALESCE(NEW.moved_at, now()), NEW.created_by
    )
    RETURNING * INTO b;
  ELSE
    /* --- §2  🔴 THE ONE EXPIRY DATE, DEFENDED -------------------- */
    --
    -- ⚠️ THIS IS THE FAILURE THIS WHOLE MIGRATION EXISTS FOR. Two
    -- receipts of one lot, two typed expiry dates, and no error. The
    -- expiry report then shows whichever the query read first, and for
    -- a pharmacy that is the only figure that matters.
    --
    -- ⭐ IT NAMES BOTH DATES. "Expiry mismatch" sends somebody hunting;
    -- "this batch is already recorded as expiring on 2027-03-31 and you
    -- have entered 2028-03-31" is a decision they can make at the desk.
    IF NEW.expiry_date IS NOT NULL
       AND b.expiry_date IS NOT NULL
       AND NEW.expiry_date <> b.expiry_date THEN
      RAISE EXCEPTION
        'Batch % of "%" is already recorded as expiring on %, and this receipt says %. One physical lot has one printed expiry — one of these two is a typing error, and correcting the batch is a deliberate act rather than something a receipt should do quietly.',
        clean, item.name, b.expiry_date, NEW.expiry_date
        USING ERRCODE = 'raise_exception';
    END IF;

    -- ⚠️ THE FIRST RECEIPT THAT KNOWS THE EXPIRY DEFINES IT. A batch
    -- created by an earlier movement that carried no date is completed
    -- here rather than left blank forever.
    IF b.expiry_date IS NULL AND NEW.expiry_date IS NOT NULL THEN
      UPDATE stock_batches
         SET expiry_date = NEW.expiry_date, updated_at = now()
       WHERE id = b.id;
      b.expiry_date := NEW.expiry_date;
    END IF;

    /* --- §3  🔴 NOTHING LEAVES A RECALLED OR WRITTEN-OFF BATCH ---- */
    --
    -- ⚠️ A FLAG THAT ONLY APPEARS ON A REPORT IS NOT A QUARANTINE.
    -- Recalled stock sitting in `quantity_on_hand` is stock a picker
    -- will be sent to, and the picker is not reading the report.
    --
    -- ⭐ `reversal` AND `expiry` ARE DELIBERATELY ALLOWED OUT — those
    -- are exactly the movements that REMOVE the bad stock. Blocking
    -- them would trap it on the books forever.
    IF b.status IN ('recalled', 'written_off', 'expired')
       AND NEW.quantity < 0
       AND NEW.reason::text NOT IN ('expiry','damage','reversal','adjustment','transfer_out') THEN
      RAISE EXCEPTION
        'Batch % of "%" is marked %. Stock cannot be issued from it — that is what the status is for. To dispose of it, use an expiry or damage write-off; to move it to quarantine, use a transfer.',
        clean, item.name, b.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  NEW.batch_id := b.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_link_stock_batch ON stock_movements;
CREATE TRIGGER trg_link_stock_batch
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_link_stock_batch();


-- =====================================================================
--  ③ THE SERIAL REGISTER
-- =====================================================================
--  🔴 ONE ROW PER PHYSICAL UNIT, AND IT ANSWERS "WHERE IS IT".
--
--  A serial number on a movement says where a unit went once. This says
--  where it is NOW, who has it, when it shipped and when its warranty
--  ends — which is what an installer standing in front of a dead
--  inverter needs, and what a movement ledger cannot answer without
--  replaying itself.
CREATE TABLE IF NOT EXISTS stock_serials (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    stock_item_id       uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,

    serial_no           varchar(120) NOT NULL,
    batch_id            uuid REFERENCES stock_batches(id) ON DELETE SET NULL,

    status              varchar(20) NOT NULL DEFAULT 'in_stock',

    /** Where it physically is, while we still have it. */
    warehouse_id        uuid REFERENCES warehouses(id) ON DELETE SET NULL,
    /** Who has it, once we do not. */
    company_id          uuid REFERENCES companies(id) ON DELETE SET NULL,

    received_at         timestamptz,
    dispatched_at       timestamptz,
    /**
     * ⚠️ WARRANTY RUNS FROM DISPATCH, NOT FROM RECEIPT INTO OUR STORE.
     * A panel that sat in a warehouse for eight months has not used
     * eight months of its warranty, and telling a customer it has is a
     * dispute the record should not create.
     */
    warranty_months     integer,
    warranty_until      date,

    last_movement_id    uuid,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT stock_serials_status_known CHECK (
        status IN ('in_stock', 'reserved', 'dispatched', 'returned',
                   'scrapped', 'quarantined')
    ),
    CONSTRAINT stock_serials_warranty_sane CHECK (
        warranty_months IS NULL OR warranty_months >= 0
    ),
    -- ⚠️ A dispatched unit is somewhere else. Holding a warehouse
    -- against it would put it back in a stock count.
    CONSTRAINT stock_serials_dispatched_has_left CHECK (
        status <> 'dispatched' OR warehouse_id IS NULL
    )
);

-- 🔴 ONE SERIAL, ONE UNIT, ONCE. Two rows for one serial is two
--    physical things that are the same physical thing.
CREATE UNIQUE INDEX IF NOT EXISTS stock_serials_unique
    ON stock_serials (tenant_id, stock_item_id, serial_no);
CREATE INDEX IF NOT EXISTS stock_serials_status_idx
    ON stock_serials (tenant_id, status);
CREATE INDEX IF NOT EXISTS stock_serials_company_idx
    ON stock_serials (tenant_id, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_serials_warranty_idx
    ON stock_serials (tenant_id, warranty_until)
    WHERE warranty_until IS NOT NULL;


-- ⭐ THE REGISTER IS MAINTAINED FROM THE LEDGER, NEVER BY HAND.
--   Same discipline as `stock_balances`: if this table were dropped it
--   could be rebuilt by replaying `stock_movements`.
CREATE OR REPLACE FUNCTION ordence_apply_serial_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  IF NEW.serial_no IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO s
    FROM stock_serials
   WHERE tenant_id = NEW.tenant_id
     AND stock_item_id = NEW.stock_item_id
     AND serial_no = NEW.serial_no;

  IF NOT FOUND THEN
    INSERT INTO stock_serials (
      tenant_id, stock_item_id, serial_no, batch_id, status,
      warehouse_id, received_at, last_movement_id
    ) VALUES (
      NEW.tenant_id, NEW.stock_item_id, NEW.serial_no, NEW.batch_id,
      CASE WHEN NEW.quantity > 0 THEN 'in_stock' ELSE 'dispatched' END,
      CASE WHEN NEW.quantity > 0 THEN NEW.warehouse_id ELSE NULL END,
      CASE WHEN NEW.quantity > 0 THEN NEW.moved_at ELSE NULL END,
      NEW.id
    );
    RETURN NEW;
  END IF;

  IF NEW.quantity > 0 THEN
    -- Coming in: a receipt, a transfer in, or a customer return.
    UPDATE stock_serials
       SET status = CASE WHEN NEW.reason::text = 'sales_return'
                         THEN 'returned' ELSE 'in_stock' END,
           warehouse_id = NEW.warehouse_id,
           company_id = NULL,
           batch_id = COALESCE(NEW.batch_id, batch_id),
           received_at = COALESCE(received_at, NEW.moved_at),
           last_movement_id = NEW.id,
           updated_at = now()
     WHERE id = s.id;
  ELSE
    -- Going out.
    UPDATE stock_serials
       SET status = CASE
                      WHEN NEW.reason::text IN ('damage','theft','expiry') THEN 'scrapped'
                      WHEN NEW.reason::text = 'transfer_out' THEN 'in_stock'
                      ELSE 'dispatched'
                    END,
           warehouse_id = NULL,
           dispatched_at = CASE WHEN NEW.reason::text = 'sales_dispatch'
                                THEN NEW.moved_at ELSE dispatched_at END,
           last_movement_id = NEW.id,
           updated_at = now()
     WHERE id = s.id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_apply_serial_movement ON stock_movements;
CREATE TRIGGER trg_apply_serial_movement
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_apply_serial_movement();


-- ⭐ AND THE ONE THAT MATTERS COMMERCIALLY: A UNIT CANNOT BE SOLD TWICE.
--
-- ⚠️ Two invoices carrying one serial number is one physical machine
-- promised to two customers. It is found by the second customer.
CREATE OR REPLACE FUNCTION ordence_guard_serial_dispatch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  IF NEW.serial_no IS NULL OR NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO s
    FROM stock_serials
   WHERE tenant_id = NEW.tenant_id
     AND stock_item_id = NEW.stock_item_id
     AND serial_no = NEW.serial_no;

  IF FOUND AND s.status = 'dispatched'
     AND NEW.reason::text NOT IN ('reversal','adjustment') THEN
    RAISE EXCEPTION
      'Serial % has already left — it was dispatched on %. One physical unit cannot be sent to two customers, and the second one finds out at delivery. If it came back, record the return first.',
      NEW.serial_no, COALESCE(s.dispatched_at::date::text, 'an earlier date')
      USING ERRCODE = 'raise_exception';
  END IF;

  IF FOUND AND s.status = 'scrapped'
     AND NEW.reason::text NOT IN ('reversal','adjustment') THEN
    RAISE EXCEPTION
      'Serial % was scrapped. It cannot be issued.', NEW.serial_no
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_serial_dispatch ON stock_movements;
CREATE TRIGGER trg_guard_serial_dispatch
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_serial_dispatch();


-- =====================================================================
--  ④ GOODS RETURNED INWARD
-- =====================================================================
--  ⭐ A SALES RETURN IS THREE SEPARATE FACTS AND MOST SOFTWARE MERGES
--     THEM INTO ONE.
--
--    1. Goods physically arrived back        → a stock movement
--    2. The customer owes less               → a credit note, s.34
--    3. Some of what came back is unsaleable → a different warehouse
--
--  🔴 MERGING (1) AND (3) IS THE EXPENSIVE ONE. Damaged goods put back
--     into the selling warehouse are goods that will be picked and sent
--     to the next customer. The condition of each returned line decides
--     where it lands, and it is captured at the door — by the person who
--     opened the carton, who is the only person who can see it.
CREATE TABLE IF NOT EXISTS goods_returns (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    return_no           varchar(40) NOT NULL,
    return_date         date NOT NULL,

    company_id          uuid REFERENCES companies(id) ON DELETE RESTRICT,
    /** The invoice being returned against. Nullable — goods come back
     *  before anybody finds the paperwork, and refusing the record until
     *  they do means the goods sit undocumented on a loading bay. */
    invoice_id          uuid REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    credit_note_id      uuid REFERENCES sales_credit_notes(id) ON DELETE SET NULL,

    reason              varchar(40) NOT NULL DEFAULT 'other',
    status              varchar(20) NOT NULL DEFAULT 'draft',

    /**
     * ⭐ SECTION 34(2) — THE DEADLINE THAT COSTS REAL MONEY.
     *
     * The tax on a credit note can only be adjusted if the note is
     * declared by 30 November following the end of the financial year of
     * the original supply, or the date of the annual return, whichever
     * is EARLIER.
     *
     * 🔴 AFTER THAT THE CREDIT NOTE CAN STILL BE ISSUED COMMERCIALLY —
     *    the customer still owes less — BUT THE GST IS GONE. The
     *    supplier has paid tax on a sale that was reversed and cannot
     *    get it back. Stored as a date so the screen can count down to
     *    it rather than discovering it afterwards.
     */
    tax_adjustment_deadline date,

    /** Goods came back on this document. Rule 55 delivery challan. */
    inward_challan_no   varchar(40),
    eway_bill_no        varchar(20),

    notes               text,

    received_at         timestamptz,
    received_by         uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT goods_returns_status_known CHECK (
        status IN ('draft', 'received', 'credited', 'rejected', 'cancelled')
    ),
    CONSTRAINT goods_returns_reason_known CHECK (
        reason IN ('damaged_in_transit', 'wrong_item', 'quality_rejection',
                   'expired', 'excess_supply', 'order_cancelled',
                   'sale_or_return', 'other')
    ),
    -- ⚠️ A received return names who opened the carton. "Received" with
    -- nobody against it is a claim, and the claim is about money.
    CONSTRAINT goods_returns_received_is_witnessed CHECK (
        received_at IS NULL OR received_by IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS goods_returns_no_unique
    ON goods_returns (tenant_id, return_no);
CREATE INDEX IF NOT EXISTS goods_returns_invoice_idx
    ON goods_returns (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS goods_returns_status_idx
    ON goods_returns (tenant_id, status, return_date DESC);
-- ⭐ The countdown query: returns whose tax adjustment is about to lapse.
CREATE INDEX IF NOT EXISTS goods_returns_deadline_idx
    ON goods_returns (tenant_id, tax_adjustment_deadline)
    WHERE status IN ('draft', 'received') AND tax_adjustment_deadline IS NOT NULL;


CREATE TABLE IF NOT EXISTS goods_return_lines (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    goods_return_id     uuid NOT NULL REFERENCES goods_returns(id) ON DELETE CASCADE,

    line_no             integer NOT NULL,
    stock_item_id       uuid REFERENCES stock_items(id) ON DELETE RESTRICT,
    description         text NOT NULL,

    /**
     * 🔴 A RETURNED BATCH KEEPS ITS ORIGINAL EXPIRY.
     *
     * ⚠️ The instinct on an inward movement is to ask for an expiry
     * date, and whoever is at the door will type today plus the shelf
     * life. That silently RESETS the clock on stock that has already
     * spent nine months at a customer — and the one-expiry-per-batch
     * trigger above is what refuses it.
     */
    batch_no            varchar(100),
    serial_no           varchar(120),

    quantity            numeric(18,3) NOT NULL,
    uom                 varchar(20) NOT NULL DEFAULT 'nos',

    /**
     * ⭐ THE FIELD THE WHOLE TABLE EXISTS FOR.
     *
     * 🔴 `saleable` PUTS IT BACK ON THE SHELF. Everything else must not.
     */
    condition           varchar(20) NOT NULL DEFAULT 'saleable',

    /** Where it landed. Quarantine for anything not saleable. */
    warehouse_id        uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
    movement_id         uuid,

    taxable_value_minor bigint NOT NULL DEFAULT 0,
    tax_rate_bps        integer NOT NULL DEFAULT 0,
    tax_value_minor     bigint NOT NULL DEFAULT 0,

    /**
     * ⭐ SECTION 17(5)(h) — INPUT TAX CREDIT ON GOODS WRITTEN OFF.
     *
     * 🔴 WHEN RETURNED STOCK IS DESTROYED RATHER THAN RESOLD, THE ITC
     *    CLAIMED ON IT IS NOT AVAILABLE. Most software posts a stock
     *    adjustment and the credit quietly stays claimed — it is found
     *    at an assessment, with interest.
     *
     * ⚠️ The figure is recorded per line rather than computed later,
     * because the rate that applied when the goods were bought is a fact
     * about that purchase and not about today.
     */
    itc_reversal_minor  bigint NOT NULL DEFAULT 0,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT goods_return_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT goods_return_lines_condition_known CHECK (
        condition IN ('saleable', 'damaged', 'expired', 'opened', 'scrap')
    ),
    CONSTRAINT goods_return_lines_values_positive CHECK (
        taxable_value_minor >= 0 AND tax_value_minor >= 0
        AND itc_reversal_minor >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS goods_return_lines_no_unique
    ON goods_return_lines (tenant_id, goods_return_id, line_no);
CREATE INDEX IF NOT EXISTS goods_return_lines_item_idx
    ON goods_return_lines (tenant_id, stock_item_id);


-- 🔴 DAMAGED GOODS DO NOT GO BACK ON THE SHELF.
--
-- ⚠️ A CHECK constraint cannot see the warehouse's type — it is in
-- another table — so this is a trigger. The rule is worth the trigger:
-- unsaleable stock returned into a selling warehouse is stock that WILL
-- be picked, and the person who finds out is the next customer.
CREATE OR REPLACE FUNCTION ordence_guard_return_destination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  wh RECORD;
BEGIN
  IF NEW.condition = 'saleable' OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO wh FROM warehouses WHERE id = NEW.warehouse_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF wh.warehouse_type <> 'quarantine' THEN
    RAISE EXCEPTION
      'This line came back %, so it cannot go into "%" — that is a selling location and the goods would be picked for the next customer. Send it to a quarantine warehouse and decide what happens to it there.',
      NEW.condition, wh.name
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_return_destination ON goods_return_lines;
CREATE TRIGGER trg_guard_return_destination
  BEFORE INSERT OR UPDATE ON goods_return_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_return_destination();


-- =====================================================================
--  ⑤ WRITE-OFFS, AND THE INPUT TAX CREDIT THAT GOES WITH THEM
-- =====================================================================
--  🔴 SECTION 17(5)(h): input tax credit is NOT available in respect of
--     goods "lost, stolen, destroyed, written off or disposed of by way
--     of gift or free samples".
--
--  ⚠️ SO A STOCK WRITE-OFF IS TWO ENTRIES, NOT ONE. The stock leaves,
--  AND the credit claimed when it was bought has to be given back. A
--  product that does only the first produces books that balance and a
--  GST position that does not — and the difference is found at an
--  assessment, with interest running from the original claim.
--
--  ⭐ THE FIGURE IS RECORDED, NOT ASSUMED. Where the position is
--  genuinely arguable — a manufacturer whose inputs lost their identity
--  in production has a real case, and the CBIC's own Circular
--  72/46/2018-GST leaves the pharma return route open — the row carries
--  the reasoning rather than a silent zero.
CREATE TABLE IF NOT EXISTS stock_write_offs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    movement_id         uuid,
    stock_item_id       uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
    batch_id            uuid REFERENCES stock_batches(id) ON DELETE RESTRICT,
    warehouse_id        uuid REFERENCES warehouses(id) ON DELETE RESTRICT,

    write_off_date      date NOT NULL,
    quantity            numeric(18,3) NOT NULL,
    reason              varchar(20) NOT NULL,

    /** What the stock was carried at. */
    cost_minor          bigint NOT NULL DEFAULT 0,

    /** The rate the credit was originally claimed at. */
    itc_rate_bps        integer NOT NULL DEFAULT 0,
    itc_reversal_minor  bigint NOT NULL DEFAULT 0,
    /** The GSTR-3B period the reversal is declared in — "2026-08". */
    reversal_period     varchar(7),

    /**
     * 🔴 REQUIRED WHEN THE REVERSAL IS ZERO. A zero here is either
     *    correct or it is the mistake this table exists to catch, and
     *    the row cannot tell you which without a sentence.
     */
    itc_note            text,

    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT stock_write_offs_qty_positive CHECK (quantity > 0),
    CONSTRAINT stock_write_offs_reason_known CHECK (
        reason IN ('expiry', 'damage', 'theft', 'obsolescence', 'recall', 'sample')
    ),
    CONSTRAINT stock_write_offs_values_positive CHECK (
        cost_minor >= 0 AND itc_reversal_minor >= 0 AND itc_rate_bps >= 0
    ),
    -- ⭐ THE CONSTRAINT THAT MAKES 17(5)(h) UNSKIPPABLE.
    CONSTRAINT stock_write_offs_zero_itc_is_explained CHECK (
        itc_reversal_minor > 0
        OR (itc_note IS NOT NULL AND length(btrim(itc_note)) >= 10)
    )
);

CREATE INDEX IF NOT EXISTS stock_write_offs_period_idx
    ON stock_write_offs (tenant_id, reversal_period);
CREATE INDEX IF NOT EXISTS stock_write_offs_item_idx
    ON stock_write_offs (tenant_id, stock_item_id, write_off_date DESC);


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE stock_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_batches_tenant_isolation ON public.stock_batches;
CREATE POLICY stock_batches_tenant_isolation ON public.stock_batches
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stock_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_serials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_serials_tenant_isolation ON public.stock_serials;
CREATE POLICY stock_serials_tenant_isolation ON public.stock_serials
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_returns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_returns_tenant_isolation ON public.goods_returns;
CREATE POLICY goods_returns_tenant_isolation ON public.goods_returns
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_return_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_return_lines_tenant_isolation ON public.goods_return_lines;
CREATE POLICY goods_return_lines_tenant_isolation ON public.goods_return_lines
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stock_write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_write_offs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_write_offs_tenant_isolation ON public.stock_write_offs;
CREATE POLICY stock_write_offs_tenant_isolation ON public.stock_write_offs
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_batches      TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_serials      TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON goods_returns      TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON goods_return_lines TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_write_offs   TO ordence_app;


-- =====================================================================
--  ⚠️ WHAT IS DELIBERATELY NOT HERE
-- =====================================================================
--  NO `days_to_expiry` COLUMN, and no "expiring soon" flag. Both are
--  `expiry_date - current_date`, and a stored copy needs a nightly job.
--  The night the job does not run, the screen says stock is fine on the
--  day it stopped being fine.
--
--  NO SEPARATE `batch_balances` TABLE. `stock_balances` is already keyed
--  on (item, warehouse, batch_no) — it has been since 0029. A second
--  balance table would give two answers to "how much of batch X is
--  left", and the wrong one would be the one the picking screen read.
--
--  NO AUTOMATIC EXPIRY SWEEP. Marking a batch `expired` moves stock out
--  of what can be sold, which is a decision with a money consequence —
--  and a job that does it at 2am gets blamed for a stockout nobody
--  authorised. The screen shows what has passed its date and a person
--  presses the button.
-- =====================================================================
