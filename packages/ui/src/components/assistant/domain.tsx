import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import { ArrowSquareOutIcon, CloudIcon, CopyIcon } from "@phosphor-icons/react"
import {
  BoughtElsewhereOutput,
  type CheckDomainOutput,
  ConnectDomainInput,
  ConnectDomainOutput,
  DEFAULT_LABELS,
  type DnsProviderEntry,
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
import { ReplyPill } from "@workspace/ui/components/assistant/reply-pill"
import { BrandMark } from "@workspace/ui/components/brand-mark"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ConnectRow } from "@workspace/ui/components/connect-row"
import {
  DoneIcon,
  StatusLine,
  ToolStatus,
} from "@workspace/ui/components/status-line"
import { useCopyToClipboard } from "@workspace/ui/hooks/use-copy-to-clipboard"
import { useLater, useReply } from "@workspace/ui/hooks/use-thread-reply"
import { useLiveCards } from "@workspace/ui/lib/live-cards"
import { refusalText } from "@workspace/ui/lib/refusal"
import { decisionView, readView } from "@workspace/ui/lib/tool-state"
import { META } from "@workspace/ui/lib/utils"
import { Fragment, type ReactNode, useState } from "react"

/**
 * Connecting a domain the owner already has. A name the owner typed runs
 * with no card; one already live asks first. What follows is two steps: open
 * where the domain's settings live (our own link to the provider's DNS page
 * when we know it, else where to look), then each record as a small grid
 * with a copy button per value. "I've added it" answers in the owner's
 * voice through the thread, and the assistant watches the domain either way.
 * Once the owner moves on to another domain, the card folds to one line.
 */

type Connecting = Extract<ConnectDomainOutput, { outcome: "connecting" }>

/** The message the added pill sends as the owner. */
export const DONE_WAITING = "I've added it"

