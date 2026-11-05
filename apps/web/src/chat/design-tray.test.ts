// @vitest-environment happy-dom
import {
  type AskDesignInput,
  type AskDesignOutput,
  type Asset,
  CALM_PALETTES,
  type DrawLogosRequest,
  LOGO_VARIANTS,
  type LogoChip,
  type LogoPalettes,
  type LogoRound,
  type LogoStyle,
  PALETTES,
  type PaletteFromImage,
} from "@workspace/contracts"
import { QuestionTray } from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayServices,
  TrayServicesProvider,
} from "@workspace/ui/components/assistant/tray-services"
import { act, type ComponentProps, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The design tray's logo pages against fake services, so no logo is ever
 * drawn: whether they have a logo is a page of its own, going back finds the
 * designs as they were, a changed brief is drawn before moving on, and Pick
 * for me keeps what the owner chose.
 */

const INPUT: AskDesignInput = {
  questions: [
    {
      id: "logo",
      question: "Do you have a logo?",
      visual: "logo",
      card: {
        step: "template",
        options: [
          {
            id: "upload",
            label: "Yes, I have my logo",
            hint: null,
            visual: null,
          },
          {
            id: "create",
            label: "No, create one for me",
            hint: null,
            visual: null,
          },
        ],
        multiple: false,
        preselected: [],
        other: null,
        skippable: false,
      },
      upload: {
        accept: ["image/png"],
        max_files: 1,
        max_bytes: 1_000_000,
        skippable: false,
      },
    },
    {
      id: "lettering",
      question: "Which lettering suits you?",
      visual: "text",
      card: {
        step: "font",
        options: [
          { id: "plain", label: "Plain", hint: null, visual: null },
          { id: "serif", label: "Serif", hint: null, visual: null },
        ],
        multiple: false,
        preselected: [],
        other: null,
        skippable: true,
      },
    },
  ],
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const logo = (id: string): Asset => ({
  id,
  name: "Logo.png",
  content_type: "image/png",
  bytes: 100,
  use: "logo",
})
const roundOf = (
  round: number,
  brief: LogoRound["brief"],
  directions?: DrawLogosRequest["directions"],
  chips?: LogoChip[]
): LogoRound => ({
  round,
  status: "ready",
  started_at: new Date().toISOString(),
  variants: Array.from({ length: LOGO_VARIANTS }, (_, at) => ({
    id: uuid(round * 10 + at),
    direction: directions?.[at] ?? {
      type: brief.type,
      style: (brief.style === "surprise"
        ? "minimal"
        : brief.style) as LogoStyle,
    },
    ...(chips ? { chips } : {}),
  })),
  brief,
})
/** A round drawn from a brief the tray no longer holds. */
const OLD = roundOf(1, {
  description: "",
  colors: [...(PALETTES[1]?.swatches.slice(2) ?? [])],
  type: "emblem",
  style: "retro",
})

/** Services that draw a ready round at once from the brief asked for, with `chips` on each design. */
function fakes(given: LogoRound[] = [], chips?: LogoChip[]) {
  const rounds = [...given]
  const drawn: DrawLogosRequest[] = []
  const kept: string[] = []
  let reads = 0
  const services: TrayServices = {
    upload: () => Promise.reject(new Error("Not here")),
    reviewPhotos: () => Promise.reject(new Error("Not here")),
    paletteFromImage: () => Promise.reject(new Error("Not here")),
    logoPalettes: async () => ({ palettes: [] }),
    drawLogos: async (request) => {
      drawn.push(request)
      const round = roundOf(
        rounds.length + 1,
        request.brief,
        request.directions,
        chips
      )
      rounds.push(round)
      return round
    },
    logoRounds: async () => {
      reads += 1
      return { rounds: [...rounds] }
    },
    keepLogo: async (id) => {
      kept.push(id)
      return { asset: logo(id) }
    },
    imageUrl: (id) => `/images/${id}`,
  }
  return { services, drawn, kept, reads: () => reads }
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  vi.stubGlobal("matchMedia", () => ({ matches: true }))
  HTMLElement.prototype.checkVisibility ??= () => true
})

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

let calls = 0
async function render(
  services: TrayServices,
  props: Partial<ComponentProps<typeof QuestionTray>> = {}
) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const onFinish = vi.fn<(output: AskDesignOutput) => void>()
  calls += 1
  await act(async () =>
    root.render(
      createElement(
        TrayServicesProvider,
        { value: services },
        createElement(QuestionTray, {
          input: INPUT,
          onFinish,
          toolCallId: `call-${calls}`,
          ...props,
        })
      )
    )
  )
  unmount = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  const header = () => container.querySelector("h2")?.textContent
  const control = (name: string) =>
    [...container.querySelectorAll<HTMLElement>("button, label")].find(
      (each) =>
        each.getAttribute("aria-label") === name ||
        each.textContent?.trim() === name ||
        ((each.tagName === "LABEL" || each.hasAttribute("aria-pressed")) &&
          each.textContent?.startsWith(name))
    )
  const press = (name: string) =>
    act(async () => {
      const found = control(name)
      if (!found) throw new Error(`No ${name} in the tray`)
      ;(found.querySelector("input") ?? found).click()
    })
  const designs = () =>
    container.querySelector<HTMLElement>('[aria-label="Logo designs"]')
  return { container, header, control, press, designs, onFinish }
}

