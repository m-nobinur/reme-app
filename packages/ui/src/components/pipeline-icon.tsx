import type { ComponentProps } from "react"

/**
 * A sales funnel with the enquiries dropping into it, drawn on phosphor's
 * 24px grid and 1.5 stroke so it sits among the rail's phosphor icons. Phosphor
 * has no funnel that shows leads going in.
 */
function PipelineIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      {...props}
    >
      <circle cx="6.5" cy="3.25" r="1" />
      <circle cx="12" cy="2.25" r="1" />
      <circle cx="17.5" cy="3.25" r="1" />
      <path d="M3 7h18l-6.5 7.5V20l-5 2v-7.5z" />
    </svg>
  )
}

export { PipelineIcon }
