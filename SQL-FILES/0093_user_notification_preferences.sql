-- ############################################################################
-- 0093 , A PLACE ON `users` FOR PREFERENCES THE SERVER CAN READ
-- ############################################################################
--
-- PURPOSE
-- -------
-- `app/(crm)/settings/notifications` offered seven category switches, an
-- email-delivery switch and a minimum-severity choice, and stored all of it
-- in `localStorage` under `ordence_notification_prefs`. Its own comment said
-- "in production this would come from the user's settings JSONB". There was
-- no such column.
--
-- 🔴 THE CONSEQUENCE THAT MATTERS IS NOT "IT DOES NOT SYNC BETWEEN DEVICES".
--    `server/notifications/create.ts` emails EVERY active user in the tenant
--    when a notification is critical or warning. It reads `users`. It has no
--    way to reach a browser's local storage, so it could not honour a switch
--    even in principle. Every one of those switches was decoration: the user
--    turned off "Inventory" email, the toggle went grey, and the mail kept
--    arriving. That is worse than having no switch at all, because the user
--    stops watching for mail they believe they have silenced.
--
-- ⭐ WHY A GENERAL `preferences` COLUMN AND NOT `notification_preferences`.
--    `users` already carries `permission_overrides` jsonb, which is an
--    authorisation artefact, not a preference. Notifications are the first
--    preference family but obviously not the last (digest cadence, locale
--    overrides, density). One `preferences` column with a `notifications`
--    key costs nothing extra today and saves a migration per family later.
--    The reader (`lib/notifications/preferences.ts`) treats every missing or
--    unrecognised value as "not set yet" and substitutes a default, so the
--    column is free to grow keys that older code has never heard of.
--
-- ⚠️ NO BACKFILL, DELIBERATELY. `'{}'` IS THE CORRECT VALUE FOR EVERY
--    EXISTING ROW. It means "this user has never expressed a preference",
--    which is exactly true, and the parser resolves it to the defaults
--    (all categories on, email on, warning-and-above). A backfill would
--    write the same defaults as if the user had CHOSEN them, and the
--    difference matters the day the defaults change.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092, restated because the reason is not obvious and the
-- project has already lost a day to it. Migrations here are PASTED INTO THE
-- NEON BROWSER CONSOLE, which sends each statement on its own. `BEGIN` buys
-- no atomicity across that boundary, it only makes a half-applied file look
-- like a clean one; `SET LOCAL` reports "executed successfully" and has
-- evaporated by the time the next statement runs.
--
-- ⭐ SO EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT, and the file is
--    safe to re-run from the top after a failure at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS.
--    `ADD COLUMN` is DDL. It is not subject to a row-level security WITH
--    CHECK, so it needs no `app.platform_scope`, no `DO` block and no
--    special role. A migration that never writes a row cannot be refused by
--    a policy , the failure mode 0091 and 0092 both hit.
--
-- RUN ORDER: after 0092. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If section 2 refuses, this row is still on your screen and still tells you
-- the two things worth knowing: whether the column is already there, and how
-- many users are about to gain one.
-- ============================================================================

SELECT
    '0093 · diagnostic'                              AS finding,
    current_user                                     AS running_as,
    (SELECT count(*) FROM public.users)              AS user_rows,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'users'
          AND column_name  = 'preferences'
    )                                                AS column_already_present;


-- ============================================================================
-- SECTION 2 · THE COLUMN · ONE IDEMPOTENT DDL STATEMENT
-- ============================================================================
--
-- ⚠️ `NOT NULL DEFAULT '{}'::jsonb` RATHER THAN NULLABLE. A nullable column
--    would give the reader two spellings of "nothing set" (NULL and `{}`) and
--    a `coalesce` at every call site, one of which will eventually be
--    forgotten. Since PostgreSQL 11 a NOT NULL column with a constant default
--    is added without rewriting the table, so this is a catalogue-only change
--    even on a large `users`.
--
-- ⚠️ NO CHECK CONSTRAINT ON THE SHAPE, AND THAT IS A CHOICE. The contents are
--    user-controlled and read on a MAIL SEND path. A constraint would move
--    validation into the database, where a mismatch between it and the
--    TypeScript parser becomes a failed write on a settings page. Instead
--    `parseNotificationPreferences()` is total: any object, any depth, any
--    junk, resolves to a valid preference set and never throws. The database
--    stores bytes; the parser owns the meaning.
-- ============================================================================

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;


-- ============================================================================
-- SECTION 3 · CONFIRMATION · THE ROW TO READ
-- ============================================================================

SELECT
    '0093 · verdict'                                 AS finding,
    c.column_name                                    AS column_name,
    c.data_type                                      AS data_type,
    c.is_nullable                                    AS is_nullable,
    c.column_default                                 AS column_default,
    CASE
        WHEN c.data_type = 'jsonb' AND c.is_nullable = 'NO'
            THEN 'PASS , users.preferences exists as NOT NULL jsonb; the send path can now read a preference the user set on any device'
        ELSE 'FAIL , section 2 did not apply as written, send me the error from its tab'
    END                                              AS verdict
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name   = 'users'
  AND c.column_name  = 'preferences';
