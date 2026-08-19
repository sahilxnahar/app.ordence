"use client";

/**
 * Ordence — ⭐⭐ E-WAY BILL · the buttons that put a lorry on a road
 * Version: v1.3.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY CONTROL HERE SAYS WHAT IT DOES TO THE TRUCK
 * ══════════════════════════════════════════════════════════════════════
 * "Update Part B" is a form field. "Without a vehicle number this
 * consignment cannot lawfully move" is a consequence. The person
 * pressing these is usually in a dispatch bay with a driver waiting, and
 * they will read exactly one line.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addEwayLeg,
  cancelEwayBill,
  extendEwayValidity,
  recordEwayNumber,
} from "@/server/actions/eway";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  canCancelEway,
  canExtendEway,
  ewayValidityDays,
  isValidVehicleNumber,
  EWAY_EXTENSION_WINDOW_HOURS,
} from "@/lib/gst/eway";

const MODES = [
  ["road", "Road"],
  ["rail", "Rail"],
  ["air", "Air"],
  ["ship", "Ship"],
] as const;

/* ------------------------------------------------------------------ */

/**
 * ⭐ RECORD THE NUMBER THE PORTAL GAVE BACK.
 *
 * ⚠️ THE FORM ASKS FOR THE GENERATION INSTANT, NOT "NOW". A bill
 * generated at 11pm and typed in at 9am the next morning has already
 * used a night of its validity, and defaulting to `now` would overstate
 * how long the consignment has left — in the direction that gets a lorry
 * stopped.
 */
