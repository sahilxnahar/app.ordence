"use client";

/**
 * Ordence — ⭐ CORRECTING AND DROPPING A PARCEL
 * Version: v1.78.0-alpha · Wave 10
 *
 * ⚠️ DROPPING IS NOT DELETING, AND THE REASON IS THE POINT.
 * `dropLandParcel` demands ten characters of explanation with its own
 * sentence attached: "somebody will look at this land again in two
 * years." A parcel walked away from for a title defect and a parcel
 * walked away from because the price moved are the same row with
 * different futures, and only the reason distinguishes them.
 *
 * ⚠️ GUNTHA IS CAPPED BELOW 40 HERE AS WELL AS IN THE SCHEMA AND IN THE
 * DATABASE. 1 acre is 40 guntha; a form that accepts 45 and then shows a
 * constraint violation has taught the operator nothing.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function ParcelControls(props: {
  parcel: {
    id: string;
    name: string;
    surveyNumber: string | null;
    village: string | null;
    district: string | null;
    extentAcre: string | null;
    extentGuntha: string | null;
  };
  save: (input: unknown) => Promise<Result<{ id: string }>>;
  drop: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const router = useRouter();
  const [name, setName] = useState(props.parcel.name);
  const [surveyNumber, setSurveyNumber] = useState(props.parcel.surveyNumber ?? "");
  const [village, setVillage] = useState(props.parcel.village ?? "");
  const [district, setDistrict] = useState(props.parcel.district ?? "");
  const [acre, setAcre] = useState(props.parcel.extentAcre ?? "");
  const [guntha, setGuntha] = useState(props.parcel.extentGuntha ?? "");
  const [dropReason, setDropReason] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const gunthaProblem =
    guntha.trim() !== "" && Number(guntha) >= 40
      ? "1 acre is 40 guntha , enter the extra acre instead."
      : null;

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.save({
        id: props.parcel.id,
        name: name.trim(),
        surveyNumber: surveyNumber.trim() === "" ? null : surveyNumber.trim(),
        village: village.trim() === "" ? null : village.trim(),
        district: district.trim() === "" ? null : district.trim(),
        extentAcre: acre.trim() === "" ? null : acre.trim(),
        extentGuntha: guntha.trim() === "" ? null : guntha.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Parcel updated.");
      router.refresh();
    });
  }

  function drop() {
    setError(null);
    startTransition(async () => {
      const result = await props.drop({ id: props.parcel.id, reason: dropReason.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="space-y-4 rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">Correct this parcel</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm sm:col-span-3">
          <span className="font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Survey number</span>
          <input
            value={surveyNumber}
            onChange={(e) => setSurveyNumber(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Village</span>
          <input
            value={village}
            onChange={(e) => setVillage(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">District</span>
          <input
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Acre</span>
          <input
            value={acre}
            onChange={(e) => setAcre(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Guntha</span>
          <input
            value={guntha}
            onChange={(e) => setGuntha(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          {gunthaProblem && (
            <span className="block text-xs text-destructive">{gunthaProblem}</span>
          )}
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <button
        type="button"
        onClick={save}
        disabled={pending || name.trim() === "" || gunthaProblem !== null}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>

      <div className="border-t pt-3">
        {!showDrop ? (
          <button
            type="button"
            onClick={() => setShowDrop(true)}
            className="text-sm text-destructive underline underline-offset-2"
          >
            Drop this parcel
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Why is it being dropped?</span>
              <textarea
                value={dropReason}
                onChange={(e) => setDropReason(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Third link in the chain is a will with no probate; counsel advised against it."
              />
              <span className="block text-xs text-muted-foreground">
                Somebody will look at this land again in two years. A parcel dropped for a
                title defect and one dropped on price are the same row with different futures.
              </span>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={drop}
                disabled={pending || dropReason.trim().length < 10}
                className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-60"
              >
                {pending ? "Dropping…" : "Drop it"}
              </button>
              <button
                type="button"
                onClick={() => setShowDrop(false)}
                className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
