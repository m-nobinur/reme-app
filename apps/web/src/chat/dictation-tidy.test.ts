// @vitest-environment happy-dom
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, expect, it, vi } from "vitest"

const tidyDictation = vi.fn()
vi.mock("@/lib/api/server", () => ({
  getDictationSocket: vi.fn(),
  tidyDictation: (input: unknown) => tidyDictation(input),
}))

const { RelayDictationAdapter } = await import("./dictation")
const { DictationTidy, dictatedSpan, tidyDictated } = await import(
  "./dictation-tidy"
)

/** The composer's field as a string the test holds. */
const field = (text: string, dictating = false) => {
  const held = { text, writes: 0, dictating }
  return {
    held,
    read: () => held.text,
    write: (next: string) => {
      held.text = next
      held.writes++
    },
    dictating: () => held.dictating,
  }
}

const NOISY = "um book a clean for thursday no wait friday"

beforeEach(() => {
  tidyDictation.mockReset()
})

it("finds the last unbroken run of dictated phrases, and none that were edited away", () => {
  const phrases = ["um book it", "for friday no wait saturday"]
  expect(dictatedSpan(`Hi. ${phrases.join(" ")}`, phrases)).toBe(
    phrases.join(" ")
  )
  // Typing between the two breaks the run: only the phrases after it count.
  expect(
    dictatedSpan("um book it please for friday no wait saturday", phrases)
  ).toBe("for friday no wait saturday")
  expect(dictatedSpan("something else entirely", phrases)).toBeNull()
  expect(dictatedSpan("anything", [])).toBeNull()
})

it("replaces the dictated words in place and leaves what was typed exactly as typed", async () => {
  const f = field(`Hi Reme,  ${NOISY}  thanks!`)
  const tidy = vi.fn(async () => "Book a clean for Friday.")
  await tidyDictated(f, [NOISY], tidy)
  expect(tidy).toHaveBeenCalledExactlyOnceWith(NOISY)
  expect(f.held.text).toBe("Hi Reme,  Book a clean for Friday.  thanks!")
})

it("tidies only the words after the last thing typed among them", async () => {
  const first = "um hello there"
  const second = "uh book a clean"
  const f = field(`${first} (typed) ${second}`)
  const tidy = vi.fn(async () => "Book a clean.")
  await tidyDictated(f, [first, second], tidy)
  expect(tidy).toHaveBeenCalledExactlyOnceWith(second)
  expect(f.held.text).toBe(`${first} (typed) Book a clean.`)
})

it("skips a short message with no filler or correction, with no request", async () => {
  const f = field("Book a clean for Friday.")
  const tidy = vi.fn(async () => "never")
  await tidyDictated(f, ["Book a clean for Friday."], tidy)
  expect(tidy).not.toHaveBeenCalled()
  expect(f.held.writes).toBe(0)
})

it("leaves the live text, silently, when the pass says nothing, fails or runs past its time", async () => {
  for (const tidy of [
    async () => null,
    async () => {
      throw new Error("503")
    },
    () => new Promise<string | null>(() => undefined),
  ]) {
    const f = field(NOISY)
    await tidyDictated(f, [NOISY], tidy, 20)
    expect(f.held.text).toBe(NOISY)
    expect(f.held.writes).toBe(0)
  }
})

it("drops an answer that comes after the words were edited or a new dictation began", async () => {
  const edited = field(NOISY)
  await tidyDictated(edited, [NOISY], async () => {
    edited.held.text = "Something else"
    return "Book a clean for Friday."
  })
  expect(edited.held.text).toBe("Something else")

  const again = field(NOISY)
  await tidyDictated(again, [NOISY], async () => {
    again.held.dictating = true
    return "Book a clean for Friday."
  })
  expect(again.held.text).toBe(NOISY)
})

// The composer end: assistant-ui's own composer, the adapter's own stop.
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket {
  readyState = 0
  binaryType = ""
  private handlers: Record<string, ((event: unknown) => void)[]> = {}
  send = () => undefined
  close = () => {
    this.readyState = 3
  }
  addEventListener = (type: string, handler: (event: unknown) => void) => {
    this.handlers[type] = [...(this.handlers[type] ?? []), handler]
  }
  fire(type: string, event: object = {}) {
    if (type === "open") this.readyState = 1
    for (const handler of this.handlers[type] ?? []) handler(event)
  }
  say(frame: object) {
    this.fire("message", { data: JSON.stringify(frame) })
  }
}

async function mounted() {
  const socket = new FakeSocket()
  const adapter = new RelayDictationAdapter({
    socket: async () => "wss://api.test/dictate?ticket=t",
    microphone: async () => ({ stop: () => undefined }),
    connect: (() => socket) as never,
    supported: () => true,
  })
  let runtime: AssistantRuntime | undefined
  const Probe = () => {
    runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => undefined,
      adapters: { dictation: adapter },
    })
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(DictationTidy, { adapter })
    )
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(createElement(Probe)))
  const composer = () => (runtime as AssistantRuntime).thread.composer
  composer().setText("Hi Reme,")
  await act(async () => composer().startDictation())
  await vi.waitFor(() => expect(socket.readyState).toBe(0))
  await act(async () => socket.fire("open"))
  await act(async () => socket.say({ type: "final", text: "um book a clean" }))
  await act(async () =>
    socket.say({ type: "final", text: "for thursday no wait friday" })
  )
  return { socket, composer, root }
}

it("tidies on stop: the span, not the typed start, replaced in the composer", async () => {
  tidyDictation.mockResolvedValue("Book a clean for Friday.")
  const { socket, composer, root } = await mounted()
  expect(composer().getState().text).toBe(
    "Hi Reme, um book a clean for thursday no wait friday"
  )
  await act(async () => composer().stopDictation())
  await act(async () => socket.fire("close", { code: 1000 }))
  await vi.waitFor(() =>
    expect(composer().getState().text).toBe("Hi Reme, Book a clean for Friday.")
  )
  expect(tidyDictation).toHaveBeenCalledExactlyOnceWith({
    data: { text: "um book a clean for thursday no wait friday" },
  })
  await act(async () => root.unmount())
})

it("asks for nothing when the dictation is cancelled, as sending the message does", async () => {
  const { composer, root } = await mounted()
  await act(async () => composer().send())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(tidyDictation).not.toHaveBeenCalled()
  expect(composer().getState().dictation).toBeUndefined()
  await act(async () => root.unmount())
})

it("keeps the live text when the pass fails", async () => {
  tidyDictation.mockRejectedValue(new Error("502"))
  const { socket, composer, root } = await mounted()
  await act(async () => composer().stopDictation())
  await act(async () => socket.fire("close", { code: 1000 }))
  await vi.waitFor(() => expect(tidyDictation).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(composer().getState().text).toBe(
    "Hi Reme, um book a clean for thursday no wait friday"
  )
  await act(async () => root.unmount())
})
