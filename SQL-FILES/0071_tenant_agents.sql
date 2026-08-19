-- =====================================================================
--  ORDENCE — 0071 · AGENTS AS TENANT DATA, AND AGENTS THAT FIRE
--  THEMSELVES
--  Version: v1.20.0-alpha
--
--  ⚠️ RUN AFTER 0070. It adds three tables and touches nothing existing.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHY A COMPILED LIST OF AGENTS WAS ALWAYS GOING TO RUN OUT
--  ══════════════════════════════════════════════════════════════════
--  `lib/ai/agents/registry.ts` has held seven agents since v0.76.0.
--  That was correct while there were seven and one person wrote all of
--  them. It stops being correct the moment a customer wants an eighth,
--  because a compiled list changes only by a deploy, and a deploy is
--  something only the vendor can do.
--
--  ⚠️ A CUSTOMER WHO CANNOT CHANGE A PROMPT CANNOT MAKE THE AGENT SOUND
--  LIKE THEIR BUSINESS, and an agent that sounds like somebody else is
--  an agent they stop using in a fortnight.
--
--  ⭐ SO AN AGENT BECOMES A ROW. The compiled catalogue becomes the shelf
--  it is copied from, and each tenant's copy diverges from the vendor's
--  forever. That is the intended outcome rather than drift.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE AGENT
-- =====================================================================
CREATE TABLE IF NOT EXISTS agent_definitions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    --  ⭐ WHERE THIS ONE CAME FROM. Null where the tenant wrote it from
    --  scratch. Kept so "why does this sound like a marketing agency"
    --  has an answer, and so a future catalogue update can tell which
    --  copies have been edited and which are still the vendor's words.
    catalogue_key       varchar(80),

    name                varchar(160) NOT NULL,
    blurb               varchar(400),
    system_prompt       text NOT NULL,

    --  🔴 THE TOOL WHITELIST. Names from `lib/mcp/registry.ts` and
    --  nowhere else.
    --
    --  ⚠️ VALIDATED IN THE APPLICATION RATHER THAN BY A CHECK, because
    --  the registry is TypeScript and the database cannot read it. The
    --  application refuses an unknown tool at write time; this column is
    --  the record of what was allowed, not the arbiter of it.
    tools               text[] NOT NULL DEFAULT '{}',

    --  🔴🔴 THE LANE, AND THE ONE RULE THAT MATTERS MOST IN THIS FILE.
    --
    --  `open`   — drafting only. May go to any free provider, including
    --             the ones whose terms permit training on inputs.
    --  `tenant` — touches real business data. Confidential lane only.
    --
    --  ⚠️ AN AGENT WITH ANY TOOL RETURNS REAL BUSINESS DATA: a customer's
    --  name, an invoice total, a phone number. Routing that to a provider
    --  that trains on what it is sent exports the customer list, quietly,
    --  and nothing anywhere reports it.
    sensitivity         varchar(10) NOT NULL DEFAULT 'open',

    is_enabled          boolean NOT NULL DEFAULT true,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT agent_definitions_lane_known
        CHECK (sensitivity IN ('open', 'tenant')),

    --  🔴🔴 THE LANE RULE, IN THE DATABASE, BECAUSE A COMMENT IS A
    --  PROMISE ABOUT CODE THAT EXISTS TODAY.
    --
    --  ⚠️ The dangerous edit is not the install. It is somebody adding a
    --  tool six months later to an agent that has always been `open`.
    --  Nothing about that edit looks alarming on a screen, and the agent
    --  silently starts sending customer records to a provider chosen for
    --  being fast and free.
    CONSTRAINT agent_definitions_tools_imply_tenant_lane
        CHECK (cardinality(tools) = 0 OR sensitivity = 'tenant'),

    CONSTRAINT agent_definitions_prompt_not_empty
        CHECK (length(btrim(system_prompt)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_definitions_name_unique
    ON agent_definitions (tenant_id, lower(name));

--  ⭐ A TENANT INSTALLS EACH CATALOGUE AGENT ONCE. Installing twice
--  gives two agents with the same prompt and different edits, and the
--  question "which one is live" then has no answer.
CREATE UNIQUE INDEX IF NOT EXISTS agent_definitions_catalogue_once
    ON agent_definitions (tenant_id, catalogue_key)
    WHERE catalogue_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_definitions_enabled_idx
    ON agent_definitions (tenant_id) WHERE is_enabled;

-- =====================================================================
--  ② WHAT MAKES ONE RUN BY ITSELF
-- =====================================================================
--
--  ⭐ THE BINDING BETWEEN A BUSINESS EVENT AND AN AGENT. 0068 built the
--  event queue, v1.19.0 finally wrote to it and drained it into the
--  workflow dispatcher. This is the second consumer of the same queue.
--
--  ⚠️ DELIBERATELY A SEPARATE TABLE RATHER THAN COLUMNS ON THE AGENT.
--  One agent may sensibly answer to three events, and three columns
--  named `trigger_1` through `trigger_3` is the shape you regret.
CREATE TABLE IF NOT EXISTS agent_triggers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id            uuid NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,

    --  Matches `automation_events`. Same four words as 0068.
    trigger_type        varchar(30) NOT NULL,
    record_type         varchar(40) NOT NULL,

    is_enabled          boolean NOT NULL DEFAULT true,

    --  ⭐ HOW MANY TIMES A DAY THIS MAY FIRE, PER TENANT.
    --
    --  🔴 THE COST IS NOT ZERO EVEN ON A FREE PROVIDER. Free tiers have
    --  rate limits, and an agent bound to `record_updated` on a busy
    --  table will exhaust the day's quota before lunch and take every
    --  other agent down with it. A cap per binding is what stops one
    --  careless trigger starving the rest.
    daily_cap           integer NOT NULL DEFAULT 50,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT agent_triggers_type_known CHECK (
        trigger_type IN ('record_created', 'record_updated', 'record_deleted', 'webhook')
    ),
    CONSTRAINT agent_triggers_cap_sane CHECK (daily_cap BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_triggers_unique
    ON agent_triggers (tenant_id, agent_id, trigger_type, record_type);

CREATE INDEX IF NOT EXISTS agent_triggers_lookup_idx
    ON agent_triggers (tenant_id, record_type, trigger_type)
    WHERE is_enabled;

-- =====================================================================
--  ③ WHAT IT ACTUALLY DID
-- =====================================================================
--
--  🔴 EVERY RUN IS RECORDED, INCLUDING THE ONES THAT PRODUCED NOTHING.
--
--  ⚠️ An agent that runs unattended and leaves no trace is a system
--  nobody can be held to. The first question after a strange email goes
--  out is "did something send this", and the only acceptable answer is
--  a row.
CREATE TABLE IF NOT EXISTS agent_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id            uuid NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,

    --  person · event · schedule
    started_by          varchar(20) NOT NULL,
    --  ⚠️ Null on an event run. There is no person standing there, and
    --  writing one in would name somebody for something they did not do.
    user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
    --  The `automation_events` row that caused it, where one did.
    event_id            uuid,

    --  Which provider answered, so a bad batch can be traced to it.
    provider_id         varchar(40),
    sensitivity         varchar(10) NOT NULL,

    --  🔴 THE OUTPUT IS A DRAFT. See ④.
    output              text,
    tokens_used         integer,
    error_message       varchar(500),

    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,

    --  🔴 DPDP: a run's output may quote somebody's data.
    purge_after         date NOT NULL,

    CONSTRAINT agent_runs_started_by_known
        CHECK (started_by IN ('person', 'event', 'schedule')),
    CONSTRAINT agent_runs_person_has_a_name
        CHECK (started_by <> 'person' OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_idx
    ON agent_runs (tenant_id, agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_daily_idx
    ON agent_runs (tenant_id, agent_id, started_at);

CREATE INDEX IF NOT EXISTS agent_runs_purge_idx ON agent_runs (purge_after);

-- =====================================================================
--  ④ 🔴🔴 THE RULE THAT MAKES AUTONOMY SAFE
-- =====================================================================
--
--  AN AGENT THAT RUNS WITHOUT A PERSON PRESENT MAY NOT ALSO ACT WITHOUT
--  ONE.
--
--  ⚠️ THIS IS THE WHOLE DIFFERENCE BETWEEN A USEFUL AUTONOMOUS AGENT AND
--  AN INCIDENT. An agent triggered by `record_created` on a lead, holding
--  a write tool and a WhatsApp template, will message every new lead the
--  moment it arrives, at ₹1 a message, to people who have not consented,
--  from a number that gets banned for it. Every step of that is
--  individually reasonable and the result is a disaster nobody chose.
--
--  ⭐ SO AN EVENT-TRIGGERED RUN PRODUCES TEXT AND NOTHING ELSE. Its
--  output lands in `agent_runs.output` for a person to read, use or
--  discard. Sending remains behind the campaign approval, the consent
--  gate and the daily spend cap that already exist.
--
--  🔴 THE TOOL WHITELIST IS ALREADY READ-ONLY BY DESIGN — the registry
--  header says agents are initialised with `read_only` scope and the
--  vault is absent from every list. This trigger is the second lock, on
--  the row rather than in the code, because the code path that grants
--  scope is not the only one that will ever exist.
CREATE OR REPLACE FUNCTION ordence_guard_agent_autonomy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound integer;
BEGIN
  SELECT count(*) INTO bound
    FROM agent_triggers t
   WHERE t.agent_id = NEW.id AND t.is_enabled;

  IF bound > 0 AND NEW.sensitivity <> 'tenant' AND cardinality(NEW.tools) > 0 THEN
    RAISE EXCEPTION
      'An agent that fires on a business event and reads business data must be on the confidential lane. This one has % tool(s) and is marked %.',
      cardinality(NEW.tools), NEW.sensitivity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_agent_autonomy ON agent_definitions;
CREATE TRIGGER ordence_guard_agent_autonomy
  BEFORE INSERT OR UPDATE ON agent_definitions
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_agent_autonomy();

-- =====================================================================
--  ⑤ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 `app_platform_scope()` BELONGS IN `USING` AND NEVER IN
--  `WITH CHECK`. Support may read a tenant's agents to answer a
--  question. Support writing an agent INTO a tenant is a different thing
--  entirely, and the two are one keyword apart.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_definitions', 'agent_triggers', 'agent_runs'] LOOP
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

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  IT DOES NOT STORE AN API KEY. Provider keys stay where
--  `lib/ai/providers.ts` puts them: environment variables, one per
--  provider, shared by the platform. A per-tenant key would belong in
--  the vault and is a different decision for a different day.
--
--  IT DOES NOT LET AN AGENT SEND ANYTHING. There is no channel column
--  and no recipient column, on purpose. An agent writes text. A person,
--  or the campaign machinery with its approval and its spend cap, sends.
--
--  IT DOES NOT COPY THE CATALOGUE INTO EVERY TENANT AT MIGRATION TIME.
--  Twenty rows per tenant that nobody asked for is twenty rows nobody
--  reads, and a tenant who deletes one would find it back after the next
--  deploy. Installing is a decision somebody makes on a screen.
-- =====================================================================
