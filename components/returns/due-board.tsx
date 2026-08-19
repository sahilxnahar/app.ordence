/**
 * Ordence — ⭐⭐ WHAT IS DUE
 * Version: v1.24.0-alpha
 *
 * ⚠️ A SERVER COMPONENT, DELIBERATELY. Nothing here is interactive:
 * there is no button, no form and no state. Shipping it as a client
 * component would send a bundle to the browser to render a list that
 * never changes after it arrives.
 *
 * ⭐ AND IT LEADS WITH THE CONSEQUENCE, NOT THE DATE. "₹1,84,000 is
 * overdue and interest is running" is what changes what somebody does in
 * the next hour. A date on its own does not.
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type DueItemView = {
  kind: string;
  label: string;
  authority: string;
  amountMinor: string;
  dueOn: string;
  state: string;
  daysUntil: number;
  ifLate: string;
  note: string | null;
};

function rupees(minor: string): string {
  const value = BigInt(minor || "0");
  const whole = (value / 100n).toLocaleString("en-IN");
  const paise = (value % 100n).toString().padStart(2, "0");
  return `₹${whole}.${paise}`;
}

function badgeFor(state: string, daysUntil: number) {
  switch (state) {
    case "overdue":
      return (
        <Badge variant="destructive">
          {Math.abs(daysUntil)} day{Math.abs(daysUntil) === 1 ? "" : "s"} overdue
        </Badge>
      );
    case "due_today":
      return <Badge variant="destructive">due today</Badge>;
    case "due_soon":
      return <Badge variant="outline">in {daysUntil} days</Badge>;
    case "nothing_owed":
      return <Badge variant="secondary">nothing owed</Badge>;
    default:
      return <Badge variant="secondary">in {daysUntil} days</Badge>;
  }
}

export function DueBoard({
  items,
  summary,
}: {
  items: DueItemView[];
  summary: string;
}) {
  const owed = items.filter((i) => BigInt(i.amountMinor || "0") > 0n);
  const total = owed.reduce((sum, i) => sum + BigInt(i.amountMinor || "0"), 0n);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <p className="text-sm font-medium">{summary}</p>
          {owed.length > 0 ? (
            <p className="mt-1 text-2xl font-semibold">{rupees(total.toString())}</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {items.map((item) => {
          const amount = BigInt(item.amountMinor || "0");
          const urgent = item.state === "overdue" || item.state === "due_today";

          return (
            <Card
              key={item.kind}
              className={urgent && amount > 0n ? "border-destructive" : undefined}
              data-testid={`due-${item.kind}`}
            >
              <CardContent className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{item.label}</span>
                  {badgeFor(item.state, item.daysUntil)}
                  <span className="text-xs text-muted-foreground">
                    {item.authority} · due {item.dueOn}
                  </span>
                  <span className="ml-auto font-semibold">{rupees(item.amountMinor)}</span>
                </div>

                {item.note ? (
                  <p className="text-xs text-muted-foreground">{item.note}</p>
                ) : null}

                {/*
                  ⚠️ THE CONSEQUENCE IS SHOWN ONLY WHERE IT APPLIES. A
                  page that prints an interest warning against every line
                  including the settled ones is a page people stop
                  reading.
                */}
                {amount > 0n && urgent ? (
                  <p className="text-xs text-destructive">{item.ifLate}</p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        ⚠️ Professional tax due dates vary by State — Ordence assumes the 20th, which is the
        common one. Check yours. And these figures are what is in your ledger: an obligation
        showing nothing owed means nothing has been posted against it, which is not the same as
        nothing being due.
      </p>
    </div>
  );
}
