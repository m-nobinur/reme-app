import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import { ConnectGoogleOutput } from "@workspace/contracts"
import { Problem } from "@workspace/ui/components/assistant/decision"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ToolStatus } from "@workspace/ui/components/status-line"
import { CARD_SURFACE } from "@workspace/ui/lib/card"
import { refusalText } from "@workspace/ui/lib/refusal"
import { NOT_DONE, readView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"

/** Where the connect flow starts, which a connected account uses to switch. */
const START = "/api/google/start"

/**
 * Connecting Google so the owner's Search Console can be read. There is no
 * yes to give here: the owner's tap on Google's screen is the consent, so the
 * card is a plain link in the same tab, never an approval.
 */
export const ConnectGoogle: ToolCallMessagePartComponent = (props) => {
  const aui = useAui()
  const running = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, ConnectGoogleOutput)
  if (view.state !== "done") {
    const working = view.state === "working" && running
    return (
      <ToolStatus
        className="flex px-1 py-1.5 text-sm"
        data-slot="connect-google"
        state={
          working ? "working" : view.state === "failed" ? "failed" : "stopped"
        }
        tool="connect_google"
      />
    )
  }
  const { output } = view
  return (
    <section
      aria-label="Connect Google"
      className={cn(CARD_SURFACE, "my-3 flex max-w-md flex-col gap-3")}
      data-slot="connect-google"
    >
      {"url" in output ? (
        <>
          <p className="text-sm">
            Google will ask you to let me see how your website shows up in
            search and to add it to Search Console.
          </p>
          <div className="flex gap-2">
            <a className={buttonVariants({ size: "sm" })} href={output.url}>
              Connect Google
            </a>
            {/* Sent as the owner's words, so Ellie puts the offer off. */}
            <Button
              disabled={running}
              onClick={() => aui.thread().append("Not now")}
              size="sm"
              type="button"
              variant="outline"
            >
              Not now
            </Button>
          </div>
        </>
      ) : "connected" in output ? (
        <>
          <p className="flex items-center gap-2 text-sm">
            <CheckCircleIcon
              aria-hidden
              className="size-4 shrink-0 text-primary"
            />
            Connected as {output.email}
          </p>
          <div>
            <a
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={START}
            >
              Use another Google account
            </a>
          </div>
        </>
      ) : "available" in output ? (
        <p className="text-sm">Connecting Google isn't available yet.</p>
      ) : (
        <Problem text={refusalText(output.error.code, NOT_DONE)} />
      )}
    </section>
  )
}
ConnectGoogle.displayName = "ConnectGoogle"
