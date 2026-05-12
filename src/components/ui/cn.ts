import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** className merge — clsx for conditionals, twMerge for collisions. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
