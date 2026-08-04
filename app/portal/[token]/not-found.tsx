/**
 * Ordence — Portal Link Not Available
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE MESSAGE FOR EVERY FAILURE — DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * A token can fail for six different reasons: malformed, unknown,
 * revoked, expired, already signed, or the workspace is inactive.
 *
 * This page says the same thing for all six.
 *
 * Telling an anonymous visitor "that link was revoked yesterday" confirms
 * the token was once real, which distinguishes a lucky guess from a dead
 * link and hands a probing attacker a signal they did not have. The
 * specific reason is written to the server log, where it is useful and
 * where the visitor cannot read it.
 *
 * The cost is a slightly less helpful message for a legitimate client
 * whose link simply expired. That is why the text names the most likely
 * causes and points them at the one action that actually resolves all of
 * them: ask the sender for a new link.
 */

import { FileX2 } from "lucide-react";

export default function PortalNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-[#E5E1DA] bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#FAF8F5]">
          <FileX2 className="h-6 w-6 text-[#6B6B6B]" aria-hidden="true" />
        </div>

        <h1 className="mt-4 font-serif text-xl font-bold text-[#1A1A1A]">
          This link is no longer available
        </h1>

        <p className="mt-3 text-sm leading-relaxed text-[#6B6B6B]">
          The link you followed may have expired, been withdrawn, or already been
          used. Links are time-limited for security.
        </p>

        <p className="mt-4 text-sm text-[#6B6B6B]">
          Please contact the person who sent it to you and ask for a new one.
        </p>

        <div className="mt-6 border-t border-[#E5E1DA] pt-4">
          <p className="font-serif text-sm font-bold text-[#1A1A1A]">Ordence</p>
          <p className="text-[11px] uppercase tracking-widest text-[#6B6B6B]">
            Operating System
          </p>
        </div>
      </div>
    </main>
  );
}
