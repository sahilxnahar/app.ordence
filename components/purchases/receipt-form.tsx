"use client";

/**
 * Ordence — ⭐⭐ THE FORM THAT BOOKS GOODS IN
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 38, second half)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `recordGoodsReceipt` HAD NO CALLER, AND v1.43.0 MADE THAT WORSE
 * ══════════════════════════════════════════════════════════════════════
 * The first half of this batch fixed the receipt so that it finally
 * writes `stock_movements` — until then inventory could only ever go
 * down, because `sales_dispatch` wrote movements and `purchase_receipt`
 * did not. That fix landed in an action nothing in the product called.
 * The only way a receipt existed was an INSERT at a psql prompt, so the
 * only way stock ever went up was the same.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE THINGS THIS FORM ASKS FOR BEFORE SAVING, NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * ① A WAREHOUSE, whenever any line being accepted is a stock item.
 *    `recordGoodsReceipt` REFUSES such a receipt without one, by design:
 *    defaulting to "the first warehouse" would put a hundred bags of
 *    cement in whichever godown happened to sort first. Discovering that
 *    at save time, after typing twelve lines, is how an operator learns
 *    to distrust the save button.
 * ② A REJECTION REASON, whenever anything is rejected. The server carries
 *    the same rule and 0063 carries it underneath as a CHECK. Firing the
 *    action and surfacing "a reason is required" teaches people to type
 *    "damaged" on every receipt, which is not a reason, it is a ritual.
 * ③ TWO SEPARATE QUANTITIES, always. Forty bags arrive, six are torn,
 *    thirty-four are accepted. One box would force a lie: "forty" pays
 *    for six torn bags, "thirty-four" loses the fact that six came and
 *    went back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND IT COMPUTES NO MONEY AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * The value of a receipt is `accepted × the order's unit price`, and the
 * server already does that in bigint to set `unitCostMinor` on the
 * movement. A running total here would be a second implementation in
 * floating point, in a browser, and the two would disagree by a paisa on
 * the first part-delivery. The rate is shown; nothing is multiplied.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * ⚠️ THE LOOSE SHAPE, DELIBERATELY. Both actions return richer types than
 * this screen reads — `runThreeWayMatch` returns findings and a bigint
 * net impact — and narrowing the prop to those types would couple a
 * client component to `MatchResult` for data it never renders.
 */
type Act<T> = (input: unknown) => Promise<
  { ok: true; data: T } | { ok: false; error: string }
>;

export type ReceiptLine = {
  id: string;
  lineNo: number;
  description: string;
  /** ⭐ Null for a service, freight or a one-off. It moves no stock. */
  stockItemId: string | null;
  stockItemName: string | null;
  uom: string;
  /** ⚠️ Thousandths, as a string. Never a number, at any width. */
  orderedQty: string;
  receivedQty: string;
  unitPriceMinor: string;
};

type Warehouse = { id: string; label: string; hint?: string };

/**
 * ⭐ THOUSANDTHS TO A READABLE QUANTITY, WITH STRING ARITHMETIC.
 *
 * 🔴 `Number(thousandths) / 1000` IS THE OBVIOUS VERSION AND IT IS WRONG
 * TWICE. It loses precision above 2^53 — a cement ledger held in grams
 * gets there — and it renders 12.340 as "12.34", which reads back as a
 * different string from the one the server stored. BigInt division with a
 * padded remainder can do neither.
 */
