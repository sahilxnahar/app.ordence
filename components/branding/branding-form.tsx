"use client";

/**
 * Ordence — The branding screen
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A LOGO, A COLOUR TAKEN FROM IT, AND A WAY TO CORRECT THE GUESS
 * ══════════════════════════════════════════════════════════════════════
 * That is the whole screen, and the restraint is the design. There is no
 * font picker, no spacing control and no layout choice, because the
 * person using this is a bookkeeper on their first morning and every one
 * of those controls is a way for them to make their own ledger
 * unreadable — after which it is our support ticket, and the damage is
 * to a workspace full of real invoices.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CONTRAST VERDICT IS SHOWN, NOT APPLIED SILENTLY
 * ══════════════════════════════════════════════════════════════════════
 * A pale yellow logo gives a brand colour that cannot carry text on
 * white. The product handles that by using the chosen colour for borders
 * and a DARKENED variant where text is involved — and it says so on this
 * screen, with the ratio, before the customer saves.
 *
 * The alternative, substituting quietly, produces the support call that
 * begins "your product changed our brand colour" and cannot be answered,
 * because nothing recorded that it did. See `evaluateContrast`.
 */

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { extractPalette, dominantColour, type PaletteCandidate } from "@/lib/branding/extract";
import { evaluateContrast, brandCssVariables } from "@/lib/branding/tokens";
import { parseHex } from "@/lib/branding/color";
import { ORDENCE_DEFAULT_COLOR, type StoredBranding } from "@/lib/branding/schema";
import { logoSrc } from "@/lib/branding/logo";
import { BrandLogo } from "@/components/branding/brand-logo";
import {
  LOGO_ACCEPT,
  MAX_LOGO_BYTES,
  describeLogoRefusal,
  readImagePixels,
  uploadLogo,
} from "@/components/branding/logo-upload";
import { updateBranding, completeBrandingSetup } from "@/server/actions/branding";

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string }
  | { kind: "saved" };

