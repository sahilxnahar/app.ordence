"use client";

/**
 * Ordence — Print / Save as PDF
 * Version: v0.97.0-alpha
 *
 * ⚠️ IT DOES NOT PRINT AUTOMATICALLY ON LOAD. Opening a page that
 * immediately throws up a print dialog is hostile: the person cannot
 * check the document before the dialog steals focus, and on a slow
 * connection the dialog can open over a half-rendered invoice. They came
 * to look at it first.
 *
 * ⚠️ THE BUTTON ITSELF IS `print:hidden`, along with everything in the
 * toolbar. A "Print" button printed on the invoice is the tell that
 * nobody ever actually put one of these on paper.
 */

import { Button } from "@/components/ui/button";

export function PrintTrigger({ label = "Print / Save as PDF" }: { label?: string }) {
  return (
    <Button type="button" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
