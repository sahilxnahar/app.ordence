-- ############################################################################
-- 0120 · THE MIGRATION LEDGER — WHICH FILES THIS DATABASE HAS ACTUALLY SEEN
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.78.0-alpha   ·   Migration number: 0120
--
-- ⚠️ NO `BEGIN`/`COMMIT`. Every statement is independently idempotent.
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY
-- ############################################################################
--
-- One hundred and nineteen numbered SQL files exist. The way they are applied
-- is: somebody opens the Neon browser console, pastes a file, and reads the
-- output. The record that it was applied is that person's memory.
--
-- Everything downstream of that is guesswork:
--
--   • "Has 0117 been applied to production?" has no answer except reading the
--     schema and inferring. `SQL-FILES/WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql`
--     exists precisely because there was no ledger — it INFERS the answer from
--     the presence of tables, which cannot distinguish a file that was applied
--     from a file that was half-applied.
--
--   • A file applied TWICE is safe, because every file is written to be
--     idempotent. A file applied in the WRONG ORDER is not, and nothing has
--     ever refused it.
--
--   • When a deploy goes wrong, the first question is "which migrations were
--     in that release", and the answer is in nobody's hands.
--
-- ############################################################################
-- ⭐⭐⭐ WHAT THIS TABLE IS, AND WHAT IT IS DELIBERATELY NOT
-- ############################################################################
--
-- It is a LEDGER, not a lock. `scripts/migrate.mjs` writes a row after a file
-- applies cleanly, and reads the table to decide what is left to do.
--
-- ⚠️ IT IS NOT A DISTRIBUTED LOCK AND MUST NOT BE MISTAKEN FOR ONE. Two people
-- pasting the same file into two console tabs at the same moment is a race
-- this table does not prevent; the files' own idempotency is what makes that
-- safe, and that property stays load-bearing. A lock would be a second
-- mechanism to get wrong, and the failure mode of a stuck migration lock —
-- nobody can deploy and nobody knows why — is worse than the one it prevents.
--
-- ⚠️ IT IS PLATFORM DATA, NOT TENANT DATA. No `tenant_id`, no RLS. A migration
-- is not something a workspace has; it is something the whole database has.
-- `check:sql-completeness` reads the absence of `tenant_id` correctly, so this
-- table is outside the tenant-scoped set by construction rather than by an
-- exception somebody has to remember.
--
-- ############################################################################
-- ⚠️ THE CHECKSUM IS THE PART THAT EARNS ITS KEEP
-- ############################################################################
--
-- A file can be EDITED after it has been applied. That happens legitimately —
-- a comment is improved, a typo in a message is fixed — and it happens
-- illegitimately, when somebody changes what a migration does after it has run
-- somewhere. The checksum tells the two apart: the runner warns when a file's
-- content no longer matches what was applied, names the file, and keeps going.
--
-- 🔴 IT WARNS RATHER THAN REFUSING, and that is a deliberate choice. Refusing
-- would mean a corrected comment blocks every future deploy until somebody
-- edits the ledger by hand — which teaches people to edit the ledger by hand,
-- which is the one habit that would make this table worthless.
--
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  -- The number, as an integer, so ordering is arithmetic rather than string
  -- comparison. `0099` before `0100` is wrong under a text sort.
  version         integer PRIMARY KEY,

  -- The file name, exactly as it appears in SQL-FILES/.
  filename        text        NOT NULL,

  -- SHA-256 of the file's bytes at the moment it was applied.
  checksum        text        NOT NULL,

  -- How many statements the splitter found. A file whose statement count
  -- changes has changed structurally, not cosmetically.
  statement_count integer     NOT NULL,

  applied_at      timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ WHO AND WHAT, because "which release was this in" is the question asked
  -- after an incident and it has never had an answer. The runner reads the
  -- version from package.json and the actor from the environment.
  applied_by      text,
  app_version     text,

  -- Wall-clock milliseconds. A migration that took four minutes on production
  -- and eight seconds on staging is worth knowing about before the next one.
  duration_ms     integer
);

COMMENT ON TABLE public.schema_migrations IS
  'Which numbered SQL files this database has applied. Written by scripts/migrate.mjs. '
  'A ledger, deliberately not a lock — see 0120 for why.';

CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx
  ON public.schema_migrations (applied_at DESC);

-- ############################################################################
-- ⚠️ BACKFILL IS NOT ATTEMPTED, AND THAT IS THE HONEST CHOICE
-- ############################################################################
--
-- This table starts EMPTY on a database that already has 119 migrations
-- applied. Inserting 119 rows claiming they were applied would be inventing a
-- record: nobody knows when, by whom, or from which version of each file.
--
-- ⭐ `scripts/migrate.mjs --adopt` is the deliberate act that records the
-- current state, with `applied_by = 'adopted'` so nobody ever mistakes an
-- adopted row for an observed one. Run it once, on each database, at the
-- moment this file is applied.
