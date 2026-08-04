"use client";

/**
 * Ordence — A Record Type's Icon
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS EXISTS INSTEAD OF `components/layout/icon.tsx`
 * ══════════════════════════════════════════════════════════════════════
 * That component resolves a kebab-case name against `import * as Icons
 * from "lucide-react"`. A namespace import is not tree-shakeable: every
 * icon in the library ends up in the bundle of any route that reaches it.
 * On the sidebar that cost is paid once, in a layout that every screen
 * already loads. Paying it a second time on these pages added roughly
 * 190 kB to the first load of `/objects` — measured, not guessed — for
 * one 16-pixel square.
 *
 * So the names this designer OFFERS are imported by name, which webpack
 * can shake, and anything else falls back to a plain box.
 *
 * ⚠️ THE FALLBACK IS THE SAME CONTRACT AS THE SIDEBAR'S: a name this map
 * does not know renders as a square rather than crashing the page. A
 * customer who types a valid Lucide name that is not on the list gets a
 * box here and the real icon in the navigation, which is a cosmetic
 * disagreement rather than a broken screen — and it is why the field is
 * described as a suggestion list rather than as a closed vocabulary.
 */

import {
  Box,
  Building2,
  Calendar,
  ClipboardList,
  FileText,
  Hammer,
  Handshake,
  KeyRound,
  MapPin,
  Package,
  Ruler,
  Shapes,
  Truck,
  UserRound,
  Wrench,
  type LucideProps,
} from "lucide-react";

/** The names offered in the designer. Anything else renders as a box. */
export const OBJECT_ICON_NAMES = [
  "box",
  "building-2",
  "calendar",
  "clipboard-list",
  "file-text",
  "hammer",
  "handshake",
  "key-round",
  "map-pin",
  "package",
  "ruler",
  "shapes",
  "truck",
  "user-round",
  "wrench",
] as const;

const REGISTRY: Record<string, React.ComponentType<LucideProps>> = {
  box: Box,
  "building-2": Building2,
  calendar: Calendar,
  "clipboard-list": ClipboardList,
  "file-text": FileText,
  hammer: Hammer,
  handshake: Handshake,
  "key-round": KeyRound,
  "map-pin": MapPin,
  package: Package,
  ruler: Ruler,
  shapes: Shapes,
  truck: Truck,
  "user-round": UserRound,
  wrench: Wrench,
};

export function ObjectIcon({ name, ...props }: { name: string } & LucideProps) {
  const Component = REGISTRY[name] ?? Box;
  return <Component aria-hidden="true" {...props} />;
}
