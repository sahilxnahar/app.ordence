"use client";

/**
 * Ordence — ⭐⭐⭐ THE RECONCILIATION WORKSPACE
 * Version: v1.18.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE IMPORT IS THE ONLY WRITE ON THIS SCREEN, AND IT WRITES
 * EVIDENCE, NOT CORRECTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A statement line, once imported, cannot be edited from anywhere in
 * Ordence. There is no button here, and there is no action behind one.
 * Reconciliation explains the difference between the bank and the books;
 * a tool that edits either side to make them agree has destroyed the
 * only evidence that something was wrong.
 *
 * ⚠️ THE PASTE BOX IS DELIBERATELY DUMB. Every Indian bank exports a
 * different CSV, several of them with a preamble, merged header rows and
 * separate withdrawal and deposit columns whose order varies. Writing a
 * parser that guesses which column is which produces an import that is
 * silently wrong for one bank in five, and the failure is a reconciliation
 * that balances against inverted signs.
 *
 * ⭐ SO THE FORMAT IS STATED, THE COLUMNS ARE FIXED, AND ONE SIGNED
 * AMOUNT IS ASKED FOR. A person pasting four columns can see whether the
 * minus signs are where they should be. A parser cannot.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function ReconciliationWorkspace({
  accounts,
  statements,
  importAction,
}: {
  accounts: ReadonlyArray<{
    id: string;
    label: string;
    bankName: string;
    accountLast4: string | null;
    reconciledTo: string | null;
  }>;
  statements: ReadonlyArray<{
    id: string;
    accountLabel: string;
    periodFrom: string;
    periodTo: string;
    lineCount: number;
  }>;
  importAction: (i: unknown) => Promise<
    Result<{
      statementId: string;
      imported: number;
      duplicatesFlagged: number;
      balanceTies: boolean;
      note: string;
    }>
  >;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    bankAccountId: accounts[0]?.id ?? "",
    periodFrom: "",
    periodTo: "",
    opening: "",
    closing: "",
    pasted: "",
  });

  function runImport() {
    let lines: ParsedLine[];
    try {
      lines = parsePasted(form.pasted);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That could not be read.");
      return;
    }
    if (lines.length === 0) {
      toast.error("Nothing to import.");
      return;
    }

    startTransition(async () => {
      const r = await importAction({
        bankAccountId: form.bankAccountId,
        periodFrom: form.periodFrom,
        periodTo: form.periodTo,
        openingBalanceMinor: toMinor(form.opening),
        closingBalanceMinor: toMinor(form.closing),
        lines: lines.map((l) => ({
          valueDate: l.valueDate,
          amountMinor: l.amountMinor,
          narration: l.narration,
          bankReference: l.bankReference,
        })),
      });

      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setForm((p) => ({ ...p, pasted: "" }));
      // ⚠️ A warning, not a success, when the balances do not tie. An
      // import that half-worked reported as "imported 240 lines" is how
      // somebody spends a morning matching an incomplete statement.
      if (r.data.balanceTies && r.data.duplicatesFlagged === 0) {
        toast.success(`${r.data.imported} lines imported and the balances tie.`);
      } else {
        toast.error(r.data.note);
      }
    });
  }

  return (
    <div className="space-y-6">
      {accounts.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No bank account is set up yet. A bank account here is the link between
            a ledger in your chart of accounts and a real account at a real bank,
            which is what makes reconciling the two possible at all.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Import a statement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="acct">Account</Label>
                <select
                  id="acct"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={form.bankAccountId}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, bankAccountId: e.target.value }))
                  }
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {a.bankName}
                      {a.accountLast4 ? ` ····${a.accountLast4}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="from">From</Label>
                  <Input
                    id="from"
                    type="date"
                    value={form.periodFrom}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, periodFrom: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="to">To</Label>
                  <Input
                    id="to"
                    type="date"
                    value={form.periodTo}
                    onChange={(e) => setForm((p) => ({ ...p, periodTo: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="open">Opening balance</Label>
                <Input
                  id="open"
                  inputMode="decimal"
                  placeholder="125000.00"
                  value={form.opening}
                  onChange={(e) => setForm((p) => ({ ...p, opening: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="close">Closing balance</Label>
                <Input
                  id="close"
                  inputMode="decimal"
                  placeholder="131450.00"
                  value={form.closing}
                  onChange={(e) => setForm((p) => ({ ...p, closing: e.target.value }))}
                />
                {/**
                 * ⭐ WHY BOTH BALANCES ARE ASKED FOR. They are not
                 * decoration: they let the import check its own
                 * arithmetic and say so before anybody starts matching.
                 */}
                <p className="mt-1 text-xs text-muted-foreground">
                  Both are checked against the lines. If they do not add up the
                  import is incomplete, and it is far better to know that now than
                  after a morning of matching.
                </p>
              </div>
            </div>

            <div>
              <Label htmlFor="paste">Statement lines</Label>
              <Textarea
                id="paste"
                rows={8}
                className="font-mono text-xs"
                placeholder={
                  "2026-04-02 | -45000.00 | NEFT DR HDFC RAMESH TRADERS | N123456789\n2026-04-03 | 118000.00 | UPI CR ANITA ENTERPRISES | UPI9988"
                }
                value={form.pasted}
                onChange={(e) => setForm((p) => ({ ...p, pasted: e.target.value }))}
              />
              {/**
               * 🔴 THE SIGN RULE IS STATED HERE, IN THESE WORDS, because
               * it is the single easiest thing to get backwards and
               * getting it backwards produces a reconciliation that
               * balances while being entirely wrong.
               */}
              <p className="mt-1 text-xs text-muted-foreground">
                One line each: date, amount, description, and optionally the
                bank&apos;s reference, separated by <code>|</code>. Money coming IN
                is positive. Money going OUT is negative. Check the minus signs
                before importing: a statement imported with the signs the wrong way
                round still reconciles, and every figure in it is wrong.
              </p>
            </div>

            <Button disabled={pending} onClick={runImport}>
              Import
            </Button>
          </CardContent>
        </Card>
      )}

      {statements.map((s) => (
        <Card key={s.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{s.accountLabel}</CardTitle>
              <Badge variant="secondary">
                {s.periodFrom} to {s.periodTo}
              </Badge>
              <Badge variant="secondary">{s.lineCount} lines</Badge>
            </div>
          </CardHeader>
          <CardContent className="text-sm">
            <Link href={`/banking/${s.id}`} className="underline">
              Match this statement
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

interface ParsedLine {
  valueDate: string;
  amountMinor: string;
  narration: string;
  bankReference: string | null;
}

/**
 * ⚠️ STRICT, AND IT REPORTS THE LINE NUMBER.
 *
 * 🔴 A LENIENT PARSER IS THE WRONG KIND OF HELPFUL HERE. Skipping a line
 * it cannot read produces a statement that is quietly short by one
 * transaction, and the reconciliation then fails by that amount with
 * nothing pointing at the cause. Refusing the whole paste and naming the
 * line is unhelpful for ten seconds and correct forever.
 */
function parsePasted(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const rows = text.split("\n").map((r) => r.trim()).filter((r) => r.length > 0);

  rows.forEach((row, i) => {
    const parts = row.split("|").map((p) => p.trim());
    const [date, amount, narration, reference] = parts;

    if (!date || !amount || !narration) {
      throw new Error(
        `Line ${i + 1} does not have a date, an amount and a description separated by | characters.`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Line ${i + 1}: "${date}" is not a date in YYYY-MM-DD form.`);
    }
    if (!/^-?\d+(\.\d{1,2})?$/.test(amount.replace(/,/g, ""))) {
      throw new Error(`Line ${i + 1}: "${amount}" is not an amount.`);
    }

    out.push({
      valueDate: date,
      amountMinor: toMinor(amount),
      narration,
      bankReference: reference && reference.length > 0 ? reference : null,
    });
  });

  return out;
}

/**
 * ⚠️ MINOR UNITS AS A STRING, computed with string operations rather
 * than `Math.round(value * 100)`. 1234.56 × 100 is 123455.99999999999 in
 * IEEE 754, and rounding it is right until the day it is not.
 */
function toMinor(value: string): string {
  const cleaned = value.replace(/,/g, "").trim();
  const negative = cleaned.startsWith("-");
  const bare = negative ? cleaned.slice(1) : cleaned;
  const [whole = "0", fraction = ""] = bare.split(".");
  const paise = (fraction + "00").slice(0, 2);
  const total = BigInt(whole || "0") * 100n + BigInt(paise || "0");
  return (negative ? -total : total).toString();
}
