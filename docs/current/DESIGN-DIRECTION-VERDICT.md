# The design gallery · what it is, and which one to pick

---

## First: credit where it is due

**This is the first delivery that stayed inside the boundaries without being corrected.** Its own document says it plainly:

> *"These are preview interactions only; no business data, authentication, persistence, money calculation, or statutory logic is introduced."*

That is exactly right, and it is the shape of task Manus should keep getting.

**And it does not touch `app.ordence`.** It is a standalone Vite + React + wouter project, 88 files, a gallery of four directions using the same fictional data so the choice rests on design rather than content. Nothing in your product changed.

---

## 🔴 One hard boundary before anything else

**This preview is Vite, wouter and pnpm. Your product is Next.js App Router, 268 tables, seventeen gates and 4,467 tests.**

The preview must stay a preview. **Never let this codebase become the app**, and never let its dependencies migrate into `app.ordence`. Adopting a direction means changing **CSS variable values and component styling** in the real repo , the theme in `tailwind.config.ts` is already fully tokenised as HSL variables, so a direction is a palette file and a density setting, not a rewrite.

If anyone proposes porting the app onto this preview's stack, the answer is no, and the reason is that it would discard every gate, every test, and every boundary that took the last two months to build.

---

## The recommendation: **A · Midnight Command**, with three changes

### Why A

| | |
|---|---|
| **"Permanent rail, compact command bar, dense table rows"** | This is the accountant's product. He came from Tally, Tally is fast, and density is the whole job. B and C both describe themselves as spacious or broad; that is the wrong instinct for the heaviest user. |
| **"Dark control plane versus bright document surfaces"** | ⭐ **This is the single best idea in the gallery.** The chrome is one thing; an invoice, a payslip, a GSTR-3B summary is another. Documents in this product get printed, emailed to a customer, and handed to an auditor. They should look like paper wherever they appear. |
| **"An asymmetric dashboard with a decision stack on the right"** | ⭐ **The second best idea, and it maps onto machinery that already exists.** The owner's actual job is approvals and exceptions: the four-eyes approval queue, credit holds blocking an order, a payroll run with a problem that blocks approval, a reconciliation that refuses to show a figure. Tell Manus to build the decision stack against **those** concepts, not invented ones. |
| **"Surfaces exceptions rather than a wall of charts"** | Correct for this product. Nobody running a ₹40 crore contracting firm needs a donut chart. They need to know which of eleven things is stuck. |

### Change 1 · 🔴 Light is the default. Dark is a preference.

A is described dark-first. Ship it the other way round.

- The site engineer is outdoors. **A dark UI in Indian sunlight is unreadable**, and he is the one who most needs to complete his task in thirty seconds.
- The accountant is in a bright office for eight hours reading dense numeric tables. Light-on-dark for sustained numeric reading is the harder direction.
- **These screens get printed.** Statements, payslips, registers, challans.
- Dark mode already exists in the product from Wave 8b. Keep it as a real, remembered preference , just not the default.

⭐ A's own "bright document surfaces" concept is the seed of this. Extend it: the whole application is bright, and dark is the option.

### Change 2 · Take D's density setting

The gallery has an information-density control: calm / balanced / high-signal. **Pick high-signal and design at that setting**, then let calm be a user preference. It is far easier to loosen a dense design than to tighten a spacious one, and the person who decides whether this product is good is looking at forty rows, not four.

### Change 3 · Violet is an accent, never a primary action on a money screen

Ordence violet as brand, selection bars and focus is good and distinctive. But on a screen where somebody approves a payment, the primary button should read as institutional, not fashionable. Keep exactly three semantic colours and give every one of them a **word** as well:

- one destructive red
- one positive green
- one amber for "needs attention"

Roughly one in twelve Indian men is colour-blind, and the site engineer is looking at a screen in the sun. **Colour reinforces; the word carries the meaning.**

### Why not the others

- **B · Linen Ledger** , genuinely beautiful, and the wrong product. "Quiet", "broad paper-like work areas", "executive briefing" describe a surface for reading, and your heaviest user is entering and reconciling. Keep the idea of documents as paper; that is already change 1.
- **C · Tidework** , "focus pages are spacious". Spacious is the opposite of what the accountant needs, and the blue is the default SaaS palette, so it makes Ordence look like every other B2B tool at exactly the moment you want it to look like it understands GST.
- **D · Signal Room** , the density is right, the palette is a monitoring room. Acid green on carbon reads as an observability tool. This product is shown to auditors, bankers and inspectors; it should look institutional.

---

## The three things to test before committing

The gallery uses clean fictional data, which is where every design looks good. **Ask for these three screenshots before signing off:**

1. **A customer list with real Indian data.** A 40-character transliterated company name, a GSTIN, a PAN, and an amount of `₹12,34,56,789`. Does the table still work, or does everything truncate to uselessness?
2. **A 12-line tax invoice** with HSN codes, three different GST rates, and a CGST/SGST split. This is the densest real screen in the product.
3. **The same customer list at 375px.** Per the brief, tables become cards on mobile , does the direction survive that, or does it only exist at 1440px?

---

## What to reply to Manus

> Direction **A, Midnight Command**, with three changes:
>
> 1. **Ship it light-first. Dark becomes a user preference, not the default.** The site engineer is outdoors in sunlight, the accountant reads dense numeric tables for eight hours in a bright office, and these screens get printed. Your "dark control plane, bright document surfaces" idea is right , extend the bright surface to the whole application and keep dark as the option.
> 2. **Design at the high-signal density setting**, not balanced. Let calm be a preference. It is easier to loosen a dense design than to tighten a spacious one.
> 3. **Violet is brand, selection and focus , not the primary action colour on a money screen.** Three semantic colours only: destructive red, positive green, amber for needs-attention, and every one of them carries a word as well as a colour.
>
> **Keep two ideas exactly as you have them, they are the best things in the gallery:** the decision stack on the right, and documents rendering as bright paper wherever they appear.
>
> ⭐ **Build the decision stack against the machinery that already exists** rather than inventing content for it: the four-eyes approval queue, credit holds that refuse an order confirmation, payroll runs blocked by a stated problem, and reconciliation screens that deliberately refuse to show a figure when two independent computations disagree. That last one is a real behaviour in this product and it must not be designed away , do not show a "probably right" number with an asterisk.
>
> **Before I commit to this, three screenshots at the chosen density:** a customer list with a 40-character transliterated company name, a GSTIN and `₹12,34,56,789`; a 12-line tax invoice with HSN codes and a CGST/SGST split; and that same customer list at 375px as cards.
>
> 🔴 **And the boundary: this preview stays a preview.** It is Vite, wouter and pnpm; the product is Next.js App Router with 268 tables, seventeen gates and 4,467 tests. Adopting a direction means changing CSS variable values and component styling in `app.ordence` , the theme is already tokenised as HSL variables in `tailwind.config.ts`, so a direction is a palette and a density setting, not a rewrite. Do not port the app onto this stack, and do not bring pnpm into the repo.
>
> The scoping on this delivery was right. No business data, no auth, no persistence, no money calculation, no statutory logic. Keep working that way.
