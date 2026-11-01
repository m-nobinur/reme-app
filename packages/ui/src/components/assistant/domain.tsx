import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react"
import {
  BoughtElsewhereOutput,
  type CheckDomainOutput,
  ConnectDomainInput,
  ConnectDomainOutput,
  DEFAULT_LABELS,
  type DnsRecord,
  DomainBoughtInput,
  dnsProvider,
  RemoveDomainInput,
  RemoveDomainOutput,
} from "@workspace/contracts"
import {
  Decision,
  Done,
  Problem,
} from "@workspace/ui/components/assistant/decision"
import { BrandMark } from "@workspace/ui/components/brand-mark"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ConnectRow } from "@workspace/ui/components/connect-row"
import {
  DoneIcon,
  StatusLine,
  ToolStatus,
} from "@workspace/ui/components/status-line"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { useCopyToClipboard } from "@workspace/ui/hooks/use-copy-to-clipboard"
import { useLiveCards } from "@workspace/ui/lib/live-cards"
import { refusalText } from "@workspace/ui/lib/refusal"
import { decisionView, readView } from "@workspace/ui/lib/tool-state"
import { META } from "@workspace/ui/lib/utils"
import { type ReactNode, useState } from "react"

/**
 * Connecting a domain the owner already has. The yes is the owner's approval;
 * what follows is two steps: sign in where the domain's settings live (our
 * own link to the provider's DNS page when we know it, else where to look),
 * then a record table with a copy button per cell. Copy all hands the whole
 * setting to whoever manages the domain. "OK" answers in the owner's voice
 * through the thread, and the assistant watches the domain either way.
 */

type Connecting = Extract<ConnectDomainOutput, { outcome: "connecting" }>

/** The message the wait button sends as the owner. */
export const DONE_WAITING = "Done, I'll wait."

/** One value with a button that copies it; the button says what it copies. */
function CopyValue({ value }: { value: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 break-words rounded-md bg-muted px-1.5 py-0.5 text-[0.8125rem]">
        {value}
      </code>
      <Button
        aria-label={`Copy ${value}`}
        onClick={() => copyToClipboard(value)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {isCopied ? <DoneIcon /> : <CopyIcon aria-hidden />}
      </Button>
      <span className="sr-only" role="status">
        {isCopied ? "Copied" : ""}
      </span>
    </span>
  )
}

/** What the bare address needs when no record can say it. */
const forwardText = (name: string) =>
  `Then forward ${name} to https://www.${name} as permanent, so the address without www works too.`

/**
 * The whole setting as plain text, for the owner to send to whoever manages
 * the domain: the domain, what the records are for, and each record.
 */
export function copyAllText(name: string, output: Connecting): string {
  return [
    `Website settings for ${name}`,
    `These point ${name} at its new website.${output.email_affected ? " Check them with whoever set up the email first." : " Email is not affected."}`,
    "",
    ...(output.steps ?? []).map(
      (r) => `${r.type} record · Name: ${r.name} · Value: ${r.value}`
    ),
    ...(output.apex === "forward" ? ["", forwardText(name)] : []),
  ].join("\n")
}

function CopyAll({ text }: { text: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  return (
    <Button
      onClick={() => copyToClipboard(text)}
      size="sm"
      type="button"
      variant="outline"
    >
      {isCopied ? <DoneIcon /> : <CopyIcon aria-hidden />}
      {isCopied ? "Copied" : "Copy all"}
    </Button>
  )
}

/** The owner's own message, once, while this is the last thing in the chat. */
function WaitButton() {
  const aui = useAui()
  const [sent, setSent] = useState(false)
  const last = useAuiState((s) => s.message.isLast && !s.thread.isRunning)
  if (!last) return null
  return (
    <Button
      disabled={sent}
      onClick={() => {
        setSent(true)
        aui.thread().append(DONE_WAITING)
      }}
      size="sm"
      type="button"
    >
      OK
    </Button>
  )
}

/** A numbered step: its number, its title, then what to do. */
function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: ReactNode
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-full bg-muted font-medium text-xs"
      >
        {n}
      </span>
      <h3 className="self-center font-medium text-sm">{title}</h3>
      <div className="col-start-2 flex flex-col gap-2">{children}</div>
    </li>
  )
}

/**
 * Where to look when we have no link: the provider's name or its
 * nameservers' domain as a hint, both text only since a domain's own DNS
 * names them, else where settings usually live.
 */
function SettingsHint({ name, host }: { name?: string; host?: string }) {
  const line = name
    ? "Look for DNS or Manage DNS once you're signed in."
    : host
      ? `Its nameservers point to ${host}, so start there. Look for DNS or Manage DNS.`
      : "Usually where you bought it, or with whoever set up your old website. Look for DNS or Manage DNS."
  return (
    <div
      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-2 pe-4 text-card-foreground"
      data-slot="settings-hint"
    >
      <BrandMark />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm">
          Where your domain's settings live
        </span>
        <span className="text-muted-foreground text-sm">{line}</span>
      </span>
    </div>
  )
}

