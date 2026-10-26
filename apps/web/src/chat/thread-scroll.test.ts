// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { AVATARS, PRONOUNS, TONES } from "@workspace/contracts"
import { PersonaCardUI } from "@workspace/ui/components/assistant/persona-card"
import { TrayFrame } from "@workspace/ui/components/assistant/question-tray"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * The thread's scrolling as the owner's browser paints it. happy-dom lays
 * nothing out, so a small model stands in: rows of set heights stacked in
 * the scroller, the held space assistant-ui adds, and the sticky footer in
 * the scroll content. scrollTop clamps to the content the way layout does,
 * and each frame runs the browser's steps in order: scroll events, then
 * animation frames, then layout and resize observers, then paint. Each paint
 * samples where the owner's last message sits, as the recorder did.
 */
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const USER_ROW = 40
const REPLY_ROW = 200

/** What the model lays out; a test changes it, then runs frames. */
let layout: {
  clientHeight: number
  footer: number
  slot: number
  /** The docked tray's content, when one is shown. */
  content: number
  rows: Map<string, number>
}

const isViewport = (el: Element) =>
  el.getAttribute("data-slot") === "aui_thread-viewport"
const viewportOf = (el: Element) =>
  el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]')
const group = (el: Element) =>
  el.closest('[data-slot="aui_message-group"]') ?? undefined
const isSlot = (el: Element) =>
  el.parentElement?.getAttribute("data-slot") === "aui_message-group" &&
  el.getAttribute("aria-live") === "polite"
const isWrapper = (el: Element): el is Element & { parentElement: Element } =>
  el.parentElement !== null &&
  isViewport(el.parentElement) &&
  el.querySelector('[data-slot="aui_message-group"]') !== null
const isReserve = (el: Element) =>
  el.hasAttribute("data-aui-top-anchor-reserve")
const isFooter = (el: Element) =>
  el.classList.contains("aui-thread-viewport-footer")

/**
 * A question tray in the footer: its header and buttons, and a body that
 * holds the height written to it and eases there over a few frames, as its
 * CSS transition does.
 */
const TRAY_CHROME = 124
const TRAY_EASE_FRAMES = 15
const trayBody = new Map<Element, { shown: number; step: number }>()
const isTrayBody = (el: Element) =>
  el.id.endsWith("-body") && el.closest('[data-slot="question-tray"]') !== null
const footerHeight = () => {
  const body = [...trayBody.keys()].find((el) => el.isConnected)
  return layout.footer + (body ? TRAY_CHROME + heightOf(body) : 0)
}
const easeTrayBodies = () => {
  for (const [el, each] of trayBody) {
    const target = Number.parseFloat((el as HTMLElement).style.height)
    // Until a height is written, the body is as tall as its content.
    if (Number.isNaN(target)) {
      each.shown = layout.content
      continue
    }
    const rest = Math.max(1, TRAY_EASE_FRAMES - each.step)
    each.shown = Math.round(each.shown + (target - each.shown) / rest)
    each.step = each.shown === target ? 0 : each.step + 1
  }
}

const heightOf = (el: Element): number => {
  const id = el.getAttribute("data-message-id")
  if (id) {
    return (
      layout.rows.get(id) ??
      (el.getAttribute("data-slot") === "aui_user-message-root"
        ? USER_ROW
        : REPLY_ROW)
    )
  }
  if (isReserve(el))
    return Number.parseFloat((el as HTMLElement).style.height) || 0
  if (isSlot(el)) return layout.slot
  if (isFooter(el)) return footerHeight()
  if (isTrayBody(el)) {
    const each = trayBody.get(el) ?? { shown: layout.content, step: 0 }
    trayBody.set(el, each)
    return each.shown
  }
  if (el.parentElement && isTrayBody(el.parentElement)) return layout.content
  if (isViewport(el)) return layout.clientHeight
  // The viewport's box of content (assistant-ui watches the viewport's
  // children), as tall as everything in it, the held space too, and at least
  // the viewport. A box with `display: contents` has no size to report.
  if (isWrapper(el)) {
    return el.classList.contains("contents")
      ? 0
      : Math.max(layout.clientHeight, contentHeight(el.parentElement))
  }
  if (el.getAttribute("data-slot") === "aui_message-group") {
    return [...el.children].reduce((sum, child) => sum + heightOf(child), 0)
  }
  return 0
}

