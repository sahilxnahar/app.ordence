"use client";

/**
 * Ordence — ⭐ MEASUREMENT BOOK ENTRY & CHECK
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM IS SHAPED LIKE A MEASUREMENT BOOK, NOT LIKE A DATABASE ROW
 * ══════════════════════════════════════════════════════════════════════
 * A site engineer does not know a quantity. They know
 *
 *     nos × length × breadth × depth
 *
 * and that is what the page in the physical MB has columns for. A form
 * with a single "quantity" box asks them to do the arithmetic on a phone,
 * at site, and type the answer — which is where transcription errors come
 * from, and where a falsified quantity hides.
 *
 * ⚠️ SO THE DIMENSIONS ARE THE INPUT AND THE TOTAL IS SHOWN, NOT TYPED.
 * The preview below is computed in the browser purely so the engineer can
 * see the number before submitting. The SERVER recomputes it from the same
 * dimensions and stores that — the browser's figure is never sent. If the
 * two ever disagreed, the server's is the one that counts, and the
 * engineer would see the difference on the next render rather than
 * silently getting their own arithmetic stored.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A DEDUCTION IS A TICKBOX, NEVER A MINUS SIGN
 * ══════════════════════════════════════════════════════════════════════
 * A lift shaft void is entered as a POSITIVE size with "deduction"
 * ticked. Typing −40 would be rejected by the server, and rightly: the
 * consumption view and the billing view read the `is_deduction` FLAG, so
 * a negative quantity would be counted as work-of-negative-size by one
 * and as a deduction by the other. The two reports would disagree with
 * nothing to say which was right.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordMeasurement, checkMeasurement } from "@/server/actions/construction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type MeasurableItem = { id: string; itemCode: string; description: string; uom: string };
export type BookOption = { id: string; bookNumber: string };

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        {notice}
      </p>
    );
  }
  return null;
}

/**
 * Multiply the supplied dimensions, for DISPLAY ONLY.
 *
 * ⚠️ THIS VALUE IS NEVER SENT. The server multiplies the same dimensions
 * in BigInt micro-units and stores that result. Sending this number
 * instead would put a float in the middle of a quantity that ends up on
 * an invoice — and it would be invisible, because the two agree for every
 * value anybody tests with.
 *
 * Returns null when nothing has been entered, so the caller can say
 * nothing rather than show a confident "0.000".
 */
function previewQuantity(parts: Array<string | null>): string | null {
  const given = parts.filter((p): p is string => p != null && p.trim() !== "");
  if (given.length === 0) return null;

  let product = 1;
  for (const part of given) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    product *= value;
  }
  return product.toFixed(3);
}

/* ------------------------------------------------------------------ */
/* RECORD                                                              */
/* ------------------------------------------------------------------ */