function fromThousandths(v: string): string {
  const n = BigInt(v || "0");
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? "-" : ""}${abs / 1000n}.${(abs % 1000n).toString().padStart(3, "0")}`;
}

/** The same conversion the server does, so "over-delivery" can be judged here. */
function toThousandths(decimal: string): bigint {
  const [whole = "0", frac = ""] = decimal.split(".");
  return BigInt(whole || "0") * 1000n + BigInt((frac + "000").slice(0, 3));
}

/** ⚠️ Paise to rupees for display only. The arithmetic never leaves bigint. */
function rupees(minor: string): string {
  const n = BigInt(minor || "0");
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? "-" : ""}₹${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * ⭐ THE SERVER'S OWN QUANTITY GRAMMAR, MIRRORED.
 *
 * ⚠️ A MIRROR IS NOT A SECOND SOURCE OF TRUTH. `receiveSchema` accepts
 * `^\d+(\.\d{1,3})?$` and `toThousandths` throws on anything else. If
 * this drifts the screen refuses something the server would have taken,
 * which is a puzzled operator. Were it absent, "40 bags" would round-trip
 * and come back as a zod message quoting a regular expression, which is
 * worse.
 */
const QUANTITY = /^\d+(\.\d{1,3})?$/;

type Parsed = { ok: boolean; value: string; positive: boolean };

/** ⭐ Blank means "none of this line", which is a legitimate answer. */
function quantityOf(raw: string): Parsed {
  const t = raw.trim();
  if (t === "") return { ok: true, value: "0", positive: false };
  if (!QUANTITY.test(t)) return { ok: false, value: t, positive: false };
  // ⚠️ A digit test, not `Number(t) > 0`. The string has already been
  // proved to be digits and at most one point, so a non-zero digit
  // anywhere in it means a non-zero quantity, at any magnitude.
  return { ok: true, value: t, positive: /[1-9]/.test(t) };
}

export function ReceiptForm({
  poId,
  poStatus,
  lines,
  warehouses,
  today,
  action,
}: {
  poId: string;
  poStatus: string;
  lines: readonly ReceiptLine[];
  warehouses: readonly Warehouse[];
  today: string;
  action: Act<{ id: string; grnNumber: string; poStatus: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [receivedOn, setReceivedOn] = useState(today);
  const [challanNo, setChallanNo] = useState("");
  const [challanDate, setChallanDate] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [entries, setEntries] = useState<
    Record<string, { accepted: string; rejected: string }>
  >({});

  const entryOf = (id: string) => entries[id] ?? { accepted: "", rejected: "" };

  /**
   * ⭐ WHAT THE FORM ALREADY KNOWS, recomputed as the operator types, so
   * every requirement appears while it can still be met rather than as a
   * refusal afterwards.
   */
  const state = useMemo(() => {
    let anythingEntered = false;
    let anythingRejected = false;
    let movesStock = false;
    let firstBad: string | null = null;

    for (const l of lines) {
      const e = entries[l.id] ?? { accepted: "", rejected: "" };
      const a = quantityOf(e.accepted);
      const r = quantityOf(e.rejected);
      if (!a.ok && firstBad === null) firstBad = e.accepted;
      if (!r.ok && firstBad === null) firstBad = e.rejected;
      if (a.positive || r.positive) anythingEntered = true;
      if (r.positive) anythingRejected = true;
      /**
       * ⚠️ ONLY THE ACCEPTED QUANTITY MAKES THIS A STOCK MOVEMENT.
       * Rejected goods sit on the premises awaiting return to the vendor;
       * they were never bought and the server does not move them. A
       * receipt of nothing but rejections needs no warehouse, and
       * demanding one would be a rule the server does not have.
       */
      if (l.stockItemId !== null && a.positive) movesStock = true;
    }

    return { anythingEntered, anythingRejected, movesStock, firstBad };
  }, [lines, entries]);

  function setEntry(id: string, patch: Partial<{ accepted: string; rejected: string }>) {
    setEntries((e) => ({
      ...e,
      [id]: { ...(e[id] ?? { accepted: "", rejected: "" }), ...patch },
    }));
  }

  function submit() {
    setError(null);

    if (state.firstBad !== null) {
      setError(
        `"${state.firstBad}" is not a quantity. Digits, with at most three decimal places — the stock ledger counts in thousandths and has nowhere to put a fourth.`,
      );
      return;
    }

    if (!state.anythingEntered) {
      setError(
        "Nothing has been entered. A receipt records what arrived, and a receipt of nothing is not a document anybody needs.",
      );
      return;
    }

    /**
     * 🔴 THE TWO REQUIREMENTS, CHECKED HERE SO THE SERVER NEVER HAS TO
     * SAY THEM. Both are enforced server-side as well, and one of them
     * again by a CHECK underneath that. This is the courtesy; those are
     * the control.
     */
    if (state.movesStock && !warehouseId) {
      setError(
        "Choose where the goods went. This receipt includes stock items, and stock has to arrive somewhere — picking a godown for you would put the goods in the wrong one without telling anybody.",
      );
      return;
    }

    if (state.anythingRejected && rejectionReason.trim() === "") {
      setError(
        "Something is being rejected and no reason has been given. A rejection with no reason cannot be argued with the vendor later, which is the only moment it matters.",
      );
      return;
    }

    const payload = {
      poId,
      receivedOn,
      /**
       * ⚠️ NULL, NOT "". `warehouseId` is `uuid().optional().nullable()`,
       * and an empty string is neither: a receipt of pure services would
       * be refused with a message about uuid format.
       */
      warehouseId: warehouseId || null,
      challanNo: challanNo.trim() || null,
      challanDate: challanDate || null,
      rejectionReason: state.anythingRejected ? rejectionReason.trim() : null,
      /**
       * ⭐ ONLY THE LINES WITH SOMETHING ON THEM. Sending every line with
       * zeroes writes a `goods_receipt_lines` row per untouched line, and
       * the receipt then looks like a full delivery to every report that
       * counts rows rather than quantities.
       */
      lines: lines
        .filter((l) => {
          const e = entryOf(l.id);
          return quantityOf(e.accepted).positive || quantityOf(e.rejected).positive;
        })
        .map((l) => ({
          poLineId: l.id,
          acceptedQty: quantityOf(entryOf(l.id).accepted).value,
          rejectedQty: quantityOf(entryOf(l.id).rejected).value,
        })),
    };

    start(async () => {
      const result = await action(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEntries({});
      setRejectionReason("");
      /**
       * ⭐ REFRESH RATHER THAN NAVIGATE AWAY. The next thing that happens
       * after a part delivery is the rest of it arriving, and the
       * outstanding quantities on this page are what the next receipt
       * gets typed against.
       */
      router.refresh();
    });
  }

  /**
   * ⚠️ A DRAFT ORDER IS REFUSED BY THE SERVER, SO THE FORM IS NOT SHOWN.
   * "Booking goods in against an unapproved order records a commitment
   * nobody made" is the server's sentence. Rendering the form anyway
   * would make somebody type out a delivery note in order to be told it.
   *
   * 🔴 AFTER THE HOOKS, NEVER BEFORE THEM. An early return above the
   * `useState` calls changes the hook order between renders, and React
   * would tear the component down the first time an order was approved
   * while this page was open.
   */
  if (poStatus === "draft") {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">Nothing can be booked in yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This order is still a draft. Approving it is a separate step taken by
          a separate person, because booking goods in against an unapproved
          order records a commitment nobody made.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="font-medium">Book goods in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What actually turned up, recorded by whoever took delivery. Accepted
          quantities move the stock ledger. Rejected ones do not, because
          rejected goods are on the premises and are not ours.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="receivedOn">Received on</Label>
          <Input
            id="receivedOn"
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
          {/*
            🔴 NOT PAPERWORK. s.15 MSMED runs the payment clock from
            ACCEPTANCE, and where nobody objects in writing acceptance is
            deemed fifteen days after delivery. This date starts that
            clock; the date the vendor printed on the invoice does not.
          */}
          <p className="text-xs text-muted-foreground">
            The day the lorry arrived, not the day the invoice is dated. The
            MSME payment clock runs from this.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="challanNo">Delivery challan</Label>
          <Input
            id="challanNo"
            maxLength={100}
            value={challanNo}
            onChange={(e) => setChallanNo(e.target.value)}
            placeholder="Their document number"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="challanDate">Challan date</Label>
          <Input
            id="challanDate"
            type="date"
            value={challanDate}
            onChange={(e) => setChallanDate(e.target.value)}
          />
        </div>
      </div>

      {/*
        ══════════════════════════════════════════════════════════════
        🔴 THE WAREHOUSE, ASKED FOR WITH ITS REASON ATTACHED
        ══════════════════════════════════════════════════════════════
        `recordGoodsReceipt` refuses a receipt containing stock items
        with no warehouse. The field is present for every receipt rather
        than appearing the moment a stock line is touched, because a
        field that materialises halfway through typing is a field people
        scroll past. It becomes REQUIRED, visibly, when it matters.
      */}
      <div className="space-y-1.5">
        <Label htmlFor="warehouseId">
          Where did it go{state.movesStock ? " — required" : ""}
        </Label>
        {warehouses.length === 0 ? (
          /*
            ⚠️ NO WAREHOUSES IS EXPLAINED, NOT RENDERED AS AN EMPTY
            DROPDOWN. Without one a receipt of stock items cannot be
            saved at all, and an empty select with no explanation sends
            somebody to a support channel.
          */
          <p className="text-sm text-amber-600 dark:text-amber-400">
            No warehouse has been set up. Stock items cannot be received until
            there is somewhere to receive them into. A receipt of services alone
            will still save.
          </p>
        ) : (
          <select
            id="warehouseId"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">Choose…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
                {w.hint ? ` · ${w.hint}` : ""}
              </option>
            ))}
          </select>
        )}
        {state.movesStock && !warehouseId ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            These lines are stock items, so the goods have to arrive somewhere.
            Choosing for you would put them in the wrong godown without telling
            anybody.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only needed when stock items are being accepted. A receipt of
            services alone has no warehouse, and that is not an omission.
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="p-2 font-medium">#</th>
              <th className="p-2 font-medium">Line</th>
              <th className="p-2 text-right font-medium">Ordered</th>
              <th className="p-2 text-right font-medium">Already in</th>
              <th className="p-2 text-right font-medium">Rate</th>
              <th className="p-2 font-medium">Accepted</th>
              <th className="p-2 font-medium">Rejected</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const outstanding =
                BigInt(l.orderedQty || "0") - BigInt(l.receivedQty || "0");
              const accepted = quantityOf(entryOf(l.id).accepted);
              /**
               * ⚠️ OVER-DELIVERY IS FLAGGED AND NOT BLOCKED. 101 of 100
               * happens constantly, `recomputeOrderStatus` uses `>=` for
               * exactly that reason, and the extra unit is a finding for
               * the three-way match. Refusing it here would make the
               * storekeeper record a lie about what came off the lorry.
               */
              const over =
                accepted.ok &&
                accepted.positive &&
                toThousandths(accepted.value) > outstanding;

              return (
                <tr key={l.id} className="border-b align-top last:border-0">
                  <td className="p-2">{l.lineNo}</td>
                  <td className="p-2">
                    {l.description}
                    {/*
                      ⭐ WHETHER A LINE IS A STOCK ITEM IS SHOWN, because
                      that is the fact deciding whether a warehouse is
                      required. A line with no catalogue item — freight, a
                      service, a one-off — moves nothing, and the server
                      skips it rather than inventing a phantom item that
                      nobody could ever count.
                    */}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {l.stockItemId
                        ? `stock · ${l.stockItemName ?? "item"}`
                        : "no stock item · moves nothing"}
                    </span>
                  </td>
                  <td className="p-2 text-right">
                    {fromThousandths(l.orderedQty)} {l.uom}
                  </td>
                  <td className="p-2 text-right text-muted-foreground">
                    {fromThousandths(l.receivedQty)}
                    <span className="block text-xs">
                      {outstanding > 0n
                        ? `${fromThousandths(outstanding.toString())} still due`
                        : "complete"}
                    </span>
                  </td>
                  <td className="p-2 text-right text-muted-foreground">
                    {rupees(l.unitPriceMinor)}
                  </td>
                  <td className="p-2">
                    {/*
                      ⭐ NOT PRE-FILLED WITH THE OUTSTANDING QUANTITY.
                      ⚠️ It would save typing, and it would turn the
                      receipt into a confirmation of the paperwork instead
                      of a record of the count. The number in this box has
                      to be what somebody counted on the dock, and a
                      pre-filled box is a box people tab past.
                    */}
                    <Input
                      aria-label={`Line ${l.lineNo} accepted quantity`}
                      inputMode="decimal"
                      placeholder="0"
                      value={entryOf(l.id).accepted}
                      onChange={(e) => setEntry(l.id, { accepted: e.target.value })}
                    />
                    {over ? (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                        More than is outstanding. That is allowed — it becomes a
                        finding when the bill is matched.
                      </p>
                    ) : null}
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Line ${l.lineNo} rejected quantity`}
                      inputMode="decimal"
                      placeholder="0"
                      value={entryOf(l.id).rejected}
                      onChange={(e) => setEntry(l.id, { rejected: e.target.value })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        🔴 THE REASON IS ASKED FOR BEFORE THE ACTION, NOT AFTER A
        REFUSAL. `recordGoodsReceipt` returns a sentence about it and 0063
        carries the rule as a CHECK. Firing the save and surfacing the
        message teaches an operator to type one word and press it again.
      */}
      {state.anythingRejected ? (
        <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <Label htmlFor="rejectionReason">Why was it rejected?</Label>
          <Input
            id="rejectionReason"
            required
            maxLength={1000}
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            placeholder="Six bags split in transit, returned on the same lorry"
          />
          <p className="text-xs text-muted-foreground">
            The vendor will dispute this, and this sentence is what the answer
            gets read from. Rejected quantities are not added to stock and are
            not payable.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="button" disabled={pending} onClick={submit}>
        {pending ? "Saving…" : "Record this receipt"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE MATCH                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE OTHER ORPHAN ON THIS SCREEN: `runThreeWayMatch`.
 *
 * ⚠️ IT LIVES IN THIS MODULE RATHER THAN ITS OWN because it is the same
 * screen and the same `Act` plumbing; a file of its own would duplicate
 * the type and the transition for one button.
 *
 * 🔴 IT IS A DIFFERENT PERSON'S BUTTON, AND THE SCREEN SHOWS THAT.
 * `recordGoodsReceipt` is guarded on `inventory.movements.post`; this is
 * guarded on `settings:update`. The page renders it only when the viewer
 * holds the second, so the storekeeper who booked the goods in is not
 * offered a control that passes the bill for them. Three documents, three
 * hands, is the entire value of a three-way match.
 */
export function BillMatch({
  invoiceId,
  invoiceNumber,
  matchState,
  action,
}: {
  invoiceId: string;
  invoiceNumber: string;
  matchState: string | null;
  action: Act<unknown>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await action({ invoiceId });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            /**
             * ⭐ THE VERDICT IS NOT RENDERED FROM THIS RESPONSE. It was
             * STORED against the bill, and the page re-reads it.
             *
             * ⚠️ 0063's own comment says why the result is stored at
             * approval rather than recomputed on display: the reason a
             * bill was passed has to survive the tolerance being changed
             * later. Painting the returned object here would quietly make
             * this the one screen showing a live recomputation, which is
             * the number nobody can defend in March.
             */
            router.refresh();
          });
        }}
      >
        {pending
          ? "Checking…"
          : matchState
            ? `Re-check ${invoiceNumber}`
            : `Check ${invoiceNumber} against the order`}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
