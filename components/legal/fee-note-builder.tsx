"use client";

/**
 * Ordence — ⭐⭐⭐ THE FEE NOTE BUILDER
 * Version: v1.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TAX DECISION IS SHOWN BEFORE THE BILL, NOT AFTER IT
 * ══════════════════════════════════════════════════════════════════════
 * A tax rate field somebody types 18 into is how a firm charges GST it
 * had no authority to charge. So this screen does not offer a rate at
 * all — it works out the basis from what the firm is and what the client
 * is, prints the reasoning and the notification number, and puts the
 * Rule 46(p) declaration on the document.
 *
 * ⚠️ The one contested combination — a senior advocate billing another
 * advocate — is shown in red as ARGUABLE rather than answered quietly.
 * A confident wrong answer on that is worse than an honest open one.
 */

import { useState, useTransition } from "react";
import { previewFeeNote } from "@/server/actions/legal-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function inr(minorUnits: string): string {
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

type Result = Awaited<ReturnType<typeof previewFeeNote>>;

const BASIS_LABEL: Record<string, string> = {
  exempt: "Exempt — nobody pays",
  reverse_charge: "Reverse charge — the client pays",
  forward_charge: "Forward charge — the firm charges and pays",
  export_zero_rated: "Export — zero rated",
};

const SERVICE_LABEL: Record<string, string> = {
  advice: "Advice or drafting",
  representational: "Appearing before a court or tribunal",
  arbitral_tribunal: "Sitting as an arbitral tribunal",
  not_a_legal_service: "Not a legal service (training, writing, letting)",
};

export function FeeNoteBuilder({
  clients,
}: {
  clients: readonly { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<Result, { ok: true }>["data"] | null>(
    null,
  );

  const [companyId, setCompanyId] = useState(clients[0]?.id ?? "");
  const [feesRupees, setFeesRupees] = useState("100000");
  const [service, setService] = useState("advice");

  function submit() {
    setError(null);
    start(async () => {
      /** ⚠️ Rupees in the box, paise on the wire. Money never floats. */
      const whole = feesRupees.trim().replace(/,/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(whole)) {
        setError("Enter the fee in rupees, with at most two decimals.");
        return;
      }
      const [rupees = "0", paise = ""] = whole.split(".");
      const minor = `${rupees}${paise.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");

      const res = await previewFeeNote({
        companyId,
        feesMinor: minor === "" ? "0" : minor,
        service,
      });
      if (!res.ok) {
        setError(res.error);
        setResult(null);
        return;
      }
      setResult(res.data);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Price a bill</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="fn-client">Client</Label>
              <Select
                id="fn-client"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Choose a client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="fn-service">What was supplied</Label>
              <Select
                id="fn-service"
                value={service}
                onChange={(e) => setService(e.target.value)}
              >
                {Object.entries(SERVICE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="fn-fees">Professional fees (₹)</Label>
              <Input
                id="fn-fees"
                inputMode="decimal"
                value={feesRupees}
                onChange={(e) => setFeesRupees(e.target.value)}
              />
            </div>
          </div>

          {/**
           * 🔴 THERE IS NO TAX RATE FIELD, AND THAT IS THE POINT.
           */}
          <p className="text-xs text-muted-foreground">
            There is no tax rate to type. The rate follows from what the firm is
            and what the client is — offering a box would be offering somebody
            the chance to charge tax the firm had no authority to charge.
          </p>

          <Button onClick={submit} disabled={pending || !companyId}>
            {pending ? "Working it out…" : "Work out the bill"}
          </Button>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <>
          <Card
            className={
              result.charge.arguable
                ? "border-destructive"
                : result.charge.basis === "forward_charge"
                  ? undefined
                  : "border-emerald-500"
            }
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {BASIS_LABEL[result.charge.basis] ?? result.charge.basis}{" "}
                {result.charge.arguable && (
                  <Badge variant="destructive" className="ml-1">
                    arguable
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>{result.charge.reason}</p>
              <p className="text-xs text-muted-foreground">{result.charge.citation}</p>

              {/**
               * 🔴 Rule 46(p). The exact line that has to appear on the
               * document, quoted so it can be copied.
               */}
              <div className="rounded border-l-4 border-muted bg-muted/40 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  On the invoice — Rule 46(p)
                </p>
                <p className="mt-1 font-medium">{result.charge.invoiceDeclaration}</p>
              </div>

              {result.charge.arguableNote && (
                <p className="rounded border-l-4 border-destructive bg-red-50 p-3 text-sm">
                  {result.charge.arguableNote}
                </p>
              )}

              {result.charge.notes.map((n, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {n}
                </p>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">The bill</CardTitle>
              <p className="text-sm text-muted-foreground">
                {/**
                 * 🔴 Rule 33(ii) — separately indicated, on the face of
                 * the document.
                 */}
                Disbursements are listed apart from the fee and added after the
                tax. They were never in the value of supply, and Rule 33(ii)
                requires them to be separately indicated on the invoice.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b">
                    <td className="py-2">Professional fees</td>
                    <td className="py-2 text-right tabular-nums">
                      {inr(result.feesMinor)}
                    </td>
                  </tr>
                  {result.taxableRecoveriesMinor !== "0" && (
                    <tr className="border-b">
                      <td className="py-2">
                        Recoveries forming part of the supply
                        <p className="text-xs text-muted-foreground">
                          Travel, courier and anything the client was never
                          liable to the third party for.
                        </p>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {inr(result.taxableRecoveriesMinor)}
                      </td>
                    </tr>
                  )}
                  <tr className="border-b font-medium">
                    <td className="py-2">Taxable value</td>
                    <td className="py-2 text-right tabular-nums">
                      {inr(result.taxableValueMinor)}
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">
                      GST at {(result.taxRateBps / 100).toFixed(0)}%
                      {result.taxRateBps === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {result.charge.basis === "reverse_charge"
                            ? "Nil on this invoice — the client pays it under reverse charge and takes the credit for it."
                            : result.charge.basis === "exempt"
                              ? "Nil — the supply is exempt, so nobody pays it."
                              : "Nil — zero rated."}
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {inr(result.taxMinor)}
                    </td>
                  </tr>

                  {result.lines
                    .filter((l) => l.isPureAgent)
                    .map((l) => (
                      <tr key={l.id} className="border-b">
                        <td className="py-2 pl-4 text-muted-foreground">
                          {l.kindLabel} — {l.description}
                          <p className="text-xs">
                            Paid on your behalf. Excluded from the value of
                            supply under Rule 33.
                          </p>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {inr(l.recoveredMinor)}
                        </td>
                      </tr>
                    ))}

                  <tr className="text-base font-semibold">
                    <td className="py-3">Total payable</td>
                    <td className="py-3 text-right tabular-nums">
                      {inr(result.totalPayableMinor)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {result.pureAgentDisbursementsMinor !== "0" && (
                <p className="text-xs text-muted-foreground">
                  ⭐ {inr(result.pureAgentDisbursementsMinor)} of that total is
                  money the firm paid out for the client and is recovering at
                  actual. It carries no tax, whatever the basis of the fee.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
