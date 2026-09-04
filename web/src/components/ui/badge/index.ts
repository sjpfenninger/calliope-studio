import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

/**
 * A 20px pill at the micro type step, which is what the nine hand-rolled badges
 * around the app had each independently arrived at. `rounded-full` was the one
 * thing they all overrode: a lozenge does not belong in a near-square console.
 */
export const badgeVariants = cva(
  // `px-1` rather than shadcn's `px-1.5`: every call site in the app overrode it,
  // which is the primitive being wrong. `outline` takes the subtle hairline for
  // the same reason — `WARNING_BADGE` and the model tree's badges all reached
  // past `border-border`, so the neutral badge was louder than the warning one.
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-xs border px-1 text-2xs font-medium whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-surface-2 text-text-dim",
        destructive: "border-transparent bg-danger-soft text-danger-text",
        outline: "border-border-subtle text-text-dim",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
