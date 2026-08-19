/**
 * Ordence — ⭐⭐ WHAT EVERY VENDOR IS OWED
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `currencyAssumed` IS SHOWN, NOT SWALLOWED
 * ══════════════════════════════════════════════════════════════════════
 * `getVendorBalances` returns a currency AND whether it had to assume
 * one, plus a sentence explaining the assumption. A total across vendors
 * whose ledgers are in different currencies is not a quantity of
 * anything, and the flag is how the caller finds out before adding them
 * up in their head.
 *
 * ⚠️ A SERVER COMPONENT. There is nothing to interact with , the rows
 * link to the vendor page, which is where the writes live.
 */

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type VendorBalanceRow = {
  vendorId: string;
  legalName: string;
  balanceMinor: string;
  currency: string;
  currencyAssumed: boolean;
};

function inr(minor: string): string {
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

export function VendorBalances(props: {
  rows: readonly VendorBalanceRow[];
  currency: string;
  currencyAssumed: boolean;
  currencyNote: string;
}) {
  /**
   * ⚠️ SUMMED AS `bigint`. A purchase ledger crossing ₹90 crore in paise
   * exceeds what a double can hold exactly, and the first symptom is a
   * total that is wrong by a rupee and cannot be reproduced.
   */
  const total = props.rows.reduce((acc, row) => acc + BigInt(row.balanceMinor), 0n).toString();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Owed to vendors</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {props.currencyAssumed && (
          <p className="border-b bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            {props.currencyNote}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Vendor</th>
                <th className="p-3 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {props.rows.map((row) => (
                <tr key={row.vendorId} className="hover:bg-muted/30">
                  <td className="p-3">
                    <Link
                      href={`/purchases/vendors/${row.vendorId}`}
                      className="underline underline-offset-2"
                    >
                      {row.legalName}
                    </Link>
                    {row.currencyAssumed && (
                      <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                        currency assumed
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums">{inr(row.balanceMinor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/30">
                <td className="p-3 font-medium">Total ({props.currency})</td>
                <td className="p-3 text-right font-semibold tabular-nums">{inr(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
