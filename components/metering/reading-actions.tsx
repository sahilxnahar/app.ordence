"use client";

/**
 * Ordence — ⭐ ENGINE 5 · READING ENTRY
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM ASKS WHAT THE DIAL SAID. IT NEVER ASKS FOR CONSUMPTION.
 * ══════════════════════════════════════════════════════════════════════
 * There is one number field on the reading form and it is the cumulative
 * total on the face of the meter. There is no "units used" field, and
 * adding one would be the single most expensive change anybody could make
 * to this engine: storing the difference throws away the only thing that
 * can ever verify it, so when a customer disputes July you have your own
 * arithmetic and nothing to check it against.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PREVIEW IS A COURTESY. THE TRIGGER IS THE AUTHORITY.
 * ══════════════════════════════════════════════════════════════════════
 * `consumptionBetween()` is imported from db/schema/utility-meters.ts and
 * run in the browser so a reader can see roughly what they are recording
 * before they commit — in particular whether the number they typed is
 * about to be treated as a dial rollover.
 *
 * ⚠️ WHAT IT SHOWS IS NOT WHAT IS STORED. `meter_reading_derive()` in
 * SQL-FILES/0035 computes and writes the real figure, chained against the
 * previous reading BY `read_at` — which is not necessarily the last
 * reading this page knows about, because a field agent's phone may have
 * synced a backdated reading between the page render and this submit. The
 * preview also cannot see the meter's history, so it cannot tell you
 * whether the result will be flagged. The server action returns the
 * trigger's own verdict, and that is what is shown afterwards.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE IS NO EDIT FIELD FOR A DIAL VALUE, ANYWHERE ON THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * A wrong reading is corrected by SUPERSEDING it: the old row is marked
 * `superseded` and a new one is recorded beside it. The database refuses
 * an in-place edit (`meter_reading_guard_immutable`) and the application
 * role holds no DELETE privilege on the table at all, so offering either
 * control would be offering a button that cannot work.
 *
 * ⚠️ AND AN ANOMALY IS NEVER A REJECTION. When the action comes back with
 * `isAnomaly` the reading has already been saved. The note is shown so
 * somebody can go and look at the meter — not so they can try again with
 * a different number.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  recordMeterReading,
  setMeterReadingStatus,
  supersedeMeterReading,
} from "@/server/actions/metering";
import { consumptionBetween } from "@/db/schema/utility-meters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MeterOption = {
  id: string;
  serialNumber: string;
  kind: string;
  status: string;
  unit: string;
  digitCount: number;
  multiplier: string;
  lastReadingValue: string | null;
  lastReadAt: string | null;
  acceptsReadings: boolean;
};

type ReadingOption = {
  id: string;
  label: string;
  meterId: string;
  status: string;
};

type Panel = "none" | "record" | "supersede" | "status";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const SOURCES = [
  "manual",
  "photo",
  "smart_meter",
  "api",
  "estimated",
  "customer_submitted",
] as const;

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

export function ReadingActions({
  meters,
  readings,
}: {
  meters: MeterOption[];
  readings: ReadingOption[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("record");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** ⭐ The trigger's own words, shown after a save. Never paraphrased. */
  const [flag, setFlag] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const readable = meters.filter((m) => m.acceptsReadings);

  /* ---- Live preview state. See the header: courtesy, not authority. */
  const [meterId, setMeterId] = useState<string>(readable[0]?.id ?? "");
  const [typed, setTyped] = useState<string>("");

  const meter = useMemo(
    () => meters.find((m) => m.id === meterId) ?? null,
    [meters, meterId],
  );

  /**
   * ⭐ WHAT THIS READING PROBABLY MEANS, computed in the browser.
   *
   * ⚠️ `null` WHEN ANYTHING IS UNKNOWN — no meter chosen, nothing typed,
   * or the meter has never been read. A preview that quietly falls back to
   * a baseline of zero on a meter installed showing 1,250 would tell the
   * reader they are about to record 1,250 units of somebody else's
   * consumption, which is exactly the mistake `initial_reading` exists to
   * prevent. Silence is better than a confident wrong number.
   */
  const preview = useMemo(() => {
    if (!meter || meter.lastReadingValue === null) return null;
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(typed.trim())) return null;
    const previous = Number(meter.lastReadingValue);
    const current = Number(typed.trim());
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
    return consumptionBetween(
      previous,
      current,
      meter.digitCount,
      Number(meter.multiplier) || 1,
    );
  }, [meter, typed]);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setError(null);
    setNotice(null);
    setFlag(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        /**
         * ⚠️ THE DATABASE'S REFUSAL IS SHOWN VERBATIM. "A meter reading's
         * value cannot be edited — mark this reading superseded and record
         * a new one" tells the operator what to do next. "Could not save"
         * sends them to a spreadsheet, and the spreadsheet becomes the
         * real system.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      setTyped("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "record" ? "default" : "outline"}
          onClick={() => setPanel(panel === "record" ? "none" : "record")}
        >
          Record a reading
        </Button>
        <Button
          size="sm"
          variant={panel === "supersede" ? "default" : "outline"}
          onClick={() => setPanel(panel === "supersede" ? "none" : "supersede")}
        >
          Correct a reading
        </Button>
        <Button
          size="sm"
          variant={panel === "status" ? "default" : "outline"}
          onClick={() => setPanel(panel === "status" ? "none" : "status")}
        >
          Dispute or validate
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
      {/* ⚠️ AMBER, NOT RED. The reading was SAVED. This is a flag on a
          number that stands, not a failure to record it. */}
      {flag && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">
            Recorded, and flagged. The reading stands.
          </p>
          <p className="mt-1">{flag}</p>
        </div>
      )}

      {panel === "record" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Record a reading</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {readable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No meter on this register can take a reading. A meter that is
                removed or disconnected is refused by the database — if it was
                replaced, record the reading against the replacement meter,
                which is a row of its own because the new dial starts at zero
                and has no arithmetic relationship to the old one.
              </p>
            ) : (
              <form
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  setError(null);
                  setNotice(null);
                  setFlag(null);
                  startTransition(async () => {
                    const res = await recordMeterReading({
                      meterId: f.get("meterId"),
                      readAt: f.get("readAt"),
                      readingValue: f.get("readingValue"),
                      source: f.get("source") || "manual",
                      status: f.get("status") || "recorded",
                      notes: f.get("notes") || null,
                    });
                    if (!res.ok) {
                      setError(res.error ?? "The reading could not be recorded.");
                      return;
                    }
                    setNotice(
                      res.data.consumption === null
                        ? "Reading recorded."
                        : `Reading recorded. ${res.data.consumption} ${
                            meter?.unit ?? "units"
                          } consumed${
                            res.data.isRollover
                              ? " — the dial was treated as having rolled over."
                              : "."
                          }`,
                    );
                    // ⭐ The trigger wrote this sentence. Verbatim.
                    if (res.data.isAnomaly && res.data.anomalyNote) {
                      setFlag(res.data.anomalyNote);
                    }
                    setTyped("");
                    router.refresh();
                  });
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="r-meter">Meter</Label>
                  <select
                    id="r-meter"
                    name="meterId"
                    required
                    className={SELECT_CLASS}
                    value={meterId}
                    onChange={(e) => setMeterId(e.target.value)}
                  >
                    {readable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.serialNumber} · {humanise(m.kind)} · {m.digitCount} digits
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="r-at">Read at</Label>
                  <Input id="r-at" name="readAt" type="datetime-local" required />
                  {/* ⚠️ When the DIAL was looked at, not when this form was
                      filled in. The whole consumption chain is built on this
                      column, so a reading entered a week late with today's
                      timestamp takes a week of somebody else's consumption
                      with it. */}
                  <p className="text-[11px] text-muted-foreground">
                    When the dial was looked at, not when this form was filled
                    in.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="r-value">Dial reading</Label>
                  <Input
                    id="r-value"
                    name="readingValue"
                    required
                    inputMode="decimal"
                    placeholder="e.g. 041237.0000"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    The cumulative total on the face of the meter — never the
                    units used since last time.
                  </p>
                </div>

                <div className="space-y-1">
                  {/* ⭐ `estimated` is a first-class source, not something to
                      avoid. Recording an estimate as `manual` to keep the
                      register tidy destroys the reconciliation the next
                      actual reading owes it. */}
                  <Label htmlFor="r-source">Source</Label>
                  <select
                    id="r-source"
                    name="source"
                    defaultValue="manual"
                    className={SELECT_CLASS}
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {humanise(s)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="r-status">Status</Label>
                  <select
                    id="r-status"
                    name="status"
                    defaultValue="recorded"
                    className={SELECT_CLASS}
                  >
                    <option value="recorded">Recorded</option>
                    <option value="validated">Validated</option>
                    <option value="disputed">Disputed</option>
                  </select>
                </div>

                <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="r-notes">Notes</Label>
                  <Textarea id="r-notes" name="notes" rows={2} maxLength={2000} />
                </div>

                {/* ── ⭐ THE PREVIEW. Courtesy, not authority. ────────── */}
                <div className="sm:col-span-2 lg:col-span-3">
                  {meter && meter.lastReadingValue !== null ? (
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                      <span className="text-muted-foreground">
                        Last dial value {meter.lastReadingValue} on this meter.{" "}
                      </span>
                      {preview ? (
                        <>
                          <span className="font-medium tabular-nums">
                            About {preview.consumption.toLocaleString("en-IN")}{" "}
                            {meter.unit}
                          </span>
                          {preview.isRollover && (
                            <span className="text-amber-700 dark:text-amber-300">
                              {" "}
                              — this is LOWER than the last reading, so it would
                              be treated as the dial rolling past{" "}
                              {"9".repeat(meter.digitCount)}. If the meter was
                              actually replaced, that is a new meter row, not a
                              rollover.
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {" "}
                            The database computes the figure that is stored —
                            chained against whatever reading actually precedes
                            this one by date, which may have synced in since
                            this page loaded.
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          Type a dial value for an estimate of the consumption.
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      This meter has no reading yet, so there is nothing to
                      preview against. The first reading is chained against the
                      meter&rsquo;s installation reading — which is why a meter
                      installed showing 1,250 does not bill its new consumer for
                      1,250 units somebody else used.
                    </p>
                  )}
                </div>

                <div className="sm:col-span-2 lg:col-span-3">
                  <Button type="submit" size="sm" disabled={pending}>
                    {pending ? "Recording…" : "Record reading"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {panel === "supersede" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Correct a reading by superseding it
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              There is no edit field for a dial value here and there is none in
              the database either — a trigger refuses the change and the
              application role holds no DELETE privilege on readings at all. The
              wrong row is marked <span className="font-mono">superseded</span>{" "}
              and the right one is recorded beside it, so the invoice that was
              computed from the wrong figure still has something to point at.
            </p>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    supersedeMeterReading({
                      id: f.get("id"),
                      readingValue: f.get("readingValue"),
                      readAt: f.get("readAt"),
                      source: f.get("source") || "manual",
                      reason: f.get("reason"),
                    }),
                  "Original marked superseded; the corrected reading is recorded beside it.",
                )
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="s-id">Reading now believed wrong</Label>
                <select id="s-id" name="id" required className={SELECT_CLASS}>
                  {readings
                    .filter((r) => r.status !== "superseded")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-value">Corrected dial reading</Label>
                <Input
                  id="s-value"
                  name="readingValue"
                  required
                  inputMode="decimal"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-at">Read at</Label>
                <Input id="s-at" name="readAt" type="datetime-local" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-source">Source</Label>
                <select
                  id="s-source"
                  name="source"
                  defaultValue="manual"
                  className={SELECT_CLASS}
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="s-reason">What was wrong with the original</Label>
                <Textarea id="s-reason" name="reason" rows={2} required maxLength={1000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  {pending ? "Recording…" : "Supersede and re-record"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "status" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dispute, validate or reject</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              The number never changes here. A disputed reading stays exactly as
              recorded and the disagreement becomes visible on the row instead
              of living in somebody&rsquo;s email. A rejected reading is dropped
              from the consumption chain by the trigger — use it for a reading
              of the wrong meter, not for a reading you dislike.
            </p>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    setMeterReadingStatus({
                      id: f.get("id"),
                      status: f.get("status"),
                      notes: f.get("notes") || null,
                    }),
                  "Reading status updated. The dial value is untouched.",
                )
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="st-id">Reading</Label>
                <select id="st-id" name="id" required className={SELECT_CLASS}>
                  {readings.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="st-status">New status</Label>
                <select
                  id="st-status"
                  name="status"
                  defaultValue="validated"
                  className={SELECT_CLASS}
                >
                  <option value="recorded">Recorded</option>
                  <option value="validated">Validated</option>
                  <option value="disputed">Disputed</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="st-notes">Note</Label>
                <Textarea id="st-notes" name="notes" rows={2} maxLength={2000} />
                <p className="text-[11px] text-muted-foreground">
                  Appended, never replacing what is already there.
                </p>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  {pending ? "Saving…" : "Update status"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
