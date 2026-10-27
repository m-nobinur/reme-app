import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import type { ServerButton } from "@workspace/contracts"
import { BuyTray } from "@workspace/ui/components/assistant/buy-domain"
import { ConnectGoogleRow } from "@workspace/ui/components/assistant/google"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { useState } from "react"

/**
 * The button on a message the assistant posted on its own (`data-button`).
 * `ask` sends its words as the owner's next message, as a suggestion does;
 * `open` opens the https link the contract allows in a new tab; `pay` opens
 * Your details for buying its name in the tray, with a fresh Checkout;
 * `connect` is the service's row, which starts its sign-in.
 */
function ServerButtonPart({ data }: { data: ServerButton }) {
  const aui = useAui()
  const running = useAuiState((s) => s.thread.isRunning)
  const messageId = useAuiState((s) => s.message.id)
  const [paying, setPaying] = useState(false)
  const { action, label } = data
  if (action.kind === "pay") {
    return paying ? (
      <BuyTray draftId={`pay:${messageId}`} name={action.name} />
    ) : (
      <Button
        className="mt-2"
        disabled={running}
        onClick={() => setPaying(true)}
        size="sm"
        type="button"
      >
        {label}
      </Button>
    )
  }
  if (action.kind === "connect") {
    return <ConnectGoogleRow className="mt-2 max-w-md" />
  }
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