it("asks whether they have a logo on its own page, draws only on No, then shows the designs with no logo row", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  expect(tray.header()).toBe("Do you have a logo?")
  expect(tray.designs()).toBeNull()
  expect(fake.drawn).toHaveLength(0)

  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  expect(tray.header()).toBe("Pick your logo")
  expect(tray.designs()).not.toBeNull()
  expect(tray.container.textContent).not.toContain("No, create one for me")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
})

it("opens on the way the owner chose in words: the designs on create, the drop zone on upload", async () => {
  const withPath = (path: "upload" | "create"): AskDesignInput => ({
    questions: INPUT.questions.map((q) =>
      q.visual === "logo" ? { ...q, path } : q
    ),
  })
  const fake = fakes()
  const made = await render(fake.services, { input: withPath("create") })
  await vi.waitFor(() => expect(made.header()).toBe("Pick your logo"))
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
  expect(made.designs()).not.toBeNull()
  expect(made.container.textContent).not.toContain("Drop your logo")
  await unmount?.()

  const own = await render(fakes().services, { input: withPath("upload") })
  expect(own.header()).toBe("Your logo")
  expect(own.container.textContent).toContain(
    "Drop your logo here or choose it"
  )
})

it("going back to the designs draws them at once, with no yes or no first and nothing read", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  await vi.waitFor(() =>
    expect(tray.designs()?.querySelector("input:checked")).not.toBeNull()
  )
  await vi.waitFor(() => expect(tray.control("Next")).toBeDefined())
  await tray.press("Next")
  expect(tray.header()).toBe("Which lettering suits you?")

  // Reads from here on never answer, so what shows is what the page held.
  fake.services.logoRounds = () => new Promise(() => undefined)
  await tray.press("Previous question")
  expect(tray.header()).toBe("Pick your logo")
  expect(tray.container.textContent).not.toContain("Yes, I have my logo")
  const shown = tray.designs()
  expect(shown?.closest("[style*='display: none']")).toBeNull()
  expect(shown?.querySelector("input:checked")).not.toBeNull()
  expect(shown?.querySelector("img")?.getAttribute("alt")).toBe(
    "Design 1, symbol and name"
  )
})

it("draws a changed brief before moving on, then moves on from the new round", async () => {
  const fake = fakes([OLD])
  const tray = await render(fake.services, {
    start: {
      index: 1,
      answers: { logo: { logo: logo(uuid(10)) } },
      logo: { path: "create" },
    },
  })
  await vi.waitFor(() => expect(tray.control("Redesign my logo")).toBeDefined())

  await tray.press("Redesign my logo")
  expect(fake.drawn).toHaveLength(1)
  expect(tray.header()).toBe("Pick your logo")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(20)]))
  await vi.waitFor(() => expect(tray.control("Next")).toBeDefined())
  expect(tray.control("Redesign my logo")).toBeUndefined()

  await tray.press("Next")
  expect(tray.header()).toBe("Which lettering suits you?")
  expect(fake.drawn).toHaveLength(1)
})

