import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { ConnectGoogleOutput } from "@workspace/contracts"
import { Problem } from "@workspace/ui/components/assistant/decision"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ConnectRow } from "@workspace/ui/components/connect-row"
import { DoneIcon, ToolStatus } from "@workspace/ui/components/status-line"
import { CARD_SURFACE } from "@workspace/ui/lib/card"
import { useLiveCards } from "@workspace/ui/lib/live-cards"
import { refusalText } from "@workspace/ui/lib/refusal"
import { NOT_DONE, readView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"

/** Where the connect flow starts, which a connected account uses to switch. */
const START = "/api/google/start"

/** Signed in to Google now, by the live workspace; false when unknown. */
const useConnected = () => useLiveCards()?.googleConnected === true

/** What a connect offer becomes once the owner has signed in. */
function Connected({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 text-sm", className)}>
      <DoneIcon />
      Connected to Google
    </p>
  )
}

/**
 * The row that starts Google's sign-in, in the same tab so the start route
 * reads the chat to come back to from the referrer. Once signed in it says
 * so, so an offer posted earlier cannot start a second sign-in.
 */
export function ConnectGoogleRow({
  href = START,
  className,
}: {
  href?: string
  className?: string
}) {
  if (useConnected()) return <Connected className={className} />
  return (
    <ConnectRow
      className={className}
      href={href}
      line="Show up when people near you search"
      name="Google Search Console"
    />
  )
}

/**
 * Connecting Google so the owner's Search Console can be read. There is no
 * yes to give here: the owner's tap on Google's screen is the consent, so the
 * card is a plain link in the same tab, never an approval.
 */
export const ConnectGoogle: ToolCallMessagePartComponent = (props) => {
  const aui = useAui()
  const running = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, ConnectGoogleOutput)
  const connected = useConnected()
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
  // Before a domain is live the assistant says why in its own words.
  if ("outcome" in output && output.error.code === "search.needs_domain") {
    return null
  }
  return (
    <section
      aria-label="Connect Google"
      className={cn(CARD_SURFACE, "my-3 flex max-w-md flex-col gap-3")}
      data-slot="connect-google"
    >
      {"url" in output && connected ? (
        <Connected />
      ) : "url" in output ? (
        <>
          <p className="text-sm">
            Google will ask you to let me see how your website shows up in
            search and to add it to Search Console.
          </p>
          <ConnectGoogleRow href={output.url} />
          <div>
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
            <DoneIcon />
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
