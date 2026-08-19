# DEPLOY , Ordence v1.53.0-alpha (the Railway build fix)

**Repo: `app.ordence`**

🔴 **SQL: unchanged from v1.52.0.** `0086`, `0087`, `0088`, `0089`, `0090`, all BEFORE the code push. If you have already run them, there is nothing new to run.
⚠️ **No new environment variables.**

**Push this and the build will complete.** Sixteen gates green, `tsc` clean, 128 test files, 4,467 tests.

---

## 1. What failed, and why nothing caught it

```
app/api/webhooks/clerk/route.ts
Type error: Route "app/api/webhooks/clerk/route.ts" does not match the
required types of a Next.js Route.
  "handleUserCreated" is not a valid Route export field.
```

A Next.js `route.ts` may export **only** the HTTP verbs (`GET`, `POST`, …) and Next's config fields (`runtime`, `dynamic`, `revalidate`, and a few others). Anything else is a hard build error.

That file exported three handler functions so `_handlers.ts` could re-export them for the evidence tests. Reasonable intent, forbidden mechanism.

⚠️ **Every gate was green when it shipped, and that is the part worth understanding.** `tsc --noEmit` passed. All 4,467 tests passed. Fifteen checks passed. **The rule is enforced by TypeScript types that Next.js generates into `.next/types` during `next build`** , they do not exist until a full production build runs. And a full production build is OOM-killed in the container this project is developed in, which I told you earlier and then did not treat as the gap it was. So the first machine that could possibly see this error was Railway.

**My miss, not Manus's.** I verified v1.52.0 with `tsc` and called it verified.

---

## 2. The fix

**The implementation did not move.** `route.ts` was copied to `_webhook.ts` byte for byte , the leading underscore keeps it out of Next's route resolution , and `route.ts` is now three lines:

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export { POST } from "./_webhook";
```

`_handlers.ts` re-exports from `_webhook.ts` instead of from the route file. **Nothing about the webhook contract, the Svix verification or the dispatch behaviour changed.**

---

## 3. ⭐ The sixteenth gate, so this cannot recur

```
npm run check:route-exports
```

Static. No build, no types, no memory. It reads the export statements of every route file and compares them to the list Next.js accepts.

**Verified by reintroducing the exact defect**, not by assertion:

```
❌ 1 export(s) Next.js will refuse at build time:
      app/api/webhooks/clerk/route.ts:33  "handleUserCreated" is not a valid Route export field
```

⚠️ **It is honest about being a subset.** It cannot check handler signatures or `params` shapes. It catches the one class that has actually broken a deploy here.

---

## 4. 🔴 A second thing the build told us, which was only a warning

```
A Node.js API is used (process.version at line: 240) which is not
supported in the Edge Runtime.
Import trace: ./node_modules/@upstash/redis/nodejs.mjs
              ./lib/edge/limits.ts
```

`lib/edge/limits.ts` is the per-tenant rate limiter and it is imported by `middleware.ts`, which runs in the Edge Runtime. It was importing the **Node** build of `@upstash/redis`.

⚠️ **Being only a warning is why it survived.** The build goes green, the deploy succeeds, and the rate limiter is the thing that silently does not work in the runtime it was written for , which is how a per-tenant limit becomes no limit at all, with nothing to read. Now `@upstash/redis/cloudflare`, the same client over `fetch`.

⚠️ **You will still see one warning about multiple lockfiles** if a stray `package-lock.json` sits above the app directory in the build context. Harmless, and not present in this zip.

---

## 5. And a gate caught the consequence on its own

The moment the implementation left the route file it stopped being server-side by definition and became an ordinary module. `check:boundaries` asked it to declare itself, on the first run, correctly. It now imports `server-only`.

Two tests also read the webhook by path and were updated to read `_webhook.ts`. Both were pinning the file, not the behaviour.

---

## 6. Deploy

1. **SQL: nothing new.** If `0086` to `0090` are already applied, skip straight to the push. If not, they go first, lowest number first. `CHECK-EVERYTHING-neon-safe.sql` tells you which.
2. Unzip `ordence-v1.53.0-alpha.zip`, commit, push. Railway builds automatically.
3. Watch for `Compiled successfully` and the absence of the `process.version` warning.

---

## 7. Still on your side

| | What |
|---|---|
| 🔴 | `NEXT_PUBLIC_ZONE_DOMAIN = ordence.com` on the Railway **service**, then **redeploy** , this is what makes `admin.ordence.com` stop 404ing |
| 🔴 | Run `CHECK-EVERYTHING-neon-safe.sql` and send me tabs 1 to 4 |
| | `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER`, `openssl rand -hex 32`, set on Railway, **never pasted to me** |
| | A Groq key and a Cloudflare Workers AI key |
| | `projects.state_code` on every live project |

⚠️ **`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are worth setting now.** The product says so in its own logs: without them the rate limiter falls back to per-instance memory counters, and on a serverless deployment the effective limit becomes the limit multiplied by the number of instances.
