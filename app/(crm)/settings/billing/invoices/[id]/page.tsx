/**
 * Ordence — Invoice Detail
 * Version: v0.16.0-alpha
 *
 * Renders the same document a customer would print, inside the app.
 *
 * ⚠️ The invoice HTML is generated SERVER-SIDE and injected with
 * `dangerouslySetInnerHTML`. That is safe here and only here, because
 * `renderInvoiceHtml()` escapes every interpolated value at the point of
 * interpolation — the customer's legal name, address and every line
 * description are attacker-controlled and are escaped there, with tests
 * asserting it against script tags and event handlers.
 *
 * If that renderer ever stops escaping, this line becomes a stored XSS
 * against whoever opens the invoice — including our own staff. The
 * escaping tests in `tests/ui/invoicing.test.tsx` are what keep this
 * honest, which is why they assert on hostile input rather than on
 * well-formed names.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getInvoiceHtml } from "@/server/actions/invoicing";

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getInvoiceHtml(id);

  // Same response for "does not exist" and "belongs to another tenant".
  // A distinguishable error would confirm an id exists somewhere.
  if (!result.ok) notFound();

  return (
    <div className="space-y-4">
      <Link
        href="/settings/billing"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to billing
      </Link>

      <p className="text-sm text-muted-foreground">
        Use your browser&rsquo;s print option to save this as a PDF.
      </p>

      <div
        className="overflow-hidden rounded-lg border border-border"
        // See the file header. Every value inside is escaped by the
        // renderer at interpolation time.
        dangerouslySetInnerHTML={{ __html: result.data.html }}
      />
    </div>
  );
}
