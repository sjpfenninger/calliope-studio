import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

/**
 * A 20px pill at the micro type step, which is what the nine hand-rolled badges
 * around the app had each independently arrived at. `rounded-full` was the one
 * thing they all overrode: a lozenge does not belong in a near-square console.
 */
export const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-xs border px-1.5 text-2xs font-medium whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-surface-2 text-text-dim",
        destructive: "border-transparent bg-danger-soft text-danger-text",
        outline: "border-border text-text-dim",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
