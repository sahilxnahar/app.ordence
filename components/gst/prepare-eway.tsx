"use client";

/**
 * Ordence — ⭐ Preparing an e-way bill from an issued invoice
 * Version: v1.3.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FORM ANSWERS "HOW LONG IS THIS GOOD FOR" WHILE IT IS BEING
 *    FILLED IN, NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * Distance is the only input on this form that decides validity, and the
 * person typing it usually does not know that. Showing the resulting
 * number of days beside the box turns a guess into a decision — and
 * makes over-dimensional cargo, which gets 20 km per day rather than
 * 200, impossible to miss.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { prepareEwayBill } from "@/server/actions/eway";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  EWAY_SUB_SUPPLY_TYPES,
  EWAY_MAX_DISTANCE_KM,
  ewayValidityDays,
  isValidVehicleNumber,
  partBRequired,
  type EwaySubSupplyType,
} from "@/lib/gst/eway";

export function PrepareEway({
  invoiceId,
  invoiceNumber,
  isInterState,
  defaultFromStateCode,
  defaultToStateCode,
}: {
  invoiceId: string;
  invoiceNumber: string;
  isInterState: boolean;
  defaultFromStateCode: string | null;
  defaultToStateCode: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fromPincode, setFromPincode] = useState("");
  const [fromPlace, setFromPlace] = useState("");
  const [toPincode, setToPincode] = useState("");
  const [toPlace, setToPlace] = useState("");
  const [distanceKm, setDistanceKm] = useState("");
  const [vehicleType, setVehicleType] = useState<"regular" | "odc">("regular");
  const [subSupplyType, setSubSupplyType] = useState<EwaySubSupplyType>("supply");
  const [transporterName, setTransporterName] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [voluntary, setVoluntary] = useState(false);

  const km = Number(distanceKm);
  const kmValid = Number.isInteger(km) && km >= 0 && km <= EWAY_MAX_DISTANCE_KM;

  const days = useMemo(() => {
    if (!kmValid) return null;
    try {
      return ewayValidityDays(km, vehicleType);
    } catch {
      return null;
    }
  }, [km, kmValid, vehicleType]);

  /**
   * ⚠️ SAID BEFORE SOMEBODY GOES LOOKING FOR A LORRY NUMBER. Part B is
   * excused only for a short leg WITHIN the State — and the inter-state
   * half is the one people drop.
   */
  const partB = useMemo(
    () => partBRequired({ distanceKm: kmValid ? km : 0, isInterState, isTransporterLeg: true }),
    [km, kmValid, isInterState],
  );

  const vehicleLooksWrong = vehicleNo.trim() !== "" && !isValidVehicleNumber(vehicleNo);

  function submit() {
    setError(null);
    if (!/^\d{6}$/.test(fromPincode) || !/^\d{6}$/.test(toPincode)) {
      setError("Both PIN codes are six digits — the portal computes the route from them.");
      return;
    }
    if (!kmValid) {
      setError(`Distance must be a whole number of kilometres, up to ${EWAY_MAX_DISTANCE_KM}.`);
      return;
    }
    start(async () => {
      const res = await prepareEwayBill({
        invoiceId,
        fromPincode,
        toPincode,
        ...(fromPlace.trim() ? { fromPlace: fromPlace.trim() } : {}),
        ...(toPlace.trim() ? { toPlace: toPlace.trim() } : {}),
        ...(defaultFromStateCode ? { dispatchStateCode: defaultFromStateCode } : {}),
        ...(defaultToStateCode ? { deliveryStateCode: defaultToStateCode } : {}),
        distanceKm: km,
        vehicleType,
        subSupplyType,
        ...(transporterName.trim() ? { transporterName: transporterName.trim() } : {}),
        ...(vehicleNo.trim()
          ? { partB: { transportMode: "road" as const, vehicleNo: vehicleNo.trim() } }
          : {}),
        voluntary,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/gst/eway/${res.data.id}`);
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Prepare e-way bill
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <p className="font-medium">{invoiceNumber}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`ew-fp-${invoiceId}`} required>
            Dispatch PIN code
          </Label>
          <Input
            id={`ew-fp-${invoiceId}`}
            value={fromPincode}
            onChange={(e) => setFromPincode(e.target.value)}
            placeholder="411001"
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ew-fpl-${invoiceId}`}>Dispatch from</Label>
          <Input
            id={`ew-fpl-${invoiceId}`}
            value={fromPlace}
            onChange={(e) => setFromPlace(e.target.value)}
            placeholder="Pune"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ew-tp-${invoiceId}`} required>
            Delivery PIN code
          </Label>
          <Input
            id={`ew-tp-${invoiceId}`}
            value={toPincode}
            onChange={(e) => setToPincode(e.target.value)}
            placeholder="560001"
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ew-tpl-${invoiceId}`}>Deliver to</Label>
          <Input
            id={`ew-tpl-${invoiceId}`}
            value={toPlace}
            onChange={(e) => setToPlace(e.target.value)}
            placeholder="Bengaluru"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={`ew-km-${invoiceId}`} required>
            Distance (km)
          </Label>
          <Input
            id={`ew-km-${invoiceId}`}
            value={distanceKm}
            onChange={(e) => setDistanceKm(e.target.value)}
            placeholder="840"
            className="tabular-nums"
          />
          {days !== null && (
            <p className="text-xs font-medium">
              {/**
               * ⭐ THE ANSWER TO THE ONLY QUESTION THAT MATTERS ON THIS
               * FORM, shown while it is being answered.
               */}
              Valid for {days} day{days === 1 ? "" : "s"} once the vehicle is
              entered.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`ew-vt-${invoiceId}`}>Cargo</Label>
          <Select
            id={`ew-vt-${invoiceId}`}
            value={vehicleType}
            onChange={(e) => setVehicleType(e.target.value as "regular" | "odc")}
          >
            <option value="regular">Regular — 200 km per day</option>
            <option value="odc">Over dimensional — 20 km per day</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ A transformer or a turbine blade moves at night under
             * escort. Giving it the regular allowance expires the bill
             * halfway through a lawful journey.
             */}
            Over-dimensional cargo gets a tenth of the daily distance.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`ew-ss-${invoiceId}`}>Reason for movement</Label>
          <Select
            id={`ew-ss-${invoiceId}`}
            value={subSupplyType}
            onChange={(e) => setSubSupplyType(e.target.value as EwaySubSupplyType)}
          >
            {(Object.keys(EWAY_SUB_SUPPLY_TYPES) as EwaySubSupplyType[]).map((k) => (
              <option key={k} value={k}>
                {EWAY_SUB_SUPPLY_TYPES[k]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`ew-tn-${invoiceId}`}>Transporter</Label>
          <Input
            id={`ew-tn-${invoiceId}`}
            value={transporterName}
            onChange={(e) => setTransporterName(e.target.value)}
            placeholder="VRL Logistics"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={`ew-vn-${invoiceId}`}>Vehicle number (Part B)</Label>
          <Input
            id={`ew-vn-${invoiceId}`}
            value={vehicleNo}
            onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
            placeholder="MH12AB1234"
            className="uppercase tabular-nums"
          />
          {vehicleLooksWrong ? (
            <p className="text-xs text-destructive">
              The portal will not accept that format.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {partB.allowed
                ? "Leave blank if the lorry is not assigned yet — the clock starts when it is."
                : partB.reason}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id={`ew-vol-${invoiceId}`}
          type="checkbox"
          checked={voluntary}
          onChange={(e) => setVoluntary(e.target.checked)}
          className="h-4 w-4"
        />
        <Label htmlFor={`ew-vol-${invoiceId}`}>
          Raise it voluntarily even if the consignment is under the threshold
        </Label>
      </div>

      <div className="rounded border-l-2 border-sky-500 bg-sky-50 p-3">
        <p className="font-medium">
          {/**
           * 🔴 SAID ON EVERY PREPARE, because the alternative is somebody
           * dispatching on a `prepared` row that looks like coverage.
           */}
          This prepares the bill and builds the NIC upload file. It does not
          generate anything on the portal — nothing may move until the number
          comes back and is recorded here.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Preparing…" : "Prepare"}
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
