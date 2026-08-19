/**
 * Ordence — ⭐⭐⭐ THE MORNING SUMMARY
 * Version: v1.26.0-alpha · Batch 18
 *
 * ⚠️ A SERVER COMPONENT, DELIBERATELY. There is no button, no form and
 * no state on this page: it is read, acted on by following a link, and
 * closed. Shipping it as a client component would send a bundle to a
 * phone on a site office connection to render a list that never changes
 * after it arrives.
 *
 * ⭐ AND IT LEADS WITH ONE SENTENCE. Somebody reads exactly that much
 * before deciding whether to keep reading, so it has to be the true
 * thing rather than a count of rows.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type MorningItemView = {
  key: string;
  kind: string;
  headline: string;
  amountMinor: string | null;
  deadline: string | null;
  state: string;
  compounds: boolean;
  consequence: string;
  where: string;
  detail: string | null;
};

function rupees(minor: string): string {
  const value = BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(whole)}.${paise}`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

function stateBadge(state: string) {
  switch (state) {
    case "overdue":
      return <Badge variant="destructive">late</Badge>;
    case "closing_today":
      return <Badge variant="destructive">today</Badge>;
    case "due_soon":
      return <Badge variant="outline">soon</Badge>;
    case "missed":
      return <Badge variant="secondary">window closed</Badge>;
    default:
      return <Badge variant="secondary">watch</Badge>;
  }
}

export function MorningBoard({
  headline,
  allClear,
  actionableCount,
  totalAtStakeMinor,
  items,
  hiddenNote,
  asOf,
}: {
  headline: string;
  allClear: boolean;
  actionableCount: number;
  totalAtStakeMinor: string;
  items: MorningItemView[];
  hiddenNote: string | null;
  asOf: string;
}) {
  return (
    <div className="space-y-4">
      <Card className={allClear ? undefined : "border-destructive"}>
        <CardContent className="pt-4">
          <p className="text-lg font-medium">{headline}</p>
          {!allClear && BigInt(totalAtStakeMinor || "0") > 0n ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {rupees(totalAtStakeMinor)} across {actionableCount} thing
              {actionableCount === 1 ? "" : "s"} that can still be acted on.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">As of {asOf}.</p>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to show. Every statutory liability is settled, every document is posted,
          and nobody is waiting on money.
        </p>
      ) : null}

      <div className="space-y-2">
        {items.map((item) => {
          const urgent = item.state === "overdue" || item.state === "closing_today";
          const amount = item.amountMinor ? BigInt(item.amountMinor) : null;

          return (
            <Card
              key={item.key}
              className={urgent ? "border-destructive" : undefined}
              data-testid={`morning-${item.kind}`}
            >
              <CardContent className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={item.where} className="font-medium underline">
                    {item.headline}
                  </Link>
                  {stateBadge(item.state)}
                  {/*
                    🔴 THE COMPOUNDING MARK IS THE MOST USEFUL BADGE ON
                    THE PAGE. It is the difference between a thing that
                    costs the same tomorrow and a thing that does not,
                    and it is the reason a ₹4,000 line can sit above a
                    ₹40 lakh one without that looking like a bug.
                  */}
                  {item.compounds && item.state !== "watch" ? (
                    <Badge variant="destructive">getting worse daily</Badge>
                  ) : null}
                  {amount !== null && amount > 0n ? (
                    <span className="ml-auto font-semibold">
                      {rupees(item.amountMinor!)}
                    </span>
                  ) : null}
                </div>

                {item.detail ? (
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                ) : null}

                {/*
                  ⚠️ THE CONSEQUENCE IS ALWAYS SHOWN, not only on the
                  urgent rows. It is the whole reason the line is on the
                  page — a headline says what is true and the consequence
                  says why anybody should care, and hiding the second
                  behind a click makes the first look like noise.
                */}
                <p className="text-xs text-muted-foreground">{item.consequence}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {hiddenNote ? (
        <p className="text-xs text-muted-foreground">{hiddenNote}</p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        ⚠️ This page computes nothing of its own — every figure is read from the module
        that owns it, so a number that looks wrong here is wrong there too. It shows
        totals and counts rather than names or individual amounts, which is why it needs
        only read access to settings; following a link lands on a screen with its own
        guard.
      </p>
    </div>
  );
}
