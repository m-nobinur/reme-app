import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  LinkBreakIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react"
import type {
  ChannelLink,
  ChannelLinkStarted,
  ChannelsState,
} from "@workspace/contracts"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { ConnectRow, ConnectRows } from "@workspace/ui/components/connect-row"
import { QrCode } from "@workspace/ui/components/qr-code"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import { useCallback, useEffect, useId, useState } from "react"
import {
  disconnectChannel,
  getChannels,
  setChannelUpdates,
  startWhatsAppLink,
} from "@/lib/api/server"

type WhatsApp = ChannelsState["whatsapp"]

/** How often the QR screen asks whether the owner's phone has connected. */
const POLL_MS = 2_000

const NOTE = "max-w-prose text-muted-foreground"

/** What the owner's settings know about the channels; the section is there only when `available`. */
export function useChannels() {
  const [channels, setChannels] = useState<ChannelsState | null>(null)
  const refresh = useCallback(async () => {
    try {
      setChannels(await getChannels())
    } catch {
      // Keep what is shown; the next open of the section reads again.
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { channels, setChannels, refresh }
}

function Failed({ children }: { children: string }) {
  return (
    <p className="text-destructive" role="alert">
      {children}
    </p>
  )
}

/**
 * The code's screen. It asks for a code on opening and again on "New code",
 * and watches for a new link while the code lives: a link beyond the ones
 * there were when it opened means the owner's phone sent it.
 */
export function LinkScreen({
  known,
  onBack,
  onConnected,
}: {
  /** How many chats were linked when the screen opened. */
  known: number
  onBack: () => void
  onConnected: (state: ChannelsState) => void
}) {
  const [started, setStarted] = useState<ChannelLinkStarted | null>(null)
  const [failed, setFailed] = useState(false)
  const [expired, setExpired] = useState(false)
  const [round, setRound] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the "New code" press.
  useEffect(() => {
    let live = true
    setStarted(null)
    setFailed(false)
    setExpired(false)
    startWhatsAppLink()
      .then((next) => {
        if (!live) return
        setStarted(next)
        setFailed(next === null)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [round])

  useEffect(() => {
    if (!started || expired) return
    let live = true
    let reading = false
    const left = Date.parse(started.expires_at) - Date.now()
    const end = setTimeout(() => setExpired(true), Math.max(left, 0))
    const poll = setInterval(async () => {
      if (reading) return
      reading = true
      try {
        const next = await getChannels()
        if (live && next && next.whatsapp.links.length > known) {
          onConnected(next)
        }
      } catch {
        // The next tick asks again.
      } finally {
        reading = false
      }
    }, POLL_MS)
    return () => {
      live = false
      clearTimeout(end)
      clearInterval(poll)
    }
  }, [started, expired, known, onConnected])

  const dead = failed || expired
  return (
    <div className="flex max-w-prose flex-col items-start gap-4">
      <Button onClick={onBack} size="sm" variant="ghost">
        <CaretLeftIcon aria-hidden />
        Back
      </Button>
      <p>
        Scan this code with your phone's camera to chat with Reme on WhatsApp.
        Reme only sees the messages you send it, and you can disconnect at any
        time.
      </p>
      {dead ? (
        <>
          <p className="text-muted-foreground" role="status">
            {failed ? "Reme could not make a code." : "This code has expired."}
          </p>
          <Button onClick={() => setRound(round + 1)} variant="outline">
            <ArrowClockwiseIcon aria-hidden />
            New code
          </Button>
        </>
      ) : started ? (
        <>
          <QrCode
            className="hidden size-60 sm:block"
            label="Code to scan with your phone's camera"
            value={started.url}
          />
          <a
            className={cn(buttonVariants({ size: "lg" }), "w-full sm:hidden")}
            href={started.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <WhatsappLogoIcon aria-hidden />
            Open WhatsApp
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="text-muted-foreground text-sm">
            Anyone with this code can use Reme as you for the next 10 minutes.
            Don't share it.
          </p>
        </>
      ) : (
        <p className="text-muted-foreground" role="status">
          Making your code.
        </p>
      )}
    </div>
  )
}

/** One linked chat: its number, the updates switch and Disconnect. */
function LinkRow({
  link,
  onChanged,
}: {
  link: ChannelLink
  onChanged: () => Promise<void>
}) {
  const label = useId()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async (write: () => Promise<{ done: boolean }>) => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await write()
      if (result.done) await onChanged()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex max-w-prose flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <p className="font-medium">{link.label}</p>
      <div className="flex items-center justify-between gap-4">
        <span id={label}>Send updates here</span>
        <Switch
          aria-labelledby={label}
          checked={link.updates}
          disabled={busy}
          onCheckedChange={(updates) =>
            run(() => setChannelUpdates({ data: { id: link.id, updates } }))
          }
        />
      </div>
      <Button
        className="self-start"
        disabled={busy}
        onClick={() => run(() => disconnectChannel({ data: { id: link.id } }))}
        variant="outline"
      >
        <LinkBreakIcon aria-hidden />
        Disconnect
      </Button>
      {failed ? <Failed>That did not save. Try again.</Failed> : null}
    </li>
  )
}

/**
 * The Messaging channels page: WhatsApp on the business's own number. What
 * shows follows the account: no number yet, a number the owner has not
 * linked their phone to, or linked chats.
 */
export function MessagingChannels({
  whatsapp,
  onState,
  refresh,
}: {
  whatsapp: WhatsApp
  onState: (state: ChannelsState) => void
  refresh: () => Promise<void>
}) {
  const [linking, setLinking] = useState(false)
  // The page opens on what the api says now, not what was read at sign-in.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const { account, links } = whatsapp
  if (linking) {
    return (
      <LinkScreen
        known={links.length}
        onBack={() => setLinking(false)}
        onConnected={(state) => {
          onState(state)
          setLinking(false)
        }}
      />
    )
  }
  if (!account) {
    return (
      <div className="flex flex-col gap-4">
        <p className={NOTE}>
          Talk to Reme in WhatsApp, on your business's own number.
        </p>
        <div className="max-w-md">
          <ConnectRows heading="Coming soon">
            <ConnectRow
              disabled
              line="Keep the number your customers already message"
              mark="whatsapp"
              name="Use my WhatsApp Business number"
            />
            <ConnectRow
              disabled
              line="Reme sets up a UK mobile number for you"
              mark="whatsapp"
              name="Get a new number"
            />
          </ConnectRows>
        </div>
      </div>
    )
  }
  if (account.status !== "active") {
    return (
      <p className={NOTE}>
        {account.status === "pending"
          ? `${account.display_number} is being set up with WhatsApp.`
          : `${account.display_number} is switched off in WhatsApp.`}
      </p>
    )
  }
  return (
    <div className="flex flex-col items-start gap-4">
      <p className={NOTE}>
        Reme answers on WhatsApp as {account.display_name},{" "}
        {account.display_number}.
      </p>
      {links.length > 0 ? (
        <ul className="flex w-full flex-col gap-3">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} onChanged={refresh} />
          ))}
        </ul>
      ) : (
        <Button onClick={() => setLinking(true)}>
          <WhatsappLogoIcon aria-hidden />
          Chat with Reme here
        </Button>
      )}
    </div>
  )
}
