/**
 * Ordence — The branded subtree
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * A SERVER COMPONENT, AND A `<style>` RATHER THAN INLINE PROPERTIES
 * ══════════════════════════════════════════════════════════════════════
 * The brand belongs to the WORKSPACE, not to the browser. It must not be
 * cached in `localStorage` the way the light/dark choice is: that cache
 * belongs to one device, and on a shared laptop it would paint the last
 * workspace's colours over the next one for the length of a paint flash.
 * Rendering it on the server means the correct colours arrive with the
 * HTML and there is no flash at all.
 *
 * A `<style>` element rather than `style={{ "--primary": ... }}` because
 * there are TWO blocks: the light values and the `.dark` ones. The theme
 * is a class on `<html>` (`components/layout/theme-provider.tsx`), so the
 * dark variant has to be a rule that the class can select — an inline
 * declaration cannot express "and this other set when an ancestor has
 * .dark".
 *
 * ⚠️ THE STYLE IS SCOPED TO A CLASS ON THIS WRAPPER, WHICH IS THE WHOLE
 * BOUNDARY. Custom properties inherit down, so everything inside is
 * branded and everything outside — `app/platform/**`, the operator
 * console — is untouched. There is no `:root` rule anywhere in this
 * wave, deliberately: a `:root` rule would be global, and this product
 * serves several workspaces to the same operator.
 */

import { BRAND_SCOPE_CLASS, brandStyleSheet } from "@/lib/branding/tokens";
import { parseBranding } from "@/lib/branding/schema";

export function BrandScope({
  branding,
  className,
  children,
}: {
  branding: unknown;
  className?: string;
  children: React.ReactNode;
}) {
  const colour = parseBranding(branding).primaryColor;
  const sheet = colour ? brandStyleSheet(colour) : "";

  /*
   * No brand colour → nothing is emitted and the class is still applied.
   * The class with no rule behind it costs nothing and means the markup
   * does not change shape between a branded and an unbranded workspace,
   * which is what keeps a layout patch from needing a conditional.
   */
  return (
    <>
      {sheet ? (
        /*
         * ⚠️ `dangerouslySetInnerHTML` AND IT IS NOT DANGEROUS HERE, for
         * a reason that has to survive review: `sheet` is not user text.
         * It is built by `brandStyleSheet()` from ONE hex colour that
         * `parseBranding()` has already matched against
         * /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/ and then converted through
         * `toCssTriple()`, which emits three numbers. There is no path
         * by which a stored string reaches this attribute verbatim — the
         * only way to get a `<` in here is to change the colour parser.
         */
        <style dangerouslySetInnerHTML={{ __html: sheet }} />
      ) : null}
      <div className={[BRAND_SCOPE_CLASS, className].filter(Boolean).join(" ")}>
        {children}
      </div>
    </>
  );
}
