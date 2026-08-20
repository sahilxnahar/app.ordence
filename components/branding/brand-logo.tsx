"use client";

/**
 * Ordence — The logo, with the wordmark behind it
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FALLBACK IS THE FEATURE
 * ══════════════════════════════════════════════════════════════════════
 * This component is mounted in the sidebar header, which is how a person
 * knows WHICH WORKSPACE THEY ARE IN. If the image fails — a rotated R2
 * credential, a bucket the customer moved, a Clerk image they deleted —
 * a plain `<img>` renders a broken-image glyph or an empty box, and the
 * one thing on screen that identifies the workspace is gone.
 *
 * So the workspace NAME is always in the DOM. The image is shown over it
 * when it loads, and `onError` puts the name back. A user whose logo
 * never arrives sees a readable wordmark and does not know anything went
 * wrong; a user whose logo arrives sees their logo.
 *
 * ⚠️ A CLIENT COMPONENT ONLY BECAUSE `onError` IS AN EVENT HANDLER. There
 * is no state that matters, no fetch, and no effect.
 *
 * ⚠️ PLAIN `<img>`, NOT `next/image`. The source is a route that streams
 * bytes out of R2 after resolving the tenant from the hostname; running
 * it through the image optimiser would put a second cache in front of a
 * per-tenant resource keyed on a header, which is how one workspace's
 * logo ends up served to another. Logos are small; the optimiser buys
 * nothing here and risks a cross-tenant cache.
 */

import { useState } from "react";
import { wordmark } from "@/lib/branding/logo";

export function BrandLogo({
  src,
  tenantName,
  className,
  imgClassName,
  height = 28,
}: {
  src: string | null;
  tenantName: string;
  className?: string;
  imgClassName?: string;
  height?: number;
}) {
  const [failed, setFailed] = useState(false);
  const name = wordmark(tenantName);
  const showImage = Boolean(src) && !failed;

  return (
    <span className={className}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src ?? ""}
          alt={name}
          style={{ height, width: "auto", maxWidth: "100%" }}
          className={imgClassName}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="truncate text-sm font-semibold">{name}</span>
      )}
    </span>
  );
}
