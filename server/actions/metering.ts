"use server";

/**
 * Ordence — ⭐ ENGINE 5 · UTILITY METERING ACTIONS
 * Version: v0.70.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else — a constant, a Zod schema, a type guard — publishes it as
 * an RPC endpoint reachable by anyone on the internet. Every helper and
 * every schema below is deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS FILE NEVER COMPUTES CONSUMPTION
 * ══════════════════════════════════════════════════════════════════════
 * `consumption`, `previous_value`, `previous_reading_id`, `is_rollover`,
 * `is_anomaly` and `anomaly_note` are derived by
 * `meter_reading_derive()` in SQL-FILES/0035 and are never sent from
 * here. Not "not usually" — never.
 *
 * The reason is not tidiness. A reading can arrive three days late from a
 * field agent's phone, out of order against a smart-meter backfill, and
 * the trigger re-chains the row after it (`meter_reading_repair_successor`).
 * TypeScript arithmetic done at submit time is arithmetic done against
 * whatever the chain looked like at that instant, and it does not get
 * revisited when a backdated reading lands underneath it. Two months of
 * consumption that do not sum to the meter's own movement is a discrepancy
 * the CUSTOMER finds, in a dispute, holding an invoice.
 *
 * `consumptionBetween()` in db/schema/utility-meters.ts exists for a live
 * preview in the form — showing an operator roughly what they are about to
 * record. It is a courtesy. The trigger is the authority.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A READING IS AN ODOMETER — AND THERE IS NO EDIT, AND NO DELETE
 * ══════════════════════════════════════════════════════════════════════
 * `meter_reading_guard_immutable()` refuses any change to
 * `reading_value`, `read_at` or `meter_id`, and the app role holds no
 * DELETE privilege on `meter_readings` at all (section 10 of 0035 REVOKEs
 * it explicitly). So this file offers no `deleteMeterReading`, and
 * `supersedeMeterReading` is the correction path: the wrong row is marked
 * `superseded` and a new one is recorded beside it.
 *
 * ⚠️ THAT IS NOT BUREAUCRACY. Deleting a reading silently re-chains
 * everything after it — the next reading's baseline jumps back to the row
 * before the deleted one, that period's consumption doubles, and the
 * invoice already in the customer's hands no longer matches anything in
 * the database. Editing the value in place is worse: last month's bill was
 * computed from a figure that now exists nowhere, and the customer's PDF
 * becomes the only surviving record of what the system actually did.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ANOMALIES ARE FLAGGED, NEVER REJECTED
 * ══════════════════════════════════════════════════════════════════════
 * Nothing here refuses a reading for being 4× the meter's average. A 4×
 * jump is theft, a stuck dial, or a transposed digit — and it is also a
 * family that bought an air conditioner in April. Refusing it makes an
 * honest bill impossible and pushes the reading into a notebook; not
 * noticing it at all is how tampering runs for two years. It is recorded,
 * flagged, and put in front of a person.
 *
 * ⚠️ AND `anomaly_note` IS SURFACED VERBATIM. The trigger writes it for a
 * human — "treated as a dial rollover, but the resulting consumption is
 * far above this meter's recent average" — and paraphrasing it on the way
 * out throws away the only part that says what to do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY LEAVES THIS FILE AS A STRING. SO DO THE UNITS.
 * ══════════════════════════════════════════════════════════════════════
 * `energy_charge_minor` and friends are `bigint` paise. `JSON.stringify`
 * throws on a bigint and a server action's return value is serialised, so
 * one un-stringified bigint anywhere in a payload takes down the entire
 * page with "Do not know how to serialize a BigInt", nowhere near the
 * column that caused it.
 *
 * ⚠️ AND `numeric` COLUMNS COME BACK FROM DRIZZLE AS STRINGS. They are
 * kept as strings the whole way. `numeric(18,4)` rounded through a
 * JavaScript float loses precision at the fourth decimal — on a meter
 * reading, which is the one number in this engine that is evidence.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  utilityMeters,
  meterReadings,
  meterBillingPeriods,
} from "@/db/schema/utility-meters";
import { contacts } from "@/db/schema/crm";
import { rateCards } from "@/db/schema/pricing";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/** ⚠️ Exactly this string. It is the key in lib/modules/registry.ts. */
const FEATURE = "metering.readings" as const;

const READ_PERMISSION = "metering.readings.read";
const WRITE_PERMISSION = "metering.readings.manage";

/**
 * ⭐ How long a meter may go unread before it is on the stale list.
 *
 * ⚠️ 45 DAYS, NOT 30. A monthly cycle that slips a week is normal
 * operations; flagging it teaches the reader to ignore the list, and a
 * list that is ignored does not surface the meter nobody has visited
 * since March. 45 says "this one missed a cycle", which is actionable.
 */
const STALE_DAYS = 45;

/**
 * ⭐ How many consecutive estimates make a run worth interrupting.
 *
 * ⚠️ AN ESTIMATE IS A DEBT THE SYSTEM OWES ITSELF. One estimate is a
 * locked gate; the next actual reading reconciles it and nobody notices.
 * Three in a row is a meter nobody has physically seen in a quarter, and
 * the reconciliation when it finally happens arrives as one enormous
 * correct bill after a year of small wrong ones — which is the bill that
 * ends up in front of a regulator.
 */
const ESTIMATE_RUN_ALARM = 3;

/* ------------------------------------------------------------------ */
/* SHAPES — every numeric and every bigint is a string. See the header. */
/* ------------------------------------------------------------------ */

export type MeterRow = {
  id: string;
  serialNumber: string;
  kind: string;
  status: string;

  consumerContactId: string | null;
  consumerName: string | null;

  location: string | null;
  connectionRef: string | null;

  /** ⭐ What makes rollover survivable. 3–12, enforced by CHECK. */
  digitCount: number;
  /** `numeric(12,4)` — a string. Usually "1.0000". */
  multiplier: string;
  unit: string;

  rateCardId: string | null;
  rateCardName: string | null;

  installedOn: string | null;
  /** `numeric(18,4)` — a string. Consumption never counts below this. */
  initialReading: string;

  replacesMeterId: string | null;
  replacesSerialNumber: string | null;
  replacedOn: string | null;

  isNetMetered: boolean;
  sanctionedLoadKw: string | null;

  /* ---- From `v_meter_status`. Not recomputed here. --------------- */

  lastReadAt: string | null;
  lastReadingValue: string | null;
  lastConsumption: string | null;
  lastSource: string | null;
  /** ⭐ The latest reading carried a flag. The register leads with these. */
  lastWasAnomaly: boolean;
  /** `null` when the meter has never been read at all. */
  daysSinceRead: number | null;
  openAnomalies: number;

  /* ---- From `v_meter_estimates_outstanding`. --------------------- */

  /** Consecutive estimates with no actual reading after them. */
  consecutiveEstimates: number;
  estimatingSince: string | null;
  estimatedUnits: string | null;

  /** `days_since_read` past the threshold, or never read at all. */
  isStale: boolean;
};

export type MeterReadingRow = {
  id: string;
  meterId: string;
  meterSerialNumber: string;
  meterUnit: string;
  meterDigitCount: number;

  readAt: string;
  /** ⭐ What the DIAL said. Cumulative. Never a consumption figure. */
  readingValue: string;

  source: string;
  status: string;

  previousReadingId: string | null;
  previousValue: string | null;
  /** ⭐ Derived by trigger. `null` on a row the trigger has not seen. */
  consumption: string | null;

  isRollover: boolean;
  isAnomaly: boolean;
  /** ⚠️ Written for a human by the trigger. Shown verbatim. */
  anomalyNote: string | null;

  documentId: string | null;
  readByUserId: string | null;
  readByName: string | null;
  notes: string | null;
  createdAt: string;
};

export type MeterPeriodRow = {
  id: string;
  meterId: string;
  meterSerialNumber: string;
  periodStart: string;
  periodEnd: string;
  label: string;

  openingReadingId: string | null;
  closingReadingId: string | null;

  unitsConsumed: string;
  unitsExported: string;
  /** ⭐ Carried forward, never netted away inside the month. */
  unitsBankedOpening: string;
  unitsBankedClosing: string;

  rateCardId: string | null;

  energyChargeMinor: string;
  fixedChargeMinor: string;
  dutyMinor: string;
  exportCreditMinor: string;
  totalMinor: string;

  isFinalised: boolean;
  finalisedAt: string | null;
};

export type MeterOption = {
  id: string;
  serialNumber: string;
  kind: string;
  status: string;
  unit: string;
  digitCount: number;
  multiplier: string;
  /** The dial value of the most recent non-rejected reading, for a preview. */
  lastReadingValue: string | null;
  lastReadAt: string | null;
  /** ⚠️ `removed` and `disconnected` meters cannot take readings. */
  acceptsReadings: boolean;
};

