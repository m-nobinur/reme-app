// @vitest-environment happy-dom
import type { CheckDomainOutput } from "@workspace/contracts"
import {
  DONE_WAITING,
  domainStatusText,
} from "@workspace/ui/components/assistant/domain"
import { ChatServicesProvider } from "@workspace/ui/lib/chat-services"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { ToolCard } from "./fixtures/tool-card"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The cards read the thread through assistant-ui's store; these tests stand in
// for it, since what they check is the card, not the runtime.
const store = vi.hoisted(() => ({
  isLast: true,
  isRunning: false,
  append: vi.fn(),
  messages: [] as unknown[],
}))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: {
        id: "msg-1",
        parts: [],
        isLast: store.isLast,
        status: undefined,
      },
      thread: { isRunning: store.isRunning, messages: store.messages },
    }),
  useAui: () => ({ thread: () => ({ append: store.append }) }),
  useThreadViewport: () => undefined,
}))

const NAME = "sparkleclean.co.uk"
const RECORDS = {
  outcome: "connecting",
  method: "records",
  email_affected: false,
  apex: "forward",
  steps: [
    { type: "CNAME", name: "www", value: "domains.remeai.co.uk" },
    { type: "TXT", name: "_acme-challenge.www", value: "abc123" },
  ],
} as const
const GODADDY = {
  id: "godaddy",
  name: "GoDaddy",
  settings_url: "https://dcc.godaddy.com/manage/dns",
}

type Props = Record<string, unknown>

/**
 * Draws the owner's Approval slot for a connect_domain call, under the
 * workspace's live domains when they are given.
 */
async function draw(props: Props, live?: readonly string[]) {
  const container = document.createElement("div")
  const root = createRoot(container)
  const respondToApproval = vi.fn()
  const card = createElement(ToolCard, {
    toolName: "connect_domain",
    toolCallId: "call-1",
    args: { name: NAME },
    argsText: "",
    respondToApproval,
    ...props,
  } as never)
  await act(async () =>
    root.render(
      live
        ? createElement(
            ChatServicesProvider,
            {
              value: {
                liveCards: {
                  googleConnected: null,
                  domainLive: (name) => live.includes(name),
                  published: null,
                },
              },
            },
            card
          )
        : card
    )
  )
  return {
    container,
    respondToApproval,
    unmount: () => act(async () => root.unmount()),
  }
}

const done = (output: unknown) => ({
  result: output,
  approval: { approved: true },
})
const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((b) => b.textContent?.trim())

/** The tray's labelled buttons, its no before its yes; Collapse has only an icon. */
const choices = (container: HTMLElement) =>
  buttons(container).filter((label) => label !== "")

/** Presses the card's yes, then its no, and checks what each told the thread. */
async function answer(card: Awaited<ReturnType<typeof draw>>) {
  const [no, yes] = [...card.container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim()
  )
  await act(async () => yes?.click())
  expect(card.respondToApproval).toHaveBeenLastCalledWith({ approved: true })
  await act(async () => no?.click())
  expect(card.respondToApproval).toHaveBeenLastCalledWith({ approved: false })
}

afterEach(() => {
  store.isLast = true
  store.isRunning = false
  store.messages = []
  store.append.mockReset()
})

it("asks for the owner's yes through the existing approval flow", async () => {
  const card = await draw({ approval: { approved: undefined } })
  expect(card.container.querySelector("h2")?.textContent).toBe(
    `Connect ${NAME} to your website`
  )
  expect(card.container.textContent).not.toContain("email")
  expect(choices(card.container)).toEqual(["Cancel", "Connect"])
  await answer(card)
  await card.unmount()
})

/** The step titles, then each record's cells as label and value. */
const steps = (container: HTMLElement) =>
  [...container.querySelectorAll("ol > li h3")].map((h) => h.textContent)
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="dns-record"]')].map((record) =>
    [...record.querySelectorAll("div > span:first-child + span")].flatMap(
      (value) => [value.previousElementSibling?.textContent, value.textContent]
    )
  )

