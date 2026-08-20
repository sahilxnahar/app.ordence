-- ═══════════════════════════════════════════════════════════════════════
-- Ordence — Track D, wave 15
-- FOUR NEW SECURITY EVENT TYPES: the vocabulary for a control that failed
-- ═══════════════════════════════════════════════════════════════════════
--
-- 🔴 THIS FILE HAS NO NUMBER, ON PURPOSE, AND MUST NOT BE APPLIED AS-IS.
--
-- Track D's brief allocates it NO SQL numbers ("none. Request one from
-- integration if you need it."). A duplicate migration number is named in
-- that brief as "the single most likely way this whole effort breaks", and
-- six other tracks are working on this repository right now.
--
-- ⚠️ INTEGRATION: rename this file to the next free number and apply it.
--    At 1.81.0-alpha `npm run check:migrations` reported
--    "0001…0128 (6 documented historical gaps). Next number: 0129" —
--    but that was measured before the other six tracks' files landed, so
--    take the number from a fresh run, not from this comment.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WHY IT IS NEEDED
-- ═══════════════════════════════════════════════════════════════════════
-- `lib/security/events.ts` gained four members in wave 15. That constant is
-- what `db/schema/secops.ts` derives the Drizzle `pgEnum` from — so the
-- TypeScript union and the Drizzle schema already know them. The POSTGRES
-- enum does not, and only `ALTER TYPE … ADD VALUE` can teach it.
--
--     billing.standing_unresolved     the billing gate could not decide and
--                                     refused writes rather than granting them
--     platform.scope_raised           somebody read across tenant boundaries,
--                                     with the justification on `reason`
--     security.evidence_write_failed  a piece of security evidence did not
--                                     persist — critical, because it is the
--                                     one that eats the others
--     automation.event_dropped        a workflow trigger was not queued, so
--                                     every workflow watching that record
--                                     did not fire for it
--
-- ⚠️ UNTIL THIS IS APPLIED, NOTHING IS LOST. `lib/security/evidence.ts`
-- degrades: it tries the precise type, and when the database refuses the
-- label it rewrites the same facts as `anomaly.detected` carrying
-- `detail.intended_type`. That behaviour is proven in both directions by
-- `tests/security/security-event-tenant-scope.test.ts`, which reads
-- `pg_enum` and asserts whichever branch the database is actually in.
--
-- ⚠️ THERE IS NO BACK-FILL AND THERE CANNOT BE. `security_events` is
-- append-only: `prevent_security_event_mutation` refuses every UPDATE, for
-- every role including the table owner. Rows already written under the
-- fallback stay as `anomaly.detected`, and this is how you find them:
--
--     SELECT occurred_at, source, severity, reason, detail->>'intended_type'
--       FROM security_events
--      WHERE detail ? 'intended_type'
--      ORDER BY occurred_at DESC;
--
-- ═══════════════════════════════════════════════════════════════════════
-- NOTES FOR WHOEVER RUNS IT
-- ═══════════════════════════════════════════════════════════════════════
-- • No file-level BEGIN/COMMIT — the Neon console and `check:migrations`
--   both refuse them.
-- • `ADD VALUE IF NOT EXISTS` is idempotent, so a second run is a no-op
--   rather than an error. That matters here: this file will be applied by
--   hand, in a console, possibly twice.
-- • ⚠️ EACH `ALTER TYPE` IS ITS OWN STATEMENT AND MUST STAY THAT WAY. A
--   new enum label cannot be USED in the same transaction that added it,
--   and the Neon console runs one statement per connection, which is what
--   makes the verification block at the foot work at all.
-- • The verification RAISES. A migration that can succeed while doing
--   nothing is the same bug as a `count(*) >= 10` gate.
-- ═══════════════════════════════════════════════════════════════════════


ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'billing.standing_unresolved';

ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'platform.scope_raised';

ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'security.evidence_write_failed';

ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'automation.event_dropped';


-- ═══════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION — raises if the change did not take
-- ═══════════════════════════════════════════════════════════════════════
--
-- ⚠️ IT COUNTS, AND IT ALSO NAMES. A bare `count(*) = 4` would pass if the
-- same label were somehow added four times, and would say nothing useful
-- when it failed. This reports which labels are missing, by name, in the
-- exception message — because the person reading that message is in a
-- console at an awkward hour and has no debugger.
DO $$
DECLARE
  wanted  text[] := ARRAY[
    'billing.standing_unresolved',
    'platform.scope_raised',
    'security.evidence_write_failed',
    'automation.event_dropped'
  ];
  missing text[];
BEGIN
  SELECT array_agg(w)
    INTO missing
    FROM unnest(wanted) AS w
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname  = 'security_event_type'
        AND e.enumlabel = w
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'security_event_type is missing % of 4 Track D labels: %',
      array_length(missing, 1), array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE 'Track D: all four security_event_type labels present.';
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- A SECOND, INDEPENDENT CHECK — that the enum is the one the table uses
-- ═══════════════════════════════════════════════════════════════════════
--
-- 🔴 THE FIRST BLOCK PROVES A TYPE NAMED `security_event_type` HAS FOUR
-- LABELS. It does not prove that `security_events.event_type` is that type.
-- Those are different claims, and in a schema with more than one search
-- path they can come apart. This one asks the column.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT t.typname
    INTO col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type  t ON t.oid = a.atttypid
   WHERE c.relname = 'security_events'
     AND c.relnamespace = 'public'::regnamespace
     AND a.attname  = 'event_type'
     AND a.attnum > 0;

  IF col_type IS DISTINCT FROM 'security_event_type' THEN
    RAISE EXCEPTION
      'security_events.event_type is of type %, not security_event_type — '
      'the ALTER above taught the wrong type and the new events will still be refused.',
      coalesce(col_type, '(column not found)');
  END IF;

  RAISE NOTICE 'Track D: security_events.event_type is security_event_type, as expected.';
END $$;
