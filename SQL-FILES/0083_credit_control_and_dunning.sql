-- =====================================================================
--  ORDENCE — 0083 · CREDIT CONTROL, HOLDS, OVERRIDES AND DUNNING
--  Version: v1.46.0-alpha · Batch 40
--
--  ⚠️ RUN AFTER 0082. Five new tables, three new enums, four triggers,
--  and two guarded ADD COLUMNs on `customer_credit_profiles` from 0048.
--  It reads `companies` (0002), `sales_orders` (0028) and
--  `sales_invoices` (0049) and alters none of them.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded: tables are CREATE ...
--     IF NOT EXISTS, columns are ADD COLUMN IF NOT EXISTS, enums are
--     created inside an exception handler, constraints are DROP ... IF
--     EXISTS then ADD, indexes are CREATE ... IF NOT EXISTS, functions
--     are CREATE OR REPLACE, all inside one transaction.
--
--  ⭐⭐ RUN THIS **BEFORE** PUSHING THE CODE, AND THE REASON IS NOT THE
--     USUAL ONE.
--
--     The usual reason is 42P01 — new code SELECTs a table that is not
--     there yet and the screen 500s. That applies here too:
--     `lib/credit/enforce.ts` reads `credit_hold_events` and
--     `credit_hold_overrides` on EVERY `confirmOrder`, so against a
--     database without them no order can be confirmed at all.
--
--     🔴 BUT THE REAL REASON IS THE ORDER OF THE TWO FAILURE MODES. If
--     the code goes first, the credit gate degrades to "no hold row
--     found, therefore no hold" for as long as the window lasts, and
--     every held customer trades freely with no error anywhere. If the
--     SQL goes first, the tables sit empty and inert — nothing reads
--     them, nothing writes them, no behaviour changes. One ordering
--     fails loudly and harmlessly; the other fails silently and costs
--     money. That asymmetry is what decides the order, not convenience.
--
--     ⚠️ `lib/credit/enforce.ts#creditGateForConfirmation` deliberately
--     does NOT swallow a missing-relation error into "allowed". A gate
--     that opens when it cannot read its own tables is not a gate.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHAT THIS UNBLOCKS, IN ONE PARAGRAPH
--  ══════════════════════════════════════════════════════════════════
--  0048 gave every customer a credit limit and a boolean `on_hold`, and
--  v0.89.0 wired `confirmOrder` to consult it. What that wiring does
--  with the answer is route the order to `pending_approval` — which is
--  the right answer for "over the limit" and the WRONG one for "this
--  account is on hold". An order sitting in `pending_approval` is still
--  an order in the workspace's own approval queue, and every approval
--  queue in every business is eventually cleared by somebody working
--  through it at five o'clock. A hold placed because a cheque bounced
--  is not a request for a second opinion. It is a refusal, and until
--  this file it was not one.
--
--  ⭐ `credit_hold_events` BELOW MAKES THE HOLD A RECORD RATHER THAN A
--  FLAG, and `credit_hold_overrides` makes going past it an act with a
--  name, a reason and a timestamp on it instead of a boolean somebody
--  flipped back afterwards.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE SIX DECISIONS THIS FILE IS MADE OF
--  ══════════════════════════════════════════════════════════════════
--
--  ① A HOLD REFUSES THE WRITE. Not the button — the write.
--     `components/credit/*` hides the confirm control when a customer is
--     held, and that is a courtesy, not a control: the server action is
--     a browser-reachable RPC endpoint and `curl` never sees the button.
--     The refusal lives in `lib/credit/enforce.ts`, is called from
--     inside `confirmOrder`'s transaction, and throws. 🔴 A SCREEN-ONLY
--     CHECK IS A MISTAKE GUARD, NOT A BOUNDARY, and the difference only
--     shows up on the day somebody is motivated.
--
--  ② A HOLD IS AN EVENT WITH A LIFETIME, NOT A COLUMN. `on_hold
--     = true` on 0048's profile row answers "is this customer held".
--     It cannot answer "since when", "who", "why", "was it lifted",
--     "who lifted it", or — the question a bad-debt review actually
--     opens with — "how many times has this happened before". A boolean
--     flipped back to false erases all six, and looks like tidying up.
--
--     ⚠️ 0048'S BOOLEAN IS NOT DROPPED. It is kept as a denormalised
--     mirror so that every existing query, screen and export that reads
--     it keeps working, and a trigger below keeps it in step with the
--     event table. Dropping it would have been cleaner and would have
--     broken `assessCredit()`, `getCreditPosition()` and two screens in
--     the same deploy that introduced the refusal — which is how a
--     safety feature gets reverted in week one.
--
--  ③ AN AUTOMATIC HOLD AND A MANUAL ONE ARE THE SAME ROW WITH A
--     DIFFERENT `source`. They must be, because they have to be lifted
--     the same way and counted the same way. But they may NEVER be
--     placed the same way: the partial unique index below allows AT MOST
--     ONE unreleased hold per customer, which is what makes re-running
--     the automatic sweep idempotent. Without it a nightly job that
--     places a hold for "exposure over limit" writes one row a night
--     forever, and by March a customer who was over their limit for a
--     week in June has 280 hold rows and no history anybody can read.
--
--  ④ AN OVERRIDE IS A DOCUMENT, PER ORDER, USED ONCE. Not a boolean, not
--     a session flag, not "hold lifted then re-applied". It names the
--     actor (NOT NULL, ON DELETE RESTRICT — see the column), states a
--     reason in the actor's own words (NOT NULL, minimum length checked
--     in the database and not only in Zod), and records the exposure and
--     the limit AS THEY STOOD, because "he was ₹40,000 over" is the fact
--     a review needs and it is unrecoverable six months later from a
--     table whose numbers have moved on.
--
--     🔴 AND IT IS KEYED TO ONE ORDER. A blanket "override this
--     customer's hold" is indistinguishable from lifting the hold, which
--     is a different act with a different permission. One override, one
--     order, and the unique index below means the same override cannot
--     let a second order through.
--
--  ⑤ A DUNNING STAGE THAT HAS BEEN SENT IS NEVER SENT AGAIN, AND THE
--     GUARANTEE IS A UNIQUE INDEX RATHER THAN AN `IF NOT EXISTS` IN
--     TYPESCRIPT. `credit_dunning_log_once_per_stage_key` on
--     (tenant_id, invoice_id, stage_id) is what makes the sweep safe to
--     run twice, safe to run from two containers at once, and safe to
--     re-run after a crash halfway through. A check-then-insert in the
--     action layer is not: two workers read "not sent" in the same
--     millisecond and the customer gets the same demanding letter twice,
--     which is the single most reliable way to turn a late payer into an
--     angry one.
--
--  ⑥ THIS FILE QUEUES AND RECORDS. IT DOES NOT SEND.
--     🔴 `credit_dunning_log.delivery` starts at `queued` and NOTHING IN
--     THIS BATCH MOVES IT TO `sent`. There is no SMTP call, no Resend
--     call, no webhook. `server/actions/credit.ts#runDunningSweep`
--     writes the queue rows and stops. Marking a row `sent` is the job
--     of whatever eventually delivers it, and the column exists now so
--     that the deliverer has somewhere honest to write the answer.
--
--     ⚠️ THE ALTERNATIVE — logging `sent` at queue time — is the trap
--     this decision exists to avoid. It produces a customer record that
--     says a reminder went out on the 14th, a customer who never
--     received it, and a collections call that opens with "we wrote to
--     you three times" against somebody who can prove otherwise.
--
--  ══════════════════════════════════════════════════════════════════
--  ⚠️ WHY THIS DUNNING IS NOT `dunning_policies` FROM 0038
--  ══════════════════════════════════════════════════════════════════
--  `dunning_policies`, `dunning_events` and `demand_notices` already
--  exist and are NOT reused here, for the same reason
--  `lib/credit/exposure.ts` refuses to import `demandPosition()`:
--
--     demand_notices   keyed on  booking_id + milestone_id (both NOT NULL)
--     dunning_events   keyed on  demand_id
--     sales_invoices   keyed on  company_id
--
--  The 0038 ladder chases a RERA milestone demand raised against a unit
--  booking, whose counterparty is a lead. This one chases a tax invoice,
--  whose counterparty is a company. There is no company_id anywhere in
--  `db/schema/receivables.ts`. Bolting a nullable `invoice_id` onto
--  `dunning_events` would put two counterparties in one table and make
--  every existing query say "and demand_id IS NOT NULL" forever, and the
--  first flat buyer who is also a trade customer would be chased twice
--  for one debt under two ladders that cannot see each other.
--
--  ⚠️ TWO LADDERS IS THE HONEST ANSWER. It is also the more expensive
--  one, and it is written down here so that the next person to notice
--  the duplication can see it was noticed.
--
--  ══════════════════════════════════════════════════════════════════
--  ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT STORE
--  ══════════════════════════════════════════════════════════════════
--  NO CREDIT SCORE. NO CIBIL / BUREAU PULL. NO EXTERNAL RATING.
--
--  🔴 A bureau score attached to a company row is a regulated data item
--  under the Credit Information Companies (Regulation) Act, 2005 — it may
--  only be held by a specified user for the purpose it was obtained for,
--  and it may not be retained afterwards. Storing one in a general ERP
--  table that every support session can read is the kind of thing that
--  is discovered during an audit rather than during development.
--
--  NO MESSAGE BODY. `credit_dunning_log` stores WHICH template was used
--  and WHERE it was sent, never the rendered text. The body is a
--  function of the template and the invoice, both of which are still
--  here; storing it as well gives the product two copies of a customer's
--  outstanding balance that must agree forever.
--
--  NO EXPOSURE CACHE. There is deliberately no `exposure_minor` column
--  on `customer_credit_profiles`. Exposure is derived from orders and
--  invoices at read time, twice, by two routes — see
--  `lib/credit/headroom.ts`. A cached exposure is a cache of a sum, and
--  a cache that disagrees with its ledger is the exact failure
--  `lib/reconciliation/gate.ts` exists to refuse to render.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ENUMS
-- =====================================================================

