/**
 * Ordence — ⭐⭐ CREATING A BOOKING
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE "NEW BOOKING" BUTTON LINKED HERE AND THIS PAGE DID NOT EXIST
 * ══════════════════════════════════════════════════════════════════════
 * `/sales/bookings/new` has been in the dead-link budget since the
 * bookings list was written. `createBooking` , which is the action that
 * takes a unit off the market and is the only thing standing between two
 * buyers and the same flat , had no caller.
 *
 * ⚠️ THE PICKERS ARE FILLED ON THE SERVER AND THE FORM IS A CLIENT
 * COMPONENT. `LeadRow` and `UnitRow` carry `bigint` prices and full
 * database rows; only an id, a label and a formatted price cross the
 * boundary. Handing the whole row to the browser would ship a buyer's
 * contact details to a form that needs their name.
 *
 * ⚠️ ONLY AVAILABLE UNITS ARE OFFERED. A booked or held unit in the list
 * is an invitation to double-sell, and the server refuses it anyway , so
 * offering it produces a refusal the user cannot act on. The count of
 * what was filtered out is shown, because a picker that is silently
 * empty reads as a broken screen.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { listLeads } from "@/server/actions/sales-leads";
import { listUnits } from "@/server/actions/sales-inventory";
import { createBooking, listPlanTemplates } from "@/server/actions/sales-bookings";
import { NewBookingForm } from "./new-booking-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "New booking · Ordence" };

function formatPaise(minor: bigint | null): string {
  if (minor === null) return "—";
  const whole = minor / 100n;
  return `₹${new Intl.NumberFormat("en-IN").format(whole)}`;
}

export default async function NewBookingPage() {
  const [leadsResult, unitsResult, templatesResult] = await Promise.all([
    listLeads({}),
    listUnits({}),
    listPlanTemplates(),
  ]);

  const leads = leadsResult.ok ? leadsResult.data.rows : [];
  const allUnits = unitsResult.ok ? unitsResult.data.rows : [];
  const available = allUnits.filter((unit) => unit.status === "available");
  const templates = templatesResult.ok ? templatesResult.data.templates : [];

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/sales/bookings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to bookings
        </Link>
        <h1 className="text-2xl font-bold">New booking</h1>
        <p className="text-sm text-muted-foreground">
          A booking takes the unit off the market the moment it is created. No two buyers can
          be booked into the same flat.
        </p>
      </div>

      {!leadsResult.ok && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {leadsResult.error}
        </p>
      )}
      {!unitsResult.ok && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {unitsResult.error}
        </p>
      )}

      <NewBookingForm
        leads={leads.map((lead) => ({
          id: lead.id,
          label: lead.name,
          hint: lead.phone ?? lead.email ?? null,
        }))}
        units={available.map((unit) => ({
          id: unit.id,
          label: unit.code,
          hint: [unit.projectName, unit.typology, formatPaise(unit.priceMinor)]
            .filter(Boolean)
            .join(" · "),
          /** Pre-fills the agreement value, in rupees, as a string. */
          priceRupees:
            unit.priceMinor === null ? "" : (Number(unit.priceMinor) / 100).toFixed(2),
        }))}
        unavailableCount={allUnits.length - available.length}
        templates={templates.map((t) => ({ key: t.key, name: t.name }))}
        create={createBooking}
      />
    </main>
  );
}
