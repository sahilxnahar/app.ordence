"use client";

/**
 * Ordence — Payroll setup
 * Version: v1.23.0-alpha
 *
 * ⚠️ THE TWO FLAGS THAT MATTER ARE SHOWN ON EVERY COMPONENT, not hidden
 * behind an edit dialog. `carries PF` and `pro-rates` are the two that
 * produce a payslip wrong by a plausible amount when they are backwards,
 * and a setup screen that makes them hard to see is a setup screen that
 * gets them wrong.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ComponentRow = {
  id: string;
  code: string;
  label: string;
  kind: string;
  pfApplicable: boolean;
  esiApplicable: boolean;
  taxable: boolean;
  proRates: boolean;
};

export type AccountRow = { role: string; label: string; help: string; mapped: boolean };

type Result =
  | { ok: true; data: { components: number; rates: number; note: string } }
  | { ok: false; error: string };

export function SetupPanel({
  components,
  accounts,
  canManage,
  onSeed,
}: {
  components: ComponentRow[];
  accounts: AccountRow[];
  canManage: boolean;
  onSeed: () => Promise<Result>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const unmapped = accounts.filter((a) => !a.mapped);

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Starter set</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Writes seven pay components and the provident fund, ESI and income tax rates into
              your workspace, dated. Three States&apos; professional tax slabs are included;
              everything else is deliberately left empty, because a wrong slab is worse than a
              missing one — a missing one says so on the payslip, and a wrong one deducts a
              confident amount that is not right.
            </p>
            <p className="text-xs text-muted-foreground">
              Running this again will not overwrite anything you have corrected.
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await onSeed();
                  if (result.ok) {
                    toast.success(
                      `${result.data.components} components and ${result.data.rates} rate sets added.`,
                    );
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                })
              }
            >
              Seed the starter set
            </Button>
            <p className="rounded border border-amber-500 p-2 text-xs">
              These are Ordence&apos;s opening numbers, not legal advice. Check every rate and
              every professional tax slab against what your State and your auditor say before the
              first run.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Pay components ({components.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {components.length === 0 ? (
            <p className="text-xs text-muted-foreground">None yet.</p>
          ) : null}
          {components.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-xs last:border-0">
              <span className="font-medium">{c.label}</span>
              <code className="text-muted-foreground">{c.code}</code>
              <Badge variant={c.kind === "deduction" ? "destructive" : "secondary"}>{c.kind}</Badge>
              {c.pfApplicable ? <Badge variant="outline">carries PF</Badge> : null}
              {!c.proRates ? <Badge variant="outline">paid in full</Badge> : null}
              {!c.taxable ? <Badge variant="outline">not taxable</Badge> : null}
            </div>
          ))}
          <p className="pt-2 text-xs text-muted-foreground">
            ⚠️ &quot;Carries PF&quot; and &quot;paid in full&quot; are the two flags worth checking
            with your auditor. Basic and dearness allowance carry provident fund; whether special
            allowance does is genuinely contested, and Ordence takes the common reading rather than
            deciding for you.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Ledger accounts ({accounts.length - unmapped.length} of {accounts.length} mapped)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {accounts.map((a) => (
            <div key={a.role} className="border-b py-2 text-xs last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.label}</span>
                <code className="text-muted-foreground">{a.role}</code>
                {a.mapped ? (
                  <Badge variant="secondary">mapped</Badge>
                ) : (
                  <Badge variant="destructive">not mapped</Badge>
                )}
              </div>
              <p className="text-muted-foreground">{a.help}</p>
            </div>
          ))}
          <p className="pt-2 text-xs text-muted-foreground">
            A run computes and can be approved without these. It cannot be posted without them: a
            payroll journal missing a leg does not balance, and Ordence refuses the whole entry
            rather than writing half of it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