export type MeterContactOption = { id: string; name: string };
export type MeterRateCardOption = { id: string; name: string; code: string };

export type MeterCounters = {
  total: number;
  active: number;
  /** Meters whose LATEST reading is flagged. */
  withOpenAnomalies: number;
  /** Never read, or not read in STALE_DAYS. */
  stale: number;
  /** Meters on a run of ESTIMATE_RUN_ALARM estimates or more. */
  onEstimateRuns: number;
  neverRead: number;
  netMetered: number;
  /** Units currently sitting in the export bank across open periods. */
  bankedUnits: string;
};

export type ReadingCounters = {
  total: number;
  anomalies: number;
  rollovers: number;
  estimated: number;
  superseded: number;
  disputed: number;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

/**
 * ⚠️ A `numeric` ARRIVES AS A STRING AND LEAVES AS ONE. No `Number()` on
 * the way through: `numeric(18,4)` has more significant digits than a
 * double can hold, and the column this matters most on is the dial value
 * a dispute is settled with.
 */
function num(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/** A `bigint` of paise, stringified before it can reach JSON.stringify. */
function minor(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "0";
  return String(v);
}

function personName(
  first: string | null,
  last: string | null,
  email: string | null,
): string {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || email || "Unknown user";
}

function contactName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim() || "Unnamed consumer";
}

/** The driver hands back either an array or `{ rows }`. Normalise. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * ⭐ TURN THE DATABASE'S REFUSAL INTO A SENTENCE SOMEBODY CAN ACT ON.
 *
 * ⚠️ THESE ARRIVE AS SQLSTATE P0001 — `RAISE EXCEPTION` — so
 * `toSalesActionError` does not recognise them as constraint violations
 * and would flatten every one into "something went wrong". They are
 * matched here, ahead of it.
 *
 * ⚠️ AND THE IMMUTABILITY MESSAGES ARE THE POINT OF THE WHOLE FEATURE.
 * "A meter reading's value cannot be edited — mark this reading
 * 'superseded' and record a new one" tells an operator exactly what to do
 * next. "Could not save" sends them to a database client, or to a
 * spreadsheet, and the spreadsheet becomes the real system.
 */
function explainMeterError(err: unknown): string | null {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const constraint =
    err && typeof err === "object" && "constraint" in err
      ? String((err as { constraint: unknown }).constraint)
      : "";

  /* --- Immutability. Already written for a person, verbatim. ------- */
  if (/cannot be edited/.test(message)) return message;
  if (/cannot be moved to a different meter/.test(message)) return message;

  /* --- The derivation trigger's own refusals. ---------------------- */
  if (/does not exist in this workspace/.test(message)) return message;
  if (/cannot take new readings/.test(message)) return message;

  /* --- Period freeze and close. ------------------------------------ */
  if (/is finalised and its figures cannot be changed/.test(message)) return message;
  if (/is already finalised/.test(message)) return message;

  /* --- Row-level CHECKs, which arrive as 23514 with a constraint. --- */
  if (constraint.includes("meter_readings_value_non_negative")) {
    return (
      "A meter reading cannot be negative. The field wants what the DIAL " +
      "said — the cumulative total on the face of the meter — not the units " +
      "consumed since last time. Consumption is worked out from the two " +
      "readings and is never typed in."
    );
  }
  if (constraint.includes("utility_meters_digits_sane")) {
    return (
      "A meter has between 3 and 12 digits on its dial. The digit count is " +
      "what makes a rollover survivable: a 5-digit meter passing 99999 and " +
      "showing 00042 consumed 43 units, and without the right count that " +
      "same reading becomes minus 99,957 — a credit note for roughly a year " +
      "of free supply, issued automatically."
    );
  }
  if (constraint.includes("utility_meters_no_self_replace")) {
    return (
      "A meter cannot replace itself. A replacement is a different physical " +
      "device with its own dial, so it gets its own row; pointing a meter at " +
      "itself makes a loop that any history walk follows forever."
    );
  }
  if (constraint.includes("meter_billing_periods_ordered")) {
    return "The billing period ends before it starts.";
  }

  /* --- Uniqueness. -------------------------------------------------- */
  if (code === "23505" && constraint.includes("utility_meters_serial_key")) {
    return (
      "A meter with that serial number already exists in this workspace. The " +
      "serial is what is printed on the device and what a reader matches " +
      "against when they are standing in front of it, so two cannot share one."
    );
  }
  if (code === "23505" && constraint.includes("meter_readings_meter_instant_key")) {
    return (
      "This meter already has a reading at that exact instant. A double-" +
      "submitted form would otherwise create a second reading of zero " +
      "consumption, which silently resets the baseline for every period after " +
      "it. If this is a genuine second reading, move it by a minute."
    );
  }
  if (code === "23505" && constraint.includes("meter_billing_periods_meter_period_key")) {
    return (
      "This meter already has a billing period starting on that date. Two " +
      "periods over the same days would bill the same units twice."
    );
  }

  /* --- No DELETE privilege on readings, by design. ------------------ */
  if (code === "42501" && /meter_readings/.test(message)) {
    return (
      "Readings cannot be deleted, and the application role holds no " +
      "privilege to do it. Deleting one re-chains everything after it: the " +
      "next reading's baseline jumps back past the gap, that period's " +
      "consumption doubles, and the invoice already with the customer stops " +
      "matching anything here. Mark it superseded and record a new one."
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* READ — THE REGISTER                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE METER REGISTER, LED BY THE THREE THINGS A LIST CANNOT SAY.
 *
 * ⚠️ STALENESS AND ANOMALY COUNTS COME FROM `v_meter_status`, NOT FROM
 * ARITHMETIC HERE. "Days since read" is one line of SQL and exactly the
 * kind of one line that drifts — it is measured against the latest
 * NON-REJECTED reading, which is not the same as the latest row, and a
 * screen that disagrees with the view about which meters are overdue is a
 * screen the reading round stops being planned from.
 *
 * ⚠️ AND THE ESTIMATE RUNS COME FROM `v_meter_estimates_outstanding`,
 * which already encodes the hard half of the question: an estimate only
 * counts as outstanding while no ACTUAL reading has landed after it. A
 * naive count of estimated readings would keep flagging a meter that was
 * reconciled six months ago.
 *
 * Both views are `security_invoker`, so RLS applies exactly as it does to
 * the tables. The tenant predicate below is belt as well as braces, and
 * costs nothing.
 */
export async function listMeters(params?: {
  /** Filter to one meter kind, e.g. "solar_generation". */
  kind?: string;
}): Promise<
  ActionResult<{
    meters: MeterRow[];
    /** ⭐ Latest reading carries a flag. Read these before billing. */
    withAnomalies: MeterRow[];
    /** ⭐ Nobody has been. The reading round is planned from this list. */
    stale: MeterRow[];
    /** ⭐ A run of estimates — a debt the system owes itself. */
    onEstimateRuns: MeterRow[];
    periods: MeterPeriodRow[];
    consumers: MeterContactOption[];
    rateCardOptions: MeterRateCardOption[];
    meterOptions: MeterOption[];
    kinds: string[];
    counters: MeterCounters;
    staleDays: number;
    estimateRunAlarm: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ_PERMISSION);
    const kindFilter = params?.kind?.trim() || null;

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      /**
       * ⚠️ `replacesMeterId` IS SELF-JOINED, and LEFT. Most meters
       * replace nothing; an INNER join here would hide the entire
       * register behind the handful that do.
       */
      const predecessor = sql<string | null>`(
        SELECT p.serial_number FROM utility_meters p
         WHERE p.id = ${utilityMeters.replacesMeterId}
           AND p.tenant_id = ${utilityMeters.tenantId}
      )`.as("predecessor_serial");

      const meters = await tx
        .select({
          id: utilityMeters.id,
          serialNumber: utilityMeters.serialNumber,
          kind: utilityMeters.kind,
          status: utilityMeters.status,
          consumerContactId: utilityMeters.consumerContactId,
          location: utilityMeters.location,
          connectionRef: utilityMeters.connectionRef,
          digitCount: utilityMeters.digitCount,
          multiplier: utilityMeters.multiplier,
          unit: utilityMeters.unit,
          rateCardId: utilityMeters.rateCardId,
          installedOn: utilityMeters.installedOn,
          initialReading: utilityMeters.initialReading,
          replacesMeterId: utilityMeters.replacesMeterId,
          replacedOn: utilityMeters.replacedOn,
          isNetMetered: utilityMeters.isNetMetered,
          sanctionedLoadKw: utilityMeters.sanctionedLoadKw,
          consumerFirstName: contacts.firstName,
          consumerLastName: contacts.lastName,
          rateCardName: rateCards.name,
          predecessorSerial: predecessor,
        })
        .from(utilityMeters)
        // ⚠️ LEFT on both. A meter with no consumer yet (a feeder, a
        // common-area sub-meter) and a meter with no rate card (metered
        // for record, billed elsewhere) are both ordinary.
        .leftJoin(
          contacts,
          and(
            eq(contacts.id, utilityMeters.consumerContactId),
            eq(contacts.tenantId, utilityMeters.tenantId),
          ),
        )
        .leftJoin(
          rateCards,
          and(
            eq(rateCards.id, utilityMeters.rateCardId),
            eq(rateCards.tenantId, utilityMeters.tenantId),
          ),
        )
        .where(
          and(
            eq(utilityMeters.tenantId, ctx.tenant.id),
            sql`${utilityMeters.deletedAt} IS NULL`,
            kindFilter ? sql`${utilityMeters.kind} = ${kindFilter}` : undefined,
          ),
        )
        .orderBy(asc(utilityMeters.serialNumber))
        .limit(1000);

      const status = rowsOf(
        await tx.execute(sql`
          SELECT meter_id, last_read_at, last_reading_value, last_consumption,
                 last_source, last_was_anomaly, days_since_read, open_anomalies
            FROM v_meter_status
           WHERE tenant_id = ${ctx.tenant.id}::uuid
        `),
      );

      const estimates = rowsOf(
        await tx.execute(sql`
          SELECT meter_id, consecutive_estimates, estimating_since, estimated_units
            FROM v_meter_estimates_outstanding
           WHERE tenant_id = ${ctx.tenant.id}::uuid
        `),
      );

      const periods = await tx
        .select({
          id: meterBillingPeriods.id,
          meterId: meterBillingPeriods.meterId,
          periodStart: meterBillingPeriods.periodStart,
          periodEnd: meterBillingPeriods.periodEnd,
          label: meterBillingPeriods.label,
          openingReadingId: meterBillingPeriods.openingReadingId,
          closingReadingId: meterBillingPeriods.closingReadingId,
          unitsConsumed: meterBillingPeriods.unitsConsumed,
          unitsExported: meterBillingPeriods.unitsExported,
          unitsBankedOpening: meterBillingPeriods.unitsBankedOpening,
          unitsBankedClosing: meterBillingPeriods.unitsBankedClosing,
          rateCardId: meterBillingPeriods.rateCardId,
          energyChargeMinor: meterBillingPeriods.energyChargeMinor,
          fixedChargeMinor: meterBillingPeriods.fixedChargeMinor,
          dutyMinor: meterBillingPeriods.dutyMinor,
          exportCreditMinor: meterBillingPeriods.exportCreditMinor,
          totalMinor: meterBillingPeriods.totalMinor,
          isFinalised: meterBillingPeriods.isFinalised,
          finalisedAt: meterBillingPeriods.finalisedAt,
          meterSerialNumber: utilityMeters.serialNumber,
        })
        .from(meterBillingPeriods)
        .innerJoin(
          utilityMeters,
          and(
            eq(utilityMeters.id, meterBillingPeriods.meterId),
            eq(utilityMeters.tenantId, meterBillingPeriods.tenantId),
          ),
        )
        .where(eq(meterBillingPeriods.tenantId, ctx.tenant.id))
        .orderBy(desc(meterBillingPeriods.periodStart))
        .limit(500);

      const consumerRows = await tx
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenant.id),
            sql`${contacts.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(contacts.lastName), asc(contacts.firstName))
        .limit(500);

      const rateCardRows = await tx
        .select({ id: rateCards.id, name: rateCards.name, code: rateCards.code })
        .from(rateCards)
        .where(
          and(
            eq(rateCards.tenantId, ctx.tenant.id),
            sql`${rateCards.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(rateCards.name))
        .limit(500);

      return { meters, status, estimates, periods, consumerRows, rateCardRows };
    });

    const statusByMeter = new Map(
      payload.status.map((s) => [String(s.meter_id), s]),
    );
    const estimatesByMeter = new Map(
      payload.estimates.map((e) => [String(e.meter_id), e]),
    );

    const meterRows: MeterRow[] = payload.meters.map((m) => {
      const s = statusByMeter.get(m.id);
      const e = estimatesByMeter.get(m.id);

      const daysSinceRead =
        s?.days_since_read === null || s?.days_since_read === undefined
          ? null
          : Number(s.days_since_read);

      return {
        id: m.id,
        serialNumber: m.serialNumber,
        kind: m.kind,
        status: m.status,
        consumerContactId: m.consumerContactId,
        consumerName: m.consumerContactId
          ? contactName(m.consumerFirstName, m.consumerLastName)
          : null,
        location: m.location,
        connectionRef: m.connectionRef,
        digitCount: m.digitCount,
        multiplier: String(m.multiplier),
        unit: m.unit,
        rateCardId: m.rateCardId,
        rateCardName: m.rateCardName,
        installedOn: m.installedOn,
        initialReading: String(m.initialReading),
        replacesMeterId: m.replacesMeterId,
        replacesSerialNumber: m.predecessorSerial,
        replacedOn: m.replacedOn,
        isNetMetered: m.isNetMetered,
        sanctionedLoadKw: num(m.sanctionedLoadKw),

        lastReadAt: iso(s?.last_read_at as string | null | undefined),
        lastReadingValue: num(s?.last_reading_value as string | null | undefined),
        lastConsumption: num(s?.last_consumption as string | null | undefined),
        lastSource: s?.last_source ? String(s.last_source) : null,
        lastWasAnomaly: s?.last_was_anomaly === true,
        daysSinceRead,
        openAnomalies: Number(s?.open_anomalies ?? 0),

        consecutiveEstimates: Number(e?.consecutive_estimates ?? 0),
        estimatingSince: iso(e?.estimating_since as string | null | undefined),
        estimatedUnits: num(e?.estimated_units as string | null | undefined),

        /**
         * ⚠️ NEVER READ COUNTS AS STALE. `days_since_read` is `null` for a
         * meter with no readings at all, and `null > 45` is false — so a
         * meter installed in March and never visited would be the one
         * meter missing from the list of meters nobody has visited.
         */
        isStale:
          m.status === "active" &&
          (daysSinceRead === null || daysSinceRead >= STALE_DAYS),
      };
    });

    const periodRows: MeterPeriodRow[] = payload.periods.map((p) => ({
      id: p.id,
      meterId: p.meterId,
      meterSerialNumber: p.meterSerialNumber,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      label: p.label,
      openingReadingId: p.openingReadingId,
      closingReadingId: p.closingReadingId,
      unitsConsumed: String(p.unitsConsumed),
      unitsExported: String(p.unitsExported),
      unitsBankedOpening: String(p.unitsBankedOpening),
      unitsBankedClosing: String(p.unitsBankedClosing),
      rateCardId: p.rateCardId,
      energyChargeMinor: minor(p.energyChargeMinor),
      fixedChargeMinor: minor(p.fixedChargeMinor),
      dutyMinor: minor(p.dutyMinor),
      exportCreditMinor: minor(p.exportCreditMinor),
      totalMinor: minor(p.totalMinor),
      isFinalised: p.isFinalised,
      finalisedAt: iso(p.finalisedAt),
    }));

    const withAnomalies = meterRows
      .filter((m) => m.lastWasAnomaly || m.openAnomalies > 0)
      .sort((a, b) => b.openAnomalies - a.openAnomalies);

    const stale = meterRows
      .filter((m) => m.isStale)
      // ⚠️ Never-read first. `null` sorts ahead of every number here on
      // purpose: a meter with no reading at all is worse than one 90 days
      // old, because there is not even a baseline to estimate from.
      .sort((a, b) => (b.daysSinceRead ?? 1e9) - (a.daysSinceRead ?? 1e9));

    const onEstimateRuns = meterRows
      .filter((m) => m.consecutiveEstimates >= ESTIMATE_RUN_ALARM)
      .sort((a, b) => b.consecutiveEstimates - a.consecutiveEstimates);

    const meterOptions: MeterOption[] = meterRows.map((m) => ({
      id: m.id,
      serialNumber: m.serialNumber,
      kind: m.kind,
      status: m.status,
      unit: m.unit,
      digitCount: m.digitCount,
      multiplier: m.multiplier,
      lastReadingValue: m.lastReadingValue,
      lastReadAt: m.lastReadAt,
      /**
       * ⚠️ MIRRORS THE TRIGGER, WHICH IS STILL THE AUTHORITY.
       * `meter_reading_derive()` refuses a reading on a removed or
       * disconnected meter. Not offering it in the picker saves a round
       * trip; the refusal underneath is what makes it true.
       */
      acceptsReadings: m.status !== "removed" && m.status !== "disconnected",
    }));

    /**
     * ⭐ The bank, summed across the latest OPEN period per meter.
     *
     * ⚠️ NOT ACROSS EVERY PERIOD. The bank is a running balance carried
     * from one period to the next — `units_banked_closing` opens the
     * following period — so adding up every row counts the same units
     * once per month they survived, which on an eighteen-month history
     * inflates the figure by an order of magnitude.
     */
    const latestOpenByMeter = new Map<string, MeterPeriodRow>();
    for (const p of periodRows) {
      const held = latestOpenByMeter.get(p.meterId);
      if (!held || p.periodStart > held.periodStart) latestOpenByMeter.set(p.meterId, p);
    }
    let banked = 0;
    for (const p of latestOpenByMeter.values()) banked += Number(p.unitsBankedClosing);

    return {
      ok: true,
      data: {
        meters: meterRows,
        withAnomalies,
        stale,
        onEstimateRuns,
        periods: periodRows,
        consumers: payload.consumerRows.map((c) => ({
          id: c.id,
          name: contactName(c.firstName, c.lastName),
        })),
        rateCardOptions: payload.rateCardRows.map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code,
        })),
        meterOptions,
        kinds: [...new Set(meterRows.map((m) => m.kind))].sort(),
        counters: {
          total: meterRows.length,
          active: meterRows.filter((m) => m.status === "active").length,
          withOpenAnomalies: withAnomalies.length,
          stale: stale.length,
          onEstimateRuns: onEstimateRuns.length,
          neverRead: meterRows.filter((m) => m.lastReadAt === null).length,
          netMetered: meterRows.filter((m) => m.isNetMetered).length,
          bankedUnits: banked.toFixed(4),
        },
        staleDays: STALE_DAYS,
        estimateRunAlarm: ESTIMATE_RUN_ALARM,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The meter register could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* READ — READINGS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ READING HISTORY, NEWEST FIRST, WITH EVERY DERIVED FIGURE INTACT.
 *
 * ⚠️ ORDERED BY `read_at`, NOT BY `created_at`. A field agent's phone
 * syncs three days late and a smart-meter backfill lands after a manual
 * entry; ordering by arrival puts a meter's history in upload order,
 * which is not a property of the meter at all. It is also the order the
 * trigger chains consumption in, so any other order on screen would show
 * a `previous_value` that does not match the row above it.
 *
 * ⚠️ REJECTED AND SUPERSEDED ROWS ARE RETURNED. They are excluded from
 * the arithmetic by the trigger and by `ordence_close_meter_period`, but
 * hiding them from the screen is how a superseding correction looks like
 * an unexplained edit six months later. The status is on the row; the
 * reader can see what happened.
 */
