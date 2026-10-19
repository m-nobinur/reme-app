import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { CaretLeftIcon, SignOutIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { closeOnLink } from "@workspace/ui/components/workspace-shell"
import { cn } from "@workspace/ui/lib/utils"
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/** One page of the settings: its row in the list and what it shows. */
type SettingsSection = {
  id: string
  label: string
  /** A phosphor icon, drawn at 20px beside the label. */
  icon: ReactNode
  content: ReactNode
}

/** Closes the dialog from inside it, when a link in a page is followed. */
const actionsOf =
  createContext<RefObject<DialogPrimitive.Root.Actions | null> | null>(null)

function Settings(props: DialogPrimitive.Root.Props) {
  const actions = useRef<DialogPrimitive.Root.Actions>(null)
  return (
    <actionsOf.Provider value={actions}>
      <DialogPrimitive.Root actionsRef={actions} {...props} />
    </actionsOf.Provider>
  )
}

function SettingsTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="settings-trigger" {...props} />
}

const ROW =
  "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-[0.9375rem] outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-5 [&_svg]:shrink-0"

/** Below Tailwind's `md`, where one half of the modal shows at a time. */
const narrow = () => !window.matchMedia("(min-width: 48rem)").matches

/** The round buttons in the page's header: back and close. */
const ROUND = "bg-foreground/5 hover:bg-foreground/10"

/**
 * The settings, as a modal on Base UI's dialog: a column of pages with Log
 * out at its foot, and the chosen page beside it. Base UI traps focus while
 * it is open and hands it back to the trigger when it closes. Below `md` it
 * fills the screen and shows the list first, then the page with a back
 * button, so one thing is on screen at a time. A plain click on a link in a
 * page closes it, since the link leads elsewhere.
 */
function SettingsContent({
  sections,
  signOutHref,
  className,
}: {
  sections: SettingsSection[]
  /** A plain address, never preloaded: signing out happens on the visit. */
  signOutHref: string
  className?: string
}) {
  const actions = useContext(actionsOf)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-background/70"
        data-slot="settings-overlay"
      />
      <DialogPrimitive.Popup
        className={cn(
          "fixed inset-0 z-50 flex bg-popover text-popover-foreground text-sm outline-none transition duration-200 ease-out data-ending-style:scale-[0.98] data-starting-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(40rem,calc(100svh-4rem))] md:w-[min(56rem,calc(100vw-4rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[1.875rem] md:border md:border-border md:shadow-lg",
          className
        )}
        data-slot="settings-content"
        onClick={closeOnLink(() => actions?.current?.close())}
      >
        <SettingsBody sections={sections} signOutHref={signOutHref} />
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

/**
 * Inside the popup, so the chosen page starts over each time it opens. On a
 * phone, choosing a page moves focus to its back button, and going back
 * returns it to the row it came from, since the other half is hidden.
 */
function SettingsBody({
  sections,
  signOutHref,
}: {
  sections: SettingsSection[]
  signOutHref: string
}) {
  // Null is the list on a phone, and the first page from `md`.
  const [chosen, setChosen] = useState<string | null>(null)
  const [from, setFrom] = useState<string | null>(null)
  const page = sections.find((each) => each.id === chosen) ?? sections[0]
  const back = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!narrow()) return
    if (chosen) back.current?.focus()
    else if (from)
      list.current
        ?.querySelector<HTMLElement>(`[data-section="${from}"]`)
        ?.focus()
  }, [chosen, from])

  const roundClose = (
    <DialogPrimitive.Close
      render={
        <Button className={cn(ROUND, "ms-auto")} size="icon" variant="ghost" />
      }
    >
      <XIcon aria-hidden />
      <span className="sr-only">Close settings</span>
    </DialogPrimitive.Close>
  )

  return (
    <div
      className="group/view flex min-w-0 flex-1"
      data-view={chosen ? "page" : "list"}
    >
      <div className="flex w-full shrink-0 flex-col border-border p-4 max-md:group-data-[view=page]/view:hidden md:w-72 md:border-e">
        <div className="flex h-11 items-center gap-3 ps-3">
          <DialogPrimitive.Title className="font-semibold text-xl">
            Settings
          </DialogPrimitive.Title>
          <span className="contents md:hidden">{roundClose}</span>
        </div>
        <nav
          aria-label="Settings"
          className="mt-4 min-h-0 flex-1 overflow-y-auto"
        >
          <ul className="flex flex-col gap-1" ref={list}>
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  aria-current={section === page ? "true" : undefined}
                  className={cn(
                    ROW,
                    // The list alone on a phone marks nothing as current.
                    "md:aria-[current=true]:bg-foreground/10"
                  )}
                  data-section={section.id}
                  onClick={() => {
                    setFrom(null)
                    setChosen(section.id)
                  }}
                  type="button"
                >
                  {section.icon}
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <a className={cn(ROW, "mt-2")} href={signOutHref}>
          <SignOutIcon aria-hidden />
          Log out
        </a>
      </div>

      {page ? (
        <section
          aria-labelledby={titleId}
          className="flex min-w-0 flex-1 flex-col max-md:group-data-[view=list]/view:hidden"
        >
          <header className="flex shrink-0 items-center gap-3 px-4 pt-4 md:px-6">
            <Button
              className={cn(ROUND, "md:hidden")}
              onClick={() => {
                setFrom(chosen)
                setChosen(null)
              }}
              ref={back}
              size="icon"
              variant="ghost"
            >
              <CaretLeftIcon aria-hidden />
              <span className="sr-only">Back to settings</span>
            </Button>
            <h2
              className="flex h-11 min-w-0 flex-1 items-center truncate font-semibold text-xl md:ps-1"
              id={titleId}
            >
              {page.label}
            </h2>
            {roundClose}
          </header>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-8 md:px-7"
            data-slot="settings-page"
          >
            {page.content}
          </div>
        </section>
      ) : null}
    </div>
  )
}

export { Settings, SettingsContent, type SettingsSection, SettingsTrigger }
