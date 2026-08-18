/**
 * Ordence — The print surface
 * Version: v0.97.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ITS OWN ROUTE GROUP, SO THE APP CHROME IS NOT ON THE PAPER
 * ══════════════════════════════════════════════════════════════════════
 * `(crm)/layout.tsx` renders the sidebar, the tenant switcher and the
 * notification bell. All three would print. Hiding them with
 * `@media print { display: none }` would work until somebody adds a
 * fourth thing and forgets — and the failure is discovered by a customer
 * receiving an invoice with a navigation menu on it.
 *
 * A separate route group means there is nothing to hide.
 *
 * ⚠️ IT IS STILL BEHIND AUTHENTICATION. `(print)` changes the layout, not
 * the URL and not the middleware — `/invoices/[id]/print` is not in the
 * public matcher, so an unauthenticated request is bounced to sign-in.
 * A printable invoice is a document full of a customer's prices.
 */

export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="document-surface print-surface bg-neutral-100 py-8 print:bg-white print:py-0">
      {/*
        ⭐ Batch 142 — `document-surface` PINS THE LIGHT TOKENS FOR THIS
        WHOLE SUBTREE, even when the rest of the application is in dark
        mode. The sheet below already hard-codes `bg-white text-black`,
        so the visible paper was never at risk; what WAS at risk is
        everything token-driven around and inside it — the surrounding
        tray, any badge, table border or muted caption a later batch drops
        onto the document. Those read `--border`, `--muted-foreground` and
        friends, and under `.dark` they would resolve to near-black lines
        on white paper. The class is the one place that is fixed for all
        of them. See the block in `app/globals.css`.
      */}
      {/**
       * ⚠️ `@page` CANNOT BE SET FROM A TAILWIND CLASS. Page size and
       * margin belong to the print stylesheet and nowhere else, so this
       * block is the one place raw CSS is justified here.
       *
       * ⚠️ THE MARGIN IS 12mm, NOT ZERO. Every consumer printer has an
       * unprintable edge of roughly 5mm; a zero margin means the last
       * column of the tax table is silently clipped on paper while
       * looking perfect on screen.
       */}
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          html, body { background: #fff !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; }
          /* A table row split across a page break is unreadable. */
          tr, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
          thead { display: table-header-group; }
          tfoot { display: table-footer-group; }
        }
      `}</style>
      {children}
    </div>
  );
}
