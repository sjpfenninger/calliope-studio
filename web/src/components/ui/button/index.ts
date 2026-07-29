import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

/**
 * Retuned to this app's density contract: 20/24/28/32px, not shadcn's 36/40.
 *
 * The stock scale is why this primitive went unused and the app hand-rolled
 * three separate button definitions instead. Sizes read as micro/compact/
 * default/large — 24px inside a form row or table cell, 28px in a toolbar or
 * standing alone, 20px for an inline affordance that must not disturb a 24px row.
 *
 * Hover is an opaque token rather than `bg-primary/90`: Tailwind's opacity
 * modifier compiles to a color-mix(), which tokens.css forbids for good reason.
 * `destructive` said `text-white` — a literal colour outside tokens.css, and
 * wrong in dark, where --cg-danger-on is near-black.
 *
 * Neither `default` nor `destructive` is a solid fill any more; the saturated
 * end of each ramp belongs to state indicators.
 *
 * **The heights come from `formClasses`, not from a second copy of the scale.**
 * The retuning above was done here and the app-layer call sites were never
 * migrated to it, so the two systems described the same four buttons twice and
 * then drifted: `size: "default"` is `h-7 px-2.5`, while the dialogs that could
 * not reach this primitive wrote `h-7 px-3` by hand — including the three whose
 * footers sit beside `DialogFooter`'s own built-in `<Button variant="outline">`.
 * Composing from the shared strings is what makes that impossible rather than
 * merely fixed.
 */
import { CONTROL_HEIGHT } from "@/lib/formClasses"
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Tinted, not solid: see lib/formClasses.ts PRIMARY_BUTTON. Saturated
        // accent is reserved for state in this app, not for actions.
        default:
          "border border-accent-border bg-accent-soft text-accent-text hover:bg-accent-soft-2",
        destructive:
          "border border-danger-soft bg-danger-soft text-danger-text hover:border-destructive hover:bg-destructive hover:text-destructive-foreground",
        outline: "border border-input bg-surface hover:bg-hover hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "text-text-dim hover:bg-hover hover:text-foreground",
        link: "text-accent-text underline-offset-2 hover:underline",
      },
      size: {
        // `default` is the 28px tier, and its `px-2.5` is the same padding
        // PRIMARY_BUTTON_MD carries — the number the hand-rolled dialog buttons
        // disagreed with.
        "default": `${CONTROL_HEIGHT.md} px-2.5 has-[>svg]:px-2`,
        "xs": `${CONTROL_HEIGHT.xs} gap-1 rounded-xs px-1.5 text-2xs has-[>svg]:px-1 [&_svg:not([class*='size-'])]:size-3`,
        "sm": `${CONTROL_HEIGHT.sm} gap-1 px-2 has-[>svg]:px-1.5`,
        "lg": `${CONTROL_HEIGHT.lg} px-3 has-[>svg]:px-2.5`,
        "icon": "size-7",
        "icon-xs": "size-5 rounded-xs [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
