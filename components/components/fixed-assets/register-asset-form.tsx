"use client";

/**
 * Ordence — ⭐⭐⭐ CAPITALISING AN ASSET
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE JUSTIFICATION BOX IS THE POINT OF THIS FORM
 * ══════════════════════════════════════════════════════════════════════
 * Schedule II Part C prescribes a useful life for every class and Part A
 * note 5 caps the residual at 5% of cost. Both may be departed from —
 * but only where the difference is justified by technical advice and
 * DISCLOSED. `assertAssetIsDepreciable` refuses to produce a single
 * paisa of depreciation for an asset that departs from either without a
 * written justification against it.
 *
 * ⚠️ SO THE REFUSAL WOULD OTHERWISE ARRIVE A MONTH LATER, at the first
 * depreciation run, about an asset somebody else entered. This form asks
 * for the justification at the moment the life is changed, says which
 * note of the schedule is in play, and shows the engine's refusal
 * verbatim if it is still not satisfied.
 *
 * ⭐ THE FORM IS NOT THE CONTROL AND DOES NOT PRETEND TO BE. The prompt
 * below is a courtesy; the guard is on the server and inside the engine,
 * where an import or a fix-up script cannot walk around it.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEPRECIATION_METHODS,
  SCHEDULE_II,
  SCHEDULE_II_CLASSES,
  SHIFT_USAGES,
} from "@/lib/fixed-assets/depreciation";
import {
  formatBp,
  justificationDemand,
  parseRupeesToMinor,
  type BlockRow,
} from "@/lib/fixed-assets/register-view";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type RegisterAction = (input: unknown) => Promise<Result<{ id: string }>>;

export function RegisterAssetForm({
  blocks,
  registerAction,
  canManage,
}: {
  blocks: readonly BlockRow[];
  registerAction: RegisterAction;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [done, setDone] = useState<string | null>(null);

  const [assetNo, setAssetNo] = useState("");
  const [description, setDescription] = useState("");
  const [assetClass, setAssetClass] = useState<string>("plant_machinery_general");
  const [cost, setCost] = useState("");
  const [residualBp, setResidualBp] = useState("500");
  const [residualJustification, setResidualJustification] = useState("");
  const [lifeMonths, setLifeMonths] = useState(
    String(SCHEDULE_II.plant_machinery_general.usefulLifeMonths ?? 180),
  );
  const [lifeJustification, setLifeJustification] = useState("");
  const [method, setMethod] = useState<string>("slm");
  const [shiftUsage, setShiftUsage] = useState<string>("single");
  const [acquiredOn, setAcquiredOn] = useState("");
  const [putToUseOn, setPutToUseOn] = useState("");
  const [itBlockId, setItBlockId] = useState("");
  const [location, setLocation] = useState("");

  const spec = SCHEDULE_II[assetClass as keyof typeof SCHEDULE_II];

  const demand = useMemo(
    () =>
      justificationDemand({
        assetClass,
        usefulLifeMonths: Number(lifeMonths) || 0,
        residualBp: Number(residualBp) || 0,
      }),
    [assetClass, lifeMonths, residualBp],
  );

  /**
   * ⚠️ CHANGING THE CLASS MOVES THE LIFE TO THE PRESCRIBED ONE, because
   * the prescribed life is the answer that needs no justification. It
   * does NOT clear a justification already written — that is somebody's
   * sentence, not the form's.
   */
  function chooseClass(next: string) {
    setAssetClass(next);
    const prescribed = SCHEDULE_II[next as keyof typeof SCHEDULE_II]?.usefulLifeMonths;
    if (prescribed !== null && prescribed !== undefined) setLifeMonths(String(prescribed));
  }

  function submit() {
    setRefusal(null);
    setFieldErrors({});
    setDone(null);

    const costMinor = parseRupeesToMinor(cost);
    if (costMinor === null) {
      setRefusal("Enter the capitalised cost in rupees, to at most two decimal places.");
      return;
    }

    startTransition(async () => {
      const result = await registerAction({
        assetNo,
        description,
        assetClass,
        costMinor,
        residualBp: Number(residualBp) || 0,
        residualJustification: residualJustification.trim() === "" ? null : residualJustification,
        usefulLifeMonths: Number(lifeMonths) || 0,
        lifeJustification: lifeJustification.trim() === "" ? null : lifeJustification,
        depreciationMethod: method,
        shiftUsage,
        acquiredOn,
        putToUseOn,
        itBlockId: itBlockId === "" ? null : itBlockId,
        location: location.trim() === "" ? null : location,
      });

      if (!result.ok) {
        /**
         * 🔴 THE ENGINE'S SENTENCE, VERBATIM. It names the asset, the
         * note of Schedule II it fell foul of and the remedy. Replacing
         * it with "Check the form" would send somebody hunting for a red
         * field that does not exist.
         */
        setRefusal(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDone(assetNo);
      setAssetNo("");
      setDescription("");
      setCost("");
      setLifeJustification("");
      setResidualJustification("");
      router.refresh();
    });
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Register an asset</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Capitalising an asset needs the <code>fixed_assets.manage</code> permission.
          Setting a useful life, a residual value and a method decides what the company
          reports for the next fifteen years, so it is held separately from reading the
          register.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Register an asset</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          {/* ⚠️ SAID BEFORE THE DATES ARE TYPED, not after they are wrong. */}
          Depreciation runs from the date the asset was put to USE, not the date it was
          bought. Both dates are recorded and neither is derived from the other.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fa-no">Asset number</Label>
            <Input
              id="fa-no"
              value={assetNo}
              onChange={(e) => setAssetNo(e.target.value)}
              placeholder="FA-0001"
            />
          </div>
          <div>
            <Label htmlFor="fa-cost">Capitalised cost (₹)</Label>
            <Input
              id="fa-cost"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="3000000.00"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="fa-desc">Description</Label>
          <Textarea
            id="fa-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fa-class">Schedule II class</Label>
            <Select
              id="fa-class"
              value={assetClass}
              onChange={(e) => chooseClass(e.target.value)}
            >
              {SCHEDULE_II_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {SCHEDULE_II[c].label}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">{spec?.note}</p>
          </div>
          <div>
            <Label htmlFor="fa-life">Useful life (months)</Label>
            <Input
              id="fa-life"
              value={lifeMonths}
              onChange={(e) => setLifeMonths(e.target.value)}
              inputMode="numeric"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {demand.prescribedLifeMonths === null
                ? "Schedule II prescribes no life for this class."
                : `Schedule II Part C prescribes ${demand.prescribedLifeMonths} months.`}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="fa-residual">Residual (basis points of cost)</Label>
            <Input
              id="fa-residual"
              value={residualBp}
              onChange={(e) => setResidualBp(e.target.value)}
              inputMode="numeric"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {formatBp(Number(residualBp) || 0)} of cost. 500bp is the Part A note 5
              ceiling.
            </p>
          </div>
          <div>
            <Label htmlFor="fa-method">Method</Label>
            <Select id="fa-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {DEPRECIATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m === "slm" ? "Straight line" : "Written-down value"}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* 🔴 The WDV rate is undefined at a nil residual. */}
              The written-down value rate is derived from the life and the residual, and
              is undefined when the residual is nil.
            </p>
          </div>
          <div>
            <Label htmlFor="fa-shift">Shift working</Label>
            <Select
              id="fa-shift"
              value={shiftUsage}
              onChange={(e) => setShiftUsage(e.target.value)}
            >
              {SHIFT_USAGES.map((s) => (
                <option key={s} value={s}>
                  {s} shift
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {spec?.noExtraShift
                ? "This class is marked NESD — Part A note 6 adds nothing however many shifts are worked."
                : "Part A note 6 adds 50% for double and 100% for triple shift working."}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fa-acq">Acquired on</Label>
            <Input
              id="fa-acq"
              type="date"
              value={acquiredOn}
              onChange={(e) => setAcquiredOn(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="fa-use">Put to use on</Label>
            <Input
              id="fa-use"
              type="date"
              value={putToUseOn}
              onChange={(e) => setPutToUseOn(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fa-block">Income-tax block</Label>
            <Select
              id="fa-block"
              value={itBlockId}
              onChange={(e) => setItBlockId(e.target.value)}
            >
              <option value="">Not classified yet</option>
              {blocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {formatBp(b.rateBp)}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* ⭐ The two computations are different and both are compulsory. */}
              The tax pool this asset joins. It has nothing to do with the Schedule II
              class above — the two statutes group assets differently.
            </p>
          </div>
          <div>
            <Label htmlFor="fa-loc">Location</Label>
            <Input
              id="fa-loc"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Where somebody would go to see it"
            />
          </div>
        </div>

        {/**
         * ⭐ THE BOX APPEARS THE MOMENT THE LIFE OR THE RESIDUAL DEPARTS
         * FROM THE SCHEDULE, and says which note put it there.
         */}
        {demand.lifeNeedsJustification && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">
            <Label htmlFor="fa-life-just">
              Justification for a useful life of {lifeMonths} months
            </Label>
            <p className="mb-2 text-xs text-muted-foreground">{demand.reasons[0]}</p>
            <Textarea
              id="fa-life-just"
              value={lifeJustification}
              onChange={(e) => setLifeJustification(e.target.value)}
              rows={3}
              placeholder="The technical advice relied on, and where it is disclosed."
            />
          </div>
        )}

        {demand.residualNeedsJustification && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">
            <Label htmlFor="fa-res-just">
              Justification for a residual of {formatBp(Number(residualBp) || 0)}
            </Label>
            <p className="mb-2 text-xs text-muted-foreground">
              {demand.reasons[demand.reasons.length - 1]}
            </p>
            <Textarea
              id="fa-res-just"
              value={residualJustification}
              onChange={(e) => setResidualJustification(e.target.value)}
              rows={3}
              placeholder="The technical advice relied on, and where it is disclosed."
            />
          </div>
        )}

        {refusal !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <p className="font-medium">This asset was not registered.</p>
            <p className="mt-1 whitespace-pre-line">{refusal}</p>
            {Object.entries(fieldErrors).map(([field, messages]) => (
              <p key={field} className="mt-1 text-xs">
                {field}: {messages.join(" ")}
              </p>
            ))}
          </div>
        )}

        {done !== null && (
          <p role="status" className="text-sm text-emerald-700">
            {done} is in the register. Nothing has been depreciated yet — depreciation is
            computed for a period and posted as a separate decision.
          </p>
        )}

        <Button onClick={submit} disabled={pending}>
          {pending ? "Registering…" : "Register the asset"}
        </Button>
      </CardContent>
    </Card>
  );
}
