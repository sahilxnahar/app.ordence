# Ordence · the UI brief

**Two surfaces, two repos, two completely different jobs. Do not blur them.**

| Surface | Repo | Who it is for | What it must do |
|---|---|---|---|
| **ordence.com** | website repo | somebody who has never heard of us | make them believe an Indian ERP can be trusted with their books |
| **app.ordence.com** | `app.ordence` | somebody who uses it eight hours a day | get out of their way |
| **admin.ordence.com** | `app.ordence` | us, three people | tell us the truth about a customer fast |

The rest of this document is what "good" means for each, and the rules that are not negotiable because they come from the domain rather than from taste.

---

# PART ZERO · Who is actually using this

Design for these five people. Not for a Dribbble shot.

1. **The owner.** 45, runs a contracting firm or a real-estate developer in Pune or Hubli. Turnover ₹8 crore to ₹80 crore. Opens the product twice a day on a phone, mostly to approve something or to ask "where is my money". Impatient. Will judge the whole product by whether the number he already knows in his head matches the number on the screen.
2. **The accountant.** The heaviest user. Lives in the product. Wants **density, keyboard, and no surprises**. Every pixel of whitespace you add is a row he cannot see. He has used Tally for twenty years and Tally is fast.
3. **The site engineer.** On a dusty site, one bar of signal, a cracked Android, gloves off for thirty seconds. Needs three fields and a big button.
4. **The HR/admin person.** Runs payroll once a month and is terrified of getting it wrong. Needs the product to tell her what will happen before it happens.
5. **The auditor or inspector.** Turns up once a year and needs to be handed evidence, not a dashboard.

⚠️ **The accountant and the site engineer want opposite things.** That tension is the whole UI problem in this product. Resolve it by surface: dense tables on desktop, three-field forms on mobile. Never by compromise, which gives both of them something mediocre.

---

# PART ONE · app.ordence.com , the product

## 1. The rules that are not style opinions

These come from the domain and from the code. Breaking any of them is a defect, not a design choice.

### Money

- **Rupees, always. `₹`, never `Rs.` or `INR` in the interface.**
- **Indian digit grouping. `₹12,34,567`, never `₹1,234,567`.** Lakh and crore grouping, not thousands. `lib/safe-render.ts` already uses `en-IN`, use it.
- **Money is `bigint` paise in the code and NEVER becomes a `Number` on the way to the screen.** Format from the bigint by string surgery. `formatNumber` and the helpers in `lib/safe-render.ts` exist for this.
- **Right-align every money column. Tabular numerals.** A column of figures that does not line up at the decimal cannot be scanned, and scanning is the entire job.
- **Show the unit once, in the column header, not on every row.** `Amount (₹)` then `12,34,567`.
- ⚠️ **Never abbreviate money in a table.** `₹1.2 Cr` is fine in a headline stat tile, never in a row somebody will reconcile against a bank statement.

### Dates and time

- **`DD-MM-YYYY` or `12 Aug 2026`. Never `MM/DD`.** An Indian user reading `08-12-2026` as 8 December while the system means 12 August is a wrong filing date.
- **Everything is Asia/Kolkata.** Never `toISOString()` for a displayed date. UTC is yesterday for the first five and a half hours of an Indian day.
- **The financial year runs 1 April to 31 March.** Any year selector, any "this year" default, any comparison, uses FY not calendar year. Label it `FY 2026-27`, which is how everyone says it.

### Quantities

- Integer thousandths under the hood. Display **3 decimals for weight and volume**, whole numbers for countable items. `12.500 MT`, `140 bags`.

### Language

- **British/Indian English.** "Organisation", "authorised", "cancelled".
- **Domain words the users actually say**, not translations: GSTIN, HSN, TDS, PF, ESI, PT, RA bill, retention, muster roll, challan, e-way bill, GRN, debit note, godown (not "warehouse" in contracting contexts).
- ⚠️ **Never invent a synonym for a statutory term.** "Tax registration number" instead of GSTIN makes the product look like it was built by somebody who has not filed a return.

## 2. Density and layout

**This is an ERP. The reference is Linear and Stripe's dashboard, not a marketing site.**

- **Base font 14px, table rows 36-40px.** Not 16/56.
- **Content width: full. Do not center a 1200px column on a 27-inch monitor.** The accountant has a big screen for a reason. `container` is already capped at 1400px in `tailwind.config.ts` , override it for data screens.
- **Sidebar: collapsible, icon-only when collapsed, state remembered.** `components/layout/sidebar.tsx` exists.
- **One primary action per screen, top right.** Everything else is secondary or lives in a row menu.
- **Tables are the primary UI.** Sticky header, sticky first column on wide tables, column sort, and a row count that reflects the whole filtered set and not the page.
- **Filters live above the table and persist in the URL.** A filtered view must be shareable by pasting a link. This matters more than it sounds: it is how the owner asks the accountant a question.

