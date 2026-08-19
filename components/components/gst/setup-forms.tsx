"use client";

/**
 * Ordence — 🔴🔴🔴 THE GST REGISTRATION AND THE RATE MASTER
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PAGE EXPLAINED WHY IT COULD NOT WORK AND OFFERED NO WAY OUT
 * ══════════════════════════════════════════════════════════════════════
 * `/gst` read: *"No registration recorded yet. Ordence decides IGST
 * versus CGST+SGST by comparing the place of supply against your own
 * state code. Without a registration it cannot make that call, so it
 * refuses rather than guessing."*
 *
 * That is a correct and well-written explanation of a permanent
 * condition. `createRegistration`, `createHsnSacCode` and `addRatePeriod`
 * are the only inserts into `gst_registrations`, `hsn_sac_codes` and
 * `hsn_sac_rates`, and nothing called any of the three. Four reachable
 * actions read `gst_registrations` — including `getInvoiceForPrint` and
 * `getCreditNoteForPrint`, so no tax invoice could carry a GSTIN.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE RATE IS DATED, AND THAT IS THE ENTIRE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * A rate is not a property of a code. It is a property of a code DURING A
 * PERIOD. When the Council changes a rate, the new rate is added with an
 * effective date and the old one is closed — it is never edited.
 *
 * 🔴 EDITING A RATE WOULD REWRITE HISTORY. An invoice raised last March
 * was raised at last March's rate, and that is what the return for March
 * reported and what the customer paid. A rate master that overwrites
 * would silently restate every historical invoice the next time anything
 * recomputed, and the difference would surface as an unexplainable
 * mismatch in a GSTR-1 reconciliation months later.
 *
 * ⚠️ BASIS POINTS, NOT PER CENT. 18% is 1800. The field says so, because
 * "18" in a basis-points field is 0.18% and would under-charge tax by a
 * factor of a hundred on every invoice using that code.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type CodeOption = { id: string; code: string; description: string };

export const REGISTRATION_TYPES = [
  { value: "regular", label: "Regular" },
  { value: "composition", label: "Composition" },
  { value: "sez", label: "SEZ" },
] as const;

const BLANK_REG = {
  gstin: "",
  legalName: "",
  tradeName: "",
  registrationType: "regular",
  line1: "",
  city: "",
  state: "",
  postalCode: "",
  effectiveFrom: "",
  isPrimary: false,
};

const BLANK_CODE = { code: "", kind: "hsn", description: "", uqc: "" };

const BLANK_RATE = {
  hsnSacId: "",
  rateBps: "",
  cessRateBps: "0",
  effectiveFrom: "",
  notificationRef: "",
  itcEligible: true,
  reverseCharge: false,
};

function Errors({ list }: { list?: string[] }) {
  if (!list) return null;
  return (
    <>
      {list.map((m) => (
        <p key={m} className="text-xs text-destructive">
          {m}
        </p>
      ))}
    </>
  );
}

export function GstRegistrationForm({
  createAction,
}: {
  createAction: (i: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ...BLANK_REG });
  const [fe, setFe] = useState<Record<string, string[]>>({});

  function submit() {
    setFe({});
    startTransition(async () => {
      const res = await createAction({
        gstin: f.gstin.trim().toUpperCase(),
        legalName: f.legalName.trim(),
        tradeName: f.tradeName.trim() || null,
        registrationType: f.registrationType,
        address: {
          line1: f.line1.trim() || undefined,
          city: f.city.trim() || undefined,
          state: f.state.trim() || undefined,
          postalCode: f.postalCode.trim() || undefined,
          country: "IN",
        },
        effectiveFrom: f.effectiveFrom,
        isPrimary: f.isPrimary,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`${f.gstin.trim().toUpperCase()} recorded.`);
      setF({ ...BLANK_REG });
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <div className="p-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Record a registration
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-b p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="r-gstin">GSTIN</Label>
          <Input
            id="r-gstin"
            maxLength={15}
            value={f.gstin}
            onChange={(e) => setF({ ...f, gstin: e.target.value })}
          />
          {/**
           * 🔴 THE FIRST TWO DIGITS ARE THE STATE CODE, and they are what
           * decides IGST versus CGST+SGST on every invoice. A wrong GSTIN
           * here does not fail: it files the tax in the wrong heads.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 The first two digits are the state code, and they decide IGST
            versus CGST and SGST on every invoice you raise.
          </p>
          <Errors list={fe.gstin} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="r-legal">Legal name on the certificate</Label>
          <Input
            id="r-legal"
            value={f.legalName}
            onChange={(e) => setF({ ...f, legalName: e.target.value })}
          />
          <Errors list={fe.legalName} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-type">Type</Label>
          <select
            id="r-type"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.registrationType}
            onChange={(e) => setF({ ...f, registrationType: e.target.value })}
          >
            {REGISTRATION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {/**
           * ⚠️ `unregistered` AND `overseas` ARE NOT OFFERED. The
           * validator refuses them for one's OWN registration, and its
           * comment gives the reason: the row exists because a GSTIN
           * exists, so an unregistered own registration is a
           * contradiction.
           */}
          <p className="text-xs text-muted-foreground">
            Unregistered and overseas are not offered here: this row exists
            because a GSTIN exists.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-from">Effective from</Label>
          <Input
            id="r-from"
            type="date"
            value={f.effectiveFrom}
            onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
          />
          <Errors list={fe.effectiveFrom} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-state">State</Label>
          <Input
            id="r-state"
            value={f.state}
            onChange={(e) => setF({ ...f, state: e.target.value })}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="r-line1">Principal place of business</Label>
          <Input
            id="r-line1"
            value={f.line1}
            onChange={(e) => setF({ ...f, line1: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-city">City</Label>
          <Input
            id="r-city"
            value={f.city}
            onChange={(e) => setF({ ...f, city: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-pin">PIN</Label>
          <Input
            id="r-pin"
            value={f.postalCode}
            onChange={(e) => setF({ ...f, postalCode: e.target.value })}
          />
        </div>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={f.isPrimary}
          onChange={(e) => setF({ ...f, isPrimary: e.target.checked })}
        />
        <span>This is the primary registration</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending ||
            f.gstin.trim().length !== 15 ||
            f.legalName.trim() === "" ||
            f.effectiveFrom === ""
          }
          onClick={submit}
        >
          Record it
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setF({ ...BLANK_REG });
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function HsnSacForms({
  codes,
  createCodeAction,
  addRateAction,
}: {
  codes: readonly CodeOption[];
  createCodeAction: (i: unknown) => Promise<Result<{ id: string }>>;
  addRateAction: (i: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [which, setWhich] = useState<"none" | "code" | "rate">("none");
  const [c, setC] = useState({ ...BLANK_CODE });
  const [r, setR] = useState({ ...BLANK_RATE });
  const [fe, setFe] = useState<Record<string, string[]>>({});

  /**
   * ⚠️ THE SHAPE RULES MIRRORED FROM THE VALIDATOR. A SAC is six digits
   * beginning 99; an HSN is 2, 4, 6 or 8 digits. Neither is arbitrary —
   * the length is the level of the tariff heading, and an invoice must
   * carry the number of digits its turnover band requires.
   */
  const codeProblem =
    c.code === ""
      ? null
      : c.kind === "sac" && !/^99\d{4}$/.test(c.code)
        ? "A SAC is six digits beginning 99, e.g. 995411."
        : c.kind === "hsn" && ![2, 4, 6, 8].includes(c.code.length)
          ? "An HSN is 2, 4, 6 or 8 digits. The length is the level of the tariff heading, and the number of digits an invoice must carry depends on your turnover band."
          : null;

  function submitCode() {
    setFe({});
    startTransition(async () => {
      const res = await createCodeAction({
        code: c.code.trim(),
        kind: c.kind,
        description: c.description.trim(),
        uqc: c.uqc.trim() || null,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`${c.code.trim()} added. It carries no rate until you add a period.`);
      setC({ ...BLANK_CODE });
      setWhich("none");
    });
  }

  function submitRate() {
    setFe({});
    startTransition(async () => {
      const res = await addRateAction({
        hsnSacId: r.hsnSacId,
        rateBps: Number(r.rateBps),
        cessRateBps: Number(r.cessRateBps || "0"),
        effectiveFrom: r.effectiveFrom,
        notificationRef: r.notificationRef.trim() || null,
        itcEligible: r.itcEligible,
        reverseCharge: r.reverseCharge,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success("Rate period added. Earlier periods are untouched.");
      setR({ ...BLANK_RATE });
      setWhich("none");
    });
  }

  if (which === "none") {
    return (
      <div className="flex flex-wrap gap-2 p-4">
        <Button variant="secondary" onClick={() => setWhich("code")}>
          Add a code
        </Button>
        <Button
          variant="secondary"
          disabled={codes.length === 0}
          onClick={() => setWhich("rate")}
        >
          Add a rate period
        </Button>
        {codes.length === 0 && (
          <span className="self-center text-xs text-muted-foreground">
            A rate belongs to a code. Add the code first.
          </span>
        )}
      </div>
    );
  }

  if (which === "code") {
    return (
      <div className="space-y-4 border-b p-4 text-sm">
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="c-kind">Kind</Label>
            <select
              id="c-kind"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={c.kind}
              onChange={(e) => setC({ ...c, kind: e.target.value })}
            >
              <option value="hsn">HSN — goods</option>
              <option value="sac">SAC — services</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-code">Code</Label>
            <Input
              id="c-code"
              value={c.code}
              inputMode="numeric"
              placeholder={c.kind === "sac" ? "995411" : "72142090"}
              onChange={(e) => setC({ ...c, code: e.target.value })}
            />
            {codeProblem && (
              <p className="text-xs text-destructive">{codeProblem}</p>
            )}
            <Errors list={fe.code} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="c-desc">What it covers</Label>
            <Input
              id="c-desc"
              value={c.description}
              onChange={(e) => setC({ ...c, description: e.target.value })}
            />
            <Errors list={fe.description} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-uqc">UQC</Label>
            <Input
              id="c-uqc"
              value={c.uqc}
              placeholder="MTR"
              onChange={(e) => setC({ ...c, uqc: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              The unit code GSTR-1 expects for this item.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              pending ||
              c.code.trim() === "" ||
              c.description.trim() === "" ||
              codeProblem !== null
            }
            onClick={submitCode}
          >
            Add the code
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setWhich("none");
              setC({ ...BLANK_CODE });
              setFe({});
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-b p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="rp-code">Code</Label>
          <select
            id="rp-code"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={r.hsnSacId}
            onChange={(e) => setR({ ...r, hsnSacId: e.target.value })}
          >
            <option value="">Choose…</option>
            {codes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} · {x.description}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rp-rate">Rate, in basis points</Label>
          <Input
            id="rp-rate"
            inputMode="numeric"
            value={r.rateBps}
            placeholder="1800"
            onChange={(e) => setR({ ...r, rateBps: e.target.value })}
          />
          {/**
           * 🔴 THE UNIT IS THE TRAP. "18" here is 0.18% and would
           * under-charge tax by a factor of a hundred on every invoice
           * using this code, silently, until a return was compared.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 5% is 500, 12% is 1200, 18% is 1800, 28% is 2800. Typing 18
            here means 0.18%.
          </p>
          <Errors list={fe.rateBps} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rp-cess">Cess, in basis points</Label>
          <Input
            id="rp-cess"
            inputMode="numeric"
            value={r.cessRateBps}
            onChange={(e) => setR({ ...r, cessRateBps: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rp-from">Effective from</Label>
          <Input
            id="rp-from"
            type="date"
            value={r.effectiveFrom}
            onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })}
          />
          {/**
           * ⭐ THE WHOLE DESIGN, IN ONE SENTENCE ON THE FIELD THAT
           * IMPLEMENTS IT.
           */}
          <p className="text-xs text-muted-foreground">
            ⭐ The previous period is closed the day before this, never edited.
            An invoice raised last March keeps last March&apos;s rate.
          </p>
          <Errors list={fe.effectiveFrom} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rp-notif">Notification reference</Label>
          <Input
            id="rp-notif"
            value={r.notificationRef}
            placeholder="11/2017-CT(R)"
            onChange={(e) => setR({ ...r, notificationRef: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The authority for this rate. What an assessment asks for.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={r.itcEligible}
            onChange={(e) => setR({ ...r, itcEligible: e.target.checked })}
          />
          <span>Input credit may be taken</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={r.reverseCharge}
            onChange={(e) => setR({ ...r, reverseCharge: e.target.checked })}
          />
          <span>Reverse charge applies</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending ||
            r.hsnSacId === "" ||
            r.rateBps === "" ||
            r.effectiveFrom === ""
          }
          onClick={submitRate}
        >
          Add the rate period
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setWhich("none");
            setR({ ...BLANK_RATE });
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