/** The group's children as they stack on screen: the held space goes last (`order-last`). */
const stacked = (box: Element) => {
  const children = [...box.children]
  return [
    ...children.filter((child) => !isReserve(child)),
    ...children.filter(isReserve),
  ]
}

/** Where an element starts in the scroll content. */
const offsetOf = (el: Element): number => {
  if (isFooter(el)) {
    const box = el.parentElement?.querySelector(
      '[data-slot="aui_message-group"]'
    )
    return box ? heightOf(box) : 0
  }
  const box = group(el)
  if (!box) return 0
  const row =
    [...box.children].find((child) => child === el || child.contains(el)) ?? el
  let top = 0
  for (const child of stacked(box)) {
    if (child === row) break
    top += heightOf(child)
  }
  return top
}

const contentHeight = (viewport: Element) => {
  const box = viewport.querySelector('[data-slot="aui_message-group"]')
  return (box ? heightOf(box) : 0) + footerHeight()
}
const maxScroll = (viewport: Element) =>
  Math.max(0, contentHeight(viewport) - layout.clientHeight)

/** Each scroller's position, clamped whenever layout is read, as a browser clamps it. */
const scrolled = new WeakMap<Element, number>()
const pendingScroll = new Set<Element>()
const readScroll = (viewport: Element) => {
  const stored = scrolled.get(viewport) ?? 0
  const clamped = Math.min(stored, maxScroll(viewport))
  if (clamped !== stored) {
    scrolled.set(viewport, clamped)
    pendingScroll.add(viewport)
  }
  return clamped
}
/**
 * Smooth scrolls under way, eased over a few frames as a browser does. Off,
 * one lands at once, and the frames sampled are where it settles.
 */
let glide = false
const GLIDE_FRAMES = 8
const gliding = new Map<Element, { from: number; to: number; step: number }>()
const writeScroll = (viewport: Element, top: number) => {
  // Any other scroll stops a glide in flight.
  gliding.delete(viewport)
  const next = Math.max(0, Math.min(top, maxScroll(viewport)))
  if (next !== (scrolled.get(viewport) ?? 0)) pendingScroll.add(viewport)
  scrolled.set(viewport, next)
}

const rectOf = (el: Element) => {
  const viewport = viewportOf(el)
  if (!viewport || el === viewport) {
    return new DOMRect(0, 0, 600, layout.clientHeight)
  }
  const natural = offsetOf(el) - readScroll(viewport)
  // Sticky to the bottom of the scroller.
  const top = isFooter(el)
    ? Math.min(natural, layout.clientHeight - footerHeight())
    : natural
  return new DOMRect(0, top, 600, heightOf(el))
}

const PATCHED = [
  "offsetHeight",
  "offsetTop",
  "offsetParent",
  "clientHeight",
  "clientWidth",
  "scrollHeight",
  "scrollTop",
] as const
const originals = new Map<string, PropertyDescriptor | undefined>()

function patchLayout() {
  const proto = HTMLElement.prototype
  for (const key of PATCHED) {
    originals.set(key, Object.getOwnPropertyDescriptor(proto, key))
  }
  originals.set("getBoundingClientRect", {
    value: proto.getBoundingClientRect,
  })
  originals.set("scrollTo", { value: proto.scrollTo })
  const inside = (el: Element) => viewportOf(el) !== null
  Object.defineProperties(proto, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return inside(this) ? heightOf(this) : 0
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return inside(this) ? heightOf(this) : 0
      },
    },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return inside(this) ? 600 : 0
      },
    },
    offsetTop: {
      configurable: true,
      get(this: HTMLElement) {
        return isViewport(this) ? 0 : offsetOf(this)
      },
    },
    offsetParent: {
      configurable: true,
      get(this: HTMLElement) {
        // The viewport is `relative`, so every row measures from it.
        return isViewport(this) ? null : viewportOf(this)
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isViewport(this)
          ? Math.max(layout.clientHeight, contentHeight(this))
          : heightOf(this)
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return isViewport(this) ? readScroll(this) : 0
      },
      set(this: HTMLElement, top: number) {
        if (isViewport(this)) writeScroll(this, top)
      },
    },
    getBoundingClientRect: {
      configurable: true,
      value(this: HTMLElement) {
        return rectOf(this)
      },
    },
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top === undefined) return
        if (!glide || options.behavior !== "smooth") {
          return writeScroll(this, options.top)
        }
        const from = readScroll(this)
        const to = Math.max(0, Math.min(options.top, maxScroll(this)))
        gliding.set(this, { from, to, step: 0 })
      },
    },
  })
}

