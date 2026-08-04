"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }>(
  ({ className, required, children, ...props }, ref) => (
    <label ref={ref} className={cn("text-sm font-medium leading-none peer-disabled:opacity-70", className)} {...props}>
      {children}
      {required && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
      {required && <span className="sr-only"> (required)</span>}
    </label>
  ),
);
Label.displayName = "Label";
