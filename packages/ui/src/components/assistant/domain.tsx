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
  type CheckDomainOutput,
  ConnectDomainInput,
  ConnectDomainOutput,
  type DnsRecord,
} from "@workspace/contracts"
import { Decision } from "@workspace/ui/components/assistant/decision"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { useCopyToClipboard } from "@workspace/ui/hooks/use-copy-to-clipboard"
import { decisionView } from "@workspace/ui/lib/tool-state"
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
    <li className="flex flex-col gap-1">
      <span>
        Set <code className="font-medium">{record.name}</code> to{" "}
        <strong className="font-medium">{record.type}</strong>
      </span>
      <CopyValue value={record.value} />
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

function Records({ output, name }: { output: Connecting; name: string }) {
  const { provider, steps } = output
  // The apex line is a step of its own, so the count matches the list; a
  // subdomain has none.
  const changes = steps?.length ? steps.length + (output.apex ? 1 : 0) : 0
  return (
    <div className="flex flex-col gap-3" data-slot="domain-records">
      <p className="text-sm">
        {provider
          ? `Your domain's settings are at ${provider.name}.`
          : "Make these changes where you manage your domain."}{" "}
        {changes
          ? `${changes === 1 ? "There is 1 change" : `There are ${changes} changes`} to make${provider ? " there" : ""}. `
          : ""}
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
      {steps?.length ? (
        <ol className="flex list-decimal flex-col gap-3 ps-5 text-sm marker:text-muted-foreground">
          {steps.map((record) => (
            <Step
              key={`${record.type}|${record.name}|${record.value}`}
              record={record}
            />
          ))}
          {output.apex ? <li>{apexText(output.apex, name)}</li> : null}
        </ol>
      ) : null}
      <p className={META}>
        I'll watch for the change and message you. There's no need to tell me
        when it's done.
      </p>
      <WaitButton />
    </div>
  )
}

export const ConnectDomain: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Connecting"
    cancelled="Not connected. You sent a message instead."
    refused="The domain could not be connected."
    detail={() =>
      "Only your website's address changes. I'll show you what to change where your domain is managed."
    }
    done={(output) =>
      output?.outcome === "connecting" ? (
        <Records
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
