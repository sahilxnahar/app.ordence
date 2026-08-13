/**
 * Ordence — ⭐⭐ THE CLIENT ACCOUNT
 * Version: v1.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE "IN DEBIT" COUNTER SHOULD ALWAYS BE ZERO
 * ══════════════════════════════════════════════════════════════════════
 * The trigger in 0058 makes a negative client balance impossible to
 * create. It is shown anyway — because a control that is never displayed
 * is a control nobody trusts, and because a non-zero here would mean the
 * trigger had been bypassed, which is worth knowing immediately.
 *
 * ⚠️ A client ledger in debit means the firm paid out money it did not
 * hold for that client, which means it paid out somebody else's. There
 * is no innocent version of that number.
 */

import Link from "next/link";
import { getClientAccount } from "@/server/actions/client-account";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Client account · Ordence" };

function inr(minorUnits: string | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
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

export default async function ClientAccountPage() {
  const result = await getClientAccount();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Client account</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { clients, totalHeldMinor, inDebitCount, dormant } = result.data;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Client account</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The cardinal rule, first. It is not "keep records".
           */}
          Money held for a client is not the firm&apos;s money. The rule that
          matters is not record-keeping — it is that one client&apos;s money may
          never fund another client&apos;s disbursement, not for an afternoon
          and not where it is repaid the same week.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Held for clients
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totalHeldMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ This corrects something v0.98.0 decided. A retainer
               * was modelled as an unapplied receipt — right
               * commercially, and nothing said it was client money in
               * the firm's bank account.
               */}
              This should agree, to the paise, with the balance on the
              firm&apos;s designated client bank account.
            </p>
          </CardContent>
        </Card>

        <Card className={inDebitCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Ledgers in debit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inDebitCount}</p>
            <p className="text-xs text-muted-foreground">
              {inDebitCount === 0
                ? "Zero, and the database refuses to create one. A payment out that would take a client's ledger below nil is rejected at the point of entry."
                : "🔴 A negative client balance means money was paid out that was not held for that client — which means another client's money was used. This should be impossible; investigate immediately."}
            </p>
          </CardContent>
        </Card>

        <Card className={dormant > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Untouched for a year
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{dormant}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ Holding a balance indefinitely after the work is done
               * is its own regulatory problem.
               */}
              Money held with no movement for over a year. Once the work is
              finished it should have gone back to the client.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            By client{" "}
            <span className="font-normal text-muted-foreground">
              ({clients.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 Fees out only against a bill.
             */}
            Fees can only be transferred to the firm&apos;s own account against
            an issued bill — a transfer with no invoice behind it is refused.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing held. Client money appears here as soon as funds are
              received on account.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 text-right font-medium">Held</th>
                  <th className="py-2 pr-3 text-right font-medium">Entries</th>
                  <th className="py-2 pr-3 font-medium">Last movement</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.companyId} className="border-b last:border-0">
                    <td className="py-2 pr-3">{c.companyName ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">
                      {inr(c.balanceMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {c.entryCount}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{c.lastEntry ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {c.inDebit ? (
                        <Badge variant="destructive">in debit</Badge>
                      ) : BigInt(c.balanceMinor) === 0n ? (
                        <Badge variant="outline">nil</Badge>
                      ) : (
                        <Badge variant="default">held</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What the rules require</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Bar Council of India Rules, Chapter II, Section II — an advocate must
            keep accounts of the client&apos;s money entrusted to him, showing
            what was received, what was spent on the client&apos;s behalf, and
            what is still held.
          </p>
          <p>
            🔴 Ordence enforces the three that are arithmetic rather than
            paperwork: a client ledger can never go into debit; funds held on one
            matter are not available to another without a deliberate transfer;
            and fees leave the client account only against an issued bill.
          </p>
          <p>
            ⚠️ It does not reconcile the firm&apos;s bank statement for you. The
            figure above is what the ledger says is held — agreeing it to the
            designated client bank account is still a person&apos;s job, and it
            is the job an inspection asks about.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/legal/matters" className="underline">
          Matters
        </Link>{" "}
        ·{" "}
        <Link href="/receipts" className="underline">
          Receipts
        </Link>
      </p>
    </main>
  );
}
