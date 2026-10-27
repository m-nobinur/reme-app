import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  HourglassIcon,
} from "@phosphor-icons/react"
import {
  BoughtElsewhereOutput,
  type CheckDomainOutput,
  ConnectDomainInput,
  ConnectDomainOutput,
  type DnsRecord,
  DomainBoughtInput,
  RemoveDomainInput,
  RemoveDomainOutput,
} from "@workspace/contracts"
import {
  Decision,
  Done,
  Problem,
} from "@workspace/ui/components/assistant/decision"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ToolStatus } from "@workspace/ui/components/status-line"
import { useCopyToClipboard } from "@workspace/ui/hooks/use-copy-to-clipboard"
import { refusalText } from "@workspace/ui/lib/refusal"
import { decisionView, readView } from "@workspace/ui/lib/tool-state"
import { META } from "@workspace/ui/lib/utils"
import { useState } from "react"

/**
 * Connecting a domain the owner already has. The yes is the owner's approval;
 * what follows is the list of records to add where their domain is managed,
 * each value with its own copy button, and a link to the provider's DNS
 * settings only when the detected provider carries one of our own links.
 * "Done, I'll wait" answers in the owner's voice through the thread, and the
 * assistant watches the domain either way.
 */

type Connecting = Extract<ConnectDomainOutput, { outcome: "connecting" }>

/** The message the wait button sends as the owner. */
export const DONE_WAITING = "Done, I'll wait."

/** One value with a button that copies it; the button says what it copies. */
function CopyValue({ value }: { value: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 break-all rounded-md bg-muted px-1.5 py-0.5 text-[0.8125rem]">
        {value}
      </code>
      <Button
        aria-label={`Copy ${value}`}
        onClick={() => copyToClipboard(value)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </Button>
      <span className="sr-only" role="status">
        {isCopied ? "Copied" : ""}
      </span>
    </span>
  )
}

/** One change to make: "Set www to CNAME", then the value to copy. */
function Step({ record }: { record: DnsRecord }) {
  return (
    // Not a flex item itself: `display: flex` on an `li` drops its number.
    <li>
      <div className="flex flex-col gap-1">
        <span>
          Set <code className="font-medium">{record.name}</code> to{" "}
          <strong className="font-medium">{record.type}</strong>
        </span>
        <CopyValue value={record.value} />
      </div>
    </li>
  )
}

/** What to do about the bare address, by how the assistant will serve it. */
function apexText(apex: "alias" | "forward", name: string) {
  return apex === "alias"
    ? "For the address without www, add an ALIAS or ANAME record at the root of your domain, pointing to the same place."
    : `For the address without www, forward it to https://www.${name} as permanent.`
}

/** The owner's own message, once, while this is the last thing in the chat. */
function WaitButton() {
  const aui = useAui()
  const [sent, setSent] = useState(false)
  const last = useAuiState((s) => s.message.isLast && !s.thread.isRunning)
  if (!last) return null
  return (
    <div>
      <Button
        disabled={sent}
        onClick={() => {
          setSent(true)
          aui.thread().append(DONE_WAITING)
        }}
        size="sm"
        type="button"
      >
        <HourglassIcon aria-hidden />
        Done, I'll wait
      </Button>
    </div>
  )
}

/** The records to add; only drawn when there is at least one. */
function Records({
  output,
  steps,
  name,
}: {
  output: Connecting
  steps: DnsRecord[]
  name: string
}) {
  const { provider } = output
  // The apex line is a step of its own, so the count matches the list; a
  // subdomain has none.
  const changes = steps.length + (output.apex ? 1 : 0)
  return (
    <div className="flex flex-col gap-3" data-slot="domain-records">
      <p className="text-sm">
        {provider
          ? `Your domain's settings are at ${provider.name}.`
          : "Make these changes where you manage your domain."}{" "}
        {`${changes === 1 ? "There is 1 change" : `There are ${changes} changes`} to make${provider ? " there" : ""}. `}
        {output.email_affected
          ? "These may touch your email, so ask whoever set it up before you change anything."
          : "Your email is not affected."}
      </p>
      {provider?.settings_url ? (
        <div>
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            href={provider.settings_url}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open {provider.name} DNS settings
            <ArrowSquareOutIcon aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      ) : null}
      <ol className="flex list-decimal flex-col gap-3 ps-5 text-sm marker:text-muted-foreground">
        {steps.map((record) => (
          <Step
            key={`${record.type}|${record.name}|${record.value}`}
            record={record}
          />
        ))}
        {output.apex ? <li>{apexText(output.apex, name)}</li> : null}
      </ol>
      <p className={META}>
        I'll watch for the change and message you. There's no need to tell me
        when it's done.
      </p>
      <WaitButton />
    </div>
  )
}

/** A connect under way: the records to add, or that it needs none from the owner. */
export function ConnectSteps({
  name,
  output,
}: {
  name: string
  output: Connecting
}) {
  return output.steps?.length ? (
    <Records name={name} output={output} steps={output.steps} />
  ) : (
    <p className="text-sm">Connecting. I'll message you when it's live.</p>
  )
}

export const ConnectDomain: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Connecting"
    cancelled="Not connected."
    refused="The domain could not be connected."
    detail={() =>
      "Only your website's address changes. Your email is not affected. Next I'll show you what to change where your domain is managed."
    }
    done={(output) =>
      output?.outcome === "connecting" ? (
        <ConnectSteps
          name={ConnectDomainInput.safeParse(props.args).data?.name ?? ""}
          output={output}
        />
      ) : (
        <p className="text-sm">Connecting. I'll message you when it's live.</p>
      )
    }
    no="Cancel"
    props={props}
    slot="connect-domain"
    title={(input) => `Put your website on ${input.name}.`}
    view={decisionView(props, ConnectDomainInput, ConnectDomainOutput)}
    yes="Connect"
  />
)
ConnectDomain.displayName = "ConnectDomain"

