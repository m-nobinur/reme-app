import type { WhatsAppSignupComplete } from "@workspace/contracts"

/**
 * Meta's Embedded Signup popup, v4 with the WhatsApp Business app (Coexistence)
 * feature. `FB.login` gives a 30-second code; the popup's own message gives the
 * WABA and phone number ids. Both are needed, in either order.
 *
 * `prepare` loads the SDK ahead of time and `start` calls `FB.login` in the
 * same tick as the click: a popup opened after an await is blocked.
 */

const SDK = "https://connect.facebook.net/en_US/sdk.js"
const GRAPH_VERSION = "v27.0"
/** After the code, how long the popup's message may take to follow. */
const SESSION_WAIT_MS = 15_000

export type SignupConfig = { appId: string; configId: string }

type Login = (
  respond: (response: { authResponse?: { code?: string } | null }) => void,
  options: object
) => void
type Facebook = { init: (options: object) => void; login: Login }
type SdkWindow = Window & {
  FB?: Facebook
  fbAsyncInit?: () => void
}

export type Signup = {
  /** The popup's result, or null when it was closed before the end. */
  start: () => Promise<WhatsAppSignupComplete | null>
}

let loading: Promise<Facebook> | undefined

function loadSdk(appId: string, win: SdkWindow): Promise<Facebook> {
  loading ??= new Promise<Facebook>((resolve, reject) => {
    win.fbAsyncInit = () => {
      const fb = win.FB as Facebook
      fb.init({
        appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: GRAPH_VERSION,
      })
      resolve(fb)
    }
    const script = win.document.createElement("script")
    script.src = SDK
    script.async = true
    script.onerror = () => {
      loading = undefined
      reject(new Error("The Facebook SDK did not load."))
    }
    win.document.head.appendChild(script)
  })
  return loading
}

const fromMeta = (origin: string) => {
  try {
    const { hostname } = new URL(origin)
    return hostname === "facebook.com" || hostname.endsWith(".facebook.com")
  } catch {
    return false
  }
}

export async function prepareEmbeddedSignup(
  config: SignupConfig,
  win: SdkWindow = window
): Promise<Signup> {
  const fb = await loadSdk(config.appId, win)
  return {
    start: () =>
      new Promise((resolve, reject) => {
        let code: string | null | undefined
        let session: { waba_id: string; phone_number_id: string } | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const end = (done: () => void) => {
          clearTimeout(timer)
          win.removeEventListener("message", onMessage)
          done()
        }
        const settle = () => {
          if (code === null) return end(() => resolve(null))
          const done = code && session ? { code, ...session } : null
          if (done) end(() => resolve(done))
        }
        const onMessage = (event: MessageEvent) => {
          if (!fromMeta(event.origin)) return
          let message: {
            type?: string
            event?: string
            data?: Record<string, unknown>
          }
          try {
            message =
              typeof event.data === "string"
                ? JSON.parse(event.data)
                : event.data
          } catch {
            return
          }
          if (message?.type !== "WA_EMBEDDED_SIGNUP") return
          const { waba_id, phone_number_id } = message.data ?? {}
          if (
            (message.event === "FINISH" ||
              message.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") &&
            typeof waba_id === "string" &&
            typeof phone_number_id === "string"
          ) {
            session = { waba_id, phone_number_id }
            settle()
          } else if (message.event === "CANCEL") {
            end(() => resolve(null))
          } else {
            end(() => reject(new Error("The sign-up did not give a number.")))
          }
        }
        win.addEventListener("message", onMessage)
        fb.login(
          (response) => {
            code = response.authResponse?.code ?? null
            if (code && !session) {
              timer = setTimeout(
                () =>
                  end(() => reject(new Error("The sign-up never finished."))),
                SESSION_WAIT_MS
              )
            }
            settle()
          },
          {
            config_id: config.configId,
            response_type: "code",
            override_default_response_type: true,
            extras: {
              setup: {},
              featureType: "whatsapp_business_app_onboarding",
              sessionInfoVersion: "3",
              version: "v4",
            },
          }
        )
      }),
  }
}
