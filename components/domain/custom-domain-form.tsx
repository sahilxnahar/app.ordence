"use client";

/**
 * Ordence — Settings ▸ Custom domain
 * Version: v1.94.0-alpha (Wave 3B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE STATES, AND THE SCREEN NEVER PRETENDS TO BE IN A FOURTH
 * ══════════════════════════════════════════════════════════════════════
 *   · No domain        , one field.
 *   · Claimed          , the TXT record to publish, and a Check button.
 *   · Verified         , the address, and a way to give it up.
 *
 * ⚠️ "CLAIMED" IS SHOWN AS NOT WORKING YET, IN THOSE WORDS. A screen that
 * showed the saved domain as though it were live would send a customer to
 * change their DNS and then to a hostname that refuses them, with the
 * product's own settings page as the evidence that it should have
 * worked.
 */

import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  setCustomDomain,
  verifyCustomDomain,
  removeCustomDomain,
  type CustomDomainState,
} from "@/server/actions/custom-domain";

type Status =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "ok"; message: string };

export function CustomDomainForm({ initial }: { initial: CustomDomainState }) {
  const [state, setState] = useState<CustomDomainState>(initial);
  const [draft, setDraft] = useState(initial.domain ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (fn: () => Promise<{ ok: boolean; error?: string; data?: CustomDomainState }>, okMessage: string) => {
      setStatus({ kind: "idle" });
      startTransition(async () => {
        const result = await fn();
        if (!result.ok || !result.data) {
          setStatus({ kind: "error", message: result.error ?? "Something went wrong." });
          return;
        }
        setState(result.data);
        setDraft(result.data.domain ?? "");
        setStatus({ kind: "ok", message: okMessage });
      });
    },
    [],
  );

  const verified = Boolean(state.verifiedAt);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border p-4">
        <label htmlFor="custom-domain" className="text-sm font-medium">
          Your own address
        </label>
        <p className="mt-1 text-sm text-muted-foreground">
          A hostname you control, such as <code>erp.example.com</code>. Point it at Ordence with a
          CNAME, then publish the TXT record below so we know it is yours.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            id="custom-domain"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="erp.example.com"
            spellCheck={false}
            autoCapitalize="none"
            className="min-w-64 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <Button
            type="button"
            disabled={pending || draft.trim().length === 0}
            onClick={() => run(() => setCustomDomain({ domain: draft }), "Domain saved. Now publish the record below.")}
          >
            Save domain
          </Button>
        </div>
      </div>

      {state.domain && state.record ? (
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium">
            {verified ? "Verified" : "Not working yet — publish this record"}
          </h3>

          {verified ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <code>{state.domain}</code> was verified on{" "}
              {new Date(state.verifiedAt as string).toLocaleDateString()} and serves this workspace.
              Leave the record in place; removing it does not sign anyone out, but it is what proves
              the name is yours if you ever re-verify.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Until this record is published and checked, <code>{state.domain}</code> will refuse
              every sign-in. That is deliberate: a hostname we have not verified must never serve a
              workspace.
            </p>
          )}

          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="break-all font-mono">{state.record.name}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono">TXT</dd>
            <dt className="text-muted-foreground">Value</dt>
            <dd className="break-all font-mono">{state.record.value}</dd>
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(verifyCustomDomain, "Verified. Your address is live.")}
            >
              {verified ? "Check again" : "Check DNS"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(removeCustomDomain, "Domain removed.")}
            >
              Remove domain
            </Button>
          </div>
        </div>
      ) : null}

      {status.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}
      {status.kind === "ok" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
