"use client";

/**
 * Ordence — ⭐ ENGINE 5 · METER REGISTER WRITE ACTIONS
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DIGIT COUNT IS THE MOST IMPORTANT FIELD ON THIS FORM
 * ══════════════════════════════════════════════════════════════════════
 * It looks like metadata. It is the number every future rollover is
 * computed against: a 5-digit meter passing 99999 and showing 00042
 * consumed 43 units, and the same reading against a wrong ceiling becomes
 * minus 99,957 — a credit note for roughly a year of free supply, issued
 * automatically, to whoever happens to be on that meter. It is defaulted
 * to 6, CHECKed between 3 and 12, and a change to it is recorded in the
 * audit log at `notice` severity.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A REPLACEMENT IS A NEW METER, NEVER AN EDIT TO THE OLD ONE
 * ══════════════════════════════════════════════════════════════════════
 * The "replaces" field points the new row at its predecessor. It does not
 * merge them, and nothing anywhere subtracts across the pair — a
 * replacement dial starts at zero and has no arithmetic relationship to
 * the meter it replaced at all. The pointer exists so a consumer's history
 * stays readable, not so the numbers can be joined up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `connection_ref` IS WHAT PAIRS AN IMPORT METER WITH ITS EXPORT METER
 * ══════════════════════════════════════════════════════════════════════
 * `ordence_close_meter_period` pairs on the connection reference, NOT on
 * the consumer, because one consumer can hold several connections and
 * crediting a rooftop's generation against a different premises'
 * consumption is a real and expensive mistake. A net-metered meter with
 * no connection reference banks nothing — the function refuses to guess.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOTHING HERE TYPES IN UNITS OR AN ENERGY CHARGE
 * ══════════════════════════════════════════════════════════════════════
 * The period form collects the dates, the label, and the two charges that
 * are genuinely a matter of policy — the fixed charge and the duty. Units
 * consumed, units exported, both bank columns and the energy charge are
 * computed by `ordence_close_meter_period` from the readings and the slab
 * engine. A units figure that no reading supports is precisely the invoice
 * a customer cannot be shown the arithmetic for.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveMeter,
  deleteMeter,
  saveMeterBillingPeriod,
  closeMeterPeriod,
  setMeterPeriodFinalised,
} from "@/server/actions/metering";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MeterOption = {
  id: string;
  serialNumber: string;
  kind: string;
  status: string;
  isNetMetered: boolean;
};

type PeriodOption = {
  id: string;
  label: string;
  isFinalised: boolean;
};

type Option = { id: string; name: string };

type Panel = "none" | "meter" | "period" | "close" | "retire";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const KINDS = [
  "electricity_import",
  "electricity_export",
  "electricity_net",
  "solar_generation",
  "water",
  "gas",
  "fuel",
  "sub_meter",
] as const;

const STATUSES = [
  "pending_installation",
  "active",
  "faulty",
  "replaced",
  "disconnected",
  "removed",
] as const;

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

export function MeterActions({
  meters,
  periods,
  consumers,
  rateCardOptions,
}: {
  meters: MeterOption[];
  periods: PeriodOption[];
  consumers: Option[];
  rateCardOptions: { id: string; name: string; code: string }[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        /**
         * ⚠️ VERBATIM. The refusals from SQL-FILES/0035 are already
         * sentences written for an operator — "Meter 4471X is removed and
         * cannot take new readings. If it was replaced, record the reading
         * against the replacement meter." Flattening that into "Could not
         * save" throws away the instruction.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      setPanel("none");
      router.refresh();
    });
  }

  const openPeriods = periods.filter((p) => !p.isFinalised);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "meter" ? "default" : "outline"}
          onClick={() => setPanel(panel === "meter" ? "none" : "meter")}
        >
          Add a meter
        </Button>
        <Button
          size="sm"
          variant={panel === "period" ? "default" : "outline"}
          onClick={() => setPanel(panel === "period" ? "none" : "period")}
        >
          Open a billing period
        </Button>
        <Button
          size="sm"
          variant={panel === "close" ? "default" : "outline"}
          onClick={() => setPanel(panel === "close" ? "none" : "close")}
        >
          Close a period
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === "retire" ? "none" : "retire")}
        >
          Remove a meter
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {panel === "meter" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add a meter</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveMeter({
                      serialNumber: f.get("serialNumber"),
                      kind: f.get("kind"),
                      status: f.get("status") || "active",
                      consumerContactId: f.get("consumerContactId") || null,
                      location: f.get("location") || null,
                      connectionRef: f.get("connectionRef") || null,
                      digitCount: f.get("digitCount") || 6,
                      multiplier: f.get("multiplier") || "1",
                      unit: f.get("unit") || "kWh",
                      rateCardId: f.get("rateCardId") || null,
                      installedOn: f.get("installedOn") || null,
                      initialReading: f.get("initialReading") || "0",
                      replacesMeterId: f.get("replacesMeterId") || null,
                      replacedOn: f.get("replacedOn") || null,
                      isNetMetered: f.get("isNetMetered") === "on",
                      sanctionedLoadKw: f.get("sanctionedLoadKw") || null,
                    }),
                  "Meter added to the register.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="m-serial">Serial number</Label>
                <Input id="m-serial" name="serialNumber" required maxLength={120} />
                <p className="text-[11px] text-muted-foreground">
                  As printed on the device — it is what a reader matches against
                  standing in front of it.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-kind">Kind</Label>
                <select id="m-kind" name="kind" required className={SELECT_CLASS}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanise(k)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-status">Status</Label>
                <select
                  id="m-status"
                  name="status"
                  defaultValue="active"
                  className={SELECT_CLASS}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                {/* ⭐ THE FIELD THIS ENGINE TURNS ON. See the header. */}
                <Label htmlFor="m-digits">Digits on the dial</Label>
                <Input
                  id="m-digits"
                  name="digitCount"
                  type="number"
                  min={3}
                  max={12}
                  defaultValue={6}
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  Count them on the meter face. This is what makes a rollover
                  survivable: a 5-digit dial passing 99999 and showing 00042
                  consumed 43 units, not minus 99,957.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-multiplier">Multiplier</Label>
                <Input id="m-multiplier" name="multiplier" defaultValue="1" />
                <p className="text-[11px] text-muted-foreground">
                  Usually 1. CT-metered supplies read in a fraction of what they
                  consume.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-unit">Unit</Label>
                <Input id="m-unit" name="unit" defaultValue="kWh" maxLength={20} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="m-consumer">Consumer</Label>
                <select id="m-consumer" name="consumerContactId" className={SELECT_CLASS}>
                  <option value="">—</option>
                  {consumers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-location">Location</Label>
                <Input id="m-location" name="location" maxLength={300} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-connection">Connection reference</Label>
                <Input id="m-connection" name="connectionRef" maxLength={120} />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ What pairs an import meter with the export meter at the same
                  premises. Net metering banks nothing without it.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="m-rate">Rate card</Label>
                <select id="m-rate" name="rateCardId" className={SELECT_CLASS}>
                  <option value="">—</option>
                  {rateCardOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-installed">Installed on</Label>
                <Input id="m-installed" name="installedOn" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-initial">Reading at installation</Label>
                <Input id="m-initial" name="initialReading" defaultValue="0" inputMode="decimal" />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ A meter installed showing 1,250 with this left at 0 bills its
                  new consumer for 1,250 units somebody else used, on their first
                  invoice.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="m-replaces">Replaces meter</Label>
                <select id="m-replaces" name="replacesMeterId" className={SELECT_CLASS}>
                  <option value="">—</option>
                  {meters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.serialNumber}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-replaced-on">Replaced on</Label>
                <Input id="m-replaced-on" name="replacedOn" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-load">Sanctioned load (kW)</Label>
                <Input id="m-load" name="sanctionedLoadKw" inputMode="decimal" />
              </div>

              <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
                <input id="m-net" name="isNetMetered" type="checkbox" className="h-4 w-4" />
                <Label htmlFor="m-net" className="font-normal">
                  Net metered — export is banked and carried forward, never
                  netted off inside the month
                </Label>
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Add meter"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "period" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Open a billing period</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveMeterBillingPeriod({
                      meterId: f.get("meterId"),
                      periodStart: f.get("periodStart"),
                      periodEnd: f.get("periodEnd"),
                      label: f.get("label"),
                      rateCardId: f.get("rateCardId") || null,
                      fixedChargeMinor: f.get("fixedChargeMinor") || null,
                      dutyMinor: f.get("dutyMinor") || null,
                      exportCreditMinor: f.get("exportCreditMinor") || null,
                    }),
                  "Billing period opened. Close it to compute the units and the charge.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="p-meter">Meter</Label>
                <select id="p-meter" name="meterId" required className={SELECT_CLASS}>
                  {meters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.serialNumber} · {humanise(m.kind)}
                      {m.isNetMetered ? " · net metered" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-label">Label</Label>
                <Input id="p-label" name="label" required maxLength={60} placeholder="July 2026" />
                <p className="text-[11px] text-muted-foreground">
                  What appears on the invoice.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-rate">Rate card</Label>
                <select id="p-rate" name="rateCardId" className={SELECT_CLASS}>
                  <option value="">Use the meter&rsquo;s own</option>
                  {rateCardOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-start">From</Label>
                <Input id="p-start" name="periodStart" type="date" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-end">To</Label>
                <Input id="p-end" name="periodEnd" type="date" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-fixed">Fixed charge (paise)</Label>
                <Input id="p-fixed" name="fixedChargeMinor" inputMode="numeric" placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-duty">Electricity duty (paise)</Label>
                <Input id="p-duty" name="dutyMinor" inputMode="numeric" placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-export">Export credit (paise)</Label>
                <Input
                  id="p-export"
                  name="exportCreditMinor"
                  inputMode="numeric"
                  placeholder="0"
                />
                <p className="text-[11px] text-muted-foreground">
                  Money settled against banked export. The units themselves carry
                  forward on their own.
                </p>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  Units consumed, units exported, the opening and closing bank
                  and the energy charge are not typed here. They are computed
                  from the readings and the slab engine when the period is
                  closed.
                </p>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Open period"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "close" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Close a billing period</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Closing runs{" "}
              <span className="font-mono">ordence_close_meter_period</span> in the
              database. It sums the consumption the reading trigger already
              derived rather than subtracting the two endpoint readings —
              subtracting endpoints gets rollover wrong all over again, silently,
              having got it right on every individual reading. For a net-metered
              meter it offsets export against import down to zero and no further;
              whatever is left becomes the closing bank and opens the next
              period.
            </p>
            {openPeriods.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open billing period. A finalised one cannot be recomputed —
                un-finalise it first, deliberately.
              </p>
            ) : (
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const id = f.get("id");
                  const action = f.get("action");
                  if (action === "finalise") {
                    run(
                      () => setMeterPeriodFinalised({ id, isFinalised: true }),
                      "Period finalised. Its figures are frozen — the customer holds a copy of them now.",
                    );
                    return;
                  }
                  run(
                    () => closeMeterPeriod({ id }),
                    "Period closed. Units, bank and energy charge recomputed from the readings.",
                  );
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="c-period">Period</Label>
                  <select id="c-period" name="id" required className={SELECT_CLASS}>
                    {openPeriods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="c-action">Then</Label>
                  <select
                    id="c-action"
                    name="action"
                    defaultValue="close"
                    className={SELECT_CLASS}
                  >
                    <option value="close">Recompute the figures</option>
                    <option value="finalise">Freeze it — it has been billed</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" size="sm" disabled={pending}>
                    {pending ? "Working…" : "Run"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {panel === "retire" && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Remove a meter from the register</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              The row is hidden, not destroyed. Every reading, billing period and
              invoice trail stays exactly where it is — the foreign key from
              readings cascades, so a hard delete would take with it the readings
              that priced invoices already sent and already paid, leaving the
              customer&rsquo;s copy as the only surviving evidence of what they
              were charged for. If the device is genuinely gone, set its status to{" "}
              <span className="font-mono">removed</span> as well: that is what
              stops new readings being accepted against it.
            </p>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () => deleteMeter({ id: f.get("id") }),
                  "Meter removed from the register. Its readings are untouched.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="d-meter">Meter</Label>
                <select id="d-meter" name="id" required className={SELECT_CLASS}>
                  {meters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.serialNumber} · {humanise(m.status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  {pending ? "Removing…" : "Remove from register"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