export function BrandingForm({
  tenantId,
  tenantName,
  branding,
  firstRun,
}: {
  tenantId: string;
  tenantName: string;
  branding: StoredBranding;
  firstRun: boolean;
}) {
  const [colour, setColour] = useState<string>(branding.primaryColor ?? ORDENCE_DEFAULT_COLOR);
  const [candidates, setCandidates] = useState<PaletteCandidate[]>([]);
  const [pendingLogoKey, setPendingLogoKey] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const storedSrc = useMemo(() => logoSrc(branding), [branding]);
  const shownSrc = previewUrl ?? storedSrc;

  /*
   * Both themes, every render. The dark verdict is the one that gets
   * forgotten — a brand that reads on white can be invisible on the dark
   * palette, and the workspace offers both.
   */
  const light = useMemo(() => evaluateContrast(colour, "light"), [colour]);
  const dark = useMemo(() => evaluateContrast(colour, "dark"), [colour]);
  const preview = useMemo(() => brandCssVariables(colour, "light"), [colour]);

  const onFile = useCallback(
    async (file: File) => {
      const refusal = describeLogoRefusal(file);
      if (refusal) {
        setStatus({ kind: "error", message: refusal });
        return;
      }

      setStatus({ kind: "working", message: "Reading your logo…" });

      /*
       * ⭐ THE COLOUR IS DERIVED BEFORE THE UPLOAD, from the local file.
       * If R2 is unreachable the person still sees their logo and their
       * palette, and the failure is one retry rather than a blank screen.
       */
      const pixels = await readImagePixels(file);
      if (pixels) {
        const palette = extractPalette(pixels);
        setCandidates(palette);
        const dominant = dominantColour(palette);
        if (dominant) setColour(dominant);
      }

      setPreviewUrl(URL.createObjectURL(file));
      setStatus({ kind: "working", message: "Uploading…" });

      try {
        const key = await uploadLogo({ file, tenantId });
        setPendingLogoKey(key);
        setStatus({ kind: "idle" });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not upload that logo.",
        });
      }
    },
    [tenantId],
  );

  const save = useCallback(() => {
    startTransition(async () => {
      const result = await updateBranding({
        primaryColor: colour,
        ...(pendingLogoKey ? { logoKey: pendingLogoKey } : {}),
      });
      setStatus(result.ok ? { kind: "saved" } : { kind: "error", message: result.error });
    });
  }, [colour, pendingLogoKey]);

  const removeLogo = useCallback(() => {
    startTransition(async () => {
      const result = await updateBranding({ primaryColor: colour, removeLogo: true });
      if (result.ok) {
        setPendingLogoKey(null);
        setPreviewUrl(null);
        setStatus({ kind: "saved" });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    });
  }, [colour]);

  const skip = useCallback(() => {
    startTransition(async () => {
      const result = await completeBrandingSetup();
      setStatus(result.ok ? { kind: "saved" } : { kind: "error", message: result.error });
    });
  }, []);

  const busy = pending || status.kind === "working";

  return (
    <div className="space-y-8">
      {firstRun ? (
        <div className="rounded-md border border-border bg-muted/40 p-4">
          <h2 className="text-base font-semibold">Make this workspace yours</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload your logo and we will take your colour from it. It appears in the
            sidebar, on your sign-in page and on the invoices you send. You can change
            it whenever you like.
          </p>
        </div>
      ) : null}

      {/* ---------------- 1. THE LOGO ---------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Logo</h3>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 min-w-[10rem] items-center justify-center rounded-md border border-border bg-card px-4">
            <BrandLogo src={shownSrc} tenantName={tenantName} height={32} />
          </div>

          <div className="space-y-1">
            <input
              ref={fileInput}
              type="file"
              accept={LOGO_ACCEPT}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
                /* Allows re-picking the same file after a refusal. */
                event.target.value = "";
              }}
            />
            <Button type="button" variant="outline" disabled={busy}
              onClick={() => fileInput.current?.click()}>
              {shownSrc ? "Replace logo" : "Upload a logo"}
            </Button>
            {storedSrc ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={removeLogo}>
                Remove
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">
              PNG, JPEG, WebP or GIF, up to {Math.round(MAX_LOGO_BYTES / (1024 * 1024))} MB.
              SVG is not accepted — it can carry script and this image is shown before
              anyone signs in.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- 2. THE COLOUR ---------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Brand colour</h3>

        {candidates.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Taken from your logo. If we picked the wrong one, choose another.
            </p>
            <div className="flex flex-wrap gap-2">
              {candidates.map((candidate) => (
                <button
                  key={candidate.hex}
                  type="button"
                  onClick={() => setColour(candidate.hex)}
                  aria-pressed={candidate.hex.toLowerCase() === colour.toLowerCase()}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs aria-pressed:border-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-5 w-5 rounded"
                    style={{ backgroundColor: candidate.hex }}
                  />
                  <span className="font-mono">{candidate.hex}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Upload a logo and we will suggest colours from it, or set one below.
          </p>
        )}

        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground" htmlFor="brand-colour">
            Colour
          </label>
          <input
            id="brand-colour"
            type="color"
            value={parseHex(colour) ? colour : ORDENCE_DEFAULT_COLOR}
            onChange={(event) => setColour(event.target.value)}
            className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent"
          />
          <span className="font-mono text-xs">{colour}</span>
        </div>
      </section>

      {/* ---------------- 3. THE VERDICT ---------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Readability</h3>
        {[light, dark].map((verdict) =>
          verdict ? (
            <p key={verdict.scheme} className="text-xs">
              <span className="font-medium capitalize">{verdict.scheme} theme: </span>
              {verdict.passesText ? (
                <span>
                  contrast {verdict.chosenRatio.toFixed(2)}:1 — your colour is used as it is,
                  including for text.
                </span>
              ) : verdict.unreachable ? (
                <span>
                  contrast {verdict.chosenRatio.toFixed(2)}:1, which is too low to read.
                  We use it for borders and the sidebar marker, and text falls back to the
                  darkest version of it we could reach ({verdict.applied},{" "}
                  {verdict.appliedRatio.toFixed(2)}:1). Consider a deeper shade.
                </span>
              ) : (
                <span>
                  contrast {verdict.chosenRatio.toFixed(2)}:1 — too low for text, so your
                  colour keeps the borders and accents and a darkened version of it (
                  {verdict.applied}, {verdict.appliedRatio.toFixed(2)}:1) carries text.
                  Nothing is substituted without telling you.
                </span>
              )}
            </p>
          ) : null,
        )}
        <p className="text-xs text-muted-foreground">
          Status colours do not change. Green still means the figures tie, amber that a
          person must look, red that something blocks the cutover — whatever your brand is.
        </p>
      </section>

      {/* ---------------- 4. WHAT IT LOOKS LIKE ---------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Preview</h3>
        <div
          className="max-w-sm rounded-md border p-4"
          style={{
            borderColor: `hsl(${preview["--brand-border"] ?? "0 0% 90%"})`,
            ...(Object.fromEntries(
              Object.entries(preview).map(([name, value]) => [name, value]),
            ) as React.CSSProperties),
          }}
        >
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <span
              aria-hidden="true"
              className="inline-block h-6 w-1 rounded"
              style={{ backgroundColor: `hsl(${preview["--brand"] ?? "0 0% 50%"})` }}
            />
            <BrandLogo src={shownSrc} tenantName={tenantName} height={20} />
          </div>
          <p className="mt-3 text-sm">Ordinary body text stays the colour it was.</p>
          <p
            className="mt-1 text-sm font-medium"
            style={{ color: `hsl(${preview["--primary"] ?? "0 0% 10%"})` }}
          >
            An accent, in your colour.
          </p>
          <div className="mt-3 flex gap-2 text-xs">
            <span className="rounded bg-green-100 px-2 py-1 text-green-800">Ties</span>
            <span className="rounded bg-amber-100 px-2 py-1 text-amber-800">Needs a look</span>
            <span className="rounded bg-red-100 px-2 py-1 text-red-800">Blocks cutover</span>
          </div>
        </div>
      </section>

      {/* ---------------- 5. SAVE ---------------- */}
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save branding"}
        </Button>
        {firstRun ? (
          <Button type="button" variant="ghost" onClick={skip} disabled={busy}>
            Skip for now
          </Button>
        ) : null}
        {status.kind === "error" ? (
          <span role="alert" className="text-xs text-destructive">
            {status.message}
          </span>
        ) : null}
        {status.kind === "working" ? (
          <span className="text-xs text-muted-foreground">{status.message}</span>
        ) : null}
        {status.kind === "saved" ? (
          <span className="text-xs text-muted-foreground">Saved.</span>
        ) : null}
      </div>
    </div>
  );
}
