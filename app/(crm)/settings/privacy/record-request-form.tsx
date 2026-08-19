"use client";

/**
 * Ordence — 🔴🔴🔴 RECORDING A DATA PRINCIPAL REQUEST
 * Version: v1.70.0-alpha (wave two, on merge of Brief H)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT PART OF BRIEF H, AND HOW IT WAS FOUND
 * ══════════════════════════════════════════════════════════════════════
 * Brief H built the DPDPA engine, the classification inventory, the
 * export, the erasure planner, the breach register, the retention rules,
 * a gate of its own, and a screen. It wired the FULFILMENT half:
 * `request-list.tsx` calls `runDataPrincipalExport` and
 * `runDataPrincipalErasure`, and `breach-panel.tsx` calls
 * `recordBreachIntimation`.
 *
 * ⚠️ IT DID NOT WIRE THE INTAKE HALF. `recordDataPrincipalRequest`,
 * `recordPersonalDataBreach` and `previewDataPrincipalPlan` had no caller
 * anywhere. The list could be acted on and nothing could get onto the
 * list.
 *
 * ⭐ `check:action-reachability` — built last wave for exactly this —
 * refused the merge and named all three. That is the fourteenth instance
 * of this defect in this codebase, and it occurred INSIDE the batch that
 * shipped a gate against the same family of fault. The pattern is not
 * carelessness; it is that "the screen exists" and "every capability
 * behind it is reachable" are different claims, and only one of them was
 * ever checked.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ PREVIEW BEFORE RECORD, AND THE PREVIEW IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * `previewDataPrincipalPlan` reports what an export or erasure would
 * actually reach: how many tables are searched, how many hold this
 * person's data and cannot be reached at all, and which statutory
 * retention provisions REFUSE the erasure. A workspace that answers an
 * erasure request without seeing that s.128(5) of the Companies Act
 * refuses eight years of ledger has promised something it must not do.
 *
 * 🔴 THE PREVIEW NEEDS A SAVED REQUEST, so the order here is record then
 * preview, not preview then record. That is the opposite of the TDS
 * screen and it is right for a different reason: a TDS assessment is
 * arithmetic over figures the form already holds, while this is a graph
 * walk over anchors that only exist once they are stored.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TEN CHARACTERS OF "HOW DID YOU VERIFY THEM" IS NOT A FORM RULE
 * ══════════════════════════════════════════════════════════════════════
 * A CHECK constraint in `0113` enforces the same minimum, and the reason
 * is in the action: answering an access request for somebody who is NOT
 * the Data Principal is itself a personal data breach, and it arrives
 * disguised as good service. A tick box records that somebody clicked.
 * This records what they did.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Plan = {
  searched: number;
  unreachable: number;
  notApplicable: number;
  outOfScope: number;
  refusals: {
    provision: string;
    period: string;
    tables: string[];
    needsAHuman: boolean;
  }[];
  blocked: boolean;
  unreachableTables: string[];
};

const KINDS = [
  { value: "access", label: "Access — a copy of what you hold about them", ref: "s.11" },
  { value: "correction", label: "Correction — something you hold is wrong", ref: "s.12" },
  { value: "erasure", label: "Erasure — stop holding it", ref: "s.12(3)" },
  { value: "grievance", label: "Grievance — a complaint about how it was handled", ref: "s.13" },
  { value: "consent_withdrawal", label: "Consent withdrawal", ref: "s.6(4)" },
] as const;

const BLANK = {
  kind: "access",
  principalLabel: "",
  principalEmail: "",
  principalPhone: "",
  verifiedHow: "",
};

const BLANK_ANCHOR = { kind: "contact", id: "", establishedBy: "" };

export function RecordRequestForm({
  principalKinds,
  recordAction,
  previewAction,
}: {
  principalKinds: readonly string[];
  recordAction: (i: unknown) => Promise<Result<{ id: string; reference: string }>>;
  previewAction: (id: unknown) => Promise<Result<Plan>>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [anchors, setAnchors] = useState([{ ...BLANK_ANCHOR }]);
  const [plan, setPlan] = useState<{ reference: string; plan: Plan } | null>(null);

  const filledAnchors = anchors.filter(
    (a) => a.id.trim() !== "" && a.establishedBy.trim().length >= 10,
  );

  /**
   * ⚠️ THE SAME MINIMUMS THE SERVER AND THE DATABASE HOLD, restated here
   * so the button explains itself before it is pressed rather than after.
   * They are NOT the authority: `0113`'s CHECK is, and the action's zod
   * schema is between them.
   */
  const ready =
    form.principalLabel.trim() !== "" &&
    form.verifiedHow.trim().length >= 10 &&
    (filledAnchors.length > 0 || form.principalEmail.trim() !== "");

  function submit() {
    startTransition(async () => {
      const res = await recordAction({
        kind: form.kind,
        principalLabel: form.principalLabel.trim(),
        principalEmail: form.principalEmail.trim() || null,
        principalPhone: form.principalPhone.trim() || null,
        verifiedHow: form.verifiedHow.trim(),
        anchors: filledAnchors.map((a) => ({
          kind: a.kind,
          id: a.id.trim(),
          establishedBy: a.establishedBy.trim(),
        })),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Recorded as ${res.data.reference}.`);

      /**
       * ⭐ THE PREVIEW RUNS IMMEDIATELY AND IS NOT OPTIONAL. Whoever
       * records the request is the person who will answer it, and the
       * refusals below are what they must not promise around.
       */
      const p = await previewAction(res.data.id);
      if (p.ok) setPlan({ reference: res.data.reference, plan: p.data });
      else toast.error(p.error);

      setForm({ ...BLANK });
      setAnchors([{ ...BLANK_ANCHOR }]);
      setOpen(false);
    });
  }

  return (
    <div className="space-y-4">
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Record a request
        </Button>
      ) : (
        <div className="space-y-4 rounded-md border border-border p-4 text-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="dpr-kind">What are they asking for</Label>
              <select
                id="dpr-kind"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value })}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label} · {k.ref}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dpr-label">Who they are</Label>
              <Input
                id="dpr-label"
                value={form.principalLabel}
                placeholder="As they identified themselves"
                onChange={(e) =>
                  setForm({ ...form, principalLabel: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dpr-email">Email they wrote from</Label>
              <Input
                id="dpr-email"
                type="email"
                value={form.principalEmail}
                onChange={(e) =>
                  setForm({ ...form, principalEmail: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dpr-phone">Phone</Label>
              <Input
                id="dpr-phone"
                value={form.principalPhone}
                onChange={(e) =>
                  setForm({ ...form, principalPhone: e.target.value })
                }
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="dpr-verified">
              How you established this is who they say they are
            </Label>
            <Textarea
              id="dpr-verified"
              rows={2}
              value={form.verifiedHow}
              placeholder="Called the number on file and they confirmed the last four digits of the invoice reference"
              onChange={(e) =>
                setForm({ ...form, verifiedHow: e.target.value })
              }
            />
            {/**
             * 🔴 THE SENTENCE SAYS WHY, not "minimum 10 characters".
             * A validation message that states a length teaches people to
             * type ten characters.
             */}
            <p className="text-xs text-muted-foreground">
              Answering an access request for somebody who is not the Data
              Principal is itself a personal data breach, and it arrives looking
              like good service. A tick records that somebody clicked; this
              records what they did. `0113` has a CHECK constraint behind it.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Which records you have established belong to them</Label>
            {anchors.map((a, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[9rem_18rem_1fr]">
                <select
                  aria-label="Record type"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={a.kind}
                  onChange={(e) => {
                    const next = [...anchors];
                    next[i] = { ...a, kind: e.target.value };
                    setAnchors(next);
                  }}
                >
                  {principalKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Record id"
                  placeholder="record id"
                  value={a.id}
                  onChange={(e) => {
                    const next = [...anchors];
                    next[i] = { ...a, id: e.target.value };
                    setAnchors(next);
                  }}
                />
                <Input
                  aria-label="Why this record is this person"
                  placeholder="why this record is this person"
                  value={a.establishedBy}
                  onChange={(e) => {
                    const next = [...anchors];
                    next[i] = { ...a, establishedBy: e.target.value };
                    setAnchors(next);
                  }}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setAnchors([...anchors, { ...BLANK_ANCHOR }])}
            >
              Add another record
            </Button>
            {/**
             * ⚠️ "A SHARED EMAIL ADDRESS IS NOT A REASON" is the action's
             * own wording and it is repeated because it is the common
             * mistake: accounts@ on three vendor rows is one mailbox, not
             * one person.
             */}
            <p className="text-xs text-muted-foreground">
              A shared email address is not a reason. `accounts@` on three rows
              is one mailbox, not one person, and treating it as one would
              disclose two other people&apos;s data.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || !ready} onClick={submit}>
              Record it and show what it reaches
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setForm({ ...BLANK });
                setAnchors([{ ...BLANK_ANCHOR }]);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/**
       * ⭐⭐⭐ WHAT THE ANSWER WOULD ACTUALLY REACH, SHOWN AT INTAKE.
       *
       * 🔴 `refusals` IS THE IMPORTANT LIST AND IT IS NOT A WARNING. An
       * erasure request against a workspace's books meets s.128(5)
       * Companies Act, which requires eight financial years of records
       * and their vouchers to be kept. Promising deletion and then not
       * deleting is worse than refusing at intake with the provision
       * named.
       */}
      {plan && (
        <div className="space-y-3 rounded-md border border-border p-4 text-sm">
          <p className="font-medium">
            {plan.reference} — what an answer would reach
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Searched</p>
              <p className="text-lg font-semibold tabular-nums">
                {plan.plan.searched}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">
                Holds their data, unreachable
              </p>
              <p className="text-lg font-semibold tabular-nums text-destructive">
                {plan.plan.unreachable}
              </p>
              <p className="text-xs text-muted-foreground">
                🔴 An export that quietly omits these is an incomplete answer
                presented as a complete one.
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">
                Not about a person
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {plan.plan.notApplicable}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">
                Ordence&apos;s own, out of scope
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {plan.plan.outOfScope}
              </p>
              <p className="text-xs text-muted-foreground">
                Reaching these would disclose one Fiduciary&apos;s records in
                answer to a request made to another.
              </p>
            </div>
          </div>

          {plan.plan.refusals.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-destructive">
                Statutory retention refuses erasure of:
              </p>
              <ul className="space-y-1">
                {plan.plan.refusals.map((r) => (
                  <li key={r.provision} className="text-muted-foreground">
                    <span className="font-medium">{r.provision}</span> ·{" "}
                    {r.period} · {r.tables.length} table
                    {r.tables.length === 1 ? "" : "s"}
                    {r.needsAHuman && (
                      <span className="text-destructive">
                        {" "}
                        · needs a human decision
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                ⚠️ Tell the Data Principal this at the outset. s.12(3) DPDPA is
                subject to other law, and the other law wins.
              </p>
            </div>
          )}

          {plan.plan.unreachableTables.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Unreachable: {plan.plan.unreachableTables.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
