/**
 * Ordence — Contracts
 * Version: v0.8.0-alpha
 */

import Link from "next/link";
import { FileSignature } from "lucide-react";
import { getContracts } from "@/server/actions/contracts";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMoney(value: string | null, currency: string): string {
  if (!value) return "—";
  const [whole = "0", fraction = "00"] = String(value).split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${withSeparators}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "executed":
    case "active":
    case "signed":
      return "default";
    case "terminated":
    case "cancelled":
    case "expired":
      return "destructive";
    case "draft":
      return "outline";
    default:
      return "secondary";
  }
}

export default async function ContractsPage() {
  const result = await getContracts();

  if (!result.ok) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-bold">Contracts</h1>
        <p className="mt-2 text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const rows = result.data;

  return (
    <main className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Contracts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? "contract" : "contracts"} in your workspace
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <FileSignature className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">
            No contracts yet.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((contract) => (
            <li key={contract.id}>
              <Link
                href={`/contracts/${contract.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{contract.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      contract.contractNumber,
                      humanise(contract.contractType),
                      contract.counterpartyName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular-nums text-sm">
                    {formatMoney(contract.value, contract.currency)}
                  </span>
                  <Badge variant={statusTone(contract.status)}>
                    {humanise(contract.status)}
                  </Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
