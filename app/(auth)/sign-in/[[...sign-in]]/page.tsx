import { SignIn } from "@clerk/nextjs";
import { LOGO_ROUTE } from "@/lib/branding/logo";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex flex-col items-center gap-6">
        {/*
          ⭐ WAVE 2E. The workspace's own logo at its own address.

          🔴 THIS IS WHY `app/api/branding/logo` EXISTS. There is no
          session on this page and no tenant scope, so the logo cannot be
          read the way every other file in this product is read. The route
          resolves the workspace from the HOSTNAME and serves exactly one
          object , the key on that tenant's own row.

          ⚠️ NO FALLBACK WORDMARK HERE, AND THAT IS DELIBERATE. This page
          is also served on the app host, where there is no tenant; a
          wordmark would have to name a workspace nobody has proved they
          belong to. A 404 renders nothing, which is what this page looked
          like before.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO_ROUTE} alt="" style={{ maxHeight: 48, width: "auto" }} />
        <SignIn />
      </div>
    </main>
  );
}
