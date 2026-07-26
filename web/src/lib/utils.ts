import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class lists, letting a later utility win over an earlier one.
 *
 * `clsx` flattens conditionals; `tailwind-merge` then resolves conflicts within
 * a group, so `cn("p-2", "p-4")` is `p-4` rather than both. Every shadcn-vue
 * component expects this to exist at this path — see `components.json`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
