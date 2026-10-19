import { BellRingingIcon, BellSimpleSlashIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { useEffect, useState } from "react"
import {
  getPushKey,
  removePushSubscription,
  savePushSubscription,
} from "@/lib/api/server"

/**
 * The notifications switch in the owner's settings: web push to this browser
 * (ADR-043). The permission prompt opens only on the owner's click. The
 * service worker (`public/sw.js`) is registered then and not before, so a
 * visitor who never turns this on never gets one.
 */

type State =
  | "checking"
  | "unavailable"
  | "unsupported"
  | "blocked"
  | "off"
  | "on"

/** Where this browser keeps the id of its saved subscription, to remove it on a switch off. */
const STORE = "reme.push-subscription"

const supported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window

const remembered = (id?: string | null) => {
  try {
    if (id === undefined) return localStorage.getItem(STORE)
    if (id) localStorage.setItem(STORE, id)
    else localStorage.removeItem(STORE)
  } catch {
    // Storage may be blocked; the push service drops a dead endpoint on its own.
  }
  return null
}

async function current(): Promise<State> {
  if (!supported()) return "unsupported"
  if (!(await getPushKey())) return "unavailable"
  if (Notification.permission === "denied") return "blocked"
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ? "on" : "off"
}

async function enable(): Promise<State> {
  const permission = await Notification.requestPermission()
  if (permission !== "granted")
    return permission === "denied" ? "blocked" : "off"
  const key = await getPushKey()
  if (!key) return "unavailable"
  const registration = await navigator.serviceWorker.register("/sw.js")
  await navigator.serviceWorker.ready
  // A new address each time: this browser's old one may still sit on another
  // business's list, and a push to it would open here.
  await (await registration.pushManager.getSubscription())?.unsubscribe()
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  })
  const { endpoint, keys } = subscription.toJSON()
  const id =
    endpoint && keys?.p256dh && keys.auth
      ? await savePushSubscription({
          data: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
        })
      : null
  if (!id) {
    await subscription.unsubscribe()
    throw new Error("The subscription was not saved.")
  }
  remembered(id)
  return "on"
}

async function disable(): Promise<State> {
  const registration = await navigator.serviceWorker.getRegistration()
  await (await registration?.pushManager.getSubscription())?.unsubscribe()
  const id = remembered()
  if (id) await removePushSubscription({ data: { id } })
  remembered(null)
  return "off"
}

const NOTE = "max-w-prose text-muted-foreground"

export function PushControl() {
  const [state, setState] = useState<State>("checking")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void current()
      .catch((): State => "unavailable")
      .then((next) => live && setState(next))
    return () => {
      live = false
    }
  }, [])

  if (state === "checking" || state === "unavailable") return null
  if (state === "unsupported") {
    return (
      <p className={NOTE}>
        This browser cannot show notifications from Reme. On an iPhone or iPad,
        add Reme to your Home Screen first.
      </p>
    )
  }
  if (state === "blocked") {
    return (
      <p className={NOTE}>
        Notifications are blocked for Reme in this browser. Allow them in the
        browser's site settings, then come back here.
      </p>
    )
  }

  const on = state === "on"
  const change = async () => {
    setBusy(true)
    setFailed(false)
    try {
      setState(await (on ? disable() : enable()))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <p className={NOTE}>
        {on
          ? "This device gets a notification when Reme has something for you."
          : "Get a notification on this device when Reme has something for you, such as a reminder or a plan waiting on your yes. It stays quiet while Reme is open in front of you."}
      </p>
      <Button disabled={busy} onClick={change} variant="outline">
        {on ? (
          <BellSimpleSlashIcon aria-hidden />
        ) : (
          <BellRingingIcon aria-hidden />
        )}
        {on ? "Turn off notifications" : "Turn on notifications"}
      </Button>
      {failed ? (
        <p className="text-destructive" role="alert">
          Notifications did not change. Try again.
        </p>
      ) : null}
    </div>
  )
}
