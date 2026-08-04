"use client";

import * as Icons from "lucide-react";
import type { LucideProps } from "lucide-react";

/**
 * Renders a Lucide icon from its kebab-case name, since industry templates store
 * icons as strings rather than component references.
 *
 * Falls back to a neutral square if the name is unknown — a typo in a template
 * must never crash the sidebar.
 */
export function Icon({ name, ...props }: { name: string } & LucideProps) {
  const pascal = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  const registry = Icons as unknown as Record<string, React.ComponentType<LucideProps>>;
  const Component = registry[pascal] ?? registry["Square"];

  if (!Component) return null;
  return <Component aria-hidden="true" {...props} />;
}
