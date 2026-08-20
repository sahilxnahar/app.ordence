# TRACK REPORT — WAVE 2E, white-labelling
Build `v1.90.0-alpha` · tree `ordence-DEPLOY-v1.90.0-alpha.zip`

---

## 0. On SQL: **none used.**

`SQL 0295`–`0299` were reserved for this wave and **not one of them was
written.** `tenants.branding` is `jsonb` and already exists
(`db/schema/core.ts:178`), so the two keys this wave adds — `logoKey` and
`setupCompletedAt` — are values, not DDL. A phase that invents a
migration it does not need turns `check:migrations` red for every
parallel stream.

```
$ node scripts/check-migrations.mjs
✅ Migrations contiguous — 168 files, 0001…0275 (6 documented historical gaps). Next number: 0276.
```

Same file count and same next number as the tree arrived with.

---

## 1. The tree was confirmed, then not re-measured

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  29/29 passed

$ npm run check:import-contract
✅ check:import-contract
   18 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: chart-of-accounts, companies, cost-centres, customers, gst-parties,
             leads, opening-stock, stock-items, tax-codes, vendors, warehouses
     wave 1: batches, contacts, opening-customer-invoices, opening-trial-balance,
             opening-vendor-bills, purchase-bills, receipts
```

Right tree.

---

## 2. What was found before anything was built

**Three writers, zero readers — confirmed, and the count is four.** The
brief names the seed script, `claim-slug.ts` and the Clerk webhook.
`server/platform/provisioning.ts` also carries branding through. Nothing
read any of it.

**A second finding, in the schema's own comment.** `db/schema/core.ts:177`
says of the column: *"Shape validated by Zod at the edge
(lib/validators)."* **There was no such validator.** That is
declared-and-unenforced in a comment describing a defence that does not
exist — the thing a reviewer would read and stop looking. It exists now:
`lib/branding/schema.ts`.

---

## 3. What was built

| Path | What it is |
|---|---|
| `lib/branding/color.ts` | WCAG 2.1 luminance and contrast, hex↔HSL, contrast-directed adjustment. No imports at all. |
| `lib/branding/tokens.ts` | **The allowlist.** `BRANDABLE`, `RESERVED`, the emitter, the scoped stylesheet. |
| `lib/branding/schema.ts` | The zod shape the schema comment promised; total parse, merge-never-replace. |
| `lib/branding/extract.ts` | Dominant colour + alternates out of RGBA pixels. Pure. |
| `lib/branding/logo.ts` | Which key may be served, what an `<img>` points at, the wordmark. |
| `lib/branding/first-run.ts` | Who is sent to the setup screen, once. |
| `components/branding/brand-scope.tsx` | Server component: the element-scoped `<style>`. |
| `components/branding/brand-logo.tsx` | The logo with the wordmark behind it. |
| `components/branding/brand-watermark.tsx` | ≤4%, bottom-right, `aria-hidden`. |
| `components/branding/logo-upload.ts` | The browser half — calls the EXISTING `/api/upload` pair. |
| `components/branding/branding-form.tsx` | The screen. |
| `app/(crm)/settings/branding/page.tsx` | Settings ▸ Branding, and the first run. |
| `server/actions/branding.ts` | `updateBranding`, `completeBrandingSetup`. |
| `tests/ui/branding.test.ts` | 45 assertions. Section 5 below. |

**Zero new npm dependencies** (`package.json` untouched). **No import of
`@/db` anywhere in `lib/branding/`.**

```
$ grep -rn "from \"@/db\"\|drizzle-orm" lib/branding/ | wc -l
0
```

### Storage: the existing mechanism, not a second one

`components/branding/logo-upload.ts` calls POST `/api/upload` and PUT
`/api/upload/put` — the signed-ticket path with the tenant-prefixed key,
the content-type pin, the byte ceiling, the rate limit, the quota gate
and the magic-byte sniff. It stops one step earlier than
`document-vault.tsx` does: no `documents` row is written, because a logo
is not a document. **No new upload route, no new bucket, no new secret.**

The one thing it needs that it does not own is `"branding"` in
`DOCUMENT_ENTITY_TYPES` — item 1 of `PATCH-REQUEST-WAVE-2E.md`.

---

## 4. The two rules that mattered

### 4a. The brand drives accents and borders. Never text, never status.

Enforced **by construction**. `brandCssVariables()` builds a candidate
object and then copies out only the names in `BRANDABLE`:

```ts
const safe: Record<string, string> = {};
for (const name of BRANDABLE) { ... }
return safe;
```

Adding `"--destructive": ...` to the object above it changes nothing, because
the name is not in the allowlist. That is the difference between a rule
and a wish — and it is why the induced failure in §5b takes three
independent assertions down rather than one.

`RESERVED` names every forbidden property with the reason:
`--foreground`, `--card-foreground`, `--muted-foreground`,
`--secondary-foreground`, `--background`, `--card`, `--secondary`,
`--muted`, `--destructive`, `--destructive-foreground`, `--border`,
`--input`, `--radius`.

**One thing the brief assumed that is not true of this tree, and it
changes nothing.** There are no semantic status tokens in
`app/globals.css` yet — no `--success`, no `--warning`, no green or
amber variable of any kind. Status colours in this product are literal
Tailwind classes (`text-red-700`, `bg-amber-50`). Wave 2D is building
that token set now. **They are already unreachable from here**, because
`BRANDABLE` is an allowlist and not a blocklist: a token that does not
exist yet cannot be emitted by a filter that only passes seven names. If
2D lands `--success`/`--warning`/`--danger`, add them to `RESERVED` — that
is documentation, not a fix. Stated in item 8 of the patch request.

### 4b. A brand that fails contrast is caught and handled, and it says so

Two thresholds, deliberately different: `AA_TEXT = 4.5` and
`AA_NON_TEXT = 3`. A colour that fails the text bar **keeps the borders,
the ring and the sidebar marker** and gets a darkened variant for
`--primary`, which is the value that carries text. The screen prints the
ratio, the substituted hex and the sentence *"Nothing is substituted
without telling you"*, and `updateBranding` writes `contrastRatio` and
`contrastAdjusted` into the tenant's own audit log — so the question
"why is our heading darker than our logo" has an answer a year later.

Both themes are judged. A near-black brand passes on white and **fails on
the dark palette**, and the correction there goes lighter rather than
darker. A single-theme check would have shipped that.

---

## 5. Proof. Every claim with the command, and the induced failure.

### 5a. The suite as it stands

```
$ npx vitest run --project=ui tests/ui/branding.test.ts
      Tests  45 passed (45)