function unpatchLayout() {
  for (const [key, descriptor] of originals) {
    if (descriptor)
      Object.defineProperty(HTMLElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, key)
  }
  originals.clear()
}

/**
 * Resize observers fire after layout, for each target whose size changed.
 * As in the browser, each round after the first delivers only targets deeper
 * than the shallowest one just delivered; a shallower one changed by a
 * callback waits for the next frame, and the page logs a loop warning.
 */
const observers = new Set<FakeResizeObserver>()
const sizeOf = (el: Element) =>
  `${(el as HTMLElement).clientWidth}x${heightOf(el)}`
const depthOf = (el: Element) => {
  let depth = 0
  for (let at = el.parentElement; at; at = at.parentElement) depth += 1
  return depth
}
class FakeResizeObserver {
  sizes = new Map<Element, string | undefined>()
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe(el: Element) {
    this.sizes.set(el, undefined)
  }
  unobserve(el: Element) {
    this.sizes.delete(el)
  }
  disconnect() {
    this.sizes.clear()
    observers.delete(this)
  }
  changed() {
    return [...this.sizes]
      .filter(([el, last]) => sizeOf(el) !== last)
      .map(([el]) => el)
  }
  deliver(targets: Element[]) {
    for (const el of targets) this.sizes.set(el, sizeOf(el))
    this.callback([], this as unknown as ResizeObserver)
  }
}
/** "ResizeObserver loop completed with undelivered notifications", as logged. */
let loops = 0
function deliverResizes() {
  let depth = -1
  for (;;) {
    const due = [...observers].map(
      (observer) =>
        [
          observer,
          observer.changed().filter((el) => depthOf(el) > depth),
        ] as const
    )
    const targets = due.flatMap(([, each]) => each)
    if (targets.length === 0) break
    for (const [observer, each] of due) {
      if (each.length > 0) observer.deliver(each)
    }
    depth = Math.min(...targets.map(depthOf))
  }
  if ([...observers].some((observer) => observer.changed().length > 0)) {
    loops += 1
  }
}

let animation: Map<number, FrameRequestCallback>
let nextFrame = 0
/** The page's clock, 16 ms a frame, which the text reveal reads. */
let clock = 0

/** One frame: scroll events, animation frames, layout and observers, then paint. */
async function frame() {
  clock += 16
  await act(async () => {
    for (const [viewport, { from, to, step }] of [...gliding]) {
      const t = (step + 1) / GLIDE_FRAMES
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      writeScroll(viewport, Math.round(from + (to - from) * eased))
      if (t < 1) gliding.set(viewport, { from, to, step: step + 1 })
    }
    for (const viewport of [...pendingScroll]) {
      pendingScroll.delete(viewport)
      viewport.dispatchEvent(new Event("scroll"))
    }
    const due = [...animation.values()]
    animation.clear()
    for (const callback of due) callback(clock)
    easeTrayBodies()
    deliverResizes()
  })
  painted.push(ownerMessageTop())
}

async function frames(count = 6) {
  for (let i = 0; i < count; i++) await frame()
}

