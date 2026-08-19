"use client";

/**
 * Ordence — 🔴🔴 RECORDING A PERSONAL DATA BREACH
 * Version: v1.70.0-alpha (wave two, on merge of Brief H)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `recordPersonalDataBreach` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * Brief H built the breach register, the two clocks, the CHECK
 * constraints and `breach-panel.tsx`, which calls
 * `recordBreachIntimation` — the act of SENDING an intimation. Nothing
 * anywhere recorded that a breach had happened, so the panel could only
 * ever list nothing and the two clocks could never start.
 *
 * ⚠️ `check:action-reachability` caught it on merge. Same family as the
 * TDS register that could never receive a row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ EVERY FIELD HERE IS A RULE 7 FIELD, AND THAT IS WHY THERE ARE
 *        SEVEN OF THEM
 * ══════════════════════════════════════════════════════════════════════
 * DPDP Rules 2025, Rule 7 sets out what an intimation to an affected
 * Data Principal must contain: the nature and extent of the breach, its
 * timing and location, the likely consequences, the mitigation
 * implemented, the safeguards the person themselves can take, and a
 * contact who can answer questions. A breach register that captures
 * "something happened on Tuesday" cannot produce that intimation, and
 * the fields would then be gathered under time pressure from memory.
 *
 * 🔴 `noticedAt` IS WHEN IT WAS NOTICED, NEVER WHEN IT OCCURRED, and both
 * statutory clocks run from it. A breach that began in March and was
 * discovered in July is a July breach for the purpose of the deadline.
 * Recording the occurrence date as the start would make the intimation
 * appear four months overdue on the day it was written, and the register
 * would report a compliance failure that never happened.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const BLANK = {
  noticedAt: "",
  occurredAt: "",
  nature: "",
  extent: "",
  timingAndLocation: "",
  likelyConsequences: "",
  mitigationImplemented: "",
  safeguardsForPrincipals: "",
  contactPerson: "",
  affectedPrincipalCount: "",
};

/** ⚠️ The seven Rule 7 narrative fields, with their own minimums. */
const NARRATIVE: {
  key: keyof typeof BLANK;
  label: string;
  help: string;
  min: number;
}[] = [
  {
    key: "nature",
    label: "What happened",
    help: "Rule 7(a). The nature of the breach.",
    min: 10,
  },
  {
    key: "extent",
    label: "How much was affected",
    help: "Rule 7(a). The extent.",
    min: 5,
  },
  {
    key: "timingAndLocation",
    label: "Timing and location",
    help: "Rule 7(b). When, and where in the system.",
    min: 5,
  },
  {
    key: "likelyConsequences",
    label: "What it may mean for the people affected",
    help: "Rule 7(c). Written for them, not for us.",
    min: 10,
  },
  {
    key: "mitigationImplemented",
    label: "What has been done about it",
    help: "Rule 7(d). Implemented, not planned.",
    min: 5,
  },
  {
    key: "safeguardsForPrincipals",
    label: "What the affected people can do to protect themselves",
    help: "Rule 7(e). ⚠️ The field most often left out, and the only one that is any use to the person reading it.",
    min: 5,
  },
  {
    key: "contactPerson",
    label: "Who can answer questions about this",
    help: "Rule 7(f). A named person on the workspace's behalf.",
    min: 5,
  },
];

export function RecordBreachForm({
  recordAction,
}: {
  recordAction: (
    i: unknown,
  ) => Promise<
    Result<{ id: string; reference: string; breachClass: string; overdue: number }>
  >;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });

  const ready =
    form.noticedAt !== "" &&
    NARRATIVE.every((f) => String(form[f.key]).trim().length >= f.min);

  function submit() {
    startTransition(async () => {
      const res = await recordAction({
        noticedAt: form.noticedAt,
        occurredAt: form.occurredAt || null,
        nature: form.nature.trim(),
        extent: form.extent.trim(),
        timingAndLocation: form.timingAndLocation.trim(),
        likelyConsequences: form.likelyConsequences.trim(),
        mitigationImplemented: form.mitigationImplemented.trim(),
        safeguardsForPrincipals: form.safeguardsForPrincipals.trim(),
        contactPerson: form.contactPerson.trim(),
        affectedPrincipalCount: form.affectedPrincipalCount
          ? Number(form.affectedPrincipalCount)
          : null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      /**
       * ⚠️ THE TOAST REPORTS `overdue` RATHER THAN CELEBRATING. Recording
       * a breach is not an accomplishment, and a breach noticed days ago
       * may already be late the moment it is entered.
       */
      toast.success(
        res.data.overdue > 0
          ? `${res.data.reference} recorded, class ${res.data.breachClass}. ⚠️ ${res.data.overdue} intimation(s) are already overdue.`
          : `${res.data.reference} recorded, class ${res.data.breachClass}. The clocks start from when it was noticed.`,
      );
      setForm({ ...BLANK });
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Record a breach
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-destructive/40 p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="pdb-noticed">When it was noticed</Label>
          <Input
            id="pdb-noticed"
            type="datetime-local"
            value={form.noticedAt}
            onChange={(e) => setForm({ ...form, noticedAt: e.target.value })}
          />
          {/**
           * 🔴 BOTH CLOCKS RUN FROM HERE. Stated on the field rather than
           * in a help panel, because it is the one entry on this form
           * that a well-meaning person will fill in wrongly.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 Both statutory clocks run from this, never from when it
            occurred.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pdb-occurred">When it occurred, if known</Label>
          <Input
            id="pdb-occurred"
            type="datetime-local"
            value={form.occurredAt}
            onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Recorded for the investigation. It does not move a deadline.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pdb-count">People affected, if known</Label>
          <Input
            id="pdb-count"
            inputMode="numeric"
            value={form.affectedPrincipalCount}
            onChange={(e) =>
              setForm({ ...form, affectedPrincipalCount: e.target.value })
            }
          />
          <p className="text-xs text-muted-foreground">
            Leave blank rather than guessing. A number nobody counted reads as
            a number somebody counted.
          </p>
        </div>
      </div>

      {NARRATIVE.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`pdb-${f.key}`}>{f.label}</Label>
          <Textarea
            id={`pdb-${f.key}`}
            rows={2}
            value={String(form[f.key])}
            onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{f.help}</p>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          disabled={pending || !ready}
          onClick={submit}
        >
          Record the breach
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setForm({ ...BLANK });
          }}
        >
          Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        ⚠️ Every field above is required because Rule 7 requires it in the
        intimation. Gathering them now is the difference between sending that
        intimation and reconstructing it under a deadline.
      </p>
    </div>
  );
}
