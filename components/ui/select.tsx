import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Native <select>. Deliberately not the Radix listbox.
 *
 * A native select is keyboard-accessible, screen-reader correct and works on
 * mobile with zero JavaScript. The Radix version looks nicer but adds ~12 kB
 * and a pile of ARIA we would have to get right ourselves.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";
