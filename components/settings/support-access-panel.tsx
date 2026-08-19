"use client";

/**
 * Ordence — ⭐⭐ SUPPORT ACCESS, FROM THE CUSTOMER'S SIDE
 * Version: v1.40.0-alpha (Mega-wave 2, Batch 41)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS SCREEN IS AN ANSWER TO A SALES QUESTION, NOT JUST A CONTROL
 * ══════════════════════════════════════════════════════════════════════
 * Every enterprise security review asks the same thing: "can your staff
 * see our data, and how would we know?" A product whose honest answer is
 * "yes, whenever we need to" loses the deal. This page's answer is: only
 * when you say so, only for as long as you said, and here is every time
 * it has happened.
 *
 * ⚠️ SO THE HISTORY IS NOT A NICE-TO-HAVE. It is the half that makes the
 * claim checkable. A grant button without a log is a promise; a log is
 * evidence.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ConsentRow = {
  id: string;
  mode: string;
  scope: string;
  grantedByEmail: string | null;
  grantedAt: string;
  expiresAt: string;
  reference: string | null;
  live: boolean;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function SupportAccessPanel({
  consents,
  grantAction,
  revokeAction,
  standingDays,
  incidentMinutes,
  isOwner,
}: {
  consents: ConsentRow[];
  grantAction: (input: unknown) => Promise<Result<unknown>>;
  revokeAction: (input: unknown) => Promise<Result<unknown>>;
  standingDays: number;
  incidentMinutes: number;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"incident" | "standing">("incident");

  const live = consents.filter((c) => c.live);

  function grant(formData: FormData) {
    setError(null);
    const reference = String(formData.get("reference") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();
    const scope = String(formData.get("scope") ?? "read_only");

    start(async () => {
      const result = await grantAction({
        mode,
        scope,
        reference: reference === "" ? undefined : reference,
        note: note === "" ? undefined : note,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function revoke(consentId: string) {
    setError(null);
    start(async () => {
      const result = await revokeAction({ consentId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/*
        ⭐ THE CURRENT STATE FIRST, AND IN PLAIN LANGUAGE. "No live
        consent" is the answer to the question the customer came here
        with, and burying it under a form would make them read the form
        to find out.
      */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">Right now</h2>
        {live.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Ordence support cannot open your workspace. Nobody has been given
            access, so nobody has it.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {live.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {c.mode === "standing" ? "Standing access" : "Incident access"}
                    {c.scope === "read_write" ? " · can make changes" : " · read only"}
                  </div>
                  <div className="text-muted-foreground">
                    Until {new Date(c.expiresAt).toLocaleString()}
                    {c.reference ? ` · ${c.reference}` : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => revoke(c.id)}
                >
                  End it now
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form action={grant} className="space-y-4 rounded-lg border bg-card p-4">
        <div>
          <h2 className="font-medium">Give support access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Access ends by itself. You do not have to remember to turn it off.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode("incident")}
            aria-pressed={mode === "incident"}
            className={`rounded-lg border p-3 text-left text-sm transition-colors ${
              mode === "incident" ? "border-foreground/40 bg-accent/40" : "hover:bg-accent/20"
            }`}
          >
            <div className="font-medium">For one problem</div>
            <p className="mt-1 text-muted-foreground">
              Ends after {incidentMinutes} minutes. An owner or an administrator
              can give this.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode("standing")}
            aria-pressed={mode === "standing"}
            className={`rounded-lg border p-3 text-left text-sm transition-colors ${
              mode === "standing" ? "border-foreground/40 bg-accent/40" : "hover:bg-accent/20"
            }`}
          >
            <div className="font-medium">Ongoing</div>
            <p className="mt-1 text-muted-foreground">
              Ends after {standingDays} days.{" "}
              {/*
                ⚠️ THE ROLE RULE IS SHOWN BEFORE THE ATTEMPT, NOT AFTER.
                The server refuses a non-owner either way; being told
                afterwards reads as a bug.
              */}
              {isOwner
                ? "Only the workspace owner can give this, which is you."
                : "Only the workspace owner can give this."}
            </p>
          </button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reference">
            {mode === "incident" ? "Ticket or incident" : "Reference (optional)"}
          </Label>
          <Input
            id="reference"
            name="reference"
            maxLength={200}
            required={mode === "incident"}
            placeholder={mode === "incident" ? "Ticket 4821, or what went wrong" : ""}
          />
          {mode === "incident" ? (
            <p className="text-xs text-muted-foreground">
              Required, so the access can be tied to the reason for it later.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="scope">What they may do</Label>
          <select
            id="scope"
            name="scope"
            defaultValue="read_only"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="read_only">Look, but not change anything</option>
            <option value="read_write">Look and make changes</option>
          </select>
          {/*
            🔴 READ-ONLY IS THE DEFAULT AND STAYS THE DEFAULT. Most
            support work is diagnosis. Making "can change things" the
            easy option would mean it is what gets chosen, and the
            difference between the two is the difference between someone
            seeing your invoice and someone editing it.
          */}
          <p className="text-xs text-muted-foreground">
            Most problems are solved by looking. Only allow changes if you have
            been asked to.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="note">Note (optional)</Label>
          <Input id="note" name="note" maxLength={500} placeholder="Anything we should know" />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "incident" ? "Allow for this problem" : "Allow ongoing access"}
        </Button>
      </form>

      {/*
        ⭐ THE HISTORY IS THE EVIDENCE HALF. `0014` calls a customer being
        able to read the record of when support was inside their
        workspace the most persuasive answer to the question every
        enterprise security review asks. It only persuades if it is here.
      */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">Every time access has been given</h2>
        {consents.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Never.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Kind</th>
                <th className="pb-2 font-medium">By</th>
                <th className="pb-2 font-medium">Until</th>
                <th className="pb-2 font-medium">Reference</th>
              </tr>
            </thead>
            <tbody>
              {consents.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="py-2">{new Date(c.grantedAt).toLocaleString()}</td>
                  <td className="py-2">
                    {c.mode === "standing" ? "Ongoing" : "One problem"}
                    {c.scope === "read_write" ? " · changes" : " · read only"}
                  </td>
                  <td className="py-2">{c.grantedByEmail ?? "—"}</td>
                  <td className="py-2">{new Date(c.expiresAt).toLocaleString()}</td>
                  <td className="py-2">{c.reference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