it("Pick for me shows only while the page is empty, and keeps the logo held", async () => {
  const fake = fakes()
  const tray = await render(fake.services, {
    start: { index: 2, answers: { logo: { logo: logo(uuid(10)) } } },
  })
  await tray.press("Pick for me")
  expect(tray.onFinish).toHaveBeenCalledWith({
    answers: { logo: { logo: logo(uuid(10)) } },
    skip_all: true,
  })
  expect(fake.drawn).toHaveLength(0)
  await tray.press("Serif")
  expect(tray.control("Pick for me")).toBeUndefined()
})

it("Pick for me leaves a logo page that holds a logo", async () => {
  const fake = fakes([OLD])
  const tray = await render(fake.services, {
    start: {
      index: 1,
      answers: { logo: { logo: logo(uuid(10)) } },
      logo: { path: "create" },
    },
  })
  await vi.waitFor(() => expect(tray.control("Redesign my logo")).toBeDefined())
  expect(tray.control("Pick for me")).toBeUndefined()
})

it("Pick for me with nothing picked takes the first design drawn", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await tray.press("Pick for me")
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  await vi.waitFor(() => expect(tray.onFinish).toHaveBeenCalledOnce())
  expect(tray.onFinish.mock.calls[0]?.[0].answers.logo).toEqual({
    logo: logo(uuid(10)),
  })
})

const DIRECTIONS = [
  { type: "lockup", style: "hand_drawn" },
  { type: "icon", style: "geometric" },
  { type: "emblem", style: "retro" },
] as const

/** The tray as the api opens it for Pruning Co: three directions and a look in the owner's words. */
const SUGGESTED: AskDesignInput = {
  questions: INPUT.questions.map((q) =>
    q.visual === "logo"
      ? {
          ...q,
          start: {
            directions: [...DIRECTIONS],
            description: "a neatly pruned tree",
          },
        }
      : q
  ),
}

const IDEAS: LogoChip[] = [
  { kind: "detail", label: "Fewer details", change: "fewer small details" },
  {
    kind: "style",
    label: "Old-school feel",
    change: "an old-school, heritage feel",
    set: { style: "retro" },
  },
]

it("answers the logo question on one tap: nothing picked first, no Next", async () => {
  const tray = await render(fakes().services)
  expect(tray.header()).toBe("Do you have a logo?")
  const way = tray.control("No, create one for me")
  expect(way?.getAttribute("aria-pressed")).toBe("false")
  expect(tray.control("Next")).toBeUndefined()
  await tray.press("No, create one for me")
  expect(tray.designs()).not.toBeNull()
})

it("draws one design per suggested direction first, each named by its kind and none captioned", async () => {
  const fake = fakes()
  const tray = await render(fake.services, { input: SUGGESTED })
  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  expect(fake.drawn[0]?.directions).toEqual(DIRECTIONS)
  expect(fake.drawn[0]?.brief).toMatchObject({
    description: "a neatly pruned tree",
    type: "lockup",
    style: "hand_drawn",
  })
  await vi.waitFor(() =>
    expect(tray.designs()?.querySelectorAll("img")).toHaveLength(3)
  )
  const names = [...(tray.designs()?.querySelectorAll("img") ?? [])].map(
    (each) => each.getAttribute("alt")
  )
  expect(names).toEqual([
    "Design 1, symbol and name",
    "Design 2, symbol only",
    "Design 3, badge",
  ])
  expect(tray.container.textContent).not.toContain("A badge for vans")
  expect(tray.container.textContent).not.toContain("Your brief")
  expect(tray.control("Change the brief")).toBeDefined()
})

