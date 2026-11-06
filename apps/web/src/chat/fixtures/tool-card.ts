import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { ownerToolkit } from "@workspace/ui/components/assistant/toolkit"
import { createElement } from "react"

/**
 * One tool call's slot as the thread draws it, for tests that render a card
 * without a runtime: the toolkit's entry for its name, else the fallback.
 */
export const ToolCard: ToolCallMessagePartComponent = (props) =>
  createElement(
    (Object.hasOwn(ownerToolkit, props.toolName)
      ? ownerToolkit[props.toolName]?.render
      : undefined) ?? Approval,
    props
  )
