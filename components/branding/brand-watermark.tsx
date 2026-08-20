/**
 * Ordence — The homepage watermark
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A LEDGER IS FOR READING NUMBERS OFF
 * ══════════════════════════════════════════════════════════════════════
 * A watermark behind the dashboard is a nice touch and a real risk: put
 * it under the metric cards and it reduces the contrast of the figures,
 * which is the exact opposite of what the screen is for. Two constraints
 * make it safe, and both are structural rather than a matter of taste:
 *
 *   1. IT IS CONSTRAINED TO EMPTY SPACE. Anchored bottom-right, sized
 *      relative to the viewport and clipped by the scroll container. The
 *      metric cards are laid out from the top-left; the corner it sits
 *      in is the region that is empty on every dashboard variant.
 *
 *   2. IT IS AT OR BELOW 4% OPACITY. `MAX_WATERMARK_OPACITY` is the
 *      ceiling and the component clamps to it rather than trusting a
 *      prop, so a later "make it a bit more visible" change has to move
 *      a named constant with this comment attached to it.
 *
 * ⚠️ `aria-hidden` AND `pointer-events-none`. A screen reader announcing
 * the company logo on every dashboard read is noise, and an invisible
 * layer that swallows clicks is the worst kind of bug to diagnose.
 *
 * ⚠️ AND IT IS DROPPED FROM PRINT. `app/globals.css` hides
 * `[aria-hidden="true"]` in its print sheet, so a printed dashboard has
 * no wash over it. That is the right outcome and it is free.
 */

/** The ceiling named in the wave brief. Do not raise it. */
export const MAX_WATERMARK_OPACITY = 0.04;

export function BrandWatermark({
  src,
  opacity = MAX_WATERMARK_OPACITY,
}: {
  src: string | null;
  opacity?: number;
}) {
  if (!src) return null;

  const safeOpacity = Math.max(0, Math.min(MAX_WATERMARK_OPACITY, opacity));

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 right-0 z-0 hidden select-none overflow-hidden lg:block"
      style={{ width: "min(38vw, 460px)", height: "min(38vw, 460px)" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        style={{
          opacity: safeOpacity,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "bottom right",
        }}
      />
    </div>
  );
}
