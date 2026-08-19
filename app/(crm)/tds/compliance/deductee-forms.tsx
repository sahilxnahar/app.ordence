"use client";

/**
 * Ordence — ⭐⭐ DEDUCTEES AND SECTION 197 CERTIFICATES
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PAN STATUS IS THE FIELD THAT DECIDES THE RATE
 * ══════════════════════════════════════════════════════════════════════
 *   valid           the ordinary rate for the section
 *   not_furnished   Section 206AA: 20%, or twice the ordinary rate,
 *                   whichever is higher
 *   inoperative     the same, and it is the one nobody expects , a PAN
 *                   not linked to Aadhaar became inoperative and the
 *                   payee does not know
 *   invalid         same treatment as not furnished
 *   applied_for     the acknowledgement is not a PAN
 *
 * A screen that offered "PAN number" and no status would let somebody
 * type a PAN that is inoperative and deduct at 2% instead of 20%, with
 * the shortfall recoverable from a subcontractor who has left.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A SECTION 197 CERTIFICATE IS A DATE RANGE AND A CAP, NOT A RATE
 * ══════════════════════════════════════════════════════════════════════
 * It authorises a LOWER rate up to a stated total, between two dates.
 * Beyond the cap or outside the dates, the ordinary rate applies again ,
 * and a certificate recorded without its cap is a certificate that will
 * under-deduct for the rest of the year.
 */

import { useState, useTransition } from "react";
import { UserPlus, FileBadge } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const PAN_STATUSES = [
  { value: "valid", label: "Valid" },
  { value: "not_furnished", label: "Not furnished , 206AA applies" },
  { value: "invalid", label: "Invalid , 206AA applies" },
  { value: "inoperative", label: "Inoperative , 206AA applies" },
  { value: "applied_for", label: "Applied for" },
] as const;

const DEDUCTEE_TYPES = [
  "individual",
  "huf",
  "company",
  "firm",
  "association_of_persons",
  "body_of_individuals",
] as const;

export function DeducteeForms(props: {
  deductees: readonly { id: string; label: string; panStatus: string }[];
  financialYear: string;
  sections: readonly string[];
  saveDeductee: (input: unknown) => Promise<Result<{ id: string }>>;
  saveCertificate: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /* ---- deductee --------------------------------------------------- */
  const [code, setCode] = useState("");
  const [legalName, setLegalName] = useState("");
  const [pan, setPan] = useState("");
  const [panStatus, setPanStatus] = useState<string>("not_furnished");
  const [deducteeType, setDeducteeType] = useState<string>("company");
  const [nonResident, setNonResident] = useState(false);
  const [specified206ab, setSpecified206ab] = useState(false);

  /* ---- certificate ------------------------------------------------ */
  const [deducteeId, setDeducteeId] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [section, setSection] = useState(props.sections[0] ?? "");
  const [ratePct, setRatePct] = useState("1");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [capRupees, setCapRupees] = useState("");

  function run<T>(fn: () => Promise<Result<T>>, success: string) {
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

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      {/* ── DEDUCTEE ──────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <UserPlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Add a deductee
        </h2>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">Legal name</span>
            <input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">PAN</span>
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              maxLength={10}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">PAN status</span>
            <select
              value={panStatus}
              onChange={(e) => setPanStatus(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {PAN_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Type</span>
            <select
              value={deducteeType}
              onChange={(e) => setDeducteeType(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {DEDUCTEE_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={nonResident}
              onChange={(e) => setNonResident(e.target.checked)}
            />
            <span>Non-resident , 195 applies rather than the ordinary section</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={specified206ab}
              onChange={(e) => setSpecified206ab(e.target.checked)}
            />
            <span>
              <span className="block">A specified person under Section 206AB</span>
              <span className="block text-xs text-muted-foreground">
                Somebody who has not filed a return for the relevant year. Deduct at the
                higher of twice the ordinary rate or 5%. Check it on the department&rsquo;s
                compliance portal , not from what they tell you.
              </span>
            </span>
          </label>
        </div>

        <button
          type="button"
          disabled={pending || code.trim() === "" || legalName.trim() === ""}
          onClick={() =>
            run(
              () =>
                props.saveDeductee({
                  code,
                  legalName,
                  panNumber: pan.trim() === "" ? null : pan.trim(),
                  panStatus,
                  deducteeType,
                  isNonResident: nonResident,
                  isSpecifiedPerson206ab: specified206ab,
                }),
              "Deductee saved.",
            )
          }
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save the deductee"}
        </button>
      </section>

      {/* ── 197 CERTIFICATE ───────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FileBadge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Record a Section 197 certificate
        </h2>
        <p className="text-sm text-muted-foreground">
          A lower rate, up to a stated total, between two dates. Beyond the cap or outside the
          dates the ordinary rate applies again.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">Deductee</span>
            <select
              value={deducteeId}
              onChange={(e) => setDeducteeId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Choose one</option>
              {props.deductees.map((deductee) => (
                <option key={deductee.id} value={deductee.id}>
                  {deductee.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Certificate number</span>
            <input
              value={certificateNumber}
              onChange={(e) => setCertificateNumber(e.target.value.toUpperCase())}
              maxLength={24}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Section</span>
            <select
              value={section}
              onChange={(e) => setSection(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {props.sections.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Rate (%)</span>
            <input
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Cap (₹)</span>
            <input
              value={capRupees}
              onChange={(e) => setCapRupees(e.target.value)}
              inputMode="decimal"
              placeholder="Leave empty for no cap"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Valid from</span>
            <input
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Valid to</span>
            <input
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          type="button"
          disabled={
            pending ||
            deducteeId === "" ||
            certificateNumber.trim() === "" ||
            validFrom === "" ||
            validTo === ""
          }
          onClick={() =>
            run(
              () =>
                props.saveCertificate({
                  deducteeId,
                  certificateNumber,
                  section,
                  /** Percent to basis points. 1% is 100. */
                  rateBps: Math.round(Number(ratePct) * 100),
                  validFrom,
                  validTo,
                  capBaseMinor: capRupees.trim() === "" ? null : capRupees.trim(),
                  financialYear: props.financialYear,
                  isActive: true,
                }),
              "Certificate recorded.",
            )
          }
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Record the certificate"}
        </button>
      </section>
    </div>
  );
}
