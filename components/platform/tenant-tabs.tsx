"use client";

/**
 * Ordence — Tenant 360 tab strip, with the tab in the URL
 * Version: v1.52.0-alpha (Batch 125)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE TAB IS URL STATE AND NOT `useState`
 * ══════════════════════════════════════════════════════════════════════
 * The sentence this screen exists to support is "look at Acme's billing"
 * — said in Slack, at 3am, by somebody who then pastes a link. With the
 * tab in component state the link lands on Overview and the reader has
 * to be told which tab, every time. With it in the query string the link
 * IS the instruction, it survives a refresh, and a bug report can name
 * the exact view somebody was looking at.
 *
 * ⚠️ `usePathname()` RATHER THAN A `/platform/...` LITERAL. This console
 * is served at two base paths — `/platform/tenants/:id` on app. and
 * `/tenants/:id` on admin. — and the pathname hook already returns
 * whichever one this request arrived on. Building the URL from a literal
 * would write a link that is a 404 on exactly one of the two hosts, which
 * is the failure `scripts/check-console-links.mjs` exists to catch.
 *
 * ⚠️ `replace`, NOT `push`. Eight tabs on one screen would otherwise put
 * eight entries in the history, and Back — which an operator presses to
 * leave the workspace — would instead walk them backwards through tabs
 * they have already read.
 *
 * ⚠️ AN UNKNOWN `?tab=` FALLS BACK TO THE FIRST TAB rather than rendering
 * an empty page. Tab names get renamed; links in old tickets do not.
 */

import type { ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export type TenantTabDef = {
  readonly value: string;
  readonly label: string;
};

export function TenantTabs({
  tabs,
  panels,
  paramKey = "tab",
}: {
  readonly tabs: readonly TenantTabDef[];
  /**
   * Server-rendered panel per tab value. These are RSC elements handed
   * across the boundary as children — each one may carry its own
   * `<Suspense>`, which is how one slow panel stops holding the rest.
   */
  readonly panels: Readonly<Record<string, ReactNode>>;
  readonly paramKey?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const requested = params.get(paramKey);
  /*
   * ⚠️ `tabs[0]` IS OPTIONAL TO THE TYPE CHECKER (`noUncheckedIndexedAccess`)
   * and the fallback is not dead code dressing: a caller that renders this
   * with an empty list should get an empty strip, not a crash on a
   * support screen.
   */
  const first = tabs[0]?.value ?? "";
  const active = tabs.some((t) => t.value === requested) ? (requested as string) : first;

  function select(next: string) {
    const query = new URLSearchParams(params.toString());
    query.set(paramKey, next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  return (
    <Tabs value={active} onValueChange={select}>
      <TabsList className="h-auto flex-wrap justify-start">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value}>
          {panels[t.value] ?? null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