export function RecordEwayNumber({
  ewayBillId,
  hasPartB,
}: {
  ewayBillId: string;
  hasPartB: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ewbNo, setEwbNo] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");

  function submit() {
    setError(null);
    if (!/^\d{12}$/.test(ewbNo.trim())) {
      setError("An e-way bill number is exactly twelve digits.");
      return;
    }
    if (!generatedAt) {
      setError("When did the portal generate it? The validity is counted from then.");
      return;
    }
    start(async () => {
      const res = await recordEwayNumber({
        ewayBillId,
        ewbNo: ewbNo.trim(),
        generatedAt: new Date(generatedAt).toISOString(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Record portal number
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ewb-no" required>
            E-way bill number
          </Label>
          <Input
            id="ewb-no"
            value={ewbNo}
            onChange={(e) => setEwbNo(e.target.value)}
            placeholder="121000123456"
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ewb-at" required>
            Generated at
          </Label>
          <Input
            id="ewb-at"
            type="datetime-local"
            value={generatedAt}
            onChange={(e) => setGeneratedAt(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/* Not "now" — a bill typed in the morning may be hours old. */}
            The time on the portal, not the time you are typing this.
          </p>
        </div>
      </div>

      {!hasPartB && (
        <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3">
          <p className="font-medium">
            {/**
             * ⚠️ A PART A WITH NO PART B IS LAWFUL AND IS NOT COVERAGE.
             * The clock has not started, and neither may the lorry.
             */}
            There is no vehicle on this bill yet, so no validity starts and
            nothing may move. Add the conveyance when the goods are loaded.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ADD A LEG. Never an edit.
 *
 * 🔴 THE FORM SAYS SO OUT LOUD, because the natural expectation of an
 *    "update vehicle" button is that it replaces what was there. It does
 *    not, and the previous leg is the evidence that the first half of
 *    the journey was lawful.
 */
export function AddEwayLeg({
  ewayBillId,
  nextLegNo,
}: {
  ewayBillId: string;
  nextLegNo: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [transportMode, setTransportMode] = useState<"road" | "rail" | "air" | "ship">(
    "road",
  );
  const [vehicleNo, setVehicleNo] = useState("");
  const [docNo, setDocNo] = useState("");
  const [fromPlace, setFromPlace] = useState("");
  const [reasonNote, setReasonNote] = useState("");

  const vehicleLooksWrong =
    transportMode === "road" && vehicleNo.trim() !== "" && !isValidVehicleNumber(vehicleNo);

  function submit() {
    setError(null);
    start(async () => {
      const res = await addEwayLeg({
        ewayBillId,
        transportMode,
        ...(vehicleNo.trim() ? { vehicleNo: vehicleNo.trim() } : {}),
        ...(docNo.trim() ? { transporterDocNo: docNo.trim() } : {}),
        ...(fromPlace.trim() ? { fromPlace: fromPlace.trim() } : {}),
        ...(reasonNote.trim() ? { reasonNote: reasonNote.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setVehicleNo("");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {nextLegNo === 1 ? "Add the vehicle (Part B)" : "Transshipment — new vehicle"}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <p className="font-medium">Leg {nextLegNo}</p>
      {nextLegNo > 1 && (
        <p className="text-xs text-muted-foreground">
          {/**
           * 🔴 The clock does NOT restart. Recomputing validity from a
           * later leg would silently extend every bill by changing
           * lorries — the exact abuse the extension window exists to
           * prevent, achieved without it noticing.
           */}
          This adds a leg. The previous vehicle stays on the record, and the
          validity does <span className="font-medium">not</span> restart — changing
          lorries buys no extra time.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`leg-mode-${nextLegNo}`}>Mode</Label>
          <Select
            id={`leg-mode-${nextLegNo}`}
            value={transportMode}
            onChange={(e) =>
              setTransportMode(e.target.value as "road" | "rail" | "air" | "ship")
            }
          >
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>

        {transportMode === "road" ? (
          <div className="space-y-1">
            <Label htmlFor={`leg-veh-${nextLegNo}`} required>
              Vehicle number
            </Label>
            <Input
              id={`leg-veh-${nextLegNo}`}
              value={vehicleNo}
              onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
              placeholder="MH12AB1234"
              className="uppercase tabular-nums"
            />
            {vehicleLooksWrong && (
              <p className="text-xs text-destructive">
                {/* Refused here rather than at the portal, with a lorry loaded. */}
                The portal will not accept that format. Use the plate as written,
                without spaces.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor={`leg-doc-${nextLegNo}`} required>
              Transport document number
            </Label>
            <Input
              id={`leg-doc-${nextLegNo}`}
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="Railway receipt / airway bill / bill of lading"
            />
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor={`leg-from-${nextLegNo}`}>From</Label>
          <Input
            id={`leg-from-${nextLegNo}`}
            value={fromPlace}
            onChange={(e) => setFromPlace(e.target.value)}
            placeholder="Nagpur"
          />
        </div>
      </div>

      <Textarea
        value={reasonNote}
        onChange={(e) => setReasonNote(e.target.value)}
        placeholder="Cross-docked at Nagpur hub; original vehicle returned."
        rows={2}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : `Add leg ${nextLegNo}`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ EXTEND — and the button is only offered inside the window.
 *
 * ⚠️ A TRANSPORTER WHO TRIES EARLY AND IS REFUSED WILL NOT TRY AGAIN IN
 * the window that would have worked. So the screen states when the
 * window opens rather than presenting a control that fails.
 */
export function ExtendEway({
  ewayBillId,
  validUntilIso,
  generatedAtIso,
  distanceKm,
  vehicleType,
}: {
  ewayBillId: string;
  validUntilIso: string;
  generatedAtIso: string;
  distanceKm: number;
  vehicleType: "regular" | "odc";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingKm, setRemainingKm] = useState(String(distanceKm));
  const [reason, setReason] = useState("");

  /**
   * ⚠️ EVALUATED WITH AN EXPLICIT `now`, from the same pure function the
   * server uses. Two implementations of an eight-hour window is two
   * answers to "can I extend", and the person reading the screen would
   * believe the wrong one.
   */
  const verdict = useMemo(
    () =>
      canExtendEway({
        validUntil: new Date(validUntilIso),
        originalGeneratedAt: new Date(generatedAtIso),
        now: new Date(),
      }),
    [validUntilIso, generatedAtIso],
  );

  const newDays = useMemo(() => {
    const km = Number(remainingKm);
    if (!Number.isInteger(km) || km < 0) return null;
    try {
      return ewayValidityDays(km, vehicleType);
    } catch {
      return null;
    }
  }, [remainingKm, vehicleType]);

  function submit() {
    setError(null);
    const km = Number(remainingKm);
    if (!Number.isInteger(km) || km < 0) {
      setError("How many kilometres are left to run?");
      return;
    }
    if (reason.trim().length < 3) {
      setError("Say why. The portal asks for it too.");
      return;
    }
    start(async () => {
      const res = await extendEwayValidity({
        ewayBillId,
        remainingKm: km,
        reason: reason.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!verdict.allowed) {
    return (
      <p className="text-xs text-muted-foreground">
        Extension: {verdict.reason}
      </p>
    );
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Extend validity
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <p className="text-xs text-muted-foreground">
        The window is {EWAY_EXTENSION_WINDOW_HOURS} hours either side of expiry.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ext-km" required>
            Kilometres still to run
          </Label>
          <Input
            id="ext-km"
            value={remainingKm}
            onChange={(e) => setRemainingKm(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ REMAINING, NOT ORIGINAL. A lorry broken down 80 km short
             * does not need another 1,200 km of validity, and declaring
             * one describes a journey that is not happening.
             */}
            What is left, not the original distance
            {newDays !== null ? ` — that is ${newDays} more day${newDays === 1 ? "" : "s"}` : ""}.
          </p>
        </div>
      </div>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Vehicle breakdown at Dhule; replacement arranged."
        rows={2}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Extending…" : "Extend"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ CANCEL — inside 24 hours, and never after verification in transit.
 *
 * ⚠️ THE VERIFICATION QUESTION IS ASKED, because Rule 138(9)'s proviso
 * is absolute and the portal enforces it. Software that only counts the
 * hours offers a button the portal refuses, which teaches people to
 * distrust the screen.
 */
export function CancelEway({
  ewayBillId,
  generatedAtIso,
}: {
  ewayBillId: string;
  generatedAtIso: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [verified, setVerified] = useState(false);

  const verdict = useMemo(
    () =>
      canCancelEway({
        generatedAt: generatedAtIso ? new Date(generatedAtIso) : null,
        now: new Date(),
        verifiedInTransit: verified,
      }),
    [generatedAtIso, verified],
  );

  function submit() {
    setError(null);
    if (reason.trim().length < 3) {
      setError("A cancellation carries a reason.");
      return;
    }
    start(async () => {
      const res = await cancelEwayBill({
        ewayBillId,
        reason: reason.trim(),
        verifiedInTransit: verified,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Cancel this e-way bill
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <div className="flex items-center gap-2">
        <input
          id="ewb-verified"
          type="checkbox"
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
          className="h-4 w-4"
        />
        <Label htmlFor="ewb-verified">
          This consignment has been verified in transit by an officer
        </Label>
      </div>

      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Order cancelled by the customer before dispatch."
        rows={2}
      />

      {!verdict.allowed ? (
        <p className="text-sm text-destructive">{verdict.reason}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {/* Not deleted — the portal keeps it and so do we. */}
          The record stays. A cancelled e-way bill is a movement that was
          declared and did not happen, and deleting it would remove the only
          evidence that the declaration was made.
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={submit}
          disabled={pending || !verdict.allowed}
        >
          {pending ? "Cancelling…" : "Cancel it"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Keep it
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ THE NIC JSON, copied to the clipboard or downloaded.
 *
 * ⚠️ THIS IS THE HONEST SHAPE OF A PRODUCT WITH NO GSP CREDENTIALS.
 * Ordence builds the payload; a human uploads it; the number comes back
 * and is recorded. Pretending to submit it would produce a screen that
 * LOOKS like it raised an e-way bill and did not.
 */
export function EwayPayload({ payload }: { payload: string }) {
  const [copied, setCopied] = useState(false);

  function download() {
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "eway-bill.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={download}>
          Download NIC JSON
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
        {payload}
      </pre>
    </div>
  );
}