it("opens a known provider, then shows each record as a grid with a copy button per value", async () => {
  const card = await draw(done({ ...RECORDS, provider: GODADDY }))
  const text = card.container.textContent ?? ""
  expect(steps(card.container)).toEqual([
    "Open GoDaddy, sign in if asked",
    "Add these records",
  ])
  // No proxy switch at GoDaddy, so no Proxy status cell.
  expect(rows(card.container)).toEqual([
    ["Type", "CNAME", "Name", "www", "Value", "domains.remeai.co.uk"],
    ["Type", "TXT", "Name", "_acme-challenge.www", "Value", "abc123"],
  ])
  expect(text).toContain(`Then forward ${NAME} to https://www.${NAME}`)
  expect(text).toContain("I'll keep checking and tell you the moment it works.")
  expect(text).not.toContain("email")
  const link = card.container.querySelector("a")
  expect(link?.getAttribute("href")).toBe(GODADDY.settings_url)
  expect(link?.getAttribute("target")).toBe("_blank")
  expect(link?.getAttribute("rel")).toContain("noopener")
  expect(link?.textContent).toBe(
    "GoDaddyOpen your DNS settings (opens in a new tab)"
  )
  expect(link?.querySelector('[data-slot="brand-mark"] img')).not.toBeNull()
  expect(
    [...card.container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")
    )
  ).toEqual([
    "Copy CNAME",
    "Copy www",
    "Copy domains.remeai.co.uk",
    "Copy TXT",
    "Copy _acme-challenge.www",
    "Copy abc123",
  ])
  expect(buttons(card.container)).not.toContain("Copy all")
  await card.unmount()
})

it("uses Cloudflare's own field names and draws its proxy switch off, DNS only", async () => {
  const card = await draw(
    done({
      ...RECORDS,
      apex: "alias",
      provider: {
        id: "cloudflare",
        name: "Cloudflare",
        settings_url:
          "https://dash.cloudflare.com/?to=/:account/sparkleclean.co.uk/dns/records",
      },
      steps: [
        { type: "CNAME", name: "www", value: "domains.remeai.co.uk" },
        { type: "ALIAS", name: "@", value: "domains.remeai.co.uk" },
      ],
    })
  )
  expect(rows(card.container)[0]).toEqual([
    "Type",
    "CNAME",
    "Name",
    "www",
    "Target",
    "domains.remeai.co.uk",
    "Proxy status",
    "DNS only, proxy off",
  ])
  expect(card.container.textContent).not.toContain("Set Proxy status")
  // The bare address is the ALIAS row, so no forward line.
  expect(card.container.textContent).not.toContain("Then forward")
  await card.unmount()
})

it("puts Add it for me first when the provider can add the record, with the records below", async () => {
  const apply =
    "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/remeai.co.uk/services/website/apply?domain=sparkleclean.co.uk&host=www&key=_dck1&sig=x"
  const card = await draw(
    done({
      outcome: "connecting",
      method: "domain_connect",
      email_affected: false,
      apex: "forward",
      provider: {
        name: "Cloudflare",
        settings_url: "https://dash.cloudflare.com/",
      },
      steps: [{ type: "CNAME", name: "www", value: "domains.remeai.co.uk" }],
      apply_url: apply,
    })
  )
  expect(card.container.textContent).toContain(
    "Cloudflare asks you to sign in and approve it, then brings you back here. Or add it yourself:"
  )
  const [first, settings] = card.container.querySelectorAll("a")
  expect(first?.textContent).toBe("Add it for me (opens in a new tab)")
  expect(first?.getAttribute("href")).toBe(apply)
  expect(first?.getAttribute("target")).toBe("_blank")
  expect(first?.getAttribute("rel")).toContain("noopener")
  expect(settings?.getAttribute("href")).toBe("https://dash.cloudflare.com/")
  expect(rows(card.container)).toHaveLength(1)
  expect(buttons(card.container)).toContain(DONE_WAITING)
  await card.unmount()
})

it("says the website is live, with no records or links, once it is on the domain", async () => {
  const card = await draw(done({ ...RECORDS, provider: GODADDY }), [NAME])
  expect(card.container.textContent).toBe(
    `Connect ${NAME} to your websiteYour website is live on ${NAME}.`
  )
  expect(card.container.querySelector("a")).toBeNull()
  expect(buttons(card.container)).toEqual([])
  await card.unmount()
  // Another domain live leaves this one's records in place.
  const other = await draw(done(RECORDS), ["other.co.uk"])
  expect(rows(other.container)).toHaveLength(2)
  await other.unmount()
})

it("says it is connecting, and offers no wait button, when there are no records to show", async () => {
  const card = await draw(
    done({
      outcome: "connecting",
      method: "domain_connect",
      email_affected: false,
    })
  )
  expect(card.container.textContent).toContain(
    "Connecting. I'll message you when it's live."
  )
  expect(card.container.querySelector("ol")).toBeNull()
  expect(buttons(card.container)).toEqual([])
  await card.unmount()
})