--  ⭐ HOW A HOLD CAME TO EXIST. Decision ③: one table, two sources.
--
--  ⚠️ `automatic` HOLDS ARE PLACED BY THE SWEEP AND LIFTED BY A HUMAN,
--  NEVER LIFTED BY THE SWEEP. A hold that lifts itself the moment a
--  receipt lands is a hold nobody ever has to look at, and the reason it
--  was placed — a bounced cheque, a customer who pays only when chased —
--  outlives the arithmetic that noticed it. `lib/credit/hold.ts` states
--  this as `AUTO_HOLDS_NEVER_SELF_RELEASE` and the tests assert it.
DO $$ BEGIN
  CREATE TYPE credit_hold_source AS ENUM ('manual', 'automatic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  🔴 DECISION ⑥ AS A TYPE. `queued` is where every row starts and where
--  every row in this batch stays. `suppressed` is not a failure — it is
--  "we decided not to send this one", which a collections team needs to
--  be able to say without deleting the row and losing the reason.
DO $$ BEGIN
  CREATE TYPE credit_dunning_delivery AS ENUM
    ('queued', 'sent', 'failed', 'suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  ⚠️ A SEPARATE TYPE FROM 0038'S `dunning_channel`, ON PURPOSE, and for
--  the reason in the header: these two ladders chase different
--  counterparties and must be free to diverge. `call` and `visit` are
--  here because an Indian collections ladder ends in a person, and a
--  record of the call is the thing a court asks for.
DO $$ BEGIN
  CREATE TYPE credit_dunning_channel AS ENUM
    ('email', 'sms', 'whatsapp', 'call', 'letter', 'visit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  ① THE HOLD, AS AN EVENT
-- =====================================================================
--
--  🔴 ONE ROW PER HOLD, NOT ONE ROW PER CUSTOMER. Decision ②.
--
--  ⚠️ `released_at IS NULL` IS THE DEFINITION OF "ON HOLD". There is no
--  `is_active` boolean, because a boolean and a timestamp that must
--  always agree is two facts where there is one, and the day they
--  disagree the customer is both held and not held depending on which
--  query ran.
CREATE TABLE IF NOT EXISTS credit_hold_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    source          credit_hold_source NOT NULL,

    --  🔴 NOT NULL, AND CHECKED FOR LENGTH BELOW. An unexplained hold
    --  becomes a phone call to somebody who does not know the answer.
    --  The automatic sweep writes a sentence too — it has the figures,
    --  so it can say "exposure ₹8,40,000 against a limit of ₹5,00,000".
    reason          text NOT NULL,

    placed_at       timestamptz NOT NULL DEFAULT now(),

    --  ⚠️ NULLABLE, AND ONLY FOR `automatic`. The CHECK below makes a
    --  manual hold with no actor impossible. The sweep has no user, and
    --  inventing one — "system", the tenant owner, whoever last logged
    --  in — would put a real person's name on a decision they did not
    --  make, which is the failure `confirmOrder`'s `approvedBy` bug was.
    placed_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    --  ⭐ THE FIGURES AS THEY STOOD. Paise, bigint, like every other
    --  money column in this schema. Recomputing them at read time would
    --  answer a different question — what the customer owes TODAY — and
    --  "why was this hold placed" is not answerable from today.
    exposure_at_hold_minor  bigint,
    limit_at_hold_minor     bigint,

    released_at     timestamptz,
    released_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    release_reason  text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    --  ⚠️ FOUR CHARACTERS, NOT ONE. A reason field that accepts "x"
    --  is a reason field that will contain "x", and Zod is not the
    --  boundary — `psql`, a migration script and a support session all
    --  reach this table without passing through it.
    CONSTRAINT credit_hold_events_reason_said
      CHECK (length(btrim(reason)) >= 4),

    CONSTRAINT credit_hold_events_manual_has_actor
      CHECK (source <> 'manual' OR placed_by IS NOT NULL),

    --  ⭐ A RELEASE IS AN ACT TOO. Lifting a hold restores a customer's
    --  entire trade, and the pair of columns move together or not at
    --  all. `release_reason` is deliberately NOT required — see
    --  `lib/validators/credit.ts`, which argues that placing a hold
    --  needs a defence and restoring the normal state does not.
    CONSTRAINT credit_hold_events_release_paired
      CHECK ((released_at IS NULL) = (released_by IS NULL)),

    CONSTRAINT credit_hold_events_release_after_placement
      CHECK (released_at IS NULL OR released_at >= placed_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_hold_events_id_tenant_key
    ON credit_hold_events (id, tenant_id);

--  🔴🔴 DECISION ③, AS AN INDEX. AT MOST ONE UNRELEASED HOLD PER
--  CUSTOMER. This is the whole of the idempotency guarantee for the
--  automatic sweep: `INSERT ... ON CONFLICT DO NOTHING` against it is a
--  no-op on the second run and on the two-hundredth, with no read-then-
--  write race in between. A TypeScript `if (!existing)` cannot make that
--  promise across two containers.
CREATE UNIQUE INDEX IF NOT EXISTS credit_hold_events_one_active_key
    ON credit_hold_events (tenant_id, company_id)
    WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS credit_hold_events_company_idx
    ON credit_hold_events (tenant_id, company_id, placed_at DESC);

CREATE INDEX IF NOT EXISTS credit_hold_events_open_idx
    ON credit_hold_events (tenant_id, placed_at DESC)
    WHERE released_at IS NULL;

-- =====================================================================
--  ② THE OVERRIDE
-- =====================================================================
--
--  🔴 DECISION ④. Going past a hold is a document, not a boolean.
--
--  ⚠️ THIS TABLE IS THE ANSWER TO "WHY DID THIS ORDER GO OUT". Without
--  it the only way past a hold is to lift the hold, confirm, and put it
--  back — three writes that leave a record saying the customer was not
--  on hold at the moment the order went out, which is false, and which
--  is what everybody actually does when there is no override.
CREATE TABLE IF NOT EXISTS credit_hold_overrides (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    --  🔴 ONE ORDER. NOT NULL. A blanket override is a lifted hold
    --  wearing a different name, and lifting a hold is a different act
    --  with a different permission and a different audit severity.
    order_id        uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,

    --  Which hold was overridden. NULL is legal and means the hold has
    --  since been deleted with its customer; the override row survives
    --  the FK being cleared because the fact that it happened does not
    --  stop being true.
    hold_event_id   uuid REFERENCES credit_hold_events(id) ON DELETE SET NULL,

    --  🔴 NOT NULL, ON DELETE RESTRICT, AND THE RESTRICT IS THE POINT.
    --  Everywhere else in this schema an actor column is `ON DELETE SET
    --  NULL`, because losing the name of whoever edited a note is
    --  acceptable. An override with no actor is exactly the boolean flip
    --  this table exists to replace: it says an order went out past a
    --  hold and nobody did it. A workspace that genuinely needs to
    --  remove a user who has signed overrides has to deal with the
    --  overrides first, deliberately, which is the correct amount of
    --  friction for erasing a signature.
    actor_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    --  🔴 IN THE ACTOR'S OWN WORDS. A dropdown of reason codes would be
    --  tidier and would lose "Mr Shah has confirmed the RTGS, UTR
    --  quoted, releasing against it" — which is the sentence that
    --  decides whether this was judgement or negligence when it is read
    --  back.
    reason          text NOT NULL,

    --  ⭐ THE POSITION AS IT STOOD, IN PAISE. See decision ④.
    exposure_at_override_minor  bigint,
    limit_at_override_minor     bigint,

    created_at      timestamptz NOT NULL DEFAULT now(),

    --  ⚠️ SET ONCE, BY THE CONFIRMATION THAT USED IT. An override that
    --  is never consumed is a granted permission nobody exercised, and
    --  that is worth being able to see separately from one that was.
    consumed_at     timestamptz,

    CONSTRAINT credit_hold_overrides_reason_said
      CHECK (length(btrim(reason)) >= 8),

    CONSTRAINT credit_hold_overrides_consumed_after_created
      CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_hold_overrides_id_tenant_key
    ON credit_hold_overrides (id, tenant_id);

--  🔴 ONE OVERRIDE PER ORDER, EVER. Decision ④'s second half. Without
--  this a single signed override can be re-read by every retry of
--  `confirmOrder` and — worse — by an order that was cancelled and
--  re-raised under the same id after an amendment.
CREATE UNIQUE INDEX IF NOT EXISTS credit_hold_overrides_one_per_order_key
    ON credit_hold_overrides (tenant_id, order_id);

CREATE INDEX IF NOT EXISTS credit_hold_overrides_company_idx
    ON credit_hold_overrides (tenant_id, company_id, created_at DESC);

-- =====================================================================
--  ③ THE DUNNING LADDER
-- =====================================================================
--
--  ⭐ A LADDER IS A ROW, NOT A CONSTANT. Seven days for a distributor on
--  30-day terms and forty-five for a government department are both
--  correct, and a constant in code means the only workspaces the product
--  fits are the ones that guessed the way we did.
CREATE TABLE IF NOT EXISTS credit_dunning_ladders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name            varchar(80) NOT NULL,
    description     text,

    --  ⚠️ INACTIVE, NOT DELETED. A ladder that has chased somebody is
    --  referenced by every log row it produced; deleting it would either
    --  cascade those away or leave them pointing at nothing, and both
    --  destroy the answer to "what did we send them".
    is_active       boolean NOT NULL DEFAULT true,

    --  ⭐ THE DEFAULT LADDER FOR CUSTOMERS WITH NO EXPLICIT ONE. At most
    --  one per tenant — see the partial unique index below.
    is_default      boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_ladders_id_tenant_key
    ON credit_dunning_ladders (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_ladders_name_key
    ON credit_dunning_ladders (tenant_id, lower(name));

--  ⚠️ ONE DEFAULT, AND ONLY WHILE IT IS ACTIVE. Two defaults means the
--  sweep picks one arbitrarily and a customer is chased on a schedule
--  nobody chose.
CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_ladders_one_default_key
    ON credit_dunning_ladders (tenant_id)
    WHERE is_default AND is_active;

-- ---------------------------------------------------------------------
--  THE STAGES
-- ---------------------------------------------------------------------
--
--  🔴 `days_past_due` IS AGE PAST THE DUE DATE, NOT AGE OF THE INVOICE.
--  An invoice dated the 1st on 30-day terms is not one day overdue on
--  the 2nd. Counting from the invoice date rather than the due date
--  sends a first reminder to a customer who is inside their agreed terms,
--  which is the fastest way to make a good payer stop answering the
--  phone.
CREATE TABLE IF NOT EXISTS credit_dunning_stages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ladder_id       uuid NOT NULL REFERENCES credit_dunning_ladders(id) ON DELETE CASCADE,

    --  Display and escalation order. 1 is the gentlest.
    stage_no        integer NOT NULL,
    label           varchar(80) NOT NULL,

    days_past_due   integer NOT NULL,
    channel         credit_dunning_channel NOT NULL DEFAULT 'email',

    --  ⚠️ A TEMPLATE KEY, NOT A BODY. See "what this file does not
    --  store" in the header.
    template_key    varchar(80),

    --  ⭐ THE STAGE AT WHICH THE LADDER STOPS ASKING AND STARTS
    --  REFUSING. When true, reaching this stage places an `automatic`
    --  hold — which is the only automatic hold in the product that is
    --  not about the arithmetic of a limit. A customer 90 days past due
    --  on ₹10,000 may be nowhere near their limit and is still not
    --  somebody to ship to.
    places_hold     boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    --  ⚠️ ZERO IS LEGAL AND MEANS "ON THE DUE DATE". Negative is not:
    --  a stage that fires before the money is due is not dunning, it is
    --  a payment reminder, and mixing the two puts "you are overdue"
    --  in front of somebody who is not.
    CONSTRAINT credit_dunning_stages_age_sane
      CHECK (days_past_due >= 0 AND days_past_due <= 3650),

    CONSTRAINT credit_dunning_stages_no_positive
      CHECK (stage_no >= 1 AND stage_no <= 20)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_stages_id_tenant_key
    ON credit_dunning_stages (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_stages_no_key
    ON credit_dunning_stages (tenant_id, ladder_id, stage_no);

--  🔴 TWO STAGES AT THE SAME AGE MAKES "WHICH STAGE IS DUE ON DAY 30"
--  UNANSWERABLE, and the sweep would send both — two letters, same day,
--  same customer, different tone.
CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_stages_age_key
    ON credit_dunning_stages (tenant_id, ladder_id, days_past_due);

-- =====================================================================
--  ④ THE LOG — WHAT WAS SENT, TO WHOM, WHEN, AND WHAT HAPPENS NEXT
-- =====================================================================
--
--  🔴 DECISION ⑤ AND DECISION ⑥ LIVE IN THIS TABLE.
--
--  ⚠️ IT IS A QUEUE AND A RECORD AT THE SAME TIME, and the `delivery`
--  column is the only thing that distinguishes the two states. Nothing
--  in this batch writes `sent`.
CREATE TABLE IF NOT EXISTS credit_dunning_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    --  🔴 RESTRICT, NOT CASCADE. An invoice that has been chased cannot
    --  be deleted out from under its own chase record. A cancelled
    --  invoice is `status = 'cancelled'`, not a missing row.
    invoice_id      uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,

    ladder_id       uuid REFERENCES credit_dunning_ladders(id) ON DELETE SET NULL,
    stage_id        uuid NOT NULL REFERENCES credit_dunning_stages(id) ON DELETE RESTRICT,

    --  ⭐ COPIED FROM THE STAGE AT QUEUE TIME, NOT JOINED AT READ TIME.
    --  Somebody will re-tune the ladder — everybody does, once — and a
    --  record that said "stage 2, 30 days" must not silently become
    --  "stage 2, 45 days" for every letter ever sent under the old one.
    stage_no        integer NOT NULL,
    days_past_due   integer NOT NULL,
    channel         credit_dunning_channel NOT NULL,
    template_key    varchar(80),

    --  🔴 WHO IT WENT TO, CAPTURED. Same rule as `customer_legal_name`
    --  on a tax invoice: a contact who changes jobs next year must not
    --  restate who we chased this year.
    recipient_name  varchar(160),
    recipient_email varchar(255),
    recipient_phone varchar(40),

    --  What was outstanding when the stage fired. Paise.
    amount_due_minor bigint NOT NULL,

    delivery        credit_dunning_delivery NOT NULL DEFAULT 'queued',
    queued_at       timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    failure_reason  text,

    --  🔴 THE NEXT-ACTION DATE, STORED RATHER THAN DERIVED.
    --
    --  ⚠️ IT IS THE DATE THE NEXT STAGE BECOMES DUE, computed in
    --  `lib/credit/dunning.ts` from the invoice's due date and the next
    --  stage's age — NOT "today plus seven". Deriving it at read time
    --  would make it move every time somebody edited the ladder, and a
    --  collections diary that reshuffles itself is a diary nobody works
    --  from. NULL means this was the last rung: there is no next stage,
    --  and the next action is a human decision.
    next_action_on  date,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT credit_dunning_log_amount_sane
      CHECK (amount_due_minor > 0),

    --  ⚠️ `sent` WITHOUT A TIMESTAMP IS A CLAIM WITH NO EVIDENCE.
    CONSTRAINT credit_dunning_log_sent_has_time
      CHECK (delivery <> 'sent' OR sent_at IS NOT NULL),

    CONSTRAINT credit_dunning_log_failed_has_reason
      CHECK (delivery <> 'failed' OR failure_reason IS NOT NULL),

    --  🔴 A CHANNEL THAT NEEDS AN ADDRESS MUST HAVE ONE. Queueing an
    --  email to nobody produces a log row saying we wrote to a customer
    --  we could not write to, which is decision ⑥'s failure with extra
    --  steps.
    CONSTRAINT credit_dunning_log_email_has_address
      CHECK (channel <> 'email' OR recipient_email IS NOT NULL),
    CONSTRAINT credit_dunning_log_sms_has_number
      CHECK (channel NOT IN ('sms', 'whatsapp') OR recipient_phone IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_log_id_tenant_key
    ON credit_dunning_log (id, tenant_id);

--  🔴🔴 DECISION ⑤, AS AN INDEX. THIS IS THE IDEMPOTENCY GUARANTEE.
--  One row per (invoice, stage), forever. `INSERT ... ON CONFLICT DO
--  NOTHING` against it is what makes the sweep safe to re-run, safe to
--  run from two containers, and safe to resume after a crash.
CREATE UNIQUE INDEX IF NOT EXISTS credit_dunning_log_once_per_stage_key
    ON credit_dunning_log (tenant_id, invoice_id, stage_id);

CREATE INDEX IF NOT EXISTS credit_dunning_log_company_idx
    ON credit_dunning_log (tenant_id, company_id, queued_at DESC);

--  The collections diary: what is due to be actioned, oldest first.
CREATE INDEX IF NOT EXISTS credit_dunning_log_next_action_idx
    ON credit_dunning_log (tenant_id, next_action_on)
    WHERE next_action_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_dunning_log_queue_idx
    ON credit_dunning_log (tenant_id, delivery, queued_at)
    WHERE delivery = 'queued';

-- =====================================================================
--  ⑤ TWO COLUMNS ON 0048'S PROFILE
-- =====================================================================
--
--  ⚠️ ADDITIVE AND GUARDED. `customer_credit_profiles` already carries
--  the limit, the terms and 0048's `on_hold` boolean, and none of those
--  are touched.
ALTER TABLE customer_credit_profiles
  ADD COLUMN IF NOT EXISTS auto_hold_enabled boolean NOT NULL DEFAULT false;

--  🔴 DEFAULT FALSE, AND THAT IS A DECISION RATHER THAN CAUTION.
--
--  Switching automatic holds on for every existing customer in the
--  migration that introduces them would, on the first sweep, stop
--  trading with every customer who happens to be over an aspirational
--  limit somebody typed in eighteen months ago and never revisited. The
--  workspace would experience the upgrade as an outage.
--
--  ⚠️ THE OPPOSITE RISK IS REAL AND IS ACCEPTED: a feature that is off by
--  default is a feature nobody turns on. The mitigation is the credit
--  board, which shows every customer who WOULD be held — so the value is
--  visible before the switch is flipped, which is the only honest way to
--  ask somebody to flip it.
ALTER TABLE customer_credit_profiles
  ADD COLUMN IF NOT EXISTS dunning_ladder_id uuid;

--  ⚠️ THE FK IS ADDED SEPARATELY AND GUARDED, because ADD COLUMN IF NOT
--  EXISTS cannot carry one on a re-run — the second run skips the column
--  and would skip the constraint with it.
ALTER TABLE customer_credit_profiles
  DROP CONSTRAINT IF EXISTS customer_credit_profiles_dunning_ladder_fk;
ALTER TABLE customer_credit_profiles
  ADD CONSTRAINT customer_credit_profiles_dunning_ladder_fk
  FOREIGN KEY (dunning_ladder_id)
  REFERENCES credit_dunning_ladders(id) ON DELETE SET NULL;

-- =====================================================================
--  ⑥ TRIGGERS
-- =====================================================================

-- ⭐ `set_updated_at()` is from 0001. Without these, `updated_at` is the
--    creation time forever and "when did this last change" is unanswerable.
DROP TRIGGER IF EXISTS credit_hold_events_set_updated_at ON credit_hold_events;
CREATE TRIGGER credit_hold_events_set_updated_at
  BEFORE UPDATE ON credit_hold_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS credit_dunning_ladders_set_updated_at ON credit_dunning_ladders;
CREATE TRIGGER credit_dunning_ladders_set_updated_at
  BEFORE UPDATE ON credit_dunning_ladders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS credit_dunning_stages_set_updated_at ON credit_dunning_stages;
CREATE TRIGGER credit_dunning_stages_set_updated_at
  BEFORE UPDATE ON credit_dunning_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
--  🔴 THE HOLD MIRROR — DECISION ② MADE TRUE BY THE DATABASE
-- ---------------------------------------------------------------------
--
--  0048's `customer_credit_profiles.on_hold` is kept so that every
--  existing reader keeps working, and a denormalised copy that anybody
--  can update independently is a copy that will disagree. This trigger
--  makes the event table the single writer of it.
--
--  ⚠️ IT UPSERTS THE PROFILE ROW. A customer can be held before anybody
--  has ever set a credit limit on them — that is in fact the common case
--  — and a trigger that only UPDATEd would silently fail to mirror the
--  hold for exactly those customers.
--
--  ⚠️ AND IT NEVER TOUCHES `credit_limit_minor`. See 0048: NULL means no
--  limit, 0 means blocked, and a mirror that inserted a default would
--  have to pick one of those and would pick wrong.
CREATE OR REPLACE FUNCTION ordence_mirror_credit_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant  uuid;
  v_company uuid;
  v_active  boolean;
  v_reason  text;
BEGIN
  v_tenant  := COALESCE(NEW.tenant_id,  OLD.tenant_id);
  v_company := COALESCE(NEW.company_id, OLD.company_id);

  SELECT true, e.reason
    INTO v_active, v_reason
    FROM credit_hold_events e
   WHERE e.tenant_id = v_tenant
     AND e.company_id = v_company
     AND e.released_at IS NULL
   LIMIT 1;

  IF v_active IS NULL THEN
    v_active := false;
    v_reason := NULL;
  END IF;

  INSERT INTO customer_credit_profiles (tenant_id, company_id, on_hold, hold_reason)
  VALUES (v_tenant, v_company, v_active, v_reason)
  ON CONFLICT (tenant_id, company_id)
  DO UPDATE SET on_hold     = EXCLUDED.on_hold,
                hold_reason = EXCLUDED.hold_reason,
                updated_at  = now();

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS credit_hold_events_mirror ON credit_hold_events;
CREATE TRIGGER credit_hold_events_mirror
  AFTER INSERT OR UPDATE OR DELETE ON credit_hold_events
  FOR EACH ROW EXECUTE FUNCTION ordence_mirror_credit_hold();

-- ---------------------------------------------------------------------
--  🔴 THE OVERRIDE IS APPEND-ONLY EXCEPT FOR `consumed_at`
-- ---------------------------------------------------------------------
--
--  ⚠️ THE ATTACK THIS REFUSES IS NOT AN ATTACK. It is somebody tidying
--  up. An override whose `reason` can be edited afterwards is an
--  override whose reason is whatever it needed to be by the time anybody
--  looked, and the edit leaves no trace because the row still exists and
--  still names the same person.
--
--  ⭐ `consumed_at` IS THE ONE MUTABLE COLUMN, AND IT MAY ONLY GO FROM
--  NULL TO A VALUE. Setting it back to NULL would make a used override
--  usable again.
CREATE OR REPLACE FUNCTION ordence_guard_credit_override_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      '🔴 A credit hold override cannot be deleted. It is the record of why an order went out past a hold; if it was raised in error, the order is the thing to cancel.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
     OR NEW.tenant_id   IS DISTINCT FROM OLD.tenant_id
     OR NEW.company_id  IS DISTINCT FROM OLD.company_id
     OR NEW.order_id    IS DISTINCT FROM OLD.order_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.reason      IS DISTINCT FROM OLD.reason
     OR NEW.exposure_at_override_minor IS DISTINCT FROM OLD.exposure_at_override_minor
     OR NEW.limit_at_override_minor    IS DISTINCT FROM OLD.limit_at_override_minor
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      '🔴 A credit hold override is a signature. Only consumed_at may change after it is written; raise a new override rather than editing this one.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION
      '🔴 An override that has been used cannot be un-used. It would let one signature release a second order.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS credit_hold_overrides_immutable ON credit_hold_overrides;
CREATE TRIGGER credit_hold_overrides_immutable
  BEFORE UPDATE OR DELETE ON credit_hold_overrides
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_credit_override_immutable();

-- ---------------------------------------------------------------------
--  🔴 THE DUNNING LOG'S IDENTITY IS FROZEN — DECISION ⑤'S SECOND HALF
-- ---------------------------------------------------------------------
--
--  The unique index stops the same stage being INSERTed twice. This
--  stops the same effect being achieved by UPDATE: re-pointing an
--  already-recorded row at a different invoice frees the (invoice,
--  stage) pair to be inserted again, and the customer is chased twice
--  with the index still reporting one row per stage.
--
--  ⭐ `delivery`, `sent_at`, `failure_reason` and `next_action_on` STAY
--  MUTABLE, because decision ⑥ says something else delivers these and
--  has to be able to write the answer back.
CREATE OR REPLACE FUNCTION ordence_guard_dunning_log_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      '🔴 A dunning record cannot be deleted. Deleting it lets the same reminder be sent again, and "we wrote to you three times" has to be true.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.stage_id   IS DISTINCT FROM OLD.stage_id
     OR NEW.stage_no   IS DISTINCT FROM OLD.stage_no
     OR NEW.queued_at  IS DISTINCT FROM OLD.queued_at
  THEN
    RAISE EXCEPTION
      '🔴 A dunning record may not be re-pointed at another invoice or stage. That is how the same customer is chased twice while the once-per-stage index still reads clean.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS credit_dunning_log_identity ON credit_dunning_log;
CREATE TRIGGER credit_dunning_log_identity
  BEFORE UPDATE OR DELETE ON credit_dunning_log
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_dunning_log_identity();

-- =====================================================================
--  ⑦ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 A CREDIT FILE IS THE MOST COMMERCIALLY SENSITIVE THING IN THE
--  PRODUCT AFTER PAYROLL. One tenant reading another's would hand them,
--  for every customer at once: who is over their limit, who is on hold,
--  who has been chased four times, and what somebody wrote in the reason
--  field about why. That last one is free text written by a salesperson
--  who assumed nobody outside the company would read it.
--
--  ⭐ `app_platform_scope()` GOES IN `USING` AND NEVER IN `WITH CHECK`,
--  the house rule the whole schema follows and that 0014 fails a deploy
--  over: platform staff may READ across tenants to answer a support
--  question, and may never WRITE a row into a workspace that is not the
--  session's. On this table set that matters twice over — a platform
--  write here could lift a hold.
--
--  ⚠️ FORCE, NOT JUST ENABLE. This application connects as the table
--  owner, and an owner without FORCE bypasses every policy — which is
--  precisely what `check:rls-writes` was built after finding.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'credit_hold_events', 'credit_hold_overrides',
    'credit_dunning_ladders', 'credit_dunning_stages', 'credit_dunning_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_isolation', t
    );
  END LOOP;
END
$$;

-- =====================================================================
--  ⑧ GRANTS TO ordence_app
-- =====================================================================
--
--  ⚠️ NO DELETE ON THE TWO EVIDENCE TABLES, AND THE TRIGGERS ABOVE SAY
--  THE SAME THING TWICE ON PURPOSE.
--
--  The trigger produces a sentence a salesperson can read. The withheld
--  GRANT produces `permission denied for table credit_hold_overrides`,
--  which is written for a DBA. Both exist because they fail in different
--  places: the trigger catches the application, the GRANT catches
--  everything that is not the application — a migration script, a
--  console session, a well-meant cleanup job at 2am. A product rule
--  enforced only where it can say something useful is a product rule
--  that is not enforced at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON credit_hold_events     TO ordence_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON credit_hold_overrides  TO ordence_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON credit_dunning_log     TO ordence_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON credit_dunning_ladders TO ordence_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON credit_dunning_stages  TO ordence_app';
  END IF;
END
$$;

-- =====================================================================
--  ⑨ THE TABLE COMMENTS, FOR WHOEVER OPENS THIS IN A CLIENT
-- =====================================================================

COMMENT ON TABLE credit_hold_events IS
  'One row per hold, manual or automatic. 🔴 `released_at IS NULL` IS '
  'THE DEFINITION OF ON HOLD — there is no is_active boolean, because a '
  'boolean and a timestamp that must always agree is two facts where '
  'there is one. customer_credit_profiles.on_hold is a mirror kept by '
  'trigger for the readers written before this table existed; never '
  'write it directly.';

COMMENT ON COLUMN credit_hold_events.source IS
  'automatic holds are placed by the sweep and lifted only by a human. A '
  'hold that lifts itself the moment a receipt lands is a hold nobody '
  'ever has to look at, and the reason it was placed outlives the '
  'arithmetic that noticed it.';

COMMENT ON TABLE credit_hold_overrides IS
  'Why one order went out past a hold. 🔴 ONE ORDER, ONE OVERRIDE, USED '
  'ONCE — a blanket override is a lifted hold wearing a different name. '
  'Append-only by trigger except consumed_at; actor_user_id is NOT NULL '
  'and ON DELETE RESTRICT because an override with no actor is the '
  'boolean flip this table exists to replace.';

COMMENT ON COLUMN credit_hold_overrides.reason IS
  'In the actor''s own words, minimum eight characters, checked in the '
  'database and not only in Zod. A dropdown of reason codes would be '
  'tidier and would lose the sentence that decides whether this was '
  'judgement or negligence when it is read back.';

COMMENT ON TABLE credit_dunning_log IS
  '🔴 A QUEUE AND A RECORD. Rows are written with delivery = queued and '
  'NOTHING IN BATCH 40 SENDS ANYTHING — no SMTP, no Resend, no webhook. '
  'Whatever delivers them writes sent/failed back. Logging sent at queue '
  'time would produce a collections call opening with "we wrote to you '
  'three times" against a customer who can prove otherwise.';

COMMENT ON COLUMN credit_dunning_log.next_action_on IS
  'The date the NEXT stage becomes due, computed from the invoice due '
  'date and the next stage''s age — not "today plus seven". NULL means '
  'this was the last rung and the next action is a human decision.';

COMMENT ON COLUMN credit_dunning_stages.days_past_due IS
  'Age past the DUE date, never past the invoice date. An invoice dated '
  'the 1st on 30-day terms is not one day overdue on the 2nd, and a '
  'first reminder to somebody inside their agreed terms is the fastest '
  'way to make a good payer stop answering the phone.';

COMMENT ON COLUMN customer_credit_profiles.auto_hold_enabled IS
  'Off by default, deliberately. Switching automatic holds on for every '
  'existing customer in the migration that introduces them would stop '
  'trading with everyone who is over an aspirational limit somebody '
  'typed eighteen months ago — the workspace experiences the upgrade as '
  'an outage. The credit board shows who WOULD be held, so the value is '
  'visible before the switch is flipped.';

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO SCHEDULER. Nothing here fires the dunning sweep on a timer.
--  `runDunningSweep` is a server action a human presses, and the cron
--  that calls it belongs to the deployment, not to a migration. A
--  pg_cron entry written by a migration runs in every environment the
--  migration is applied to, including a restored backup on a laptop,
--  and the first symptom is a developer's test tenant e-mailing real
--  customers.
--
--  NO AUTOMATIC RELEASE. Nothing lifts a hold when the money arrives.
--  See the comment on `credit_hold_events.source`. The credit board
--  shows every held customer whose exposure is now back inside their
--  limit, with a one-click release that writes a released_by — which is
--  the same outcome with a person's name on it.
--
--  NO INTEREST ON OVERDUE TRADE INVOICES. `receivable_policies` (0038)
--  already models interest for the construction side, with compounding
--  and day-count conventions that took a batch of their own. A second,
--  simpler interest engine for trade debt would be two answers to "what
--  do they owe us" inside one product.
--
--  NO WRITE-OFF. Deciding a debt is unrecoverable is an accounting entry
--  — it hits the P&L and it reverses input tax in some cases — and it
--  belongs with `journal_entries`, not with the table that chased it.
--
--  ⚠️ AND NO SEED LADDER. A workspace with no ladder configured is not
--  dunned, and `runDunningSweep` says so in a sentence rather than
--  inventing 15/30/60. A default ladder shipped by us would be the
--  schedule most workspaces are chased on, chosen by nobody, and the
--  first time it is wrong it is wrong in front of a customer.
-- =====================================================================
