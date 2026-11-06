import { afterEach, beforeEach, expect, it, vi } from "vitest"

const CONFIG = { appId: "100000000000001", configId: "200000000000002" }
const FINISH = {
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  data: { waba_id: "111", phone_number_id: "222", business_id: "333" },
}

type Respond = (response: { authResponse?: { code?: string } | null }) => void

/** A window with Meta's SDK stubbed: the script "loads" on append, and the test plays the popup. */
function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>()
  let respond: Respond = () => undefined
  const FB = {
    init: vi.fn(),
    login: vi.fn((callback: Respond, _options?: object) => {
      respond = callback
    }),
  }
  const scripts: { src?: string }[] = []
  const win = {
    FB,
    fbAsyncInit: undefined as (() => void) | undefined,
    document: {
      createElement: () => ({}) as HTMLScriptElement,
      head: {
        appendChild: (script: { src?: string }) => {
          scripts.push(script)
          queueMicrotask(() => win.fbAsyncInit?.())
          return script
        },
      },
    },
    addEventListener: (_type: string, listener: never) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: never) =>
      listeners.delete(listener),
  }
  const message = (origin: string, data: unknown) => {
    for (const listener of listeners) {
      listener({ origin, data: JSON.stringify(data) } as MessageEvent)
    }
  }
  return {
    win: win as unknown as Window,
    FB,
    scripts,
    listeners,
    message,
    answer: (code?: string) =>
      respond({ authResponse: code ? { code } : null }),
  }
}

const load = async () => await import("./whatsapp-signup")

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

it("loads the SDK once, starts it for the app, and opens the popup for Coexistence on v4 in the press itself", async () => {
  const page = fakeWindow()
  const { prepareEmbeddedSignup } = await load()
  const signup = await prepareEmbeddedSignup(CONFIG, page.win)
  await prepareEmbeddedSignup(CONFIG, page.win)
  expect(page.scripts.map((s) => s.src)).toEqual([
    "https://connect.facebook.net/en_US/sdk.js",
  ])
  expect(page.FB.init).toHaveBeenCalledWith({
    appId: CONFIG.appId,
    autoLogAppEvents: true,
    xfbml: true,
    version: "v27.0",
  })

  void signup.start()
  expect(page.FB.login).toHaveBeenCalledTimes(1)
  expect(page.FB.login.mock.calls[0]?.[1]).toEqual({
    config_id: CONFIG.configId,
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
      version: "v4",
    },
  })
})

it("gives the code and the ids whichever of the popup's two answers comes first", async () => {
  const { prepareEmbeddedSignup } = await load()
  const page = fakeWindow()
  const signup = await prepareEmbeddedSignup(CONFIG, page.win)
  const a = signup.start()
  page.message("https://www.facebook.com", FINISH)
  page.answer("AQB-code")
  expect(await a).toEqual({
    code: "AQB-code",
    waba_id: "111",
    phone_number_id: "222",
  })
  expect(page.listeners.size).toBe(0)

  const b = signup.start()
  page.answer("AQB-code")
  page.message("https://business.facebook.com", {
    ...FINISH,
    event: "FINISH",
  })
  expect(await b).toEqual({
    code: "AQB-code",
    waba_id: "111",
    phone_number_id: "222",
  })
})

it("resolves null when the popup is closed, by its own message or with no code", async () => {
  const { prepareEmbeddedSignup } = await load()
  const page = fakeWindow()
  const signup = await prepareEmbeddedSignup(CONFIG, page.win)
  const closed = signup.start()
  page.message("https://www.facebook.com", {
    type: "WA_EMBEDDED_SIGNUP",
    event: "CANCEL",
    data: { current_step: "PHONE_NUMBER_SETUP" },
  })
  expect(await closed).toBeNull()

  const bare = signup.start()
  page.answer()
  expect(await bare).toBeNull()
  expect(page.listeners.size).toBe(0)
})

it("ignores messages that are not from Meta or not about sign-up", async () => {
  const { prepareEmbeddedSignup } = await load()
  const page = fakeWindow()
  const done = (await prepareEmbeddedSignup(CONFIG, page.win)).start()
  page.message("https://evilfacebook.com", FINISH)
  page.message("https://www.facebook.com.evil.example", FINISH)
  page.message("https://www.facebook.com", { type: "OTHER", event: "FINISH" })
  page.answer("AQB-code")
  await vi.advanceTimersByTimeAsync(1_000)
  page.message("https://www.facebook.com", FINISH)
  expect(await done).toMatchObject({ waba_id: "111" })
})

it("rejects when the popup ends without a number, or its message never follows the code", async () => {
  const { prepareEmbeddedSignup } = await load()
  const page = fakeWindow()
  const signup = await prepareEmbeddedSignup(CONFIG, page.win)
  const noNumber = signup.start()
  page.message("https://www.facebook.com", {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH_ONLY_WABA",
    data: { waba_id: "111" },
  })
  await expect(noNumber).rejects.toThrow("did not give a number")

  const stalled = signup.start()
  const seen = expect(stalled).rejects.toThrow("never finished")
  page.answer("AQB-code")
  await vi.advanceTimersByTimeAsync(15_000)
  await seen
  expect(page.listeners.size).toBe(0)
})
