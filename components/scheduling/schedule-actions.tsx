"use client";

/**
 * Ordence — ⭐ ENGINE 1 · SCHEDULE WRITE ACTIONS
 * Version: v0.69.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS COMPONENT DOES NOT CHECK AVAILABILITY BEFORE SUBMITTING
 * ══════════════════════════════════════════════════════════════════════
 * The temptation is obvious: grey out the slots that are taken, so the
 * user cannot pick a clash. It reads as helpful and it is a trap.
 *
 * Whatever this component knows about availability was true when the page
 * rendered. By the time somebody has typed a guest's name and phone
 * number, another agent may have taken the room. A greyed-out grid is a
 * promise the client cannot keep — and worse, it teaches the operator to
 * trust it, so the eventual refusal reads as a system fault rather than
 * as a room that genuinely went.
 *
 * ⭐ SO THE FORM SUBMITS OPTIMISTICALLY AND SHOWS THE DATABASE'S ANSWER.
 * The database is the only thing that knows, and it is the only thing
 * that can know under concurrency. The refusal is already written as a
 * sentence for a human — see `explainScheduleError` in the server action
 * — so surfacing it verbatim is the correct thing to do here.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveScheduleResource,
  saveScheduleBooking,
  saveScheduleBlock,
  releaseExpiredHolds,
} from "@/server/actions/scheduling";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ResourceOption = {
  id: string;
  name: string;
  code: string;
  capacity: number;
};

type Panel = "none" | "resource" | "booking" | "block";

export function ScheduleActions({ resources }: { resources: ResourceOption[] }) {
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
         * ⚠️ THE DATABASE'S REFUSAL IS SHOWN VERBATIM. It has already been
         * translated into a sentence an operator can act on. Replacing it
         * with "Could not save" here would throw away the only useful
         * part — which room, and why.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      setPanel("none");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "booking" ? "default" : "outline"}
          onClick={() => setPanel(panel === "booking" ? "none" : "booking")}
        >
          New booking
        </Button>
        <Button
          size="sm"
          variant={panel === "resource" ? "default" : "outline"}
          onClick={() => setPanel(panel === "resource" ? "none" : "resource")}
        >
          Add resource
        </Button>
        <Button
          size="sm"
          variant={panel === "block" ? "default" : "outline"}
          onClick={() => setPanel(panel === "block" ? "none" : "block")}
        >
          Take out of service
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(
              async () => {
                const r = await releaseExpiredHolds();
                if (r.ok) setNotice(`${r.data.released} expired hold(s) released.`);
                return r;
              },
              "Expired holds released.",
            )
          }
        >
          Release expired holds
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

      {panel === "booking" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New booking</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveScheduleBooking({
                      resourceId: f.get("resourceId"),
                      startsAt: f.get("startsAt"),
                      endsAt: f.get("endsAt"),
                      partyName: f.get("partyName") || null,
                      partyPhone: f.get("partyPhone") || null,
                      channel: f.get("channel") || "direct",
                      quantity: f.get("quantity") || 1,
                      quotedRateMinor: f.get("quotedRateMinor") || null,
                      status: f.get("status") || "held",
                    }),
                  "Booking recorded.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="b-resource">Resource</Label>
                <select
                  id="b-resource"
                  name="resourceId"
                  required
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-start">From</Label>
                <Input id="b-start" name="startsAt" type="datetime-local" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-end">To</Label>
                <Input id="b-end" name="endsAt" type="datetime-local" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-party">Party name</Label>
                <Input id="b-party" name="partyName" maxLength={200} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-phone">Phone</Label>
                <Input id="b-phone" name="partyPhone" maxLength={30} />
              </div>
              <div className="space-y-1">
                {/* ⭐ Channel is NOT NULL and defaults to "direct" — a blank
                    makes the cancellation rate unattributable, which is how
                    you find out an OTA sends business it cannot keep. */}
                <Label htmlFor="b-channel">Channel</Label>
                <Input id="b-channel" name="channel" defaultValue="direct" maxLength={60} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-qty">Quantity</Label>
                <Input id="b-qty" name="quantity" type="number" min={1} defaultValue={1} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-rate">Rate (paise)</Label>
                <Input id="b-rate" name="quotedRateMinor" inputMode="numeric" pattern="\d*" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-status">Type</Label>
                <select
                  id="b-status"
                  name="status"
                  defaultValue="held"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="held">Hold (expires)</option>
                  <option value="confirmed">Confirmed</option>
                </select>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || resources.length === 0}>
                  {pending ? "Saving…" : "Save booking"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  A hold occupies the resource and expires on its own. The
                  database decides whether this period is free — if it refuses,
                  the reason appears above.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "resource" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add resource</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveScheduleResource({
                      code: f.get("code"),
                      name: f.get("name"),
                      kind: f.get("kind"),
                      groupName: f.get("groupName") || null,
                      capacity: f.get("capacity"),
                      overbookLimit: f.get("overbookLimit"),
                      bufferMinutes: f.get("bufferMinutes"),
                      baseRateMinor: f.get("baseRateMinor") || null,
                      isActive: true,
                      isBookableOnline: false,
                    }),
                  "Resource saved.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="r-code">Code</Label>
                <Input id="r-code" name="code" required maxLength={60} placeholder="101" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-name">Name</Label>
                <Input id="r-name" name="name" required maxLength={200} placeholder="Deluxe 101" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-kind">Kind</Label>
                <select
                  id="r-kind"
                  name="kind"
                  defaultValue="room"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {["room","bed","table","hall","practitioner","vehicle","equipment","staff","slot","other"].map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-group">Group</Label>
                <Input id="r-group" name="groupName" maxLength={120} placeholder="First floor" />
              </div>
              <div className="space-y-1">
                {/* ⚠️ 1 vs >1 selects a completely different protection
                    mechanism in the database. Worth saying so. */}
                <Label htmlFor="r-cap">Capacity</Label>
                <Input id="r-cap" name="capacity" type="number" min={1} defaultValue={1} required />
                <p className="text-[11px] text-muted-foreground">
                  1 = exclusive, and double-booking becomes impossible.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-over">Overbooking allowance</Label>
                <Input id="r-over" name="overbookLimit" type="number" min={0} defaultValue={0} />
                <p className="text-[11px] text-muted-foreground">
                  0 = cannot be oversold at all.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-buf">Changeover buffer (min)</Label>
                <Input id="r-buf" name="bufferMinutes" type="number" min={0} defaultValue={0} />
                <p className="text-[11px] text-muted-foreground">
                  Becomes part of the reserved period, not a separate check.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="r-rate">Base rate (paise)</Label>
                <Input id="r-rate" name="baseRateMinor" inputMode="numeric" pattern="\d*" />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Save resource"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "block" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Take out of service</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveScheduleBlock({
                      resourceId: f.get("resourceId"),
                      kind: f.get("kind"),
                      reason: f.get("reason"),
                      startsAt: f.get("startsAt"),
                      endsAt: f.get("endsAt"),
                    }),
                  "Resource taken out of service.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="k-resource">Resource</Label>
                <select
                  id="k-resource"
                  name="resourceId"
                  required
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="k-kind">Why</Label>
                <select
                  id="k-kind"
                  name="kind"
                  defaultValue="maintenance"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {["maintenance","cleaning","closed","holiday","reserved_internal","breakdown","other"].map((k) => (
                    <option key={k} value={k}>{k.replace("_", " ")}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⚠️ Required. A resource out of service with no stated
                    reason is one nobody dares put back. */}
                <Label htmlFor="k-reason">Detail</Label>
                <Input id="k-reason" name="reason" required maxLength={300} placeholder="AC compressor failed" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="k-start">From</Label>
                <Input id="k-start" name="startsAt" type="datetime-local" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="k-end">To</Label>
                <Input id="k-end" name="endsAt" type="datetime-local" required />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || resources.length === 0}>
                  {pending ? "Saving…" : "Take out of service"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  This will be refused if a live booking already covers the
                  period — blocking a room somebody is checked into would put a
                  guest, formally, in a room that is out of service. Move or
                  cancel the booking first.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
