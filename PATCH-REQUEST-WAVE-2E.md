# PATCH REQUEST — WAVE 2E (white-labelling, v1.90.0-alpha)

Everything in this file is a change to a file **Wave 2E does not own**.
Nothing here is included in the delivered tree; each item is the exact
diff or the exact new file, with the reason it cannot live inside the
wave's own paths.

Ordered by consequence. **Items 1–4 are load-bearing: without them the
feature is built and unreachable, which is the defect this codebase has
been found to have more than thirty times.**

---

## 1. `lib/validators/storage.ts` — one entry in `DOCUMENT_ENTITY_TYPES`

**Why it cannot be avoided.** The wave brief says storage is already
solved and a second upload mechanism is a second thing to secure. The
existing mechanism keys every object by an `entityType` drawn from this
`as const` array, and `/api/upload` refuses anything not in it. Without
this entry there is no way to use the existing uploader, and the only
alternative is the second uploader the brief forbids.

```diff
@@ lib/validators/storage.ts
    "drawing",
+  /**
+   * ⭐ WAVE 2E. The workspace's own logo, uploaded through the same
+   * three-step path as every other file: ticket, PUT, magic bytes,
+   * tenant-prefixed key. It is NOT a document — no `documents` row is
+   * written for it, it is not in the vault, the recycle bin or
+   * retention — but it is a FILE, and every file in this product
+   * arrives the same way or it arrives unguarded.
+   *
+   * ⚠️ THE ENTITY ID IS THE TENANT ID. Every other entity type names a
+   * record inside the workspace; branding names the workspace itself,
+   * which is the only id available before any record exists.
+   */
+  "branding",
  ] as const;
```

No change to `ALLOWED_MIME_TYPES` is requested. `image/png`, `image/jpeg`,
`image/webp` and `image/gif` are already on it, and
`components/branding/logo-upload.ts` narrows to exactly those four.
**`image/svg+xml` must stay off it** — see item 2 for why this particular
image makes that more important than usual, not less.

---

## 2. `app/api/branding/logo/route.ts` — NEW FILE, complete

**Why it cannot live in a file the wave owns.** It is a route, and routes
live under `app/api/`. There is no alternative: the R2 bucket is private
and has no public address, and one of the three required placements for
the logo is the **sign-in page of the tenant's own subdomain**, where by
definition there is no session and the tenant is known only from the
hostname.

**What this exposes, stated plainly, because a session-less route that
reads a bucket deserves the argument in writing:**

* It serves **one object per tenant** — the one named by
  `branding.logoKey` — and nothing else. There is no key parameter, no
  listing and no traversal: the key comes from the row, and
  `servableLogoKey()` re-checks it against that tenant's storage prefix
  before a byte is fetched, using the same `pathnameBelongsToTenant()`
  the document download route uses.
* What an attacker learns from it is the logo already printed on that
  customer's invoices and shown on their public login page. A logo is
  public **by purpose**. That is the whole reason this and only this may
  be served without a session.
* `Cache-Control: private` — never `public`. The response varies by
  hostname, and a shared cache that got that wrong once would serve one
  workspace's logo to another. A logo is a few kilobytes; the shared
  cache buys nothing worth that risk.