/**
 * The records as the provider's screen names their fields, each cell
 * copyable. In a narrow card each record stacks its fields, each led by its
 * label, in the same table, so nothing scrolls sideways on a phone.
 */
function RecordTable({
  steps,
  labels,
}: {
  steps: DnsRecord[]
  labels: { name: string; value: string }
}) {
  const heads = ["Type", labels.name, labels.value]
  return (
    <div className="@container">
      <Table className="@max-lg:block rounded-xl border border-border">
        <TableHeader className="@max-lg:sr-only">
          <TableRow>
            {heads.map((head) => (
              <TableHead className="h-9" key={head}>
                {head}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className="@max-lg:block">
          {steps.map((record) => (
            <TableRow
              className="@max-lg:block @max-lg:py-1.5"
              key={`${record.type}|${record.name}|${record.value}`}
            >
              {[record.type, record.name, record.value].map((value, i) => (
                <TableCell
                  className="@max-lg:flex @max-lg:items-center @max-lg:gap-3 @max-lg:whitespace-normal @max-lg:py-1"
                  key={heads[i]}
                >
                  <span
                    aria-hidden
                    className="@lg:hidden w-16 shrink-0 text-muted-foreground text-xs"
                  >
                    {heads[i]}
                  </span>
                  <CopyValue value={value} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** The two steps; only drawn when there is at least one record. */
function Records({
  output,
  steps,
  name,
}: {
  output: Connecting
  steps: DnsRecord[]
  name: string
}) {
  const { provider, apply_url: applyUrl } = output
  const entry = dnsProvider(provider?.id)
  const email = output.email_affected
    ? "This may touch your email, so ask whoever set it up before you change anything."
    : "Your email is not affected."
  return (
    <div className="flex flex-col gap-4" data-slot="domain-records">
      {applyUrl ? (
        <div className="flex flex-col items-start gap-1.5">
          <a
            className={buttonVariants({ size: "sm" })}
            href={applyUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Add it for me
            <ArrowSquareOutIcon aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className={META}>
            {`${provider?.name ?? "Your DNS provider"} asks you to sign in and approve it, then brings you back here. Or add it yourself:`}
          </p>
        </div>
      ) : null}
      <ol className="flex flex-col gap-4">
        <Step
          n={1}
          title={
            provider
              ? `Sign in to ${provider.name}`
              : "Open your domain's settings"
          }
        >
          {provider?.settings_url ? (
            <ConnectRow
              href={provider.settings_url}
              line="Open your DNS settings"
              mark={entry?.mark}
              name={provider.name}
              newTab
            />
          ) : (
            <SettingsHint host={output.nameserver_host} name={provider?.name} />
          )}
        </Step>
        <Step
          n={2}
          title={steps.length === 1 ? "Add this record" : "Add these records"}
        >
          <RecordTable labels={entry?.labels ?? DEFAULT_LABELS} steps={steps} />
          {entry?.note ? <p className={META}>{entry.note}</p> : null}
          {output.apex === "forward" ? (
            <p className="text-sm">{forwardText(name)}</p>
          ) : null}
        </Step>
      </ol>
      <p className={META}>
        {`${email} That's all. I'll keep an eye on it and tell you the moment it's working.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <CopyAll text={copyAllText(name, output)} />
        <WaitButton />
      </div>
    </div>
  )
}

/**
 * A connect under way: the records to add, or that it needs none from the
 * owner. Once the website is live on the domain, only that, so an old card
 * never offers the records again.
 */
export function ConnectSteps({
  name,
  output,
}: {
  name: string
  output: Connecting
}) {
  if (useLiveCards()?.domainLive(name)) {
    return <Done>{`Your website is live on ${name}.`}</Done>
  }
  return output.steps?.length ? (
    <Records name={name} output={output} steps={output.steps} />
  ) : (
    <p className="text-sm">Connecting. I'll message you when it's live.</p>
  )
}

const NOT_CONNECTED = "The domain could not be connected."

const titleOf = (name: string) => `Use ${name} for your website`

export const ConnectDomain: ToolCallMessagePartComponent = (props) => {
  const view = decisionView(props, ConnectDomainInput, ConnectDomainOutput)
  if (view.state === "refused") {
    // Refused before the owner was asked: the assistant says why in its own words.
    if (props.approval?.approved !== true) return null
    return (
      <StatusLine
        className="flex px-1 py-1.5 text-sm"
        data-slot="connect-domain"
        label={`${titleOf(view.input.name)}. ${refusalText(view.code, NOT_CONNECTED)}`}
        state="failed"
      />
    )
  }
  return (
    <Decision
      always="beside"
      busy="Connecting"
      cancelled="Not connected."
      refused={NOT_CONNECTED}
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
          <p className="text-sm">
            Connecting. I'll message you when it's live.
          </p>
        )
      }
      no="Cancel"
      props={props}
      slot="connect-domain"
      title={(input) => titleOf(input.name)}
      view={view}
      yes="Connect"
    />
  )
}
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
          <Done>{name} is yours.</Done>
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
    done={() => <Done>Done. Your website is back on its own address.</Done>}
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
