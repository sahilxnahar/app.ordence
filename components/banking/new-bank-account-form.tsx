"use client";

/**
 * Ordence — ⭐⭐ THE FORM THAT MAKES A BANK ACCOUNT POSSIBLE
 * Version: v1.39.0-alpha (Mega-wave 1, Batch 36)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BEFORE THIS FILE, `insert(bankAccounts)` APPEARED NOWHERE IN THE TREE
 * ══════════════════════════════════════════════════════════════════════
 * Not "no screen". No code path at all. Reconciliation, statement
 * import, matching and payment recording were all built on a table
 * nothing could put a row in.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM ASKS FOR A LEDGER CODE, AND EXPLAINS WHY
 * ══════════════════════════════════════════════════════════════════════
 * A bank account needs a ledger of its own, because two accounts sharing
 * one ledger cannot be reconciled and the database refuses it. Most
 * people opening a bank account in an ERP have never used the word
 * "ledger" and will not guess that.
 *
 * ⚠️ SO THE FIELD IS NOT LABELLED "LEDGER ID" AND LEFT THERE. It says
 * what it is for, offers a sensible code, and the server creates both
 * rows in one transaction so there is no half-made state to recover
 * from.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = { ok: true; data: { note: string } } | { ok: false; error: string };

export function NewBankAccountForm({
  action,
  suggestedCode,
}: {
  action: (input: unknown) => Promise<Result>;
  suggestedCode: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    setNote(null);

    const raw = (k: string) => {
      const v = formData.get(k);
      const s = typeof v === "string" ? v.trim() : "";
      return s === "" ? undefined : s;
    };

    start(async () => {
      const result = await action({
        label: raw("label"),
        bankName: raw("bankName"),
        /**
         * ⚠️ OMITTED RATHER THAN SENT EMPTY. The schema marks these
         * optional; an empty string would fail the IFSC pattern and
         * report a format error on a field the operator left blank on
         * purpose.
         */
        accountLast4: raw("accountLast4"),
        ifsc: raw("ifsc"),
        ledgerCode: raw("ledgerCode"),
        ledgerType: raw("ledgerType") ?? "operating",
        currency: raw("currency") ?? "INR",
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNote(result.data.note);
      router.refresh();
    });
  }

  return (
    <form action={submit} className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="font-medium">Add a bank account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This opens a ledger for the account at the same time. Everything that
          moves through the bank posts to that ledger, which is what makes
          reconciliation possible.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="label">Account name</Label>
          <Input
            id="label"
            name="label"
            required
            maxLength={160}
            placeholder="Current account, HDFC"
          />
          <p className="text-xs text-muted-foreground">
            What you call it in conversation. It appears on every match screen.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bankName">Bank</Label>
          <Input id="bankName" name="bankName" required maxLength={160} placeholder="HDFC Bank" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="accountLast4">Last four digits</Label>
          <Input
            id="accountLast4"
            name="accountLast4"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            placeholder="4821"
          />
          {/*
            ⚠️ THE COPY IS THE CONTROL. The column is varchar(4) and the
            schema rejects anything else, but somebody will try to paste
            a full number, and being told why beats being told "invalid".
          */}
          <p className="text-xs text-muted-foreground">
            Only the last four. A full account number in a field half the office
            can read is a full account number in a screenshot.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ifsc">IFSC</Label>
          <Input
            id="ifsc"
            name="ifsc"
            maxLength={11}
            placeholder="HDFC0001234"
            className="uppercase"
          />
          <p className="text-xs text-muted-foreground">
            Four letters, a zero, then six characters.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ledgerCode">Ledger code</Label>
          <Input
            id="ledgerCode"
            name="ledgerCode"
            required
            maxLength={40}
            defaultValue={suggestedCode}
          />
          <p className="text-xs text-muted-foreground">
            Where this account sits in your chart of accounts. Change it to match
            your existing numbering.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ledgerType">What kind of money</Label>
          <select
            id="ledgerType"
            name="ledgerType"
            defaultValue="operating"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="operating">Ours (operating)</option>
            <option value="trust">Client money held on trust</option>
            <option value="escrow">Escrow</option>
            <option value="retention">Retention</option>
          </select>
          {/*
            🔴 NOT A LABEL, A LEGAL BOUNDARY. Client money on trust is not
            the firm's asset, and commingling it with operating funds is a
            regulatory breach. Offered here because the ledger type cannot
            be changed later without moving every transaction on it.
          */}
          <p className="text-xs text-muted-foreground">
            Trust and escrow money is not yours. This cannot be changed later
            without moving every transaction on the ledger.
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {note}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Opening…" : "Add account"}
      </Button>
    </form>
  );
}