it("says when the designs cannot be read, stops asking, and reads them on Try again", async () => {
  const fake = fakes([OLD])
  let reads = 0
  const api: { down: boolean } = { down: true }
  const services: TrayServices = {
    ...fake.services,
    logoRounds: async () => {
      reads += 1
      if (api.down) throw new Error("Not read")
      return fake.services.logoRounds("call")
    },
  }
  const tray = await render(services, { input: SUGGESTED })
  await tray.press("No, create one for me")
  await vi.waitFor(() =>
    expect(tray.container.textContent).toContain("Your designs did not load.")
  )
  expect(tray.designs()).toBeNull()
  expect(fake.drawn).toHaveLength(0)
  expect(tray.control("Redesign my logo")).toBeUndefined()
  const before = reads
  await new Promise((resolve) => setTimeout(resolve, 2800))
  expect(reads).toBe(before)

  api.down = false
  await tray.press("Try again")
  await vi.waitFor(() => expect(tray.designs()).not.toBeNull())
  expect(tray.container.textContent).not.toContain("did not load")
  expect(fake.drawn).toHaveLength(0)
})

it("an idea adds its words and sets its option, a second tap takes both back, and Redesign sends them on the picked design", async () => {
  const fake = fakes([], IDEAS)
  const tray = await render(fake.services, { input: SUGGESTED })
  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
  await vi.waitFor(() => expect(tray.control("Old-school feel")).toBeDefined())
  const field = () =>
    tray.container.querySelector<HTMLTextAreaElement>("textarea")
  const retro = () =>
    tray.container.querySelector<HTMLInputElement>(
      'input[type="radio"][name$="-style"]:checked'
    )

  await tray.press("Old-school feel")
  expect(tray.control("Old-school feel")?.getAttribute("aria-pressed")).toBe(
    "true"
  )
  expect(field()?.value).toBe("an old-school, heritage feel")
  expect(retro()?.closest("label")?.textContent).toContain("Retro")
  await vi.waitFor(() => expect(tray.control("Redesign my logo")).toBeDefined())

  await tray.press("Old-school feel")
  expect(field()?.value).toBe("")
  expect(retro()?.closest("label")?.textContent).toContain("Hand-drawn")

  await tray.press("Fewer details")
  // The old label fades out over a moment before the button reads Redesign my logo alone.
  await vi.waitFor(() => expect(tray.control("Redesign my logo")).toBeDefined())
  await tray.press("Redesign my logo")
  expect(fake.drawn.at(-1)).toMatchObject({
    changes: "fewer small details",
    base: uuid(10),
  })
  expect(fake.drawn.at(-1)?.directions).toBeUndefined()
})

it("offers the fixed ideas when the picked design's own are late", async () => {
  const fake = fakes()
  const tray = await render(fake.services, { input: SUGGESTED })
  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
  expect(tray.control("Bolder")).toBeUndefined()
  await vi.waitFor(() => expect(tray.control("Bolder")).toBeDefined(), {
    timeout: 4000,
  })
  expect(tray.control("Different icon")).toBeDefined()
  expect(tray.control("Other colours")).toBeDefined()
})

it("Change the brief opens the brief on What should change?, with the field focused", async () => {
  const fake = fakes()
  const tray = await render(fake.services, { input: SUGGESTED })
  await tray.press("No, create one for me")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
  await tray.press("Change the brief")
  const field = tray.container.querySelector<HTMLTextAreaElement>("textarea")
  expect(field?.placeholder).toBe(
    "For example: bolder lettering, a leaf instead of a tree, darker green"
  )
  expect(field?.getAttribute("rows")).toBe("2")
  expect(
    tray.container.querySelector(`label[for="${field?.id}"]`)?.textContent
  ).toBe("What should change?")
  await vi.waitFor(() => expect(document.activeElement).toBe(field))
})

it("shows four fitted letterings, none tagged, and all of them on More styles", async () => {
  const pairs = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ({
    id,
    label: `Pair ${id}`,
    hint: null,
    visual: null,
  }))
  const lettering: AskDesignInput = {
    questions: [
      {
        id: "lettering",
        question: "Which lettering do you prefer?",
        visual: "font_pair",
        card: {
          step: "font",
          options: pairs,
          initial: ["a", "b", "c", "d"],
          multiple: false,
          preselected: ["a"],
          other: null,
          skippable: true,
        },
        suggested: "a",
      },
    ],
  }
  const tray = await render(fakes().services, {
    input: lettering,
    businessName: "Pruning Co",
  })
  const radios = () => tray.container.querySelectorAll('input[type="radio"]')
  expect(radios()).toHaveLength(4)
  expect(tray.container.textContent).not.toContain("Suggested for")
  await tray.press("More styles")
  expect(radios()).toHaveLength(8)
  expect(tray.control("More styles")).toBeUndefined()
})