export function RecordMeasurementForm({
  books,
  items,
}: {
  books: BookOption[];
  items: MeasurableItem[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [measurementBookId, setBookId] = useState(books[0]?.id ?? "");
  const [boqItemId, setItemId] = useState(items[0]?.id ?? "");
  const [locationRef, setLocation] = useState("");
  const [levelRef, setLevel] = useState("");
  const [measuredOn, setMeasuredOn] = useState("");
  const [nos, setNos] = useState("");
  const [length, setLength] = useState("");
  const [breadth, setBreadth] = useState("");
  const [depth, setDepth] = useState("");
  const [isDeduction, setIsDeduction] = useState(false);
  const [notes, setNotes] = useState("");

  const preview = useMemo(
    () => previewQuantity([nos, length, breadth, depth]),
    [nos, length, breadth, depth],
  );

  const selectedItem = items.find((item) => item.id === boqItemId);

  if (books.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        Open a measurement book before recording measurements. A measurement with no book has
        no page reference and nothing to certify against.
      </p>
    );
  }

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await recordMeasurement({
        measurementBookId,
        boqItemId,
        locationRef,
        levelRef: levelRef || null,
        measuredOn,
        nos: nos || null,
        length: length || null,
        breadth: breadth || null,
        depth: depth || null,
        isDeduction,
        notes: notes || null,
      });

      if (!result.ok) {
        setError(result.error ?? "That measurement could not be recorded.");
        return;
      }

      setNotice(
        "Measurement recorded. It has to be checked by somebody else before it can be billed.",
      );
      setLocation("");
      setNos("");
      setLength("");
      setBreadth("");
      setDepth("");
      setNotes("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
        {open ? "Cancel" : "Record a measurement"}
      </Button>

      <Feedback error={error} notice={notice} />

      {open && (
        <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="me-book">Book</Label>
            <select
              id="me-book"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={measurementBookId}
              onChange={(e) => setBookId(e.target.value)}
            >
              {books.map((book) => (
                <option key={book.id} value={book.id}>{book.bookNumber}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label htmlFor="me-item">BOQ item</Label>
            <select
              id="me-item"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={boqItemId}
              onChange={(e) => setItemId(e.target.value)}
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.itemCode} — {item.description}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="me-location">Where</Label>
            <Input
              id="me-location"
              value={locationRef}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Grid A1–A4, plinth to first floor"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="me-level">Level</Label>
            <Input
              id="me-level"
              value={levelRef}
              onChange={(e) => setLevel(e.target.value)}
              placeholder="+3.60"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="me-date">Measured on</Label>
            <Input
              id="me-date"
              type="date"
              value={measuredOn}
              onChange={(e) => setMeasuredOn(e.target.value)}
            />
          </div>

          {/*
            ⚠️ THE FOUR MB COLUMNS, IN THE ORDER THEY APPEAR ON THE PAPER
            PAGE. An engineer transcribing from a physical book reads left
            to right; a form in a different order costs them a mistake per
            page.
          */}
          {([
            ["me-nos", "Nos", nos, setNos, "2"],
            ["me-length", "Length", length, setLength, "8.400"],
            ["me-breadth", "Breadth", breadth, setBreadth, "0.300"],
            ["me-depth", "Depth", depth, setDepth, "0.450"],
          ] as const).map(([id, label, value, setter, placeholder]) => (
            <div key={id} className="space-y-1">
              <Label htmlFor={id}>{label}</Label>
              <Input
                id={id}
                inputMode="decimal"
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={placeholder}
              />
            </div>
          ))}

          <div className="sm:col-span-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 p-3">
              <div className="text-sm">
                {preview ? (
                  <>
                    <span className="text-muted-foreground">Works out to </span>
                    <span className="font-medium tabular-nums">
                      {preview} {selectedItem?.uom ?? ""}
                    </span>
                    {/*
                      Stated plainly: this figure is a convenience, not the
                      record. The server recomputes from the dimensions.
                    */}
                    <span className="ml-2 text-xs text-muted-foreground">
                      (recalculated on save from the dimensions above)
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Enter the dimensions — the quantity is worked out from them.
                  </span>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isDeduction}
                  onChange={(e) => setIsDeduction(e.target.checked)}
                />
                This is a deduction (a void, an opening, a cut-out)
              </label>
            </div>
            {isDeduction && (
              <p className="mt-2 text-xs text-muted-foreground">
                Enter the size of the void as a positive number. It will be subtracted, not
                added.
              </p>
            )}
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label htmlFor="me-notes">Notes</Label>
            <Input
              id="me-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex items-end">
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending ? "Recording…" : "Record"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CHECK                                                               */
/* ------------------------------------------------------------------ */

/**
 * Accept or reject one measurement.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE BUTTONS ARE SHOWN EVEN WHEN THE SERVER WILL REFUSE
 * ══════════════════════════════════════════════════════════════════════
 * `viewerIsMeasurer` is passed in, and the obvious move is to hide the
 * controls when it is true. That is worse, and it took thinking about.
 *
 * Hidden buttons teach nothing. An engineer who measured a line and finds
 * no check button assumes the screen is broken, or that checking happens
 * somewhere else, and goes looking — or asks a colleague to "just click
 * it" without saying why. Stating the rule at the moment it applies is
 * how somebody learns that measuring and checking are meant to be two
 * people, which is the actual goal.
 *
 * So the reason is shown instead, and the server refuses if it is
 * somehow submitted anyway.
 */
export function CheckMeasurementControls({
  measurementEntryId,
  viewerIsMeasurer,
}: {
  measurementEntryId: string;
  viewerIsMeasurer: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  if (viewerIsMeasurer) {
    return (
      <span className="text-xs text-muted-foreground">
        You recorded this — somebody else has to check it
      </span>
    );
  }

  function send(accept: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await checkMeasurement({
        measurementEntryId,
        accept,
        rejectionReason: accept ? null : reason,
      });
      if (!result.ok) {
        setError(result.error ?? "That could not be saved.");
        return;
      }
      setRejecting(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {!rejecting ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => send(true)}>
            Check
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What needs remeasuring?"
            aria-label="Rejection reason"
          />
          {/*
            The reason is required by the server, and the sentence explains
            why rather than just enforcing it: a rejection sends somebody
            back to site, and they need to know what to remeasure.
          */}
          <p className="text-xs text-muted-foreground">
            This sends somebody back to site. Tell them what to remeasure.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => send(false)}>
              {pending ? "Rejecting…" : "Reject it"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