/** One value with a button that copies it; the button says what it copies. */
function CopyValue({ value }: { value: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 break-words rounded-md bg-muted px-1.5 py-0.5 text-[0.8125rem]">
        {/* A long name wraps after a dot, never inside a label. */}
        {value.split(/(?<=\.)/).map((part, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
          <Fragment key={at}>
            {at ? <wbr /> : null}
            {part}
          </Fragment>
        ))}
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
 * The owner's own message, once, while this is the last thing in the chat.
 * Drawn as the quick replies above the composer are.
 */
function AddedPill() {
  const reply = useReply()
  const [sent, setSent] = useState(false)
  const last = useAuiState((s) => s.message.isLast && !s.thread.isRunning)
  if (!last) return null
  return (
    <ReplyPill
      className="self-start"
      disabled={sent}
      onClick={() => {
        setSent(true)
        reply(DONE_WAITING)
      }}
    >
      {DONE_WAITING}
    </ReplyPill>
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

/** One field of a record: what the provider's screen calls it, then its value. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card p-3">
      <span className={META}>{label}</span>
      {children}
    </div>
  )
}

/**
 * Proxy status as Cloudflare's own screen draws it, off: a grey switch, a
 * grey cloud and "DNS only". A picture of the setting, not a control.
 */
function ProxyOff() {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className="flex h-4 w-7 shrink-0 items-center rounded-full bg-muted-foreground/30 p-0.5"
      >
        <span className="size-3 rounded-full bg-background" />
      </span>
      <CloudIcon aria-hidden className="size-5 text-muted-foreground" />
      <span>
        DNS only<span className="sr-only">, proxy off</span>
      </span>
    </span>
  )
}

/**
 * Each record as a 2 by 2 grid in the provider's field names, each value
 * with its copy button: Type and Name, then the target and, where the
 * provider has a proxy switch, Proxy status. Without one the target takes
 * the whole row.
 */
function RecordGrid({
  steps,
  entry,
}: {
  steps: DnsRecord[]
  entry: DnsProviderEntry | undefined
}) {
  const labels = entry?.labels ?? DEFAULT_LABELS
  return (
    <div className="flex flex-col gap-2">
      {steps.map((record) => (
        <div
          className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border"
          data-slot="dns-record"
          key={`${record.type}|${record.name}|${record.value}`}
        >
          <Cell label="Type">
            <CopyValue value={record.type} />
          </Cell>
          <Cell label={labels.name}>
            <CopyValue value={record.name} />
          </Cell>
          <div className={entry?.proxy ? "contents" : "col-span-2 grid"}>
            <Cell label={labels.value}>
              <CopyValue value={record.value} />
            </Cell>
          </div>
          {entry?.proxy ? (
            <Cell label="Proxy status">
              <ProxyOff />
            </Cell>
          ) : null}
        </div>
      ))}
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
  return (
    <div className="flex flex-col gap-4" data-slot="domain-records">
      {/* Only behind the orchestrator's DOMAIN_CONNECT flag, off while our template is not live. */}
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
              ? `Open ${provider.name}, sign in if asked`
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
          <RecordGrid entry={entry} steps={steps} />
          {entry?.note ? <p className={META}>{entry.note}</p> : null}
          {output.apex === "forward" ? (
            <p className="text-sm">{forwardText(name)}</p>
          ) : null}
        </Step>
      </ol>
      <p className={META}>
        I'll keep checking and tell you the moment it works.
      </p>
      <AddedPill />
    </div>
  )
}

/** The domain tools whose cards a later message's card takes over from. */
const DOMAIN_CARDS = new Set([
  "connect_domain",
  "domain_bought",
  "find_domain",
  "buy_domain",
])

/**
 * The first domain card, or "address" for the address question, in a later
 * message: the owner changed course, so this one gives way. Null when none.
 */
export function useLaterDomainCard(): string | null {
  return useLater((later) => {
    for (const m of later) {
      for (const p of m.content) {
        if (p.type === "tool-call" && DOMAIN_CARDS.has(p.toolName))
          return p.toolName
        if (
          p.type === "data" &&
          p.name === "build_questions" &&
          (p.data as { kind?: unknown } | undefined)?.kind === "address"
        )
          return "address"
      }
    }
    return null
  })
}

/** An earlier connect once the owner moved on: one quiet line, and Resume to show it again. */
function Paused({ name, onResume }: { name: string; onResume: () => void }) {
  return (
    <p
      className="my-3 text-muted-foreground text-sm"
      data-slot="connect-paused"
    >
      {`Connecting ${name} · paused `}
      <button
        className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onResume}
        type="button"
      >
        Resume
        <span className="sr-only"> connecting {name}</span>
      </button>
    </p>
  )
}

/**
 * Whether this card gives way to a later one, and how to bring it back.
 * Never once the website is live on the domain: that line stays.
 */
function useFold(name: string) {
  const superseded = useLaterDomainCard() !== null
  const live = useLiveCards()?.domainLive(name) ?? false
  const [resumed, setResumed] = useState(false)
  return {
    folded: superseded && !resumed && !live,
    resume: () => setResumed(true),
  }
}

/**
 * A connect under way: the records to add, or that it needs none from the
 * owner. Once the website is live on the domain, only that, so an old card
 * never offers the records again. Once the owner has moved on to another
 * domain, one quiet line, unless the card holding it folds itself (`fold`).
 */
export function ConnectSteps({
  name,
  output,
  fold = true,
}: {
  name: string
  output: Connecting
  fold?: boolean
}) {
  const { folded, resume } = useFold(name)
  if (useLiveCards()?.domainLive(name)) {
    return <Done>{`Your website is live on ${name}.`}</Done>
  }
  if (fold && folded) return <Paused name={name} onResume={resume} />
  return output.steps?.length ? (
    <Records name={name} output={output} steps={output.steps} />
  ) : (
    <p className="text-sm">Connecting. I'll message you when it's live.</p>
  )
}

const NOT_CONNECTED = "The domain could not be connected."

const titleOf = (name: string) => `Connect ${name} to your website`

export const ConnectDomain: ToolCallMessagePartComponent = (props) => {
  const view = decisionView(props, ConnectDomainInput, ConnectDomainOutput)
  const name = ConnectDomainInput.safeParse(props.args).data?.name ?? ""
  const { folded, resume } = useFold(name)
  if (folded && view.state === "done") {
    return <Paused name={name} onResume={resume} />
  }
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
        "Only your website's address changes. Next I'll show you what to change where your domain is managed."
      }
      done={(output) =>
        output?.outcome === "connecting" ? (
          <ConnectSteps fold={false} name={name} output={output} />
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
        // The assistant says so in its reply.
        <ToolStatus
          args={{ domain: name }}
          className="flex px-1 py-1.5 text-sm"
          state="done"
          tool="domain_bought"
        />
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
