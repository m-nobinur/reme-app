// @vitest-environment happy-dom
import {
  type AskDesignInput,
  type AskDesignOutput,
  type Asset,
  type DrawLogosRequest,
  LOGO_VARIANTS,
  type LogoRound,
  PALETTES,
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
        preselected: ["create"],
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
const roundOf = (round: number, brief: LogoRound["brief"]): LogoRound => ({
  round,
  status: "ready",
  variants: Array.from({ length: LOGO_VARIANTS }, (_, at) => ({
    id: uuid(round * 10 + at),
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

/** Services that draw a ready round at once from the brief asked for. */
function fakes(given: LogoRound[] = []) {
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
      const round = roundOf(rounds.length + 1, request.brief)
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
        (each.tagName === "LABEL" && each.textContent?.startsWith(name))
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

it("asks whether they have a logo on its own page, then shows the designs with no logo row", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  expect(tray.header()).toBe("Do you have a logo?")
  expect(tray.designs()).toBeNull()

  await tray.press("No, create one for me")
  expect(tray.header()).toBe("Your logo")
  expect(tray.designs()).not.toBeNull()
  expect(tray.container.textContent).not.toContain("No, create one for me")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(10)]))
})

it("going back to the designs draws them at once, with no yes or no first and nothing read", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  await tray.press("No, create one for me")
  await vi.waitFor(() =>
    expect(tray.designs()?.querySelector("input:checked")).not.toBeNull()
  )
  await tray.press("Next")
  expect(tray.header()).toBe("Which lettering suits you?")

  // Reads from here on never answer, so what shows is what the page held.
  fake.services.logoRounds = () => new Promise(() => undefined)
  await tray.press("Previous question")
  expect(tray.header()).toBe("Your logo")
  expect(tray.container.textContent).not.toContain("Yes, I have my logo")
  const shown = tray.designs()
  expect(shown?.closest("[style*='display: none']")).toBeNull()
  expect(shown?.querySelector("input:checked")).not.toBeNull()
  expect(shown?.querySelector("img")?.getAttribute("alt")).toBe("Design 1")
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

  await tray.press("Next question")
  expect(fake.drawn).toHaveLength(1)
  expect(tray.header()).toBe("Your logo")
  await vi.waitFor(() => expect(fake.kept).toEqual([uuid(20)]))
  await vi.waitFor(() => expect(tray.control("Next")).toBeDefined())
  expect(tray.control("Redesign my logo")).toBeUndefined()

  await tray.press("Next question")
  expect(tray.header()).toBe("Which lettering suits you?")
  expect(fake.drawn).toHaveLength(1)
})

it("Pick for me keeps the pick on the page, unsaved, and the logo held", async () => {
  const fake = fakes()
  const tray = await render(fake.services, {
    start: { index: 2, answers: { logo: { logo: logo(uuid(10)) } } },
  })
  await tray.press("Serif")
  await tray.press("Pick for me")
  expect(tray.onFinish).toHaveBeenCalledWith({
    answers: { logo: { logo: logo(uuid(10)) }, lettering: { choice: "serif" } },
    skip_all: true,
  })
  expect(fake.drawn).toHaveLength(0)
})

it("Pick for me draws a changed logo brief first and finishes on its first design", async () => {
  const fake = fakes([OLD])
  const tray = await render(fake.services, {
    start: {
      index: 1,
      answers: { logo: { logo: logo(uuid(10)) } },
      logo: { path: "create" },
    },
  })
  await vi.waitFor(() => expect(tray.control("Redesign my logo")).toBeDefined())
  await tray.press("Pick for me")
  await vi.waitFor(() => expect(tray.onFinish).toHaveBeenCalledOnce())
  expect(fake.drawn).toHaveLength(1)
  expect(tray.onFinish.mock.calls[0]?.[0]).toEqual({
    answers: { logo: { logo: logo(uuid(20)) } },
    skip_all: true,
  })
})

it("Pick for me with nothing picked takes the first design drawn", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  await tray.press("Pick for me")
  await vi.waitFor(() => expect(tray.onFinish).toHaveBeenCalledOnce())
  expect(tray.onFinish.mock.calls[0]?.[0].answers.logo).toEqual({
    logo: logo(uuid(10)),
  })
})

it("Pick for me after Yes keeps the upload and waits for the logo", async () => {
  const fake = fakes()
  const tray = await render(fake.services)
  await vi.waitFor(() => expect(fake.drawn).toHaveLength(1))
  await tray.press("Yes, I have my logo")
  await tray.press("Pick for me")
  expect(tray.header()).toBe("Your logo")
  expect(tray.container.textContent).toContain("Drop your logo here")
  expect(tray.container.textContent).toContain(
    "I need your logo file to finish"
  )
  await act(async () => undefined)
  expect(fake.kept).toEqual([])
  expect(tray.onFinish).not.toHaveBeenCalled()
})
