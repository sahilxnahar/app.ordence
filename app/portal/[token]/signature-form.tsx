"use client";

/**
 * Ordence — External Signature Form
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS COMPONENT IS AND IS NOT RESPONSIBLE FOR
 * ══════════════════════════════════════════════════════════════════════
 * It collects a name, a capacity and an explicit acceptance, then calls
 * `signContractViaPortal`. It enforces NOTHING.
 *
 * Every rule that matters — the token is valid, unexpired, unrevoked,
 * unconsumed, permits signing, and the contract is in a signable state —
 * is re-checked on the server, from scratch, on every call. The disabled
 * button below stops an honest mistake; it stops nothing else, and a
 * server action is a public endpoint whatever this component does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE CONSENT CHECKBOX IS NOT PRE-TICKED
 * ══════════════════════════════════════════════════════════════════════
 * A pre-ticked box is not consent; it is a default the person never chose.
 * In a dispute about whether someone agreed to be bound, "the box was
 * already ticked when they arrived" is the worst possible fact. The server
 * validates `consent: z.literal(true)`, so an absent value is refused
 * rather than coerced.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, PenLine, ShieldCheck, TriangleAlert } from "lucide-react";
import { signContractViaPortal } from "@/server/actions/signatures";
import { CONSENT_STATEMENT } from "@/lib/validators/portal";

export function SignatureForm({
  token,
  contractTitle,
  recipientName,
  recipientEmail,
}: {
  token: string;
  contractTitle: string;
  recipientName: string | null;
  recipientEmail: string | null;
}) {
  const router = useRouter();

  const [signerName, setSignerName] = React.useState(recipientName ?? "");
  const [signerTitle, setSignerTitle] = React.useState("");
  const [consent, setConsent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const [signed, setSigned] = React.useState<{ at: string; name: string } | null>(null);

  const trimmedName = signerName.trim();
  const nameLooksValid = trimmedName.length >= 2 && !/[<>{}\\]/.test(trimmedName);
  const canSubmit = nameLooksValid && consent && !isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setError(null);

    startTransition(async () => {
      try {
        const result = await signContractViaPortal({
          token,
          signerName: trimmedName,
          signerTitle: signerTitle.trim() || undefined,
          consent: true,
        });

        if (result.ok) {
          setSigned({ at: result.data.signedAt, name: result.data.signerName });
          router.refresh();
          return;
        }

        setError(result.error);
      } catch (err) {
        console.error("[portal sign]", err);
        setError("We could not reach the server. Please check your connection and try again.");
      }
    });
  }

  /* ---- Signed confirmation ---------------------------------------- */

  if (signed) {
    return (
      <div
        className="rounded-lg border border-emerald-600/30 bg-emerald-50 p-6 text-center"
        role="status"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <ShieldCheck className="h-6 w-6 text-emerald-700" aria-hidden="true" />
        </div>

        <h3 className="mt-3 font-serif text-lg font-bold text-emerald-900">
          Thank you — this document is signed
        </h3>

        <p className="mt-2 text-sm text-emerald-800">
          Signed by <strong>{signed.name}</strong> on{" "}
          {new Date(signed.at).toLocaleString("en-IN", {
            dateStyle: "long",
            timeStyle: "short",
          })}
          .
        </p>

        <p className="mt-3 text-xs text-emerald-800/80">
          A record of this signature has been kept, including the time and the
          document you approved. This link is now closed and cannot be used again.
        </p>
      </div>
    );
  }

  /* ---- The form ---------------------------------------------------- */

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div>
        <h3 className="font-serif text-lg font-bold text-[#1A1A1A]">
          Approve and sign
        </h3>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          Please confirm your name to sign <strong>{contractTitle}</strong>.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="signer-name" className="block text-sm font-medium text-[#1A1A1A]">
          Your full name <span aria-hidden="true">*</span>
        </label>
        <input
          id="signer-name"
          type="text"
          required
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          disabled={isPending}
          maxLength={300}
          autoComplete="name"
          aria-describedby="signer-name-help"
          className="w-full rounded-md border border-[#E5E1DA] bg-white px-3 py-2 text-sm text-[#1A1A1A] focus:border-[#B8935A] focus:outline-none focus:ring-2 focus:ring-[#B8935A]/30 disabled:opacity-60"
        />
        <p id="signer-name-help" className="text-xs text-[#6B6B6B]">
          Type your name as it should appear on the record.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="signer-title" className="block text-sm font-medium text-[#1A1A1A]">
          Your position <span className="font-normal text-[#6B6B6B]">(optional)</span>
        </label>
        <input
          id="signer-title"
          type="text"
          value={signerTitle}
          onChange={(e) => setSignerTitle(e.target.value)}
          disabled={isPending}
          maxLength={200}
          placeholder="e.g. Managing Director"
          className="w-full rounded-md border border-[#E5E1DA] bg-white px-3 py-2 text-sm text-[#1A1A1A] focus:border-[#B8935A] focus:outline-none focus:ring-2 focus:ring-[#B8935A]/30 disabled:opacity-60"
        />
      </div>

      {recipientEmail && (
        <p className="text-xs text-[#6B6B6B]">
          This signature will be recorded against{" "}
          <strong className="text-[#1A1A1A]">{recipientEmail}</strong> — the address
          this link was sent to.
        </p>
      )}

      {/* The consent statement, shown in full. Never collapsed behind a
          "terms apply" link: the whole point is that the signer read it. */}
      <div className="rounded-md border border-[#E5E1DA] bg-[#FAF8F5] p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            disabled={isPending}
            required
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[#B8935A]"
          />
          <span className="text-sm leading-relaxed text-[#1A1A1A]">
            {CONSENT_STATEMENT}
          </span>
        </label>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-[#B8935A] px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-[#a8834a] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Recording your signature…
          </>
        ) : (
          <>
            <PenLine className="h-4 w-4" aria-hidden="true" />
            Approve &amp; Sign
          </>
        )}
      </button>

      {!canSubmit && !isPending && (
        <p className="text-center text-xs text-[#6B6B6B]" role="status">
          {!nameLooksValid
            ? "Enter your full name to continue."
            : "Please accept the statement above to continue."}
        </p>
      )}

      <p className="text-center text-xs text-[#6B6B6B]">
        This can be done once. After signing, this link will close.
      </p>
    </form>
  );
}