```ts
/**
 * Ordence — The tenant logo, by hostname
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONLY SESSION-LESS READ OF THE OBJECT STORE IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * Every other file is reached through `/api/documents/[id]/download`,
 * which re-derives the Clerk session on each request. That is correct
 * for an executed contract and impossible for a logo, because the logo
 * has to appear on the SIGN-IN PAGE at `companyname.ordence.com` — where
 * there is no session and the tenant is known only from the hostname.
 *
 * The decisions this route makes, and each one's refusal:
 *
 *   1. WHICH TENANT — from the hostname via `resolveTenantFromHost()`,
 *      the same pure resolver `middleware.ts` uses. Not from a header,
 *      not from a query parameter. No subdomain and no session → 404.
 *   2. WHICH OBJECT — `branding.logoKey` from that tenant's row. There
 *      is no key parameter. A caller cannot ask for a different object.
 *   3. WHETHER THAT KEY IS THEIRS — `pathnameBelongsToTenant()`, which
 *      also refuses `..`. The action already refused a foreign key on
 *      the way in; this refuses it again on the way out, because a value
 *      validated once is only as trustworthy as everything that could
 *      have written it since.
 *
 * ⚠️ A MISS IS A 404 AND NOT AN ERROR. No logo, no tenant, no object,
 * storage unconfigured — all 404. The component behind this renders the
 * workspace's name instead, so the failure is invisible to the user and
 * silent in the log, which is what it should be for an image.
 */

import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { resolveTenantFromHost } from "@/lib/tenant";
import { getStoredObject, isStorageConfigured } from "@/lib/storage/r2";
import { pathnameBelongsToTenant } from "@/lib/validators/storage";
import { servableLogoKey } from "@/lib/branding/logo";
import { getTenantContext } from "@/server/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readRuntimeEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const NOT_FOUND = () => new NextResponse(null, { status: 404 });

export async function GET(request: NextRequest): Promise<Response> {
  if (!isStorageConfigured()) return NOT_FOUND();

  const locator = resolveTenantFromHost(
    request.headers.get("host"),
    readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN") ?? "localhost:3000",
    { zoneDomain: readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN") },
  );

  let tenantId: string | null = null;
  let branding: unknown = null;

  if (locator.kind === "subdomain") {
    /*
     * ⚠️ PLATFORM SCOPE, AND IT IS THE RIGHT CALL HERE FOR THE SAME
     * REASON `requireTenantContext` USES IT: this asks "which workspace
     * is at this hostname" BEFORE any workspace is known, which is by
     * definition a question no single workspace can answer. The SELECT
     * is pinned to one slug and returns two columns.
     */
    const row = await withPlatformScope((tx) =>
      tx.query.tenants.findFirst({
        where: and(eq(tenants.slug, locator.slug), isNull(tenants.deletedAt)),
        columns: { id: true, branding: true },
      }),
    );
    if (row) {
      tenantId = row.id;
      branding = row.branding;
    }
  } else {
    /*
     * The canonical app host has no tenant in it, so the CRM shell on
     * `app.ordence.com` falls back to the session. Signed out on a host
     * with no subdomain there is nothing to serve, and nothing is.
     */
    const ctx = await getTenantContext();
    if (ctx) {
      tenantId = ctx.tenant.id;
      branding = ctx.tenant.branding;
    }
  }

  if (!tenantId) return NOT_FOUND();

  const key = servableLogoKey(branding, tenantId, pathnameBelongsToTenant);
  if (!key) return NOT_FOUND();

  const object = await getStoredObject(key);
  if (!object) return NOT_FOUND();

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      /*
       * 🔴 `private`, NEVER `public`. This response varies by hostname;
       * a shared cache that keyed it wrongly even once would serve one
       * workspace's logo on another workspace's login page.
       */
      "cache-control": "private, max-age=300, must-revalidate",
      "x-content-type-options": "nosniff",
      /*
       * The stored type is already constrained to four raster formats
       * by the upload allowlist. `Content-Disposition: inline` with
       * `nosniff` means a file that somehow got past that renders as a
       * download rather than as a document in this origin.
       */
      "content-disposition": "inline",
    },
  });
}
```

### 2b. `middleware.ts` — the route must be public

```diff
@@ middleware.ts  (const isPublicRoute = createRouteMatcher([...]))
   "/api/webhooks(.*)",
+  /**
+   * ⭐ WAVE 2E. The tenant logo, resolved from the hostname. It is on
+   * this list for the same reason `/sign-in` is: it is rendered ON the
+   * sign-in page, before any session exists. What it may serve is one
+   * object per tenant — see the route's own header for the argument.
+   */
+  "/api/branding/logo",
```

---

## 3. `app/(crm)/settings/settings-tabs.tsx` — one tab

**Without this the screen has no navigation to it.** `check:links` passes
either way (the page exists), which is exactly how built-and-unreachable
survives a green build.

```diff
@@ app/(crm)/settings/settings-tabs.tsx
   { href: "/settings/appearance", label: "Appearance" },
+  // ⭐ Wave 2E. The WORKSPACE's logo and colour — distinct from
+  // "Appearance" one line above, which is a PERSONAL light/dark choice
+  // stored on the user row. One is what this company looks like to its
+  // customers; the other is what this person's screen looks like.
+  { href: "/settings/branding", label: "Branding" },
```

