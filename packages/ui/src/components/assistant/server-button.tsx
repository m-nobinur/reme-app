import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import type { ServerButton } from "@workspace/contracts"
import { Button, buttonVariants } from "@workspace/ui/components/button"

/**
 * The button on a message the assistant posted on its own (`data-button`).
 * `ask` sends its words as the owner's next message, as a suggestion does;
 * `open` opens the https link the contract allows in a new tab.
 */
function ServerButtonPart({ data }: { data: ServerButton }) {
  const aui = useAui()
  const running = useAuiState((s) => s.thread.isRunning)
  const { action, label } = data
  if (action.kind === "open") {
    return (
      <a
        className={buttonVariants({
          variant: "outline",
          size: "sm",
          className: "mt-2",
        })}
        href={action.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {label}
        <ArrowSquareOutIcon aria-hidden />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }
  return (
    <Button
      className="mt-2"
      disabled={running}
      onClick={() => aui.thread().append(action.text)}
      size="sm"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  )
}

export const ServerButtonUI = makeAssistantDataUI<ServerButton>({
  name: "button",
  render: ServerButtonPart,
})