it("shows a subdomain's one record with no line about the bare address", async () => {
  const card = await draw(
    done({
      outcome: "connecting",
      method: "records",
      email_affected: false,
      steps: [{ type: "CNAME", name: "book", value: "domains.remeai.co.uk" }],
    })
  )
  expect(steps(card.container)).toEqual([
    "Open your domain's settings",
    "Add this record",
  ])
  expect(rows(card.container)).toHaveLength(1)
  expect(card.container.textContent).not.toContain("without www")
  await card.unmount()
})

it("copies a value to the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
  const card = await draw(done({ ...RECORDS, provider: GODADDY }))
  const copy = card.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy domains.remeai.co.uk"]'
  )
  await act(async () => copy?.click())
  expect(writeText).toHaveBeenCalledWith("domains.remeai.co.uk")
  expect(
    copy?.parentElement?.querySelector('[role="status"]')?.textContent
  ).toBe("Copied")
  await card.unmount()
})

it("shows where to look, never a link, when the provider is not one we know", async () => {
  const hint = (container: HTMLElement) =>
    container.querySelector('[data-slot="settings-hint"]')?.textContent

  const named = await draw(
    done({ ...RECORDS, provider: { name: "Example DNS" } })
  )
  expect(steps(named.container)[0]).toBe("Open Example DNS, sign in if asked")
  expect(hint(named.container)).toBe(
    "Where your domain's settings liveLook for DNS or Manage DNS once you're signed in."
  )
  expect(named.container.querySelector("a")).toBeNull()
  await named.unmount()

  const traced = await draw(
    done({ ...RECORDS, nameserver_host: "katapult.io" })
  )
  expect(steps(traced.container)[0]).toBe("Open your domain's settings")
  expect(hint(traced.container)).toContain(
    "Its nameservers point to katapult.io, so start there."
  )
  expect(traced.container.querySelector("a")).toBeNull()
  await traced.unmount()

  const unknown = await draw(done(RECORDS))
  expect(hint(unknown.container)).toContain(
    "Usually where you bought it, or with whoever set up your old website."
  )
  expect(
    unknown.container.querySelector('[data-slot="brand-mark"] svg')
  ).not.toBeNull()
  expect(unknown.container.querySelector("a")).toBeNull()
  await unknown.unmount()
})

it("says nothing about email, whatever the connect says of it", async () => {
  const card = await draw(done({ ...RECORDS, email_affected: true }))
  expect(card.container.textContent).not.toContain("email")
  await card.unmount()
})

it("sends I've added it as the owner only while the card is the last message", async () => {
  const card = await draw(done(RECORDS))
  const wait = [...card.container.querySelectorAll("button")].find(
    (b) => b.textContent === DONE_WAITING
  )
  await act(async () => wait?.click())
  expect(store.append).toHaveBeenCalledExactlyOnceWith(DONE_WAITING)
  expect(wait?.disabled).toBe(true)
  await card.unmount()

  store.isLast = false
  const later = await draw(done(RECORDS))
  expect(buttons(later.container)).not.toContain(DONE_WAITING)
  await later.unmount()
})

it("says what happened when the owner cancels or the call is refused", async () => {
  const denied = await draw({
    isError: true,
    result: { error: "denied" },
    approval: { approved: false },
  })
  expect(denied.container.textContent).toContain("You said not now.")
  await denied.unmount()

  const REFUSAL = {
    outcome: "refused",
    error: { code: "domain.in_use", message: "written for the model" },
  }
  // After the owner's yes: one calm line, the warning in the icon alone.
  const refused = await draw(done(REFUSAL))
  expect(refused.container.textContent).toContain(
    "The domain could not be connected."
  )
  expect(refused.container.textContent).not.toContain("written for the model")
  expect(refused.container.querySelector(".text-destructive")?.tagName).toBe(
    "svg"
  )
  await refused.unmount()

  // Never asked: the assistant explains it in its own words, so no line.
  const quiet = await draw({ result: REFUSAL })
  expect(quiet.container.innerHTML).toBe("")
  await quiet.unmount()
})