export async function listMeterReadings(params?: {
  /** Narrow to one meter's history. */
  meterId?: string;
  /** How many rows. The default is a page, not a year. */
  limit?: number;
}): Promise<
  ActionResult<{
    readings: MeterReadingRow[];
    /** ⭐ Flagged, never rejected. The screen leads with these. */
    anomalies: MeterReadingRow[];
    /** Drops the trigger treated as a dial wrap. */
    rollovers: MeterReadingRow[];
    meters: MeterOption[];
    counters: ReadingCounters;
  }>
> {
  try {
    const ctx = await requirePermission(READ_PERMISSION);

    const parsed = z
      .object({
        meterId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
      })
      .safeParse(params ?? {});
    const meterFilter = parsed.success ? (parsed.data.meterId ?? null) : null;
    const limit = (parsed.success ? parsed.data.limit : undefined) ?? 500;

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const readings = await tx
        .select({
          id: meterReadings.id,
          meterId: meterReadings.meterId,
          readAt: meterReadings.readAt,
          readingValue: meterReadings.readingValue,
          source: meterReadings.source,
          status: meterReadings.status,
          previousReadingId: meterReadings.previousReadingId,
          previousValue: meterReadings.previousValue,
          consumption: meterReadings.consumption,
          isRollover: meterReadings.isRollover,
          isAnomaly: meterReadings.isAnomaly,
          anomalyNote: meterReadings.anomalyNote,
          documentId: meterReadings.documentId,
          readByUserId: meterReadings.readByUserId,
          notes: meterReadings.notes,
          createdAt: meterReadings.createdAt,
          meterSerialNumber: utilityMeters.serialNumber,
          meterUnit: utilityMeters.unit,
          meterDigitCount: utilityMeters.digitCount,
          readerFirstName: users.firstName,
          readerLastName: users.lastName,
          readerEmail: users.email,
        })
        .from(meterReadings)
        .innerJoin(
          utilityMeters,
          and(
            eq(utilityMeters.id, meterReadings.meterId),
            eq(utilityMeters.tenantId, meterReadings.tenantId),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, meterReadings.readByUserId),
            eq(users.tenantId, meterReadings.tenantId),
          ),
        )
        .where(
          and(
            eq(meterReadings.tenantId, ctx.tenant.id),
            sql`${utilityMeters.deletedAt} IS NULL`,
            meterFilter ? eq(meterReadings.meterId, meterFilter) : undefined,
          ),
        )
        .orderBy(desc(meterReadings.readAt), desc(meterReadings.createdAt))
        .limit(limit);

      const status = rowsOf(
        await tx.execute(sql`
          SELECT meter_id, last_read_at, last_reading_value
            FROM v_meter_status
           WHERE tenant_id = ${ctx.tenant.id}::uuid
        `),
      );

      const meters = await tx
        .select({
          id: utilityMeters.id,
          serialNumber: utilityMeters.serialNumber,
          kind: utilityMeters.kind,
          status: utilityMeters.status,
          unit: utilityMeters.unit,
          digitCount: utilityMeters.digitCount,
          multiplier: utilityMeters.multiplier,
        })
        .from(utilityMeters)
        .where(
          and(
            eq(utilityMeters.tenantId, ctx.tenant.id),
            sql`${utilityMeters.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(utilityMeters.serialNumber))
        .limit(1000);

      return { readings, meters, status };
    });

    const rows: MeterReadingRow[] = payload.readings.map((r) => ({
      id: r.id,
      meterId: r.meterId,
      meterSerialNumber: r.meterSerialNumber,
      meterUnit: r.meterUnit,
      meterDigitCount: r.meterDigitCount,
      readAt: iso(r.readAt) ?? "",
      readingValue: String(r.readingValue),
      source: r.source,
      status: r.status,
      previousReadingId: r.previousReadingId,
      previousValue: num(r.previousValue),
      consumption: num(r.consumption),
      isRollover: r.isRollover,
      isAnomaly: r.isAnomaly,
      anomalyNote: r.anomalyNote,
      documentId: r.documentId,
      readByUserId: r.readByUserId,
      readByName: r.readByUserId
        ? personName(r.readerFirstName, r.readerLastName, r.readerEmail)
        : null,
      notes: r.notes,
      createdAt: iso(r.createdAt) ?? "",
    }));

    const statusByMeter = new Map(payload.status.map((s) => [String(s.meter_id), s]));

    const meterOptions: MeterOption[] = payload.meters.map((m) => {
      const s = statusByMeter.get(m.id);
      return {
        id: m.id,
        serialNumber: m.serialNumber,
        kind: m.kind,
        status: m.status,
        unit: m.unit,
        digitCount: m.digitCount,
        multiplier: String(m.multiplier),
        lastReadingValue: num(s?.last_reading_value as string | null | undefined),
        lastReadAt: iso(s?.last_read_at as string | null | undefined),
        acceptsReadings: m.status !== "removed" && m.status !== "disconnected",
      };
    });

    /**
     * ⚠️ `rejected` ROWS ARE OUT OF THE ANOMALY LIST. The trigger already
     * ignores them when chaining, so an anomaly on a rejected row is an
     * observation about a number nothing downstream uses — and leaving it
     * on the alarm panel is how an alarm panel stops being read.
     */
    const anomalies = rows.filter((r) => r.isAnomaly && r.status !== "rejected");
    const rollovers = rows.filter((r) => r.isRollover);

    return {
      ok: true,
      data: {
        readings: rows,
        anomalies,
        rollovers,
        meters: meterOptions,
        counters: {
          total: rows.length,
          anomalies: anomalies.length,
          rollovers: rollovers.length,
          estimated: rows.filter((r) => r.source === "estimated").length,
          superseded: rows.filter((r) => r.status === "superseded").length,
          disputed: rows.filter((r) => r.status === "disputed").length,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The reading history could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* SHARED SHAPES — not exported. See the header.                       */
/* ------------------------------------------------------------------ */

const optionalUuid = z
  .union([z.string().uuid("That is not a valid reference."), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

/**
 * ⭐ A DIAL VALUE, AS TYPED, AS A STRING.
 *
 * ⚠️ NEVER `z.coerce.number()`. `numeric(18,4)` holds more significant
 * digits than a double, and this is the column a billing dispute is
 * settled with — a value that quietly changes in the seventh digit
 * between the form and the database is a value nobody can defend. The
 * string goes to Postgres and Postgres does the parsing.
 */
const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,14}(\.\d{1,4})?$/, label);

const optionalDecimal = (label: string) =>
  z
    .union([decimalString(label), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

/** A whole number of paise, as typed. Kept a string until the last moment. */
const paise = z
  .string()
  .trim()
  .regex(/^-?\d{1,18}$/, "Enter a whole amount in paise, digits only.");

const optionalPaise = z
  .union([paise, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

/** `date` columns come back from Drizzle as `YYYY-MM-DD` strings. */
const optionalDay = z
  .union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-08-04."),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .transform((v) => (v ? v : null));

const requiredMoment = z
  .string()
  .trim()
  .min(1, "When was the meter read?")
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), {
    message: "That is not a date and time this system can read.",
  });

/* ------------------------------------------------------------------ */
/* WRITE — METERS                                                      */
/* ------------------------------------------------------------------ */

const meterSchema = z.object({
  id: z.string().uuid().optional(),

  /** ⚠️ NOT NULL and unique per tenant. It is what is printed on the device. */
  serialNumber: z
    .string()
    .trim()
    .min(1, "Give the serial number printed on the meter.")
    .max(120),

  kind: z.enum([
    "electricity_import",
    "electricity_export",
    "electricity_net",
    "solar_generation",
    "water",
    "gas",
    "fuel",
    "sub_meter",
  ]),

  status: z
    .enum([
      "pending_installation",
      "active",
      "faulty",
      "replaced",
      "disconnected",
      "removed",
    ])
    .default("active"),

  consumerContactId: optionalUuid,
  location: optionalText(300),

  /**
   * ⭐ THE PAIRING KEY FOR NET METERING.
   *
   * ⚠️ `ordence_close_meter_period` pairs an import meter with its export
   * meter on `connection_ref`, NOT on the consumer. One consumer can hold
   * several connections, and crediting a rooftop's generation against a
   * different premises' consumption is a real and expensive mistake. A
   * net-metered meter with no connection ref banks nothing at all, because
   * the function refuses to guess.
   */
  connectionRef: optionalText(120),

  /**
   * ⚠️ NOT NULL, defaults to 6, and CHECKed between 3 and 12. Getting it
   * wrong is not a cosmetic error — see `explainMeterError`.
   */
  digitCount: z.coerce
    .number()
    .int()
    .min(3, "A meter dial has at least 3 digits.")
    .max(12, "A meter dial has at most 12 digits.")
    .default(6),

  /** NOT NULL, defaults to "1". Meters that read in thousands need this. */
  multiplier: z
    .union([decimalString("Use a number like 1 or 40.0000."), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : "1")),

  /** NOT NULL, defaults to kWh. */
  unit: z
    .union([z.string().trim().min(1).max(20), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : "kWh")),

  rateCardId: optionalUuid,
  installedOn: optionalDay,

  /**
   * ⭐ THE READING AT INSTALLATION, AND IT IS NOT COSMETIC.
   *
   * ⚠️ The first reading on a meter is chained against this, not against
   * zero. A meter installed showing 1,250 with `initial_reading` left at 0
   * bills its new consumer for 1,250 units somebody else used, on their
   * very first invoice.
   */
  initialReading: z
    .union([decimalString("Enter the dial reading at installation."), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : "0")),

  /**
   * ⭐ A REPLACEMENT IS A NEW ROW POINTING AT ITS PREDECESSOR.
   *
   * ⚠️ NEVER AN EDIT TO THE OLD METER. The new device starts at zero and
   * has no arithmetic relationship to the old one, so nothing may ever
   * subtract across the pair. The pointer keeps the consumer's history
   * readable without letting the numbers mix.
   */
  replacesMeterId: optionalUuid,
  replacedOn: optionalDay,

  isNetMetered: z.coerce.boolean().default(false),
  sanctionedLoadKw: optionalDecimal("Use a number like 5 or 7.500."),
});

/**
 * ⭐ Create or amend a meter.
 *
 * ⚠️ THIS IS THE ONLY PLACE `digit_count` IS SETTABLE, and it is worth
 * saying out loud what changing it later does: every future rollover is
 * computed against the new ceiling. Readings already recorded keep the
 * consumption the trigger derived at the time — which is correct, because
 * that is what was billed — so a corrected digit count fixes the future
 * and leaves the past auditable, rather than silently rewriting invoices
 * that have already gone out.
 */
export async function saveMeter(
  input: unknown,
): Promise<ActionResult<{ id: string; serialNumber: string }>> {
  try {
    const data = meterSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "metering:meter:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: data.id ? { type: "utility_meter", id: data.id } : undefined,
    });

    if (data.replacesMeterId && data.id && data.replacesMeterId === data.id) {
      return {
        ok: false,
        error:
          "A meter cannot replace itself. A replacement is a different " +
          "physical device with its own dial, and it gets its own row.",
      };
    }

    const values = {
      serialNumber: data.serialNumber,
      kind: data.kind,
      consumerContactId: data.consumerContactId,
      location: data.location,
      connectionRef: data.connectionRef,
      digitCount: data.digitCount,
      multiplier: data.multiplier,
      unit: data.unit,
      rateCardId: data.rateCardId,
      installedOn: data.installedOn,
      initialReading: data.initialReading,
      replacesMeterId: data.replacesMeterId,
      replacedOn: data.replacedOn,
      isNetMetered: data.isNetMetered,
      sanctionedLoadKw: data.sanctionedLoadKw,
      updatedAt: new Date(),
    };

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [before] = await tx
            .select({
              serialNumber: utilityMeters.serialNumber,
              digitCount: utilityMeters.digitCount,
              status: utilityMeters.status,
              multiplier: utilityMeters.multiplier,
            })
            .from(utilityMeters)
            .where(
              and(
                eq(utilityMeters.tenantId, ctx.tenant.id),
                eq(utilityMeters.id, data.id),
              ),
            )
            .limit(1);

          if (!before) {
            throw new Error("That meter no longer exists in this workspace.");
          }

          const [row] = await tx
            .update(utilityMeters)
            .set({ ...values, status: data.status })
            .where(
              and(
                eq(utilityMeters.tenantId, ctx.tenant.id),
                eq(utilityMeters.id, data.id),
              ),
            )
            .returning({
              id: utilityMeters.id,
              serialNumber: utilityMeters.serialNumber,
            });

          if (!row) throw new Error("That meter no longer exists in this workspace.");
          return { ...row, before };
        }

        const [row] = await tx
          .insert(utilityMeters)
          .values({ tenantId: ctx.tenant.id, status: data.status, ...values })
          .returning({
            id: utilityMeters.id,
            serialNumber: utilityMeters.serialNumber,
          });

        if (!row) throw new Error("The meter could not be created.");
        return { ...row, before: null };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "utility_meter",
      resourceId: saved.id,
      oldValue: saved.before
        ? {
            serialNumber: saved.before.serialNumber,
            digitCount: saved.before.digitCount,
            multiplier: String(saved.before.multiplier),
            status: saved.before.status,
          }
        : null,
      newValue: {
        serialNumber: data.serialNumber,
        digitCount: data.digitCount,
        multiplier: data.multiplier,
        status: data.status,
      },
      // ⚠️ `reason`, not `summary`. There is no `summary` on AuditEntry.
      reason: `${data.serialNumber} · ${data.kind} · ${data.digitCount} digits${
        data.isNetMetered ? " · net metered" : ""
      }`,
      metadata: {
        kind: data.kind,
        connectionRef: data.connectionRef,
        rateCardId: data.rateCardId,
        initialReading: data.initialReading,
        replacesMeterId: data.replacesMeterId,
      },
      /**
       * ⚠️ A CHANGED DIGIT COUNT IS A NOTICE, not an info line. It changes
       * how every future rollover is computed on this meter, and a
       * rollover computed against the wrong ceiling is the credit note for
       * a year of free supply.
       */
      severity:
        saved.before && saved.before.digitCount !== data.digitCount
          ? "notice"
          : "info",
    });

    revalidatePath("/meters");
    revalidatePath("/meters/readings");
    return { ok: true, data: { id: saved.id, serialNumber: saved.serialNumber } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/**
 * ⭐ Take a meter off the register.
 *
 * ⚠️ SOFT, BY SETTING `deleted_at`, AND NOT MERELY OUT OF CAUTION. The
 * composite foreign key from `meter_readings` is ON DELETE CASCADE, so a
 * hard delete takes every reading with it — including the readings that
 * priced invoices already sent, already paid, and already reconciled. The
 * customer's copy would then be the only surviving evidence of what they
 * were charged for.
 *
 * ⚠️ AND SOFT-DELETING DOES NOT STOP READINGS ARRIVING. `v_meter_status`
 * and the register filter on `deleted_at IS NULL`, but the derivation
 * trigger does not — it checks `status`. A meter that is genuinely gone
 * should be set to `removed` as well, which is why the status is
 * recorded on the audit line below.
 */
export async function deleteMeter(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const ctx = await guardSalesWrite({
      operation: "metering:meter:delete",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "utility_meter", id },
      // ⚠️ Judged as DESTRUCTIVE by the impersonation policy rather than as
      // an ordinary register edit. See guardSalesWrite.
      impersonationOperation: "delete:utility_meter",
    });

    const removed = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .update(utilityMeters)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(utilityMeters.tenantId, ctx.tenant.id),
              eq(utilityMeters.id, id),
              sql`${utilityMeters.deletedAt} IS NULL`,
            ),
          )
          .returning({
            id: utilityMeters.id,
            serialNumber: utilityMeters.serialNumber,
            status: utilityMeters.status,
          });

        if (!row) throw new Error("That meter is not on the register.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "utility_meter",
      resourceId: id,
      oldValue: { serialNumber: removed.serialNumber, status: removed.status },
      reason:
        `${removed.serialNumber} removed from the register; every reading, ` +
        `billing period and invoice trail is untouched`,
      severity: "warning",
    });

    revalidatePath("/meters");
    revalidatePath("/meters/readings");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — READINGS                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE FORM COLLECTS WHAT THE DIAL SAID. NOTHING ELSE.
 *
 * ⚠️ THERE IS NO `consumption` FIELD HERE AND THERE MUST NEVER BE ONE.
 * Consumption, `previous_value`, `is_rollover`, `is_anomaly` and
 * `anomaly_note` are all derived by `meter_reading_derive()`. Accepting
 * any of them from a form — even "just to save a round trip" — creates a
 * second source of truth that disagrees with the trigger the first time a
 * reading arrives out of order, which on a fleet of field phones is
 * weekly.
 */
const readingSchema = z.object({
  meterId: z.string().uuid("Choose the meter that was read."),

  /**
   * ⭐ WHEN THE DIAL WAS LOOKED AT, not when the form was submitted.
   *
   * ⚠️ THE CHAIN IS BUILT ON THIS COLUMN. A reading entered a week late
   * with today's timestamp inserts itself at the end of the chain and
   * takes a week of somebody else's consumption with it.
   */
  readAt: requiredMoment,

  /** ⭐ The cumulative dial value. NOT NULL, CHECKed >= 0. */
  readingValue: decimalString(
    "Enter the cumulative number shown on the dial — not the units used.",
  ),

  /**
   * ⚠️ `estimated` IS A FIRST-CLASS SOURCE, NOT A FLAG TO AVOID. When
   * nobody could reach the meter the bill still goes out, and the NEXT
   * actual reading must reconcile against it. Recording an estimate as
   * `manual` to keep the register tidy destroys the ability to do that
   * reconciliation, and the error compounds every month nobody visits.
   */
  source: z
    .enum(["manual", "photo", "smart_meter", "api", "estimated", "customer_submitted"])
    .default("manual"),

  /** Defaults to `recorded`. Nothing here sets `superseded`. */
  status: z.enum(["recorded", "validated", "disputed"]).default("recorded"),

  documentId: optionalUuid,
  readByUserId: optionalUuid,
  notes: optionalText(2000),
});

/**
 * ⭐ RECORD A READING.
 *
 * ⚠️ NOTHING HERE REFUSES A READING FOR LOOKING WRONG. If it is 4× the
 * meter's average the trigger flags it and it stands. A 4× jump is a
 * bypass, a fault, a transposed digit — and an air conditioner bought in
 * April. Refusing it would push the number into a notebook, and the meter
 * would then have a hole in its history exactly where the interesting
 * month was.
 *
 * ⚠️ AND THE FLAG COMES BACK TO THE CALLER. `isAnomaly` and `anomalyNote`
 * are read back from the inserted row — written BY THE TRIGGER, not by
 * this function — so the form can put the trigger's own sentence in front
 * of the person who is still standing at the meter and can go and look
 * again.
 */
export async function recordMeterReading(input: unknown): Promise<
  ActionResult<{
    id: string;
    consumption: string | null;
    isRollover: boolean;
    isAnomaly: boolean;
    anomalyNote: string | null;
  }>
> {
  try {
    const data = readingSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "metering:reading:record",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "meter_reading" },
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(meterReadings)
          .values({
            tenantId: ctx.tenant.id,
            meterId: data.meterId,
            readAt: data.readAt,
            readingValue: data.readingValue,
            source: data.source,
            status: data.status,
            documentId: data.documentId,
            readByUserId: data.readByUserId,
            notes: data.notes,
            /* ⚠️ NOT SET, DELIBERATELY: previousReadingId, previousValue,
             * consumption, isRollover, isAnomaly, anomalyNote. The trigger
             * owns all six. */
          })
          .returning({
            id: meterReadings.id,
            consumption: meterReadings.consumption,
            isRollover: meterReadings.isRollover,
            isAnomaly: meterReadings.isAnomaly,
            anomalyNote: meterReadings.anomalyNote,
            previousValue: meterReadings.previousValue,
          });

        if (!row) throw new Error("The reading could not be recorded.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "meter_reading",
      resourceId: saved.id,
      newValue: {
        readingValue: data.readingValue,
        readAt: data.readAt.toISOString(),
        source: data.source,
        // ⭐ The derived figures, recorded as the DATABASE computed them.
        consumption: num(saved.consumption),
        isRollover: saved.isRollover,
        isAnomaly: saved.isAnomaly,
      },
      reason: `dial ${data.readingValue} at ${data.readAt.toISOString()} (${
        data.source
      })${saved.isRollover ? " · rollover" : ""}${saved.isAnomaly ? " · flagged" : ""}`,
      metadata: {
        meterId: data.meterId,
        previousValue: num(saved.previousValue),
        anomalyNote: saved.anomalyNote,
      },
      /**
       * ⚠️ A FLAGGED READING IS A NOTICE IN THE AUDIT LOG, because the
       * flag is the whole reason anybody would come looking later — a
       * tampering investigation starts from "when did this meter start
       * behaving oddly", and an info line does not answer that.
       */
      severity: saved.isAnomaly ? "notice" : "info",
    });

    revalidatePath("/meters");
    revalidatePath("/meters/readings");
    return {
      ok: true,
      data: {
        id: saved.id,
        consumption: num(saved.consumption),
        isRollover: saved.isRollover,
        isAnomaly: saved.isAnomaly,
        anomalyNote: saved.anomalyNote,
      },
    };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/**
 * ⭐ MOVE A READING'S STATUS, AND NOTHING ELSE.
 *
 * ⚠️ THE THREE COLUMNS THAT MATTER ARE NOT IN THIS SCHEMA — no
 * `readingValue`, no `readAt`, no `meterId` — and the database would
 * refuse them anyway (`meter_reading_guard_immutable`). A UI that offers
 * an editable dial field and then apologises has already taught the
 * operator that the system is arbitrary.
 *
 * `disputed` is the one an operator reaches for most: the customer says
 * the number is wrong, the reading stays exactly as recorded, and the
 * disagreement is visible on the row instead of living in an email.
 */
export async function setMeterReadingStatus(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        status: z.enum(["recorded", "validated", "disputed", "superseded", "rejected"]),
        notes: optionalText(2000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "metering:reading:status",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "meter_reading", id: data.id },
    });

    const moved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            status: meterReadings.status,
            readingValue: meterReadings.readingValue,
            notes: meterReadings.notes,
          })
          .from(meterReadings)
          .where(
            and(
              eq(meterReadings.tenantId, ctx.tenant.id),
              eq(meterReadings.id, data.id),
            ),
          )
          .limit(1);

        if (!before) throw new Error("That reading no longer exists in this workspace.");

        const [row] = await tx
          .update(meterReadings)
          .set({
            status: data.status,
            // ⚠️ APPENDED, never replaced. The note on a disputed reading is
            // the customer's own words, and the second person to look at it
            // needs both sides.
            notes:
              data.notes === null
                ? before.notes
                : [before.notes, data.notes].filter(Boolean).join("\n"),
          })
          .where(
            and(
              eq(meterReadings.tenantId, ctx.tenant.id),
              eq(meterReadings.id, data.id),
            ),
          )
          .returning({ id: meterReadings.id, status: meterReadings.status });

        if (!row) throw new Error("That reading no longer exists in this workspace.");
        return { ...row, from: before.status, readingValue: before.readingValue };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "meter_reading",
      resourceId: data.id,
      oldValue: { status: moved.from },
      newValue: { status: moved.status },
      reason: `dial ${moved.readingValue}: ${moved.from} → ${moved.status}${
        data.notes ? ` — ${data.notes}` : ""
      }`,
      severity:
        data.status === "rejected" || data.status === "disputed" ? "notice" : "info",
    });

    revalidatePath("/meters");
    revalidatePath("/meters/readings");
    return { ok: true, data: { id: moved.id, status: moved.status } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/**
 * ⭐ CORRECT A READING BY SUPERSEDING IT — THE ONLY CORRECTION THERE IS.
 *
 * ⚠️ THIS EXISTS BECAUSE THERE IS NO EDIT AND NO DELETE, and both
 * absences are enforced beneath this function rather than by it:
 * `meter_reading_guard_immutable()` refuses a changed dial value, and the
 * application role holds no DELETE privilege on `meter_readings` at all.
 * So a typo is fixed by marking the wrong row `superseded` and recording
 * the right one beside it. Both survive; the invoice that was computed
 * from the wrong one still has something to point at.
 *
 * ⚠️ THE TWO WRITES ARE ONE TRANSACTION, and the order is deliberate:
 * supersede first, then insert. The derivation trigger skips only
 * `rejected` rows when it looks for a predecessor, so the superseded row
 * is still in the chain — but doing the insert first would briefly leave
 * two live readings claiming the same period, and if the insert fails the
 * original would already have been marked wrong with no replacement.
 */
export async function supersedeMeterReading(input: unknown): Promise<
  ActionResult<{
    supersededId: string;
    replacementId: string;
    consumption: string | null;
    isAnomaly: boolean;
    anomalyNote: string | null;
  }>
> {
  try {
    const data = z
      .object({
        /** The reading now believed wrong. */
        id: z.string().uuid(),
        /** ⭐ The dial value as it should have been read. */
        readingValue: decimalString(
          "Enter the cumulative number shown on the dial — not the units used.",
        ),
        readAt: requiredMoment,
        source: z
          .enum([
            "manual",
            "photo",
            "smart_meter",
            "api",
            "estimated",
            "customer_submitted",
          ])
          .default("manual"),
        reason: z
          .string()
          .trim()
          .min(1, "Say what was wrong with the original reading.")
          .max(1000),
        readByUserId: optionalUuid,
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "metering:reading:supersede",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "meter_reading", id: data.id },
    });

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [original] = await tx
          .select({
            id: meterReadings.id,
            meterId: meterReadings.meterId,
            readingValue: meterReadings.readingValue,
            readAt: meterReadings.readAt,
            status: meterReadings.status,
            notes: meterReadings.notes,
          })
          .from(meterReadings)
          .where(
            and(
              eq(meterReadings.tenantId, ctx.tenant.id),
              eq(meterReadings.id, data.id),
            ),
          )
          .limit(1);

        if (!original) {
          throw new Error("That reading no longer exists in this workspace.");
        }

        if (original.status === "superseded") {
          throw new Error(
            "That reading has already been superseded. Correct the reading " +
              "that replaced it, not this one — otherwise the meter ends up " +
              "with two live corrections for the same visit.",
          );
        }

        await tx
          .update(meterReadings)
          .set({
            status: "superseded",
            notes: [original.notes, `Superseded: ${data.reason}`]
              .filter(Boolean)
              .join("\n"),
          })
          .where(
            and(
              eq(meterReadings.tenantId, ctx.tenant.id),
              eq(meterReadings.id, data.id),
            ),
          );

        const [replacement] = await tx
          .insert(meterReadings)
          .values({
            tenantId: ctx.tenant.id,
            // ⚠️ THE SAME METER, ALWAYS. A reading is an odometer value and
            // means nothing on another dial; the database refuses a move.
            meterId: original.meterId,
            readAt: data.readAt,
            readingValue: data.readingValue,
            source: data.source,
            status: "recorded",
            readByUserId: data.readByUserId,
            notes: `Supersedes reading of ${original.readingValue} — ${data.reason}`,
          })
          .returning({
            id: meterReadings.id,
            consumption: meterReadings.consumption,
            isAnomaly: meterReadings.isAnomaly,
            anomalyNote: meterReadings.anomalyNote,
          });

        if (!replacement) {
          throw new Error("The corrected reading could not be recorded.");
        }

        return { original, replacement };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "meter_reading",
      resourceId: data.id,
      oldValue: {
        readingValue: String(outcome.original.readingValue),
        status: outcome.original.status,
      },
      newValue: {
        status: "superseded",
        replacementId: outcome.replacement.id,
        replacementReadingValue: data.readingValue,
      },
      reason: `${outcome.original.readingValue} superseded by ${data.readingValue} — ${data.reason}`,
      metadata: {
        meterId: outcome.original.meterId,
        replacementId: outcome.replacement.id,
        consumption: num(outcome.replacement.consumption),
      },
      // ⚠️ A correction to a number that may already have been billed.
      severity: "notice",
    });

    revalidatePath("/meters");
    revalidatePath("/meters/readings");
    return {
      ok: true,
      data: {
        supersededId: data.id,
        replacementId: outcome.replacement.id,
        consumption: num(outcome.replacement.consumption),
        isAnomaly: outcome.replacement.isAnomaly,
        anomalyNote: outcome.replacement.anomalyNote,
      },
    };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — BILLING PERIODS                                             */
/* ------------------------------------------------------------------ */

const periodSchema = z
  .object({
    id: z.string().uuid().optional(),
    meterId: z.string().uuid("Choose a meter."),

    periodStart: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-07-01."),
    periodEnd: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-07-31."),

    /** ⚠️ NOT NULL. "July 2026" is what appears on the invoice. */
    label: z.string().trim().min(1, "Name the period, e.g. \"July 2026\".").max(60),

    rateCardId: optionalUuid,

    /**
     * ⚠️ THE ONLY MONEY FIELDS A FORM MAY SET. `energy_charge_minor` and
     * `total_minor` are computed by `ordence_close_meter_period` from the
     * slab engine; typing them in produces an invoice that disagrees with
     * the tariff and nobody finds out until a regulator asks how it was
     * derived.
     */
    fixedChargeMinor: optionalPaise,
    dutyMinor: optionalPaise,
    exportCreditMinor: optionalPaise,
  })
  .refine((d) => d.periodEnd >= d.periodStart, {
    message: "The period ends before it starts.",
    path: ["periodEnd"],
  });

/**
 * ⭐ Open or amend a billing period.
 *
 * ⚠️ THIS FUNCTION NEVER WRITES THE UNITS OR THE ENERGY CHARGE.
 * `units_consumed`, `units_exported`, both bank columns,
 * `opening_reading_id`, `closing_reading_id` and `energy_charge_minor`
 * are all set by `ordence_close_meter_period()`. Setting them from a form
 * would let somebody type a units figure that no reading supports — which
 * is precisely the invoice a customer cannot be shown the arithmetic for.
 */
export async function saveMeterBillingPeriod(
  input: unknown,
): Promise<ActionResult<{ id: string; label: string }>> {
  try {
    const data = periodSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "metering:period:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: data.id ? { type: "meter_billing_period", id: data.id } : undefined,
    });

    const values = {
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      label: data.label,
      rateCardId: data.rateCardId,
      fixedChargeMinor: BigInt(data.fixedChargeMinor ?? "0"),
      dutyMinor: BigInt(data.dutyMinor ?? "0"),
      exportCreditMinor: BigInt(data.exportCreditMinor ?? "0"),
      updatedAt: new Date(),
    };

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [row] = await tx
            .update(meterBillingPeriods)
            .set(values)
            .where(
              and(
                eq(meterBillingPeriods.tenantId, ctx.tenant.id),
                eq(meterBillingPeriods.id, data.id),
              ),
            )
            .returning({
              id: meterBillingPeriods.id,
              label: meterBillingPeriods.label,
            });
          if (!row) throw new Error("That billing period no longer exists.");
          return row;
        }

        const [row] = await tx
          .insert(meterBillingPeriods)
          .values({ tenantId: ctx.tenant.id, meterId: data.meterId, ...values })
          .returning({ id: meterBillingPeriods.id, label: meterBillingPeriods.label });

        if (!row) throw new Error("The billing period could not be created.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "meter_billing_period",
      resourceId: saved.id,
      newValue: {
        label: data.label,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        fixedChargeMinor: data.fixedChargeMinor ?? "0",
        dutyMinor: data.dutyMinor ?? "0",
      },
      reason: `${data.label} · ${data.periodStart} → ${data.periodEnd}`,
      metadata: { meterId: data.meterId, rateCardId: data.rateCardId },
    });

    revalidatePath("/meters");
    return { ok: true, data: { id: saved.id, label: saved.label } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/**
 * ⭐ CLOSE A PERIOD — `ordence_close_meter_period(tenant, period)`.
 *
 * ⚠️ THE WHOLE COMPUTATION IS IN THE DATABASE AND IT IS NOT `import −
 * export`. Surplus export is BANKED: it offsets import down to zero and
 * NO FURTHER, and whatever is left carries into the next period to be
 * settled annually, usually at a different rate from the import tariff.
 * Netting inside the month destroys the bank — quietly, monthly, in the
 * utility's favour, and invisibly on the invoice because the invoice only
 * shows the net. Reimplementing any part of that here would give this
 * screen a second opinion about a customer's credit balance.
 *
 * ⚠️ AND THE FUNCTION SUMS THE DERIVED CONSUMPTION RATHER THAN
 * SUBTRACTING THE TWO ENDPOINT READINGS. Subtracting endpoints gets
 * rollover wrong all over again, silently, having already got it right on
 * every individual reading.
 *
 * ⚠️ `security_invoker` DOES NOT APPLY TO FUNCTIONS — the tenant id is
 * passed explicitly as the first argument AND the call runs inside
 * `withTenant`, so RLS still governs every table it touches.
 */
export async function closeMeterPeriod(
  input: unknown,
): Promise<ActionResult<{ id: string; period: MeterPeriodRow }>> {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const ctx = await guardSalesWrite({
      operation: "metering:period:close",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "meter_billing_period", id },
    });

    const closed = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            unitsConsumed: meterBillingPeriods.unitsConsumed,
            unitsBankedClosing: meterBillingPeriods.unitsBankedClosing,
            totalMinor: meterBillingPeriods.totalMinor,
          })
          .from(meterBillingPeriods)
          .where(
            and(
              eq(meterBillingPeriods.tenantId, ctx.tenant.id),
              eq(meterBillingPeriods.id, id),
            ),
          )
          .limit(1);

        if (!before) {
          throw new Error("That billing period does not exist in this workspace.");
        }

        await tx.execute(
          sql`SELECT ordence_close_meter_period(${ctx.tenant.id}::uuid, ${id}::uuid)`,
        );

        const [after] = await tx
          .select({
            id: meterBillingPeriods.id,
            meterId: meterBillingPeriods.meterId,
            periodStart: meterBillingPeriods.periodStart,
            periodEnd: meterBillingPeriods.periodEnd,
            label: meterBillingPeriods.label,
            openingReadingId: meterBillingPeriods.openingReadingId,
            closingReadingId: meterBillingPeriods.closingReadingId,
            unitsConsumed: meterBillingPeriods.unitsConsumed,
            unitsExported: meterBillingPeriods.unitsExported,
            unitsBankedOpening: meterBillingPeriods.unitsBankedOpening,
            unitsBankedClosing: meterBillingPeriods.unitsBankedClosing,
            rateCardId: meterBillingPeriods.rateCardId,
            energyChargeMinor: meterBillingPeriods.energyChargeMinor,
            fixedChargeMinor: meterBillingPeriods.fixedChargeMinor,
            dutyMinor: meterBillingPeriods.dutyMinor,
            exportCreditMinor: meterBillingPeriods.exportCreditMinor,
            totalMinor: meterBillingPeriods.totalMinor,
            isFinalised: meterBillingPeriods.isFinalised,
            finalisedAt: meterBillingPeriods.finalisedAt,
            meterSerialNumber: utilityMeters.serialNumber,
          })
          .from(meterBillingPeriods)
          .innerJoin(
            utilityMeters,
            and(
              eq(utilityMeters.id, meterBillingPeriods.meterId),
              eq(utilityMeters.tenantId, meterBillingPeriods.tenantId),
            ),
          )
          .where(
            and(
              eq(meterBillingPeriods.tenantId, ctx.tenant.id),
              eq(meterBillingPeriods.id, id),
            ),
          )
          .limit(1);

        if (!after) throw new Error("The closed period could not be read back.");
        return { before, after };
      },
      { impersonationId: ctx.impersonationId },
    );

    const period: MeterPeriodRow = {
      id: closed.after.id,
      meterId: closed.after.meterId,
      meterSerialNumber: closed.after.meterSerialNumber,
      periodStart: closed.after.periodStart,
      periodEnd: closed.after.periodEnd,
      label: closed.after.label,
      openingReadingId: closed.after.openingReadingId,
      closingReadingId: closed.after.closingReadingId,
      unitsConsumed: String(closed.after.unitsConsumed),
      unitsExported: String(closed.after.unitsExported),
      unitsBankedOpening: String(closed.after.unitsBankedOpening),
      unitsBankedClosing: String(closed.after.unitsBankedClosing),
      rateCardId: closed.after.rateCardId,
      energyChargeMinor: minor(closed.after.energyChargeMinor),
      fixedChargeMinor: minor(closed.after.fixedChargeMinor),
      dutyMinor: minor(closed.after.dutyMinor),
      exportCreditMinor: minor(closed.after.exportCreditMinor),
      totalMinor: minor(closed.after.totalMinor),
      isFinalised: closed.after.isFinalised,
      finalisedAt: iso(closed.after.finalisedAt),
    };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "meter_billing_period",
      resourceId: id,
      oldValue: {
        unitsConsumed: String(closed.before.unitsConsumed),
        unitsBankedClosing: String(closed.before.unitsBankedClosing),
        totalMinor: minor(closed.before.totalMinor),
      },
      newValue: {
        unitsConsumed: period.unitsConsumed,
        unitsExported: period.unitsExported,
        unitsBankedOpening: period.unitsBankedOpening,
        unitsBankedClosing: period.unitsBankedClosing,
        energyChargeMinor: period.energyChargeMinor,
        totalMinor: period.totalMinor,
      },
      reason:
        `${period.label} closed: ${period.unitsConsumed} units consumed, ` +
        `${period.unitsExported} exported, ${period.unitsBankedClosing} banked forward`,
      metadata: {
        meterId: period.meterId,
        openingReadingId: period.openingReadingId,
        closingReadingId: period.closingReadingId,
        rateCardId: period.rateCardId,
      },
      severity: "notice",
    });

    revalidatePath("/meters");
    return { ok: true, data: { id, period } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}

/**
 * ⭐ FREEZE OR UNFREEZE A PERIOD.
 *
 * ⚠️ FINALISING IS THE MOMENT THE NUMBERS STOP BEING OURS. Once it is
 * billed, the customer holds a copy — so `meter_period_guard_finalised()`
 * refuses any change to the figures while the flag is set, and
 * `ordence_close_meter_period` refuses to recompute a finalised period at
 * all. Un-finalising is allowed, because a mistake needs somewhere to
 * attach a credit note, but it is a deliberate separate act rather than a
 * side effect of editing a number.
 */
export async function setMeterPeriodFinalised(
  input: unknown,
): Promise<ActionResult<{ id: string; isFinalised: boolean }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        isFinalised: z.coerce.boolean(),
        reason: optionalText(1000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: data.isFinalised
        ? "metering:period:finalise"
        : "metering:period:unfinalise",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "meter_billing_period", id: data.id },
    });

    const moved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            label: meterBillingPeriods.label,
            isFinalised: meterBillingPeriods.isFinalised,
            totalMinor: meterBillingPeriods.totalMinor,
          })
          .from(meterBillingPeriods)
          .where(
            and(
              eq(meterBillingPeriods.tenantId, ctx.tenant.id),
              eq(meterBillingPeriods.id, data.id),
            ),
          )
          .limit(1);

        if (!before) throw new Error("That billing period no longer exists.");

        const [row] = await tx
          .update(meterBillingPeriods)
          .set({
            isFinalised: data.isFinalised,
            /**
             * ⚠️ `finalised_at` IS STAMPED BY THE TRIGGER on the
             * false → true edge, and NOT cleared on the way back. When a
             * period was first billed is a fact; un-finalising it does not
             * make the invoice that went out un-happen.
             */
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(meterBillingPeriods.tenantId, ctx.tenant.id),
              eq(meterBillingPeriods.id, data.id),
            ),
          )
          .returning({
            id: meterBillingPeriods.id,
            isFinalised: meterBillingPeriods.isFinalised,
          });

        if (!row) throw new Error("That billing period no longer exists.");
        return { ...row, label: before.label, was: before.isFinalised, totalMinor: before.totalMinor };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "meter_billing_period",
      resourceId: data.id,
      oldValue: { isFinalised: moved.was },
      newValue: { isFinalised: moved.isFinalised },
      reason: data.isFinalised
        ? `${moved.label} finalised at ${minor(moved.totalMinor)} paise${
            data.reason ? ` — ${data.reason}` : ""
          }`
        : `${moved.label} un-finalised${data.reason ? ` — ${data.reason}` : ""}`,
      /**
       * ⚠️ UN-FINALISING IS A WARNING. It reopens figures the customer
       * already holds a copy of, and it is the step somebody takes just
       * before a number changes underneath an invoice that has been sent.
       */
      severity: data.isFinalised ? "notice" : "warning",
    });

    revalidatePath("/meters");
    return { ok: true, data: { id: moved.id, isFinalised: moved.isFinalised } };
  } catch (err) {
    const explained = explainMeterError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "metering");
  }
}
