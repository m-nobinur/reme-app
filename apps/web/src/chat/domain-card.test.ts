// @vitest-environment happy-dom
import type { CheckDomainOutput } from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  DONE_WAITING,
  domainStatusText,
} from "@workspace/ui/components/assistant/domain"
import { LiveCardsProvider } from "@workspace/ui/lib/live-cards"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The cards read the thread through assistant-ui's store; these tests stand in
// for it, since what they check is the card, not the runtime.
const store = vi.hoisted(() => ({
  isLast: true,
  isRunning: false,
  append: vi.fn(),
}))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { parts: [], isLast: store.isLast, status: undefined },
      thread: { isRunning: store.isRunning, messages: [] },
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
  const card = createElement(Approval, {
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
            LiveCardsProvider,
            {
              value: {
                googleConnected: null,
                domainLive: (name) => live.includes(name),
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
  store.append.mockReset()
})

it("asks for the owner's yes through the existing approval flow", async () => {
  const card = await draw({ approval: { approved: undefined } })
  expect(card.container.querySelector("h2")?.textContent).toBe(
    `Put your website on ${NAME}.`
  )
  expect(card.container.textContent).toContain("Your email is not affected.")
  expect(choices(card.container)).toEqual(["Cancel", "Connect"])
  await answer(card)
  await card.unmount()
})

it("shows the records, a copy button for each value, and the provider button", async () => {
  const card = await draw(done({ ...RECORDS, provider: GODADDY }))
  const text = card.container.textContent ?? ""
  expect(text).toContain("Your domain's settings are at GoDaddy.")
  expect(text).toContain("There are 3 changes to make there.")
  expect(text).toContain("Your email is not affected.")
  const items = card.container.querySelectorAll("ol > li")
  expect(items).toHaveLength(3)
  expect(items[0]?.textContent).toContain("domains.remeai.co.uk")
  expect(items[2]?.textContent).toContain(
    `forward it to https://www.${NAME} as permanent`
  )
  const link = card.container.querySelector("a")
  expect(link?.getAttribute("href")).toBe(GODADDY.settings_url)
  expect(link?.getAttribute("target")).toBe("_blank")
  expect(link?.getAttribute("rel")).toContain("noopener")
  expect(link?.textContent).toBe(
    "GoDaddyOpen your DNS settings (opens in a new tab)"
  )
  expect(
    [...card.container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")
    )
  ).toEqual(["Copy domains.remeai.co.uk", "Copy abc123"])
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
  const text = card.container.textContent ?? ""
  expect(text).toContain(
    "Your domain's settings are at Cloudflare, and I can add the record there for you."
  )
  expect(text).toContain("Or make the 2 changes yourself:")
  // The record it adds is www's; the bare address stays the owner's step.
  expect(text).toContain(
    "The address without www is still yours to set: the last step below."
  )
  const [first, settings] = card.container.querySelectorAll("a")
  expect(first?.textContent).toBe("Add it for me (opens in a new tab)")
  expect(first?.getAttribute("href")).toBe(apply)
  expect(first?.getAttribute("target")).toBe("_blank")
  expect(first?.getAttribute("rel")).toContain("noopener")
  expect(settings?.getAttribute("href")).toBe("https://dash.cloudflare.com/")
  expect(card.container.querySelectorAll("ol > li")).toHaveLength(2)
  expect(buttons(card.container)).toContain("Done, I'll wait")
  await card.unmount()
})

it("says the website is live, with no records or links, once it is on the domain", async () => {
  const card = await draw(done({ ...RECORDS, provider: GODADDY }), [NAME])
  expect(card.container.textContent).toBe(
    `Put your website on ${NAME}.Your website is live on ${NAME}.`
  )
  expect(card.container.querySelector("a")).toBeNull()
  expect(buttons(card.container)).toEqual([])
  await card.unmount()
  // Another domain live leaves this one's records in place.
  const other = await draw(done(RECORDS), ["other.co.uk"])
  expect(other.container.querySelectorAll("ol > li")).toHaveLength(3)
  await other.unmount()
})

it("keeps every step a list item, so each shows its number", async () => {
  const card = await draw(done(RECORDS))
  // `display: flex` on an `li` drops its marker, so none of them may carry it.
  for (const item of card.container.querySelectorAll("ol > li")) {
    expect(item.className.split(" ")).not.toContain("flex")
  }
  await card.unmount()
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
  const text = card.container.textContent ?? ""
  expect(text).toContain("There is 1 change to make.")
  expect(card.container.querySelectorAll("ol > li")).toHaveLength(1)
  expect(text).not.toContain("without www")
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
  expect(card.container.querySelector('[role="status"]')?.textContent).toBe(
    "Copied"
  )
  await card.unmount()
})

it("offers no provider button without a settings link, and names no provider without one", async () => {
  const named = await draw(
    done({ ...RECORDS, provider: { name: "Namecheap" } })
  )
  expect(named.container.textContent).toContain("settings are at Namecheap.")
  expect(named.container.querySelector("a")).toBeNull()
  await named.unmount()

  const unknown = await draw(done(RECORDS))
  expect(unknown.container.textContent).toContain(
    "where you manage your domain"
  )
  expect(unknown.container.querySelector("a")).toBeNull()
  await unknown.unmount()
})

it("says what to do with the address without www, by how it is served", async () => {
  const card = await draw(done({ ...RECORDS, apex: "alias" }))
  const last = [...card.container.querySelectorAll("ol > li")].at(-1)
  expect(last?.textContent).toContain("ALIAS or ANAME record at the root")
  await card.unmount()
})

it("warns, rather than reassures, when the email may be affected", async () => {
  const card = await draw(done({ ...RECORDS, email_affected: true }))
  expect(card.container.textContent).toContain("ask whoever set it up")
  expect(card.container.textContent).not.toContain("not affected")
  await card.unmount()
})

it("sends Done, I'll wait as the owner only while the card is the last message", async () => {
  const card = await draw(done(RECORDS))
  const wait = [...card.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Done, I'll wait")
  )
  await act(async () => wait?.click())
  expect(store.append).toHaveBeenCalledExactlyOnceWith(DONE_WAITING)
  expect(wait?.disabled).toBe(true)
  await card.unmount()

  store.isLast = false
  const later = await draw(done(RECORDS))
  expect(buttons(later.container).some((b) => b?.includes("Done"))).toBe(false)
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
    `${NAME} is no longer connected. Your website is back on its own address.`
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
  expect(connected.container.querySelectorAll("ol > li")).toHaveLength(3)
  expect(connected.container.querySelector("a")?.getAttribute("href")).toBe(
    GODADDY.settings_url
  )
  await connected.unmount()

  const waiting = await draw({
    toolName: "domain_bought",
    result: { outcome: "not_registered_yet", name: NAME },
  })
  expect(waiting.container.textContent).toBe(
    `I can't see ${NAME} at the registry yet. It can take a few minutes, and I check each day too.`
  )
  await waiting.unmount()
})
