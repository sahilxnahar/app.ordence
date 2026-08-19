"use client";

/**
 * Ordence — ⭐⭐ BRING YOUR OWN AI KEY
 * Version: v1.65.0-alpha  ·  Batch 0105
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE AUDIENCE IS THE CUSTOMER, NOT US
 * ══════════════════════════════════════════════════════════════════════
 * `components/integrations/connection-manager.tsx` set the test and it
 * is the right one: could somebody who has never spoken to us finish
 * without asking anyone? So "lane", "budget scope" and "circuit breaker"
 * are our words and they do not appear. What appears instead is:
 *
 *   · which key is answering right now — theirs or ours
 *   · whether that provider may be shown their own business data
 *   · where to get a key, as a link
 *   · what went wrong last time, in the provider's own words
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NO FIELD ON THIS SCREEN EVER SHOWS A KEY, NOT EVEN FOUR CHARACTERS
 * ══════════════════════════════════════════════════════════════════════
 * The server action cannot return one. `db/schema/vault.ts` already
 * decided that `api_credential` gets NO visible suffix, and the reason
 * holds here: the first characters of an API key are a provider
 * fingerprint and the length narrows a search. The customer knows which
 * key they pasted; we do not need to prove it back to them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE LANE IS EXPLAINED, NOT ENFORCED IN SILENCE
 * ══════════════════════════════════════════════════════════════════════
 * A customer who adds their own Groq key will reasonably expect it to be
 * used for everything, because it is their key and their data. It will
 * not be, and finding that out from an empty result is a bad way to find
 * it out. So the row says so, in the row, at the moment they are looking
 * at it.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ProviderRowView {
  providerId: string;
  label: string;
  lane: "open" | "confidential";
  mayTrainOnInputs: boolean;
  keyUrl: string;
  jurisdiction: string | null;
  tenantSupplied: boolean;
  platformSupplied: boolean;
  effectiveSource: "tenant" | "platform" | null;
  blockedNote: string | null;
  status: string | null;
  lastSuccessAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  lastFailureAt: string | null;
  lastFailureKind: string | null;
  lastFailureMessage: string | null;
  accountId: string | null;
  requiresAccountId: boolean;
}

/**
 * ⭐ THE SENTENCE THAT ANSWERS "WHY IS MY KEY NOT BEING USED FOR
 * EVERYTHING", WRITTEN ONCE.
 *
 * ⚠️ Deliberately not a tooltip. The customer reads this on the screen
 * where they are about to type a key, which is the only moment it
 * changes a decision.
 */
function laneSentence(row: ProviderRowView): string {
  if (row.lane === "confidential") {
    return (
      "May be shown your own business data — your contacts, invoices, " +
      "payroll and site records. This is the only kind of provider the " +
      "background monitors and the assistant can use on your data."
    );
  }
  return (
    "Used for general drafting only. It is never shown your contacts, " +
    "invoices, payroll or site records" +
    (row.mayTrainOnInputs
      ? ", because its free terms permit training on what is sent to it. " +
        "That does not change when the key is yours: the key decides who " +
        "pays, not what the provider may do with the text."
      : ".")
  );
}

function whoAnswers(row: ProviderRowView): {
  text: string;
  tone: "your" | "ours" | "none";
} {
  if (row.effectiveSource === "tenant") {
    return { text: "Your key. Your quota, your bill.", tone: "your" };
  }
  if (row.effectiveSource === "platform") {
    return { text: "Ordence's key, shared with other workspaces.", tone: "ours" };
  }
  return { text: "Not available — no key at all.", tone: "none" };
}

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

/**
 * ⚠️ The failure sentence, chosen by KIND rather than by a status code.
 * `auth` and `rate_limited` must not read the same: one clears on its
 * own in sixty seconds and the other never clears until a person
 * re-enters a key. Telling a customer to wait for the second is telling
 * them to wait for something that will not happen.
 */
