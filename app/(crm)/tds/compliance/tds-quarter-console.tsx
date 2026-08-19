"use client";

/**
 * Ordence — ⭐⭐⭐ THE QUARTER, END TO END
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CHALLAN ID IS HELD IN STATE AFTER IT IS RECORDED
 * ══════════════════════════════════════════════════════════════════════
 * There is no read action that lists challans, so mapping deductions to
 * one needs its id. Rather than asking somebody to copy a uuid, the
 * console keeps the id of the challan just recorded and offers the
 * mapping step immediately , which is also the order the work actually
 * happens in: you deposit the money, then you say what it covers.
 *
 * A field for pasting an existing challan id is offered as well, because
 * the money was often deposited last week by somebody else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FIVE AMOUNTS ON A CHALLAN ARE FIVE FIELDS
 * ══════════════════════════════════════════════════════════════════════
 * Tax, surcharge, cess, interest and fee are separate boxes on the ITNS
 * 281 and separate columns in the return. A single "amount" split by
 * software would be a guess, and interest and fee in particular are not
 * available as credit to the deductee , mapping them as tax overstates
 * what the deductee can claim in their 26AS.
 */

import { useState, useTransition } from "react";
import { Banknote, CheckCheck, FileCheck2, Scale, Search } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;
const RETURN_FORMS = ["24Q", "26Q", "27Q", "27EQ"] as const;
const CERTIFICATE_FORMS = ["16", "16A", "16B", "27D"] as const;