/** Where the owner's last message sits in the viewport, each painted frame. */
let painted: number[] = []
let chat: HTMLElement
const ownerMessageTop = () => {
  const rows = chat.querySelectorAll('[data-slot="aui_user-message-root"]')
  const last = rows[rows.length - 1]
  return last ? Math.round(last.getBoundingClientRect().top) : Number.NaN
}

/** The furthest the owner's message moved between two painted frames since `from`. */
const worstMove = (from: number) =>
  painted
    .slice(from)
    .reduce(
      (worst, top, i, all) =>
        i === 0 ? 0 : Math.max(worst, Math.abs(top - (all[i - 1] ?? top))),
      0
    )

/** The thread's store: messages and whether a turn is running. */
let state: { messages: ThreadMessageLike[]; isRunning: boolean }
const listeners = new Set<() => void>()
const setState = (next: Partial<typeof state>) =>
  act(async () => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  })
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function Chat() {
  const current = useSyncExternalStore(subscribe, () => state)
  const runtime = useExternalStoreRuntime({
    messages: current.messages,
    isRunning: current.isRunning,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(PersonaCardUI),
    createElement(Thread, { autoFocus: false })
  )
}

const said = (id: string, role: "user" | "assistant", text: string) =>
  ({
    id,
    role,
    content: [{ type: "text", text }],
    ...(role === "assistant"
      ? { status: { type: "complete", reason: "stop" } }
      : {}),
  }) as ThreadMessageLike

const HISTORY = [
  said("a0", "assistant", "Hello, I'm Reme."),
  said("u0", "user", "Spendid Cleaning"),
  said("a1", "assistant", "Lovely. Shall we choose a look?"),
]

let root: Root
beforeEach(async () => {
  layout = {
    clientHeight: 729,
    footer: 80,
    slot: 0,
    content: 0,
    rows: new Map(),
  }
  painted = []
  glide = false
  gliding.clear()
  loops = 0
  animation = new Map()
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1
    animation.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animation.delete(id))
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  patchLayout()
  state = { messages: HISTORY, isRunning: false }
  chat = document.createElement("div")
  document.body.appendChild(chat)
  root = createRoot(chat)
  await act(async () => root.render(createElement(Chat)))
  await frames()
})