function failureSentence(row: ProviderRowView): string {
  switch (row.lastFailureKind) {
    case "auth":
      return `${row.label} rejected your key. It is wrong, revoked, or lacks the required scope. Nobody at Ordence can see or repair it.`;
    case "quota":
      return `${row.label} says your key is out of quota or credit. Top it up with ${row.label}, or remove the key here to fall back to Ordence's.`;
    case "rate_limited":
      return `${row.label} rate-limited your key. This clears on its own and needs nothing from you.`;
    case "misconfigured":
      return `Your ${row.label} credential is incomplete, so no request was sent. See the note below.`;
    case "unreachable":
      return `${row.label} could not be reached at all. Nothing was sent.`;
    default:
      return `${row.label} returned an error on your key.`;
  }
}

export function ProviderKeyManager({
  rows,
  vaultReady,
  vaultMessage,
  schemaReady,
  confidentialProvidersAvailable,
  saveAction,
  removeAction,
  setEnabledAction,
}: {
  rows: readonly ProviderRowView[];
  vaultReady: boolean;
  /**
   * ⚠️ THE VAULT'S OWN SENTENCE, NAMING WHICH VARIABLE IS MISSING.
   * `vaultReadiness()` already writes it and already knows to name the
   * variables and never the values. Paraphrasing it here would be a
   * second copy that drifts, and the copy on screen would be the one
   * that stopped being true.
   */
  vaultMessage: string | null;
  schemaReady: boolean;
  confidentialProvidersAvailable: number;
  saveAction: (
    i: unknown,
  ) => Promise<Result<{ rotated: boolean; unchanged: boolean }>>;
  removeAction: (i: unknown) => Promise<Result<{ secretsErased: number }>>;
  setEnabledAction: (i: unknown) => Promise<Result<{ status: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  /** ⚠️ Keyed by provider id. Two fields are never one piece of state. */
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<Record<string, string>>({});

  function save(row: ProviderRowView) {
    const apiKey = (keys[row.providerId] ?? "").trim();
    if (apiKey.length < 8) {
      toast.error("Paste the whole key. That looks too short to be one.");
      return;
    }
    const accountId = (accounts[row.providerId] ?? row.accountId ?? "").trim();
    /**
     * 🔴 REFUSED IN THE BROWSER TOO, so the customer is told before the
     * key leaves the form rather than after. The action refuses it as
     * well, and so does the database — this one only saves a round trip
     * and is never the control.
     */
    if (row.requiresAccountId && accountId.length === 0) {
      toast.error(
        `${row.label} needs its account id as well as the token. With only ` +
          `the token every call fails and nothing says why.`,
      );
      return;
    }

    startTransition(async () => {
      const result = await saveAction({
        providerId: row.providerId,
        apiKey,
        accountId: accountId.length > 0 ? accountId : null,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // 🔴 CLEARED FROM COMPONENT STATE THE MOMENT IT IS STORED. A key
      // left in a React state tree is a key in the next render's props.
      setKeys((prev) => ({ ...prev, [row.providerId]: "" }));
      setOpen(null);
      toast.success(
        result.data.unchanged
          ? `That is the key already stored for ${row.label}. Nothing changed.`
          : result.data.rotated
            ? `${row.label} key replaced. The old one has been erased.`
            : `${row.label} will now use your key.`,
      );
    });
  }

  function remove(row: ProviderRowView) {
    startTransition(async () => {
      const result = await removeAction({
        providerId: row.providerId,
        reason: "Removed by the workspace from the AI settings screen.",
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        row.platformSupplied
          ? `Your ${row.label} key was erased. Ordence's key takes over.`
          : `Your ${row.label} key was erased. ${row.label} is now unavailable.`,
      );
    });
  }

  function toggle(row: ProviderRowView, enabled: boolean) {
    startTransition(async () => {
      const result = await setEnabledAction({
        providerId: row.providerId,
        enabled,
      });
      if (!result.ok) toast.error(result.error);
      else
        toast.success(
          enabled
            ? `Your ${row.label} key is in use again.`
            : `Your ${row.label} key is switched off but still stored.`,
        );
    });
  }

  return (
    <div className="space-y-4">
      {/**
       * 🔴 THE MIGRATION NOTICE COMES FIRST, because without the table
       * nothing on this screen can be saved and an empty list would read
       * as "you have not added any keys yet".
       */}
      {!schemaReady && (
        <div className="rounded-md border border-destructive p-4 text-sm">
          <p className="font-medium text-destructive">
            Your own keys cannot be stored yet
          </p>
          <p className="mt-1 text-muted-foreground">
            Migration 0105 has not been applied to this database. The assistant
            is working normally on Ordence&apos;s own keys; only the ability to
            add your own is waiting.
          </p>
        </div>
      )}

      {/**
       * 🔴 THE VAULT WARNING. Without the encryption key nothing can be
       * saved, and the worst version of that is a person typing an API
       * key into a form that then refuses it.
       */}
      {!vaultReady && (
        <div className="rounded-md border border-destructive p-4 text-sm">
          <p className="font-medium text-destructive">
            Credentials cannot be stored yet
          </p>
          {vaultMessage && (
            <p className="mt-1 text-muted-foreground">{vaultMessage}</p>
          )}
          <p className="mt-1 text-muted-foreground">
            Nothing is saved in the clear as a fallback. The encryption key
            lives outside the database on purpose, so that a database backup on
            its own decrypts nothing.
          </p>
        </div>
      )}

      {/**
       * ⭐⭐ THE STATE THIS BATCH WAS ASKED TO MAKE LEGIBLE RATHER THAN
       * SILENT.
       *
       * 🔴 With no confidential-lane provider, all six background
       * monitors and every assistant question about this workspace's own
       * data refuse — correctly, and until now completely invisibly. The
       * live deployment is in exactly this state today: it holds an
       * OpenRouter key, which is open-lane, and nothing else.
       */}
      {confidentialProvidersAvailable === 0 && (
        <div className="rounded-md border border-amber-500/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            Nothing here may be shown your own data
          </p>
          <p className="mt-1 text-muted-foreground">
            The six background monitors, and any assistant question about your
            contacts, invoices, payroll or site records, will refuse rather than
            send those records to a provider whose terms permit training on
            them. They are not broken and they are not switched off; they have
            nowhere safe to ask.
          </p>
          <p className="mt-2 text-muted-foreground">
            Adding a Cloudflare Workers AI token below fixes it, and that key
            can be yours.
          </p>
        </div>
      )}

      {rows.map((row) => {
        const answers = whoAnswers(row);
        const disabled = row.status === "disabled";
        const failing = row.status === "failing";

        return (
          <div key={row.providerId} className="rounded-md border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{row.label}</span>

              <Badge variant={row.lane === "confidential" ? "default" : "secondary"}>
                {row.lane === "confidential"
                  ? "May see your data"
                  : "General drafting only"}
              </Badge>

              {row.tenantSupplied && (
                <Badge variant={disabled ? "secondary" : "outline"}>
                  {disabled ? "Your key, switched off" : "Your key"}
                </Badge>
              )}
              {failing && <Badge variant="destructive">Failing</Badge>}
              {row.jurisdiction && (
                <span className="text-xs text-muted-foreground">
                  {row.jurisdiction}
                </span>
              )}
            </div>

            <p
              className={
                answers.tone === "none"
                  ? "mt-2 text-xs text-muted-foreground"
                  : "mt-2 text-xs font-medium"
              }
            >
              {answers.text}
            </p>

            <p className="mt-1 text-xs text-muted-foreground">{laneSentence(row)}</p>

            {/**
             * ⭐ THE HONEST FAILURE, IN THE PROVIDER'S OWN WORDS.
             *
             * 🔴 "It is YOUR key" is the whole point. A customer shown a
             * generic "AI unavailable" for a key we cannot see, cannot
             * test and must not read raises a support ticket about our
             * product for a problem only they can fix.
             */}
            {row.tenantSupplied && row.lastFailureKind && (
              <div className="mt-2 rounded border border-destructive/40 p-2 text-xs">
                <p className="font-medium text-destructive">{failureSentence(row)}</p>
                <p className="mt-1 text-muted-foreground">
                  Last failure {when(row.lastFailureAt)}.
                  {row.lastSuccessAt
                    ? ` Last worked ${when(row.lastSuccessAt)}.`
                    : " It has never worked."}
                </p>
                {row.lastFailureMessage && (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {row.lastFailureMessage.slice(0, 300)}
                  </p>
                )}
              </div>
            )}

            {row.blockedNote && (
              <p className="mt-2 rounded border border-amber-500/50 p-2 text-xs text-amber-800 dark:text-amber-300">
                {row.blockedNote}
              </p>
            )}

            {/**
              * ⭐ THE ACCOUNTING RECORD, ON THE SCREEN.
              *
              * ⚠️ `last_used_at` is what stands in for an access-log row
              * per AI call — the same trade `server/vault/secrets.ts`
              * makes for `readForRunner` and `sync_runs`. A standing
              * record nobody can see is not a record, so it is rendered
              * here whether or not the key is currently healthy.
              */}
            {row.tenantSupplied && (
              <p className="mt-1 text-xs text-muted-foreground">
                Your key has been read {row.useCount} time
                {row.useCount === 1 ? "" : "s"}. Last read{" "}
                {when(row.lastUsedAt)}; last worked {when(row.lastSuccessAt)}.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !vaultReady || !schemaReady}
                onClick={() => setOpen(open === row.providerId ? null : row.providerId)}
              >
                {row.tenantSupplied ? "Replace your key" : "Use my own key"}
              </Button>

              <a
                href={row.keyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs underline underline-offset-2"
              >
                Where to get a {row.label} key
              </a>

              {row.tenantSupplied && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => toggle(row, disabled)}
                  >
                    {disabled ? "Switch back on" : "Switch off, keep stored"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => remove(row)}
                  >
                    Remove and erase
                  </Button>
                </>
              )}
            </div>

            {open === row.providerId && (
              <div className="mt-3 space-y-2 rounded border border-border p-3">
                <Label htmlFor={`key-${row.providerId}`} className="text-xs">
                  {row.label} API key
                </Label>
                <Input
                  id={`key-${row.providerId}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the key"
                  value={keys[row.providerId] ?? ""}
                  onChange={(e) =>
                    setKeys((prev) => ({ ...prev, [row.providerId]: e.target.value }))
                  }
                />

                {/**
                 * 🔴 THE SECOND FIELD IS NOT OPTIONAL AND SAYS SO. With a
                 * token and no account id the request URL is built with an
                 * empty account segment, every call fails, the router walks
                 * on, and nothing anywhere reports why.
                 */}
                {row.requiresAccountId && (
                  <>
                    <Label htmlFor={`acct-${row.providerId}`} className="text-xs">
                      Cloudflare account id — required, and not a secret
                    </Label>
                    <Input
                      id={`acct-${row.providerId}`}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="From your Cloudflare dashboard URL"
                      value={accounts[row.providerId] ?? row.accountId ?? ""}
                      onChange={(e) =>
                        setAccounts((prev) => ({
                          ...prev,
                          [row.providerId]: e.target.value,
                        }))
                      }
                    />
                  </>
                )}

                <p className="text-xs text-muted-foreground">
                  Stored encrypted. It is never shown again on any screen, not
                  even partly, and no Ordence screen can read it back.
                </p>

                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() => save(row)}
                >
                  Store this key
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