---

## 4. `app/(crm)/layout.tsx` — mount the brand, and the logo in the sidebar

Three edits. The style block is emitted by a component the wave owns; the
layout only wraps.

```diff
@@ app/(crm)/layout.tsx  (imports)
 import { Sidebar } from "@/components/layout/sidebar";
+import { BrandScope } from "@/components/branding/brand-scope";
+import { logoSrc } from "@/lib/branding/logo";
```

```diff
@@ app/(crm)/layout.tsx  (inside the render, around the shell)
-      <div className="flex h-screen flex-col overflow-hidden">
+      {/*
+        ⭐ WAVE 2E — THE BRANDED SUBTREE, AND ITS BOUNDARY.
+        Custom properties inherit, so everything inside this wrapper
+        gets the workspace's accent colours and everything outside keeps
+        the product's own. `app/platform/**` is outside it, deliberately:
+        an operator console wearing one customer's colours is a console
+        where somebody does the right thing in the wrong workspace.
+      */}
+      <BrandScope branding={tenant.branding} className="contents">
+      <div className="flex h-screen flex-col overflow-hidden">
...
-      </div>
+      </div>
+      </BrandScope>
```

⚠️ `className="contents"` matters: the wrapper must not become a flex/height
boundary of its own, and `display: contents` keeps the existing layout
geometry byte-identical while still carrying the custom properties.

```diff
@@ app/(crm)/layout.tsx  (both sidebars)
           <Sidebar
             sections={sections}
             industryLabel={template.label}
             tenantName={tenant.name}
+            logoSrc={logoSrc(tenant.branding)}
           />
           <MobileSidebar
             sections={sections}
             industryLabel={template.label}
             tenantName={tenant.name}
+            logoSrc={logoSrc(tenant.branding)}
           />