```

### 5b. INDUCED — somebody themes the status palette in six months

Added `"--destructive"` to `BRANDABLE` and emitted the brand colour into
it. That is the exact change the brief predicts:

```
$ npx vitest run --project=ui tests/ui/branding.test.ts
 × branding cannot move a status colour > the allowlist and the reserved list do not intersect
   → expected [ '--foreground', …(12) ] to not include '--destructive'
 × branding cannot move a status colour > leaves every reserved token BYTE-IDENTICAL after a brand is applied
   → expected '0 74% 42%' to be '0 72% 51%' // Object.is equality
 × branding cannot move a status colour > no file in this wave writes a status colour into a custom property
   → expected '/**\n * Ordence — What a brand colour…' not to match /["'`]--destructive(-foreground)?["'`]…/
      Tests  3 failed | 41 passed (44)
```

Three refusals from three different angles: the allowlist's own
consistency, **byte equality of the declaration text read out of the real
`app/globals.css`**, and a source scan. Reverted; 45 pass again.

### 5c. INDUCED — the contrast adjustment removed. **This one found a defect in my own test file.**

First attempt: deleted the adjustment from the emitter
(`const textSafe = chosen;`) so a pale yellow reaches `--primary`
verbatim.

```
      Tests  44 passed (44)      ← ALL GREEN. The mutation survived.
```

**The suite was asserting `evaluateContrast()` — the verdict shown on the
screen — and never the value that ships.** The screen would have said
"we darkened it" while the browser received it undarkened. That is
declared-and-unenforced reproduced *inside the check written to catch
it*, which is where this codebase has found it four times before. It is
recorded here rather than quietly fixed, because a report that only lists
what worked is the artefact this project's rules exist to prevent.

A test on the emitted value was added — `🔴 the EMITTED --primary clears
AA, not merely the verdict that describes it`, over five brands × two
themes — and the same mutation re-run:

```
$ npx vitest run --project=ui tests/ui/branding.test.ts
 × 🔴 the EMITTED --primary clears AA, not merely the verdict that describes it
   → --primary for #F5E663 in the light theme: expected 1.2825340178365832 to be greater than or equal to 4.5
      Tests  1 failed | 44 passed (45)
```

Reverted; 45 pass.

### 5d. INDUCED — a second real defect, found by a test rather than by reading

The first version of `adjustForContrast()` searched over **fractional**
lightness. `toCssTriple()` rounds to whole numbers, so a ring measured at
3.00:1 shipped at **2.93:1**:

```
 × the focus ring only has to clear the non-text bar, and does
   → expected 2.932513182168309 to be greater than or equal to 2.95
```

Fixed by walking integer lightness, so **the value checked is byte-for-byte
the value emitted**. The comment on that loop says why.

### 5e. The pale yellow and the near-black, both outcomes

* `#F5E663` on white → `passesText: false`, ratio **1.28:1**; emitted
  `--primary` is a darkened same-hue variant clearing **4.5:1**;
  `--brand`/`--brand-border` keep the customer's colour; hue moves by
  **< 2°**, so it is still their colour and not a substitute.
* `#141414` on white → `passesText: true`, `applied === chosen`,
  untouched. On the dark page it fails and is **lightened** instead.

### 5f. Tenant isolation on the logo key — the refusal, not the grant

`updateBranding` re-checks the client-supplied key with
`pathnameBelongsToTenant()` (the same function the document download
route uses) and `servableLogoKey()` checks it again at serve time.

```
 ✓ 🔴 REFUSES a key belonging to another tenant
 ✓ 🔴 REFUSES traversal out of the prefix
 ✓ 🔴 REFUSES a logo key belonging to another tenant, and writes nothing
```

The last one asserts `sets === []` and `audits === []` — **no UPDATE was
issued at all**, not merely that the call returned an error.

### 5g. The gates, after the wave

```
$ npx tsc --noEmit                    → clean
$ npm run gates:static                → 29/29 passed
$ node scripts/check-import-contract.mjs → 18 entities, 2 waves (unchanged)
$ node scripts/check-action-guards.mjs
✅ Action guards intact — 736 public endpoints, 693 authorisation-checked, …
$ node scripts/check-action-reachability.mjs
✅ No server action became unreachable. 119 still are (baseline 119).
$ node scripts/check-links.mjs
✅ 169 internal link shapes, 242 routes. 0 known dead (budget 0), 0 new.
```

735 → **736** public endpoints and 692 → **693** authorisation-checked:
the two new actions, both behind `settings:update`, neither exempted and
neither added to any allowlist.

---

## 6. Known-red: the brief's list is stale. Here is the measured one.

The brief says 12 pre-existing failures in `assemble-wave`, `csv-import`
and `opening-balances`. The count is right; **two of the three file names
are not.** Measured on the **untouched** tree — a fresh extraction of
`ordence-DEPLOY-v1.90.0-alpha.zip` with nothing from this wave in it:

```
$ cd /tmp/pristine && npx vitest run --project=ui \
    tests/ui/assemble-wave.test.ts tests/ui/import-discovery.test.ts \
    tests/ui/import-profiles.test.ts tests/ui/import-sales-entities.test.ts
 Test Files  4 failed (4)
      Tests  12 failed | 109 passed (121)
```

The four files are `assemble-wave`, **`import-discovery`**,
**`import-profiles`** and **`import-sales-entities`**. `csv-import` and
`opening-balances` pass on this tree.

And the whole suite with this wave in it:

```
$ npx vitest run --project=ui
 Test Files  4 failed | 209 passed (213)
      Tests  12 failed | 6847 passed | 8 skipped (6867)
```

**Same four files, same twelve failures, and 45 more passing tests.** This
wave added nothing red and fixed nothing that was not its own.

---

## 7. What is NOT built, and why

* **No theme editor.** A logo, a colour derived from it, and a correction
  control. No fonts, no spacing, no layouts. `fontFamily` exists in the
  column and this wave neither writes it nor offers it.
* **Branding never reaches `app/platform/**`.** The stylesheet is scoped
  to a class on a wrapper mounted only in the CRM shell. `brandStyleSheet()`
  is asserted never to contain `:root` or `html`.
* **The printed document keeps the product palette.** Only the logo goes
  on the invoice. `.document-surface` in `app/globals.css` deliberately
  re-pins the palette so paper stays legible, and this wave does not
  argue with it.
* **The invoice prints today's logo, not the logo as of issue.** Stated
  as a deliberate limitation in patch item 7: capturing it per invoice
  needs a column, and this wave has no migration.
* **`bannerUrl` / `faviconUrl` are carried, not written.** A favicon is a
  document-head change in `app/layout.tsx`, which this wave does not own
  and which is not worth a patch item on its own.

---

## 8. What integration must apply — `PATCH-REQUEST-WAVE-2E.md`

Eight items, none optional except the last. **Items 1–4 are load-bearing:
without them the wave is built-and-unreachable.**

1. `lib/validators/storage.ts` — `"branding"` in `DOCUMENT_ENTITY_TYPES`.
2. `app/api/branding/logo/route.ts` — **new file, given in full**, plus
   one line in `middleware.ts` making it public. The only session-less
   read of the object store in the product; the argument for why that is
   safe is in the file's header, and the refusals are already tested
   here (§5f).
3. `app/(crm)/settings/settings-tabs.tsx` — the tab.
4. `app/(crm)/layout.tsx` + both sidebars — the `BrandScope` wrapper and
   the logo.
5. `app/(crm)/dashboard/page.tsx` — the watermark and the first-run
   redirect.
6. `app/(auth)/sign-in/…/page.tsx` — the logo on the login screen.
7. `app/(print)/invoices/[id]/print/page.tsx` — the logo on the invoice.
8. `app/globals.css` — **nothing requested.** Wave 2D owns it.

---

## 9. One thing worth a later batch

`components/layout/sidebar.tsx` and `components/layout/mobile-sidebar.tsx`
have **two copies of the same workspace header**, and the patch request
has to change both. Neither is owned by this wave, so neither was merged.
The next wave that touches either should merge them — two headers is one
header that will stop matching.