it("Pick for me after Yes keeps the upload, draws nothing and waits for the logo", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await tray.press("Yes, I have my logo")
  await tray.press("Pick for me")
  expect(tray.header()).toBe("Your logo")
  expect(tray.container.textContent).toContain("Drop your logo here")
  expect(tray.container.textContent).toContain(
    "I need your logo file to finish"
  )
  await act(async () => undefined)
  expect(fake.kept).toEqual([])
  expect(fake.drawn).toHaveLength(0)
  expect(tray.onFinish).not.toHaveBeenCalled()
})

const FROM_LOGO: PaletteFromImage[] = PALETTES.slice(4, 10).map(
  ({ label, swatches: [paper = "", tint = "", primary = "", ink = ""] }) => ({
    name: label,
    stops: { paper, tint, primary, ink },
  })
)

const WITH_PALETTE: AskDesignInput = {
  questions: [
    ...INPUT.questions.slice(0, 1),
    {
      id: "palette",
      question: "Which colour palette feels right?",
      visual: "palette",
      card: {
        step: "palette",
        options: PALETTES.slice(0, 4).map((each) => ({
          id: each.id,
          label: each.label,
          hint: null,
          visual: { kind: "swatches", colors: [...each.swatches] },
        })),
        initial: CALM_PALETTES.slice(0, 4),
        multiple: false,
        preselected: [],
        other: null,
        skippable: false,
      },
    },
  ],
} as AskDesignInput

it("shows each palette read from the logo as it arrives, and the loading state only until the first", async () => {
  let arrived: (palettes: PaletteFromImage[]) => void = () => undefined
  let finished: (read: LogoPalettes) => void = () => undefined
  const fake = fakes()
  fake.services.logoPalettes = (_id, onPalettes) => {
    arrived = onPalettes
    return new Promise((resolve) => {
      finished = resolve
    })
  }
  const tray = await render(fake.services, {
    input: WITH_PALETTE,
    start: { index: 2, answers: { logo: { logo: logo(uuid(10)) } } },
  })
  const tiles = () =>
    tray.container.querySelectorAll('[role="radiogroup"] input[type="radio"]')
  const surprise = () =>
    [...tray.container.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === "Surprise me"
    )
  const waiting = () =>
    tray.container.querySelectorAll('[role="radiogroup"] > span[aria-hidden]')
  expect(tray.container.textContent).toContain(
    "Reading the colours in your logo"
  )
  expect(tiles()).toHaveLength(0)

  await act(async () => arrived(FROM_LOGO.slice(0, 1)))
  expect(tray.container.textContent).not.toContain(
    "Reading the colours in your logo"
  )
  expect(tiles()).toHaveLength(1)
  expect(waiting()).toHaveLength(3)
  expect(surprise()).toBeUndefined()

  await act(async () => arrived(FROM_LOGO.slice(0, 3)))
  expect(tiles()).toHaveLength(3)
  expect(waiting()).toHaveLength(1)

  await act(async () => arrived(FROM_LOGO.slice(0, 5)))
  await act(async () => finished({ palettes: FROM_LOGO }))
  expect(tiles()).toHaveLength(4)
  expect(waiting()).toHaveLength(0)
  expect(surprise()).toBeDefined()
})

it("lets the owner pick the first palette while the rest are still being read", async () => {
  const fake = fakes()
  fake.services.logoPalettes = (_id, onPalettes) => {
    onPalettes(FROM_LOGO.slice(0, 1))
    return new Promise(() => undefined)
  }
  const tray = await render(fake.services, {
    input: WITH_PALETTE,
    start: { index: 2, answers: { logo: { logo: logo(uuid(10)) } } },
  })
  await tray.press(FROM_LOGO[0]?.name ?? "")
  expect(
    tray.container.querySelector<HTMLInputElement>(
      `input[value="${FROM_LOGO[0]?.name}"]`
    )?.checked
  ).toBe(true)
})