/**
 * A domain the owner says they bought elsewhere (`domain_bought`). No yes
 * of its own: the owner's words are the ask. Once the registry shows the
 * name it is the connect card's records; until then, a line saying so.
 */
export const DomainBought: ToolCallMessagePartComponent = (props) => {
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, BoughtElsewhereOutput)
  const name = DomainBoughtInput.safeParse(props.args).data?.name ?? ""
  if (view.state !== "done") {
    return (
      <ToolStatus
        args={{ domain: name }}
        className="flex px-1 py-1.5 text-sm"
        data-slot="domain-bought"
        state={
          view.state === "working" && streaming
            ? "working"
            : view.state === "failed"
              ? "failed"
              : "stopped"
        }
        tool="domain_bought"
      />
    )
  }
  const { output } = view
  return (
    <section
      className="my-3 flex max-w-md flex-col gap-2"
      data-slot="domain-bought"
    >
      {output.outcome === "connecting" ? (
        <>
          <Done>{name} is yours. Next, the settings to change.</Done>
          <ConnectSteps name={name} output={output} />
        </>
      ) : output.outcome === "not_registered_yet" ? (
        <p className="text-muted-foreground text-sm">
          {`I can't see ${output.name} at the registry yet. It can take a few minutes, and I check each day too.`}
        </p>
      ) : (
        <Problem
          text={refusalText(
            output.error.code,
            "I couldn't connect it just now."
          )}
        />
      )}
    </section>
  )
}
DomainBought.displayName = "DomainBought"

/**
 * Taking the website off a connected domain. The yes is the owner's approval;
 * what it does is small and says so: the website goes back to its own address
 * and nothing is deleted where the domain is managed.
 */
export const RemoveDomain: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Removing"
    cancelled="Not removed."
    refused="The domain could not be removed."
    detail={() =>
      "Your website goes back to its own address. Nothing is deleted at your domain's provider."
    }
    done={() => (
      <Done>
        {RemoveDomainInput.safeParse(props.args).data?.name ?? "The domain"} is
        no longer connected. Your website is back on its own address.
      </Done>
    )}
    no="Keep it"
    props={props}
    slot="remove-domain"
    title={(input) => `Take your website off ${input.name}?`}
    view={decisionView(props, RemoveDomainInput, RemoveDomainOutput)}
    yes="Remove"
  />
)
RemoveDomain.displayName = "RemoveDomain"

/** Where a checked domain stands, as one plain sentence. */
export function domainStatusText(
  name: string,
  { status }: Extract<CheckDomainOutput, { outcome: "checked" }>
): string {
  switch (status.status) {
    case "valid":
      return `${name} is live.`
    case "pending_certificate":
      return `${name} points at your website. Its secure certificate is being issued.`
    case "pending_verification":
    case "not_found":
      return `Waiting for the records on ${name} to show up.`
    case "invalid_configuration":
      return `${name} has records, but they don't point at your website yet.`
    case "conflicting_record": {
      const old = status.conflicts
        .map((each) => `${each.type} record on ${each.name} (${each.value})`)
        .join(" and the ")
      return `Delete the old ${old}. It can't sit next to the new one, and I'll pick it up from there.`
    }
    case "unknown_error":
      return `I couldn't check ${name} just now. I'll try again.`
  }
}
