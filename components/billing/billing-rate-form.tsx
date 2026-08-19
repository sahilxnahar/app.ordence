"use client";

/**
 * Ordence — ⭐ Setting what an hour is worth
 * Version: v1.2.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FORM ADDS A ROW. IT NEVER EDITS ONE.
 * ══════════════════════════════════════════════════════════════════════
 * A partner's rate going from ₹8,000 to ₹9,500 on 1 April is a NEW rate
 * from 1 April — not a correction of the old one. Editing in place would
 * re-price every unbilled hour ever worked at that rate, including March
 * work billed six months later.
 *
 * ⚠️ SO THE FORM SAYS "ADD A RATE", NOT "CHANGE A RATE", and the screen
 * shows the history rather than a single current figure. A form that
 * looks like it edits will be used as though it does.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBillingRate } from "@/server/actions/time-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { parseMoney } from "@/lib/billing/money";

export function BillingRateForm({
  companies,
  people,
  defaultDate,
}: {
  companies: readonly { id: string; name: string }[];
  people: readonly { id: string; name: string }[];
  defaultDate: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState("");
  const [roleName, setRoleName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [rate, setRate] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(defaultDate);

  function submit() {
    setError(null);

    /**
     * ⚠️ PARSED WITH THE SAME `parseMoney` EVERY OTHER AMOUNT IN THE
     * PRODUCT USES. A second "just multiply by 100" here is how ₹8,000
     * becomes ₹80.00 on somebody's rate card.
     */
    let rateMinor: bigint;
    try {
      rateMinor = parseMoney(rate);
    } catch {
      setError("Enter the hourly rate in rupees — 8000 or 8,000.00.");
      return;
    }
    if (rateMinor <= 0n) {
      setError("A rate of zero would put ₹0.00 lines on a client's bill.");
      return;
    }
    if (!userId && !roleName.trim() && !companyId) {
      setError(
        "A rate must name a person, a role or a client — otherwise nothing can apply it.",
      );
      return;
    }

    start(async () => {
      const res = await saveBillingRate({
        rateMinor: rateMinor.toString(),
        effectiveFrom,
        ...(userId ? { userId } : {}),
        ...(roleName.trim() ? { roleName: roleName.trim() } : {}),
        ...(companyId ? { companyId } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRate("");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a rate
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="br-user">Person</Label>
          <Select id="br-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">— any —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="br-role">Role</Label>
          <Input
            id="br-role"
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder="Partner · Associate · Paralegal"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="br-company">Client</Label>
          <Select
            id="br-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">— the house rate, for every client —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {/**
             * ⭐ SPECIFICITY BEATS RECENCY — the whole reason this field
             * exists. A rate negotiated in an engagement letter must not
             * be overridden by a house rate somebody set yesterday.
             */}
            A rate naming a client always wins over the house rate, however
            recently the house rate was set.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="br-rate" required>
            Per hour
          </Label>
          <Input
            id="br-rate"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="8000"
            className="tabular-nums"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="br-from" required>
            Applies from
          </Label>
          <Input
            id="br-from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            Work done before this date keeps the rate that applied then.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Add rate"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
