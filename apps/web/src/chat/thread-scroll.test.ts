// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
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
const isReserve = (el: Element) =>
  el.hasAttribute("data-aui-top-anchor-reserve")
const isFooter = (el: Element) =>
  el.classList.contains("aui-thread-viewport-footer")

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
  if (isFooter(el)) return layout.footer
  if (isViewport(el)) return layout.clientHeight
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
  return (box ? heightOf(box) : 0) + layout.footer
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
const writeScroll = (viewport: Element, top: number) => {
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
    ? Math.min(natural, layout.clientHeight - layout.footer)
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
      // A smooth scroll lands at once here; the frames sampled are where it settles.
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top !== undefined) writeScroll(this, options.top)
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

/** Resize observers fire after layout, for each target whose size changed. */
const observers = new Set<FakeResizeObserver>()
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
  /** Whether it fired. */
  deliver() {
    let changed = false
    for (const [el, last] of this.sizes) {
      const size = `${(el as HTMLElement).clientWidth}x${heightOf(el)}`
      if (size !== last) changed = true
      this.sizes.set(el, size)
    }
    if (changed) this.callback([], this as unknown as ResizeObserver)
    return changed
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
    for (const viewport of [...pendingScroll]) {
      pendingScroll.delete(viewport)
      viewport.dispatchEvent(new Event("scroll"))
    }
    const due = [...animation.values()]
    animation.clear()
    for (const callback of due) callback(clock)
    for (let round = 0; round < 10; round++) {
      let fired = false
      for (const observer of [...observers]) fired = observer.deliver() || fired
      if (!fired) break
    }
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
  layout = { clientHeight: 729, footer: 80, slot: 0, rows: new Map() }
  painted = []
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
  await act(async () => root.unmount())
  chat.remove()
  observers.clear()
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