## 3. Control elements , what to use when

The primitives that exist: `button`, `input`, `select`, `textarea`, `label`, `card`, `section-card`, `page-header`, `table`, `tabs`, `badge`, `dialog`, `alert-dialog`. **Build with these. Do not add a component library.**

| Situation | Use | Never |
|---|---|---|
| Destructive or irreversible | `alert-dialog`, with the consequence in the body and the verb on the button ("Cancel order", not "Confirm") | a toast with an undo |
| A form that fits | inline on the page | a modal |
| A form that needs context from the page behind it | side sheet | a centred modal |
| Status | `badge`, with a **word**, and colour as reinforcement only | colour alone |
| A number that needs a second number to be understood | stat tile with the comparison **inside** it | two tiles side by side |
| Something loading | skeleton in the shape of the content | a spinner in the middle of the page |
| Something the server refused | inline, next to the thing, in the server's own words | a generic toast |

**Colour carries no information on its own.** Roughly 1 in 12 Indian men is colour-blind and the site engineer is looking at a screen in sunlight. Every state has a word.

## 4. The four states every screen must have

Most screens ship with one. All four are required.

1. **Loading** , skeleton in the shape of the real content.
2. **Empty** , and empty is not an error. Say what this screen is for and give the one button that creates the first record. "No purchase orders yet. Raise one when you order material from a vendor." Never a shrug emoji.
3. **Error** , what failed, and what to do. The server writes careful refusal messages in this product; **surface them verbatim.** Do not replace `"Set the place of supply before confirming this order"` with `"Something went wrong"`.
4. 🔴 **Refused** , and this one is specific to this product and is the most important. Some screens deliberately **refuse to show a number** when two independent computations disagree (`lib/reconciliation/gate.ts`, `lib/accounting/cash-flow.ts`). **Do not design that away.** Do not show the "probably right" figure with an asterisk. Show the refusal, say which two sources disagreed, and give the link to investigate. A correct number under a heading that just failed its own check reads to the person holding it as verification.

## 5. Mobile

**Mobile is not the desktop table at 375px.** Pick the four things a site engineer or an owner does on a phone and build those properly:

1. Approve or reject something in a queue.
2. Record a goods receipt against a purchase order.
3. Look up a customer's outstanding balance.
4. Mark attendance.

Everything else on mobile may be a read-only card list. **Do not attempt data entry of a 12-line invoice on a phone.**

- Touch targets 44px minimum, primary action reachable with a thumb (bottom, not top right).
- **Tables become cards on mobile**, one record per card, three fields and a chevron.
- The product must be usable on one bar of 4G. No 2MB hero images inside the app.

## 6. Performance and behaviour

- **Server components by default.** A component becomes `"use client"` only when it needs state, an effect, or an event handler.
- 🔴 **A file without `"use client"` may not import and call a `use*` hook from a file with it.** This exact mistake, in `app/layout.tsx`, returned a 500 on **every route in the product** while the deploy reported healthy. There is now a gate, `npm run check:client-hooks`, and it will refuse the work.
- **No new dependencies without asking.** The CSV parser here is 120 lines by choice.
- **No `localStorage` for anything that matters.** Notification preferences currently live there and it is on the fix list. Preferences belong to the user row.
- Optimistic UI **only** where the server cannot refuse. Never on a posting, an approval, or anything with money in it.

## 7. Accessibility, and why it is not optional here

Keyboard-first is not a compliance checkbox for this product , **it is what makes the accountant fast**. Tab order that follows the visual order, Enter submits, Escape closes, `/` focuses search, and a visible focus ring that is not `outline: none`. Every icon-only button gets an `aria-label`. Every form error is tied to its input with `aria-describedby`.

---

# PART TWO · ordence.com , the marketing site

**Different repo. Different job. Do not import the app's design system, and do not put marketing chrome in the app.**

## What it has to overcome

An Indian SMB owner evaluating an ERP is asking three questions in this order, and the site answers them in this order:

1. **"Will this understand GST, TDS and my industry, or is it an American product with a rupee sign?"**
2. **"What happens to my data, and can I get it out?"**
3. **"What does it cost, actually?"**

## Structure