afterEach(async () => {
  await act(async () => {
    trayRoot?.unmount()
    root.unmount()
  })
  trayRoot = undefined
  chat.remove()
  observers.clear()
  trayBody.clear()
  unpatchLayout()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The owner sends, the reply streams in and ends: their message at the top. */
async function sendAndReply(id: string, reply = `${id}-reply`, height = 260) {
  await setState({
    messages: [
      ...state.messages,
      said(id, "user", "Pick for me"),
      { ...said(`${id}-reply`, "assistant", ""), status: { type: "running" } },
    ],
    isRunning: true,
  })
  await frames()
  layout.rows.set(reply, height)
  await setState({
    messages: [
      ...state.messages.slice(0, -1),
      said(reply, "assistant", "Here is what I picked."),
    ],
    isRunning: false,
  })
  await frames()
  expect(ownerMessageTop()).toBe(0)
}

it("the owner's message stays at the top when the docked tray leaves", async () => {
  layout.footer = 421
  await frames()
  await sendAndReply("u1")
  const from = painted.length
  // The design tray submitted: the footer 341 px shorter at once.
  layout.footer = 80
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("the owner's message stays at the top through each step the tray swaps", async () => {
  layout.footer = 421
  await frames()
  await sendAndReply("u1")
  const from = painted.length
  for (const footer of [200, 460, 120, 80]) {
    layout.footer = footer
    await frames()
  }
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("the owner's message stays at the top when the viewport resizes after the reply", async () => {
  await sendAndReply("u1")
  const from = painted.length
  // 23:47:24: the viewport 41 px taller, no input, no new message.
  layout.clientHeight = 770
  vi.stubGlobal("innerHeight", window.innerHeight + 41)
  await frames()
  layout.clientHeight = 729
  vi.stubGlobal("innerHeight", window.innerHeight - 41)
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("the owner's message stays at the top when the tray leaves as they send", async () => {
  layout.footer = 421
  await frames()
  // Pick for me on the persona tray: the turn starts as the tray goes.
  await setState({
    messages: [
      ...state.messages,
      said("u1", "user", "Pick for me"),
      { ...said("u1-reply", "assistant", ""), status: { type: "running" } },
    ],
    isRunning: true,
  })
  layout.footer = 80
  await frames()
  const from = painted.length
  // The intro line comes in a few words at a time, then the card under it.
  for (const height of [60, 90, 120, 210]) {
    layout.rows.set("u1-reply", height)
    await frames(2)
  }
  await setState({
    messages: [
      ...state.messages.slice(0, -1),
      said("u1-reply", "assistant", "I'm Reme, here to help."),
    ],
    isRunning: false,
  })
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("a card in the slot that fits the held space moves nothing", async () => {
  await sendAndReply("u1")
  const from = painted.length
  layout.slot = 180
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("the owner's message stays at the top through the history refresh after a turn", async () => {
  await sendAndReply("u1")
  const from = painted.length
  // The rows read back after the turn: the same messages, new objects.
  await setState({ messages: state.messages.map((each) => ({ ...each })) })
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("the owner's message stays at the top when the reply's id changes as the turn ends", async () => {
  // The placeholder reply gives way to the stored one in the update that ends the run.
  await sendAndReply("u1", "row-7")
  const from = painted.length
  layout.footer = 300
  await frames()
  expect(worstMove(from)).toBeLessThanOrEqual(1)
  expect(ownerMessageTop()).toBe(0)
})

it("a tray docking under a reply that fills the view keeps the reader at its end", async () => {
  await sendAndReply("u1", "u1-reply", 1200)
  const viewport = chat.querySelector<HTMLElement>(
    '[data-slot="aui_thread-viewport"]'
  )
  if (!viewport) throw new Error("no viewport")
  viewport.scrollTop = viewport.scrollHeight
  await frames()
  layout.footer = 421
  await frames()
  expect(
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
  ).toBeLessThanOrEqual(1)
})

it("the persona card waits for the words above it to finish typing in", async () => {
  const intro =
    "Here's how I'll introduce myself from now on: I'm Reme, she/her, and I'll keep things friendly and clear."
  const reply = (content: ThreadMessageLike["content"]): ThreadMessageLike => ({
    id: "u1-reply",
    role: "assistant",
    content,
    status: { type: "running" },
  })
  await setState({
    messages: [
      ...state.messages,
      said("u1", "user", "Pick for me"),
      reply([{ type: "text", text: intro.slice(0, 20) }]),
    ],
    isRunning: true,
  })
  await frames(2)
  // The rest of the words and the card land together, the words still typing in.
  await setState({
    messages: [
      ...state.messages.slice(0, -1),
      reply([
        { type: "text", text: intro },
        {
          type: "data",
          name: "persona",
          data: {
            name: "Reme",
            pronouns: PRONOUNS[0].id,
            avatar: AVATARS[0].id,
            tone: TONES[0].id,
          },
        },
      ]),
    ],
  })
  await frame()
  const waiting = () =>
    chat.querySelector(
      '[data-slot="aui_assistant-message-content"] > .aui-md[data-status="running"] ~ [data-slot="persona-card"]'
    )
  // happy-dom applies no Tailwind, so the rule is read off the class.
  expect(
    chat.querySelector('[data-slot="persona-card"]')?.parentElement?.className
  ).toContain("[&>.aui-md[data-status=running]~*]:invisible")
  expect(waiting()).not.toBeNull()
  // About 5 ms a character, so 40 frames are plenty.
  for (let i = 0; i < 40 && waiting(); i++) await frame()
  expect(waiting()).toBeNull()
  expect(
    chat.querySelector('[data-slot="persona-card"]')?.previousElementSibling
      ?.textContent
  ).toContain("friendly and clear.")
})

/**
 * Every way the owner sends glides their message up from the bottom, as a
 * typed send does: an answer on the tray (a card, Pick for me, Looks good or
 * Next) and Skip this one take what sat above the composer away as they send.
 */
const SENDS = [
  { what: "a typed message", footer: 80, leavesFirst: false },
  { what: "an answer on the tray", footer: 421, leavesFirst: false },
  {
    what: "an answer on the tray, gone a frame early",
    footer: 421,
    leavesFirst: true,
  },
  { what: "Skip this one", footer: 124, leavesFirst: false },
]
for (const { what, footer, leavesFirst } of SENDS) {
  it(`${what} glides the owner's message to the top`, async () => {
    layout.footer = footer
    await frames()
    await sendAndReply("u1")
    glide = true
    const from = painted.length
    layout.footer = 80
    if (leavesFirst) await frame()
    await setState({
      messages: [
        ...state.messages,
        said("u2", "user", "Something else"),
        { ...said("u2-reply", "assistant", ""), status: { type: "running" } },
      ],
      isRunning: true,
    })
    await frames(GLIDE_FRAMES + 4)
    // From the frame it lands, the new message shows under the reply where
    // the composer was, with nothing above it moved, then rises.
    const path = painted.slice(from + (leavesFirst ? 1 : 0))
    const trace = path.join(" ")
    expect(path[0], trace).toBe(USER_ROW + 260)
    expect(path.at(-1), trace).toBe(0)
    expect(
      path.every((top, i) => i === 0 || top <= (path[i - 1] ?? top)),
      trace
    ).toBe(true)
    const steps = path.filter((top, i) => i > 0 && top !== path[i - 1])
    expect(steps.length, trace).toBeGreaterThanOrEqual(GLIDE_FRAMES - 1)
  })
}

it("Scroll to bottom shows once the reply grows past the composer", async () => {
  await sendAndReply("u1")
  const button = chat.querySelector(".aui-thread-scroll-to-bottom")
  expect(button?.classList.contains("invisible")).toBe(true)
  layout.rows.set("u1-reply", 1200)
  await frames()
  expect(button?.classList.contains("invisible")).toBe(false)
})

it("logs no resize loop through a turn, a tray and the next send", async () => {
  layout.footer = 421
  await frames()
  loops = 0
  await sendAndReply("u1")
  layout.slot = 180
  await frames()
  layout.footer = 80
  await setState({
    messages: [
      ...state.messages,
      said("u2", "user", "Something else"),
      { ...said("u2-reply", "assistant", ""), status: { type: "running" } },
    ],
    isRunning: true,
  })
  // The reply streams into the space held below it, then past the fold.
  for (const height of [60, 120, 300, 900]) {
    layout.rows.set("u2-reply", height)
    await frames(2)
  }
  layout.clientHeight = 770
  await frames()
  expect(loops).toBe(0)
})

/** The tray frame itself, docked above the composer on page `index` of 3. */
async function showTray(index: number, content: number) {
  layout.content = content
  const slot = chat.querySelector<HTMLElement>(
    ".aui-thread-viewport-footer div.empty\\:hidden"
  )
  if (!slot) throw new Error("no tray slot")
  trayRoot ??= createRoot(slot)
  await act(async () =>
    trayRoot?.render(
      createElement(TrayFrame, {
        question: "How can customers reach you?",
        page: { index, total: 3 },
        collapsed: false,
        onCollapsedChange: () => undefined,
        onBack: () => undefined,
        onForward: () => undefined,
        // biome-ignore lint/correctness/noChildrenProp: the frame requires children as a prop, which createElement's rest argument does not satisfy
        children: createElement("div", { key: index }, `Page ${index + 1}`),
      })
    )
  )
}
let trayRoot: Root | undefined

it("logs no resize loop as the tray eases to the next page", async () => {
  await sendAndReply("u1")
  await showTray(0, 187)
  await frames(GLIDE_FRAMES * 2)
  loops = 0
  await showTray(1, 249)
  await frames(TRAY_EASE_FRAMES + 4)
  // The footer grew over those frames, a few pixels at a time.
  expect(footerHeight()).toBe(80 + TRAY_CHROME + 249)
  expect(loops).toBe(0)
  await showTray(2, 120)
  await frames(TRAY_EASE_FRAMES + 4)
  expect(loops).toBe(0)
})
