import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Toggle } from "./Toggle.vue"

/**
 * Selected is `accent-soft`, not shadcn's `bg-accent`.
 *
 * That was a bug, not a preference: shadcn's `--accent` resolves to --cg-hover,
 * the *same value* this control uses for hover — so the selected segment of the
 * plot-type toggle was indistinguishable from a merely hovered one. A soft
 * accent wash is what selection means everywhere else in this app.
 */
export const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-sm text-sm font-medium whitespace-nowrap text-text-dim transition-colors hover:bg-hover hover:text-foreground data-[state=on]:bg-accent-soft data-[state=on]:text-accent-text disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-surface hover:bg-hover",
      },
      size: {
        default: "h-7 min-w-7 px-2",
        sm: "h-6 min-w-6 px-1.5",
        lg: "h-8 min-w-8 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ToggleVariants = VariantProps<typeof toggleVariants>