- **Hero: one sentence that names the industry and the country.** Not "modern business management". Something like "ERP for Indian contractors and developers , GST, TDS and payroll built in, not bolted on". A real screenshot of a dense screen, not an abstract illustration.
- **Proof above the fold**: GSTR-1 and 3B, e-invoicing, TDS and 26Q, PF/ESI/PT, RA bills and retention. Name the forms. The forms *are* the marketing.
- **One page per vertical**: contracting, real estate, manufacturing, trading, services. Each showing the screens that vertical actually uses.
- **Pricing, with numbers.** "Contact us" reads as expensive and loses the segment. Per workspace, per user, in ₹, with what is included.
- **A security and data page** that says where data lives, that each workspace is isolated at the database level, that exports are available, and what happens on cancellation. This is a real objection and answering it plainly converts.
- **Trust: GSTIN, registered address, a phone number that a person answers.** An Indian buyer checks these.

## Performance and reach

- **Static. Fast on a 4G phone in a tier-2 city.** Lighthouse 95+ on mobile, LCP under 2.5s on throttled 4G.
- **Hindi is worth considering for the marketing site. It is not worth it for the app** , the accountant works in English because the statutes are in English.
- Schema markup, real meta descriptions, an actual sitemap.

## Tone

Plain, specific, unhype. **Every claim must be checkable.** No "AI-powered" unless a named feature uses AI and does something a customer can point at. This segment has been sold to badly for twenty years and is alert to it.

---

# PART THREE · admin.ordence.com , the staff console

Three people use this. It should be **the plainest surface of the three** , dense, fast, no marketing polish. Its job is to answer "what is happening with this customer" in under thirty seconds.

- Everything is one search away.
- Every screen answers a question a support conversation actually starts with.
- **Every destructive action shows who approved it and when.**
- **Never show a customer's business data unless the reason is recorded.** The consent and impersonation machinery exists; the UI must make using it the easy path, not the annoying one.

---

# PART FOUR · Priorities, in order

Do not do these in parallel. In this order.

| # | What | Why first |
|---|---|---|
| **1** | **An audit of the 31-item UX list: which are actually shipped and wired, which are declared and dead.** Report as a table with the file for each. | Several items were reported shipped in Wave 8b. At least one, the UTM capture, took the whole product down. Establish the truth before adding to it. |
| **2** | **The four states on every existing screen** , loading, empty, error, refused. | This is the single biggest perceived-quality gain available, and it needs no new features. |
| **3** | **Money, date and number formatting, one helper, applied everywhere.** `₹12,34,567`, `12 Aug 2026`, FY 2026-27. | It is what makes an Indian user trust the product in the first ten seconds. |
| **4** | **Table quality pass**: sticky headers, URL-persisted filters, real row counts, right-aligned money. | The accountant is the heaviest user and tables are their whole day. |
| **5** | **Mobile: the four flows above, properly.** | The owner and the site engineer never see a desktop. |
| **6** | **Keyboard and accessibility pass.** | Makes the heaviest user twice as fast. |
| **7** | **ordence.com rebuild.** | Separate repo, no dependency on the above. Can run in parallel with a different person. |

---

# PART FIVE · Boundaries. These are not suggestions.

**You are doing UI work. That is a large and valuable job. It does not include:**

1. 🔴 **Any SQL file.** No migrations, no policies, no grants, no verifiers.
2. 🔴 **Anything touching RLS, guards, permissions, or `withTenant` / `withPlatformScope`.**
3. 🔴 **Any money or statutory arithmetic.** Payroll, tax, GST, valuation. You may **display** a number the server computed. You may not compute one.
4. 🔴 **`drizzle-kit push` is banned outright.** It drops row level security on 268 tables and nothing looks broken afterwards.
5. **No new dependencies without asking first.**

**If a UI change seems to need one of those, stop and say so.** That is a useful finding, not a failure , several real defects have been found exactly that way.

## And the standing rule

> **Assert the outcome, never the shape.** Never report a check you did not run in the terminal in that session. If you say the gates are green, paste the output. If you write a verifier, it must try to break the thing, as the role that would break it, and get nothing back.

Three separate times a green report from a self-written check hid a real defect: a payroll change that underpaid employees, a policy that leaked one workspace's data to another, and a build that failed on Railway with every local gate green. Each artifact looked like diligence. None of them tried to break the thing.

## The seventeen gates are the contract

```
tsc --noEmit          check:guards          check:tenant-isolation
check:boundaries      check:sql             check:route-exports
check:migrations      check:sql-executes    check:client-hooks
check:rls-writes      check:posting         test:ui
check:reachability    check:tax-decisions   check:links
```

Nothing merges that turns any of them red. `check:client-hooks` and `check:route-exports` are new and both exist because of build-breaking defects that shipped past every other check.

---

## What to send back with the work

1. The zip.
2. The list of what changed, per file.
3. **Pasted terminal output** of `tsc`, all gates, and `test:ui`.
4. Anything you found and did **not** fix, with the file and line.
5. Screenshots of any screen you changed, in **both** light and dark, at **both** 375px and 1440px.
