/**
 * Ordence — Plan Catalogue Seeder
 * Version: v0.11.0-alpha
 *
 * Run with:  npm run seed:plans
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS AN UPSERT AND NOT AN INSERT
 * ══════════════════════════════════════════════════════════════════════
 * It will be run more than once — after every deployment that adds a
 * plan, and by anyone setting up a fresh environment. An INSERT would
 * fail the second time on the unique index over `code`, and the usual
 * "fix" for that (delete everything first) would break every
 * `subscriptions.plan_id` foreign key pointing at the rows it deleted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does NOT reprice existing customers. A subscription copies its price
 * onto itself at purchase (`subscriptions.unit_amount_minor`), so
 * changing a catalogue price here affects only NEW purchases. That is the
 * whole reason the price is denormalised, and running this script must
 * never be capable of silently raising what someone already pays.
 *
 * It also does NOT deactivate plans that have been removed from the
 * catalogue in code. Deactivating a plan somebody is subscribed to is a
 * commercial decision, not a deployment side effect — do it deliberately
 * with a SQL statement you have looked at.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { PLAN_CATALOGUE } from "../lib/validators/billing";

/* Load .env.local if present, otherwise rely on the ambient environment
 * (which is how this runs in CI and on a deploy host). */
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) config({ path: envPath });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "\n  DATABASE_URL is not set.\n\n" +
      "  Set it in .env.local, or export it before running this script.\n",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log("\n  Seeding the plan catalogue…\n");

    let inserted = 0;
    let updated = 0;

    for (const plan of PLAN_CATALOGUE) {
      /**
       * `ON CONFLICT (code) DO UPDATE` — everything about a plan may be
       * corrected in place EXCEPT its id, which other tables reference.
       *
       * `xmax = 0` is a PostgreSQL trick for telling an INSERT from an
       * UPDATE in an upsert: the system column is zero on a freshly
       * inserted row and non-zero on one that was updated. Without it the
       * script cannot report what it actually did, and a seeder that says
       * "5 plans" whether or not anything changed is a seeder nobody
       * trusts.
       */
      const result = await pool.query<{ inserted: boolean }>(
        `INSERT INTO plans (
           code, name, description, tier, interval, currency,
           amount_minor, included_seats, per_seat_amount_minor,
           storage_limit_mb, emails_per_month, api_calls_per_month,
           trial_days, is_public, sort_order, highlights,
           razorpay_plan_id, stripe_price_id
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
         ON CONFLICT (code) DO UPDATE SET
           name                   = EXCLUDED.name,
           description            = EXCLUDED.description,
           tier                   = EXCLUDED.tier,
           interval               = EXCLUDED.interval,
           currency               = EXCLUDED.currency,
           amount_minor           = EXCLUDED.amount_minor,
           included_seats         = EXCLUDED.included_seats,
           per_seat_amount_minor  = EXCLUDED.per_seat_amount_minor,
           storage_limit_mb       = EXCLUDED.storage_limit_mb,
           emails_per_month       = EXCLUDED.emails_per_month,
           api_calls_per_month    = EXCLUDED.api_calls_per_month,
           trial_days             = EXCLUDED.trial_days,
           is_public              = EXCLUDED.is_public,
           sort_order             = EXCLUDED.sort_order,
           highlights             = EXCLUDED.highlights,
           -- Provider ids are only ever FILLED IN, never blanked. They are
           -- set by hand after mirroring a plan into Razorpay or Stripe,
           -- and a re-run of this script must not wipe that work.
           razorpay_plan_id       = COALESCE(EXCLUDED.razorpay_plan_id, plans.razorpay_plan_id),
           stripe_price_id        = COALESCE(EXCLUDED.stripe_price_id,  plans.stripe_price_id),
           updated_at             = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          plan.code,
          plan.name,
          plan.description,
          plan.tier,
          plan.interval,
          plan.currency,
          plan.amountMinor,
          plan.includedSeats,
          plan.perSeatAmountMinor,
          plan.storageLimitMb,
          plan.emailsPerMonth,
          plan.apiCallsPerMonth,
          plan.trialDays,
          plan.isPublic,
          plan.sortOrder,
          JSON.stringify(plan.highlights),
          // Filled in by hand once the plan exists at the provider.
          process.env[`RAZORPAY_PLAN_${plan.code.toUpperCase()}`] ?? null,
          process.env[`STRIPE_PRICE_${plan.code.toUpperCase()}`] ?? null,
        ],
      );

      const wasInsert = result.rows[0]?.inserted ?? false;
      if (wasInsert) inserted += 1;
      else updated += 1;

      const rupees = (BigInt(plan.amountMinor) / 100n).toString();
      console.log(
        `    ${wasInsert ? "created" : "updated"}  ${plan.code.padEnd(24)} ` +
          `₹${rupees.padStart(8)} / ${plan.interval}`,
      );
    }

    console.log(`\n  ${inserted} created, ${updated} updated.\n`);

    /* ---- Report which plans cannot actually be sold yet ------------- */
    //
    // A plan with no provider id is a row on a pricing page that produces
    // a failed checkout. Better to say so now than to find out from a
    // customer.
    const unsellable = await pool.query<{ code: string; name: string }>(
      `SELECT code, name FROM plans
       WHERE is_active AND is_public
         AND amount_minor > 0
         AND razorpay_plan_id IS NULL
         AND stripe_price_id IS NULL
       ORDER BY sort_order`,
    );

    if (unsellable.rowCount && unsellable.rowCount > 0) {
      console.log("  ⚠️  These plans have NO provider id and cannot be purchased online:\n");
      for (const row of unsellable.rows) {
        console.log(`       ${row.code}  (${row.name})`);
      }
      console.log(
        "\n     Create the matching plan in Razorpay or Stripe, then set its id:\n" +
          "       UPDATE plans SET razorpay_plan_id = 'plan_xxx' WHERE code = '…';\n" +
          "     Until then, checkout for these plans fails with a clear message\n" +
          "     rather than a provider error.\n",
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\n  Seeding failed:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