```

### 4b. `components/layout/sidebar.tsx`

```diff
@@ components/layout/sidebar.tsx
+import { BrandLogo } from "@/components/branding/brand-logo";
+
 export function Sidebar({
   sections,
   industryLabel,
   tenantName,
+  logoSrc = null,
 }: {
   sections: NavSection[];
   industryLabel: string;
   tenantName: string;
+  /** Null for a workspace with no logo — the name is shown instead. */
+  logoSrc?: string | null;
 }) {
@@
       <div className="border-b border-border px-4 py-3">
-        <p className="truncate text-sm font-semibold">{tenantName}</p>
+        {/*
+          ⚠️ THE NAME IS THE FALLBACK AND IS ALWAYS AVAILABLE. This
+          header is how a person knows WHICH WORKSPACE THEY ARE IN; an
+          `<img>` that 404s after a bucket move would otherwise leave an
+          empty box in the one place that answers that question.
+        */}
+        <BrandLogo src={logoSrc} tenantName={tenantName} height={24} />
         <p className="truncate text-xs text-muted-foreground">{industryLabel}</p>
       </div>
```

**The same two-line change is needed in `components/layout/mobile-sidebar.tsx`**
(props at 66–74, header at 111–112). Two headers exist today; this wave does
not merge them, but a merge would be worth a later batch.

---

## 5. `app/(crm)/dashboard/page.tsx` — the watermark, and the first run

```diff
@@ app/(crm)/dashboard/page.tsx  (imports)
+import { redirect } from "next/navigation";
+import { BrandWatermark } from "@/components/branding/brand-watermark";
+import { logoSrc } from "@/lib/branding/logo";
+import { shouldPromptBrandingSetup, BRANDING_SETUP_PATH } from "@/lib/branding/first-run";
```

```diff
@@ app/(crm)/dashboard/page.tsx  (after `const ctx = await requirePageContext()`)
+  /*
+   * ⭐ WAVE 2E — THE FIRST RUN, ONCE AND ONLY FOR AN OWNER.
+   * The whole rule is `shouldPromptBrandingSetup()`, in lib/, where it
+   * can be exercised against every combination of role and stored
+   * branding without a browser. Skipping counts as deciding; a member
+   * is never sent, because they cannot pass `settings:update` and would
+   * land on a form they cannot submit.
+   */
+  if (shouldPromptBrandingSetup({ branding: ctx.tenant.branding, role: ctx.role })) {
+    redirect(BRANDING_SETUP_PATH);
+  }
```

```diff
@@ app/(crm)/dashboard/page.tsx  (the top-level element)
-    <main className="space-y-8 p-6">
+    <main className="relative space-y-8 p-6">
+      {/*
+        ⚠️ BEHIND, AND OUT OF THE WAY. Bottom-right, ≤4% opacity,
+        `aria-hidden`, `pointer-events-none`, and hidden below `lg`.
+        A wash under the metric cards would reduce the contrast of the
+        figures, which is the opposite of what a ledger is for.
+      */}
+      <BrandWatermark src={logoSrc(ctx.tenant.branding)} />
```

---

## 6. `app/(auth)/sign-in/[[...sign-in]]/page.tsx` — the logo on the login screen

There is no `app/(auth)/layout.tsx`; the page is four lines and this makes
it eight. It is a **server component with no session**, so the logo comes
from the route in item 2 — which is why item 2 exists.

```diff
-import { SignIn } from "@clerk/nextjs";
+import { SignIn } from "@clerk/nextjs";
+import { LOGO_ROUTE } from "@/lib/branding/logo";
 
 export default function SignInPage() {
   return (
     <main className="flex min-h-screen items-center justify-center p-6">
-      <SignIn />
+      <div className="flex flex-col items-center gap-6">
+        {/*
+          ⭐ WAVE 2E. The workspace's own logo at its own address.
+          ⚠️ NO FALLBACK WORDMARK HERE, and that is deliberate: this page
+          is served on the app host too, where there is no tenant, and a
+          wordmark would have to name a workspace nobody has proved they
+          belong to. A 404 from the route renders nothing, which is what
+          this page looked like before.
+        */}
+        {/* eslint-disable-next-line @next/next/no-img-element */}
+        <img src={LOGO_ROUTE} alt="" style={{ maxHeight: 48, width: "auto" }} />
+        <SignIn />
+      </div>
     </main>
   );
 }
```

---

## 7. `app/(print)/invoices/[id]/print/page.tsx` — the logo on the invoice

**The placement customers care about most.**

```diff
+import { getTenantContext } from "@/server/tenant-context";
+import { BrandLogo } from "@/components/branding/brand-logo";
+import { logoSrc } from "@/lib/branding/logo";
@@
   const { invoice, supplier, recipient, lines, hsnSummary, copies, gaps } = result.data;
+  const ctx = await getTenantContext();
@@
           <header className="relative border-b-2 border-black pb-2">
+            {ctx ? (
+              <div className="absolute left-0 top-0">
+                <BrandLogo
+                  src={logoSrc(ctx.tenant.branding)}
+                  tenantName={ctx.tenant.name}
+                  height={36}
+                />
+              </div>
+            ) : null}
             <p className="text-center text-[13px] font-bold uppercase tracking-wide">
```

⚠️ **A KNOWN AND DELIBERATE LIMITATION, stated so integration can decide.**
This prints the workspace's **current** logo, so reprinting a two-year-old
invoice shows today's logo rather than the one that was on the original.
Everything else on this page is captured at issue (`supplierRegistrationId`,
the address, the GSTIN) precisely because it must not drift. Capturing the
logo per invoice needs a column on the invoice row — a migration this wave
does not have and, per the brief, should not invent. **The colours are not
applied to the printed document at all**: `.document-surface` in
`app/globals.css` deliberately re-pins the palette so paper stays legible,
and this wave does not argue with that.

---

## 8. `app/globals.css` — nothing requested

Wave 2D owns it and is building the token set right now. **This wave asks
for no change to it.** The brand is emitted as an element-scoped
`<style>` block by `components/branding/brand-scope.tsx`, overriding only
`--primary`, `--primary-foreground`, `--ring`, `--accent`,
`--accent-foreground` and adding `--brand` and `--brand-border`.

**If Wave 2D introduces semantic status tokens** (`--success`,
`--warning`, `--danger` or similar), the only change needed here is to
add their names to `RESERVED` in `lib/branding/tokens.ts`, which this
wave owns. They are already unreachable — `BRANDABLE` is an allowlist and
the emitter filters through it — so the addition is documentation, not a
fix.
