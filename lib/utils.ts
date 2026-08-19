import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes safely (later classes win on conflict). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