function inr(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const paise = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${new Intl.NumberFormat("en-IN").format(whole)}.${paise}`;
}

export function TdsQuarterConsole(props: {
  financialYear: string;
  undepositedMinor: string;
  unmappedDeductions: readonly { id: string; label: string }[];
  sections: readonly string[];
  canManage: boolean;
  canFile: boolean;
  recordChallan: (input: unknown) => Promise<Result<{ id: string }>>;
  mapDeductions: (
    input: unknown,
  ) => Promise<Result<{ mapped: number; utilisedMinor: string; capacityMinor: string }>>;
  reconcile: (
    input: unknown,
  ) => Promise<
    Result<{
      reconciles: boolean;
      registerTdsMinor: string;
      challanTaxCapacityMinor: string;
      differenceMinor: string;
    }>
  >;
  sweepThresholds: (
    input: unknown,
  ) => Promise<
    Result<{
      findings: Array<{
        deducteeId: string;
        deducteeName: string;
        section: string;
        aggregateMinor: string;
      }>;
    }>
  >;
  buildReturn: (
    input: unknown,
  ) => Promise<
    Result<{
      id: string;
      formType: string;
      dueDate: string;
      deducteeCount: number;
      deductionCount: number;
    }>
  >;
  fileReturn: (
    input: unknown,
  ) => Promise<Result<{ id: string; lateFilingFeeMinor: string; note: string }>>;
  buildCertificates: (
    input: unknown,
  ) => Promise<
    Result<{
      certificates: Array<{ id: string; deducteeName: string; formType: string }>;
    }>
  >;
}) {
  const [financialYear, setFinancialYear] = useState(props.financialYear);
  const [quarter, setQuarter] = useState<string>("Q1");
  const [tan, setTan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /* ---- challan ---------------------------------------------------- */
  const [bsrCode, setBsrCode] = useState("");
  const [challanSerial, setChallanSerial] = useState("");
  const [depositDate, setDepositDate] = useState("");
  const [section, setSection] = useState("");
  const [tax, setTax] = useState("0");
  const [surcharge, setSurcharge] = useState("0");
  const [cess, setCess] = useState("0");
  const [interest, setInterest] = useState("0");
  const [fee, setFee] = useState("0");
  const [challanId, setChallanId] = useState("");
  const [challanNotice, setChallanNotice] = useState<string | null>(null);

  /* ---- mapping ---------------------------------------------------- */
  const [selected, setSelected] = useState<string[]>([]);
  const [mapNotice, setMapNotice] = useState<string | null>(null);

  /* ---- reconcile -------------------------------------------------- */
  const [reconciliation, setReconciliation] = useState<{
    reconciles: boolean;
    registerTdsMinor: string;
    challanTaxCapacityMinor: string;
    differenceMinor: string;
  } | null>(null);

  /* ---- thresholds -------------------------------------------------- */
  const [findings, setFindings] = useState<
    Array<{ deducteeId: string; deducteeName: string; section: string; aggregateMinor: string }>
  | null>(null);

  /* ---- return ----------------------------------------------------- */
  const [formType, setFormType] = useState<string>("26Q");
  const [built, setBuilt] = useState<{
    id: string;
    formType: string;
    dueDate: string;
    deducteeCount: number;
    deductionCount: number;
  } | null>(null);
  const [filedOn, setFiledOn] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");
  const [fileNotice, setFileNotice] = useState<string | null>(null);

  /* ---- certificates ------------------------------------------------ */
  const [certificateForm, setCertificateForm] = useState<string>("16A");
  const [certificateNotice, setCertificateNotice] = useState<string | null>(null);

  const period = { tan, financialYear, quarter };

  function run<T>(fn: () => Promise<Result<T>>, onOk: (data: T) => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOk(result.data);
    });
  }

  return (
    <div className="space-y-4">
      {/* ── THE PERIOD ────────────────────────────────────────────── */}
      <section className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">TAN</span>
          <input
            value={tan}
            onChange={(e) => setTan(e.target.value.toUpperCase())}
            placeholder="BLRA12345B"
            maxLength={10}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Financial year</span>
          <input
            value={financialYear}
            onChange={(e) => setFinancialYear(e.target.value)}
            placeholder="2026-27"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Quarter</span>
          <select
            value={quarter}
            onChange={(e) => setQuarter(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {QUARTERS.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── 1. DEPOSIT ────────────────────────────────────────────── */}
      {props.canManage && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Banknote className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            1. Record a challan
          </h2>
          <p className="text-sm text-muted-foreground">
            {inr(props.undepositedMinor)} of deducted tax is not yet against a challan for{" "}
            {props.financialYear}.
          </p>

          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 text-sm">
              <span className="font-medium">BSR code</span>
              <input
                value={bsrCode}
                onChange={(e) => setBsrCode(e.target.value)}
                maxLength={7}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Challan serial</span>
              <input
                value={challanSerial}
                onChange={(e) => setChallanSerial(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Deposited on</span>
              <input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Section</span>
              <select
                value={section}
                onChange={(e) => setSection(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Not specified</option>
                {props.sections.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-5">
            {[
              ["Tax", tax, setTax],
              ["Surcharge", surcharge, setSurcharge],
              ["Cess", cess, setCess],
              ["Interest", interest, setInterest],
              ["Fee", fee, setFee],
            ].map(([label, value, setter]) => (
              <label key={label as string} className="space-y-1 text-sm">
                <span className="font-medium">{label as string} (₹)</span>
                <input
                  value={value as string}
                  onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Interest and fee are not credit the deductee can claim in their 26AS. Recording
            them as tax overstates what they can set off.
          </p>

          {challanNotice && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">{challanNotice}</p>
          )}

          <button
            type="button"
            disabled={
              pending ||
              tan === "" ||
              bsrCode === "" ||
              challanSerial === "" ||
              depositDate === ""
            }
            onClick={() =>
              run(
                () =>
                  props.recordChallan({
                    ...period,
                    bsrCode,
                    challanSerial,
                    depositDate,
                    section: section === "" ? null : section,
                    taxMinor: tax,
                    surchargeMinor: surcharge,
                    cessMinor: cess,
                    interestMinor: interest,
                    feeMinor: fee,
                    status: "deposited",
                  }),
                (data) => {
                  setChallanId(data.id);
                  setChallanNotice("Challan recorded. Map the deductions it covers below.");
                },
              )
            }
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Recording…" : "Record the challan"}
          </button>
        </section>
      )}

      {/* ── 2. MAP ────────────────────────────────────────────────── */}
      {props.canManage && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CheckCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            2. Say what the challan covers
          </h2>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Challan</span>
            <input
              value={challanId}
              onChange={(e) => setChallanId(e.target.value.trim())}
              placeholder="Filled in automatically after recording one above"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            />
          </label>

          {props.unmappedDeductions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every deduction this year is already against a challan.
            </p>
          ) : (
            <>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                {props.unmappedDeductions.map((deduction) => (
                  <label key={deduction.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(deduction.id)}
                      onChange={(e) =>
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, deduction.id]
                            : current.filter((id) => id !== deduction.id),
                        )
                      }
                    />
                    <span>{deduction.label}</span>
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelected(props.unmappedDeductions.map((d) => d.id))}
                  className="underline underline-offset-2"
                >
                  select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelected([])}
                  className="underline underline-offset-2"
                >
                  clear
                </button>
              </div>
            </>
          )}

          {mapNotice && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">{mapNotice}</p>
          )}

          <button
            type="button"
            disabled={pending || challanId === "" || selected.length === 0}
            onClick={() =>
              run(
                () => props.mapDeductions({ challanId, deductionIds: selected }),
                (data) => {
                  setMapNotice(
                    `${data.mapped} mapped. ${inr(data.utilisedMinor)} of ${inr(
                      data.capacityMinor,
                    )} challan capacity used.`,
                  );
                  setSelected([]);
                },
              )
            }
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Mapping…" : `Map ${selected.length} deduction${selected.length === 1 ? "" : "s"}`}
          </button>
        </section>
      )}

      {/* ── 3. RECONCILE ──────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Scale className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          3. Does the register match the challans?
        </h2>

        <button
          type="button"
          disabled={pending || financialYear === ""}
          onClick={() =>
            run(
              () => props.reconcile({ financialYear, quarter }),
              (data) => setReconciliation(data),
            )
          }
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Checking…" : "Check the quarter"}
        </button>

        {reconciliation && (
          <div
            className={
              reconciliation.reconciles
                ? "space-y-1 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"
                : "space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            }
          >
            <p className="font-medium">
              {reconciliation.reconciles
                ? "The register and the challans agree."
                : `They differ by ${inr(reconciliation.differenceMinor)}.`}
            </p>
            <p className="text-xs text-muted-foreground">
              Register {inr(reconciliation.registerTdsMinor)} · challan capacity{" "}
              {inr(reconciliation.challanTaxCapacityMinor)}
            </p>
          </div>
        )}
      </section>

      {/* ── THRESHOLDS ────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Who crossed a threshold without being deducted from?
        </h2>
        <p className="text-sm text-muted-foreground">
          A payee whose aggregate for the year passes a section threshold owes tax on
          everything paid to them, including the payments made before they crossed it. Finding
          them in March is a catch-up deduction the payee will not expect.
        </p>

        <button
          type="button"
          disabled={pending || financialYear === ""}
          onClick={() =>
            run(
              () => props.sweepThresholds({ financialYear }),
              (data) => setFindings(data.findings),
            )
          }
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Sweeping…" : "Sweep the year"}
        </button>

        {findings && (
          <div className="text-sm">
            {findings.length === 0 ? (
              <p className="text-emerald-700 dark:text-emerald-400">
                Nobody has crossed a threshold without being deducted from.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {findings.map((finding, i) => (
                  <li key={`${finding.deducteeId}-${i}`} className="flex flex-wrap gap-2 p-2.5">
                    <span className="font-medium">{finding.deducteeName}</span>
                    <span className="text-xs text-muted-foreground">{finding.section}</span>
                    <span className="ml-auto tabular-nums">{inr(finding.aggregateMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ── 4. THE RETURN ─────────────────────────────────────────── */}
      {props.canFile && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileCheck2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            4. Build and file the return
          </h2>
          <p className="text-sm text-muted-foreground">
            Build it only once the quarter reconciles. A return whose challans do not cover
            its deductions comes back defective and has to be corrected.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Form</span>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {RETURN_FORMS.map((form) => (
                  <option key={form} value={form}>
                    {form}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={pending || tan === ""}
                onClick={() =>
                  run(
                    () => props.buildReturn({ ...period, formType }),
                    (data) => setBuilt(data),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Building…" : "Build it"}
              </button>
            </div>
          </div>

          {built && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
              <p>
                {built.formType} for {quarter}: {built.deducteeCount} deductee
                {built.deducteeCount === 1 ? "" : "s"}, {built.deductionCount} deduction
                {built.deductionCount === 1 ? "" : "s"}. Due {built.dueDate}.
              </p>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1">
                  <span className="font-medium">Filed on</span>
                  <input
                    type="date"
                    value={filedOn}
                    onChange={(e) => setFiledOn(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 sm:col-span-2">
                  <span className="font-medium">Provisional receipt number</span>
                  <input
                    value={acknowledgement}
                    onChange={(e) => setAcknowledgement(e.target.value.toUpperCase())}
                    maxLength={20}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  />
                </label>
              </div>

              {fileNotice && <p className="font-medium">{fileNotice}</p>}

              <button
                type="button"
                disabled={pending || filedOn === "" || acknowledgement === ""}
                onClick={() =>
                  run(
                    () =>
                      props.fileReturn({
                        ...period,
                        formType,
                        returnId: built.id,
                        filedOn,
                        acknowledgementNumber: acknowledgement,
                      }),
                    (data) =>
                      /*
                        ⚠️ THE LATE FEE IS REPORTED, NOT HIDDEN. Section
                        234E is ₹200 a day until the return is filed, and
                        it is capped at the tax deducted. Somebody filing
                        late needs to see the number now rather than in a
                        demand notice.
                      */
                      setFileNotice(
                        `${data.note}${
                          data.lateFilingFeeMinor !== "0"
                            ? ` Late filing fee ${inr(data.lateFilingFeeMinor)}.`
                            : ""
                        }`,
                      ),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Recording…" : "Record it as filed"}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── 5. CERTIFICATES ───────────────────────────────────────── */}
      {props.canFile && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">5. Certificates for the deductees</h2>
          <p className="text-sm text-muted-foreground">
            A deductee cannot claim credit without one, and the deadline is fifteen days after
            the return is due.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Form</span>
              <select
                value={certificateForm}
                onChange={(e) => setCertificateForm(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {CERTIFICATE_FORMS.map((form) => (
                  <option key={form} value={form}>
                    {form}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={pending || tan === ""}
                onClick={() =>
                  run(
                    () => props.buildCertificates({ ...period, formType: certificateForm }),
                    (data) =>
                      setCertificateNotice(
                        `${data.certificates.length} certificate${
                          data.certificates.length === 1 ? "" : "s"
                        } built.`,
                      ),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Building…" : "Build them"}
              </button>
            </div>
          </div>

          {certificateNotice && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">{certificateNotice}</p>
          )}
        </section>
      )}
    </div>
  );
}
