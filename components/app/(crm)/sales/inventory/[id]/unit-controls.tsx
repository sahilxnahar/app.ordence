"use client";

/**
 * Ordence — ⭐⭐ HOLDING, BLOCKING AND CORRECTING A UNIT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE DIFFERENT OPERATIONS THAT ALL LOOK LIKE "TAKE IT OFF THE
 *    MARKET", AND THEY ARE NOT INTERCHANGEABLE
 * ══════════════════════════════════════════════════════════════════════
 *   HOLD     is for a named lead, expires on its own, and is swept by the
 *            database. It is a promise with a clock on it.
 *   BLOCK    has no lead and no clock. It is for a unit that is not
 *            saleable , a sample flat, one caught in litigation, one the
 *            landowner takes under a joint development agreement.
 *   BOOKED   is not on this screen at all, because a booking is created
 *            against a buyer and a price, not toggled.
 *
 * A screen that offered one control for all three would produce holds
 * that never expire and blocked units nobody can explain.
 *
 * ⚠️ EACH CONTROL HAS ITS OWN PERMISSION and is HIDDEN rather than
 * disabled when the person lacks it. `units:hold` and `units:block` are
 * separate keys because holding is a sales act and blocking is not.
 */

import { useState, useTransition } from "react";
import { Ban, CircleCheck, Clock, Pencil } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function UnitControls(props: {
  unitId: string;
  status: string;
  code: string;
  tower: string;
  floor: number | null;
  typology: string;
  facing: string;
  carpetAreaSqft: number | null;
  builtUpAreaSqft: number | null;
  priceRupees: string;
  leads: readonly { id: string; label: string }[];
  canUpdate: boolean;
  canHold: boolean;
  canBlock: boolean;
  update: (input: unknown) => Promise<Result<{ id: string }>>;
  hold: (input: unknown) => Promise<Result<{ unitId: string; holdUntil: string }>>;
  release: (input: unknown) => Promise<Result<{ unitId: string }>>;
  setAvailability: (input: unknown) => Promise<Result<{ unitId: string }>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /* ---- edit ------------------------------------------------------ */
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(props.code);
  const [tower, setTower] = useState(props.tower);
  const [floor, setFloor] = useState(props.floor === null ? "" : String(props.floor));
  const [typology, setTypology] = useState(props.typology);
  const [facing, setFacing] = useState(props.facing);
  const [carpet, setCarpet] = useState(
    props.carpetAreaSqft === null ? "" : String(props.carpetAreaSqft),
  );
  const [builtUp, setBuiltUp] = useState(
    props.builtUpAreaSqft === null ? "" : String(props.builtUpAreaSqft),
  );
  const [price, setPrice] = useState(props.priceRupees);

  /* ---- hold ------------------------------------------------------ */
  const [holdOpen, setHoldOpen] = useState(false);
  const [leadId, setLeadId] = useState("");
  const [days, setDays] = useState("7");
  const [tokenAmount, setTokenAmount] = useState("");
  const [holdNote, setHoldNote] = useState("");

  /* ---- block ----------------------------------------------------- */
  const [blockReason, setBlockReason] = useState("");

  function run(fn: () => Promise<Result<unknown>>, success: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(success);
    });
  }

  function save() {
    run(
      () =>
        props.update({
          id: props.unitId,
          code,
          tower: tower.trim() === "" ? null : tower.trim(),
          floor: floor.trim() === "" ? null : Number(floor),
          typology: typology.trim() === "" ? null : typology.trim(),
          facing: facing.trim() === "" ? null : facing.trim(),
          carpetAreaSqft: carpet.trim() === "" ? null : Number(carpet),
          builtUpAreaSqft: builtUp.trim() === "" ? null : Number(builtUp),
          price: price.trim() === "" ? undefined : price.trim(),
        }),
      "Unit updated.",
    );
    setEditing(false);
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      {/* ── AVAILABILITY ──────────────────────────────────────────── */}
      <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-sm font-semibold">Availability</h2>

        {props.canHold && props.status === "available" && (
          <>
            {!holdOpen ? (
              <button
                type="button"
                onClick={() => setHoldOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm"
              >
                <Clock className="h-4 w-4" aria-hidden="true" />
                Hold it for a lead
              </button>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">For</span>
                    <select
                      value={leadId}
                      onChange={(e) => setLeadId(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">Choose a lead</option>
                      {props.leads.map((lead) => (
                        <option key={lead.id} value={lead.id}>
                          {lead.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Days</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Token (₹)</span>
                    <input
                      value={tokenAmount}
                      onChange={(e) => setTokenAmount(e.target.value)}
                      inputMode="decimal"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  </label>
                </div>

                <input
                  value={holdNote}
                  onChange={(e) => setHoldNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || leadId === ""}
                    onClick={() =>
                      run(
                        () =>
                          props.hold({
                            unitId: props.unitId,
                            leadId,
                            days: days.trim() === "" ? undefined : Number(days),
                            tokenAmount: tokenAmount.trim() === "" ? undefined : tokenAmount.trim(),
                            note: holdNote.trim() === "" ? null : holdNote.trim(),
                          }),
                        "Held. It releases itself when the time is up.",
                      )
                    }
                    className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
                  >
                    {pending ? "Holding…" : "Hold it"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHoldOpen(false)}
                    className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {props.canHold && props.status === "held" && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => props.release({ unitId: props.unitId, reason: null }),
                "Hold released. The unit is back on the market.",
              )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
          >
            <CircleCheck className="h-4 w-4" aria-hidden="true" />
            Release the hold
          </button>
        )}

        {props.canBlock && (props.status === "available" || props.status === "blocked") && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              Blocking is for a unit that is not saleable at all , a sample flat, one in
              litigation, one taken by the landowner. It has no clock and no lead.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="Why"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      props.setAvailability({
                        unitId: props.unitId,
                        status: props.status === "blocked" ? "available" : "blocked",
                        reason: blockReason.trim() === "" ? null : blockReason.trim(),
                      }),
                    props.status === "blocked"
                      ? "Back on the market."
                      : "Blocked. It will not appear as available anywhere.",
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
              >
                <Ban className="h-4 w-4" aria-hidden="true" />
                {props.status === "blocked" ? "Put it back on the market" : "Block it"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── DETAILS ───────────────────────────────────────────────── */}
      {props.canUpdate && (
        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Pencil className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Details
          </h2>

          {!editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-sm underline underline-offset-2"
            >
              Correct this unit
            </button>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Code</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Tower</span>
                  <input
                    value={tower}
                    onChange={(e) => setTower(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Floor</span>
                  <input
                    type="number"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Typology</span>
                  <input
                    value={typology}
                    onChange={(e) => setTypology(e.target.value)}
                    placeholder="3BHK"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Facing</span>
                  <input
                    value={facing}
                    onChange={(e) => setFacing(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Price (₹)</span>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Carpet area (sq ft)</span>
                  <input
                    type="number"
                    value={carpet}
                    onChange={(e) => setCarpet(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Built-up area (sq ft)</span>
                  <input
                    type="number"
                    value={builtUp}
                    onChange={(e) => setBuiltUp(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
              </div>

              {/*
                ⚠️ CARPET AREA IS THE ONE A BUYER IS SOLD ON UNDER RERA,
                and correcting it after an agreement is executed is not a
                data fix , it changes what was sold.
              */}
              <p className="text-xs text-muted-foreground">
                Carpet area is the figure a buyer is sold on under RERA. Changing it after an
                agreement exists changes what was sold, not just what is recorded.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={pending}
                  className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