it("reads a domain check as one plain sentence", () => {
  const checked = (status: object) =>
    domainStatusText(NAME, {
      outcome: "checked",
      state: "awaiting_dns",
      status,
      next_step: "",
    } as Extract<CheckDomainOutput, { outcome: "checked" }>)
  expect(checked({ status: "valid" })).toBe(`${NAME} is live.`)
  expect(checked({ status: "pending_verification" })).toContain("Waiting")
  expect(checked({ status: "pending_certificate" })).toContain("certificate")
  expect(
    checked({
      status: "conflicting_record",
      conflicts: [{ type: "A", name: `www.${NAME}`, value: "192.0.2.10" }],
    })
  ).toBe(
    `Delete the old A record on www.${NAME} (192.0.2.10). It can't sit next to the new one, and I'll pick it up from there.`
  )
})

it("draws a domain check in the transcript as that one sentence", async () => {
  const card = await draw({
    toolName: "check_domain",
    result: {
      outcome: "checked",
      state: "verifying",
      status: { status: "pending_certificate" },
      next_step: "Tell the owner the certificate is being issued.",
    },
  })
  expect(card.container.textContent).toBe(
    `${NAME} points at your website. Its secure certificate is being issued.`
  )
  await card.unmount()
})

it("asks before taking the website off a domain, and says nothing is deleted", async () => {
  const card = await draw({
    toolName: "remove_domain",
    approval: { approved: undefined },
  })
  expect(card.container.querySelector("h2")?.textContent).toBe(
    `Take your website off ${NAME}?`
  )
  expect(card.container.textContent).toContain(
    "Your website goes back to its own address. Nothing is deleted at your domain's provider."
  )
  expect(choices(card.container)).toEqual(["Keep it", "Remove"])
  await answer(card)
  await card.unmount()
})

it("says the domain is no longer connected once removed, and what a refusal or a no leaves", async () => {
  const removed = await draw({
    toolName: "remove_domain",
    ...done({ outcome: "removed" }),
  })
  expect(removed.container.textContent).toContain(
    "Done. Your website is back on its own address."
  )
  expect(buttons(removed.container)).toEqual([])
  await removed.unmount()

  const refused = await draw({
    toolName: "remove_domain",
    ...done({
      outcome: "refused",
      error: { code: "domain.not_found", message: "written for the model" },
    }),
  })
  expect(refused.container.textContent).toContain(
    "The domain could not be removed."
  )
  await refused.unmount()

  const kept = await draw({
    toolName: "remove_domain",
    isError: true,
    result: { error: "denied" },
    approval: { approved: false },
  })
  expect(kept.container.textContent).toContain("You said not now.")
  await kept.unmount()
})

it("draws a domain bought elsewhere as the connect's records, or that the registry can't see it yet", async () => {
  const connected = await draw({
    toolName: "domain_bought",
    result: { ...RECORDS, provider: GODADDY },
  })
  expect(connected.container.textContent).toContain(`${NAME} is yours.`)
  expect(rows(connected.container)).toHaveLength(2)
  expect(connected.container.querySelector("a")?.getAttribute("href")).toBe(
    GODADDY.settings_url
  )
  await connected.unmount()

  const waiting = await draw({
    toolName: "domain_bought",
    result: { outcome: "not_registered_yet", name: NAME },
  })
  // The assistant says it isn't registered yet, in its reply.
  expect(waiting.container.textContent).toBe(`Looked for ${NAME}`)
  await waiting.unmount()
})

it("folds to one quiet line once a later message holds another domain card, and Resume shows it again", async () => {
  store.messages = [
    { id: "msg-1", content: [] },
    { id: "msg-2", content: [{ type: "tool-call", toolName: "find_domain" }] },
  ]
  const card = await draw(done({ ...RECORDS, provider: GODADDY }))
  expect(card.container.textContent).toBe(
    `Connecting ${NAME} · paused Resume connecting ${NAME}`
  )
  expect(card.container.querySelector("a")).toBeNull()
  await act(async () =>
    [...card.container.querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("Resume"))
      ?.click()
  )
  expect(rows(card.container)).toHaveLength(2)
  await card.unmount()

  // The address question asked again folds it too; a later reply in words does not.
  store.messages = [
    { id: "msg-1", content: [] },
    {
      id: "msg-2",
      content: [
        { type: "data", name: "build_questions", data: { kind: "address" } },
      ],
    },
  ]
  const asked = await draw(done(RECORDS))
  expect(asked.container.textContent).toContain("· paused")
  await asked.unmount()
  store.messages = [
    { id: "msg-1", content: [] },
    { id: "msg-2", content: [{ type: "text", text: "Thanks" }] },
  ]
  const words = await draw(done(RECORDS))
  expect(rows(words.container)).toHaveLength(2)
  await words.unmount()
})
