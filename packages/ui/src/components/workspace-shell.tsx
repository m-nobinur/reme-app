import {
  ArchiveIcon,
  BellIcon,
  CaretDownIcon,
  DotsThreeIcon,
  ListIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react"
import { countLabel } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { PANEL_COOKIE, RAIL_COOKIE } from "@workspace/ui/lib/panel"
import { titleText } from "@workspace/ui/lib/title"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  cloneElement,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

/** A year: the choice is a preference, not a session. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function remember(cookie: string, open: boolean) {
  // biome-ignore lint/suspicious/noDocumentCookie: one preference the server has to read on the next request, which the Cookie Store API cannot promise in every browser this app supports.
  document.cookie = `${cookie}=${open ? "open" : "closed"}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
}

/**
 * Closes a sheet when a plain click inside it followed a link. A modified or
 * middle click opens the link elsewhere, so the sheet stays.
 */
function closeOnLink(close: () => void) {
  return (event: MouseEvent) => {
    const modified =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    if (!modified && (event.target as Element).closest("a[href]")) {
      close()
    }
  }
}

/**
 * Closes a sheet once the viewport reaches the width where its content is
 * inline again, so the rail it holds is never missing from both.
 */
function useCloseAt(query: string, close: () => void) {
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => {
      if (media.matches) {
        close()
      }
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [query, close])
}

/** Tailwind's `lg`: from here the panel's open state is the remembered one. */
const WIDE = "(min-width: 64rem)"
const onWidth = (change: () => void) => {
  const media = window.matchMedia(WIDE)
  media.addEventListener("change", change)
  return () => media.removeEventListener("change", change)
}
/** Wide on the server, so the first client render matches its HTML. */
const useWide = () =>
  useSyncExternalStore(
    onWidth,
    () => window.matchMedia(WIDE).matches,
    () => true
  )

/** A count drawn on a toggle's corner. */
const BADGE =
  "absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[0.8125rem] text-primary-foreground tabular-nums leading-none"

/**
 * The owner workspace: a 15rem rail, the conversation, and the live panel
 * floating over the conversation's top right corner.
 *
 * From `md` the rail collapses with the toggle at the top left, remembered in
 * a cookie; below `md` it is a sheet from the left. The panel is a rounded
 * card whose header is always one line of live activity (`panelLine`); open,
 * it grows with its content to half the viewport's height and scrolls past
 * that. From `lg` whether it is open is remembered; below `lg` it starts
 * minimised, since there it covers the conversation. The rail and the panel
 * are slots, so this package still imports no router. `title` and `menu`
 * name the page in the top bar, and `notifications` is the link the bell at
 * the top right renders as, with `unread` drawn on it.
 */
function WorkspaceShell({
  rail,
  panel,
  panelLine,
  unread = 0,
  notifications,
  defaultRailOpen = true,
  defaultPanelOpen = true,
  openPanel = false,
  title,
  menu,
  renaming,
  titleError,
  children,
  className,
}: {
  rail: ReactNode
  panel: ReactNode
  /** One line of live activity: the panel's header, and all of it minimised. */
  panelLine: ReactNode
  /** Plain text, never markup: a title can be the owner's or the model's words. */
  title?: string | undefined
  /** The page's ··· menu, drawn beside the title. */
  menu?: ReactNode
  /** While set, the title is a form that renames it, in place of the title and menu. */
  renaming?: Renaming | undefined
  /** Why the last action on the title failed, such as an archive. */
  titleError?: string | undefined
  /** How many notifications are unread; the bell shows it. */
  unread?: number
  /** The link element the bell renders as, from the app's router. */
  notifications?: ReactElement<ComponentProps<"a">> | undefined
  defaultRailOpen?: boolean
  defaultPanelOpen?: boolean
  /**
   * The owner followed a link to the panel: it opens when this turns true,
   * even if they had minimised it.
   */
  openPanel?: boolean
  children: ReactNode
  className?: string
}) {
  const [railOpen, setRailOpen] = useState(defaultRailOpen)
  const [railSheet, setRailSheet] = useState(false)
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen)
  const [narrowOpen, setNarrowOpen] = useState(false)
  const wide = useWide()
  const expanded = wide ? panelOpen : narrowOpen
  const panelId = useId()
  // Tailwind's `md`, the width the sheet hands the rail back to the layout.
  useCloseAt(
    "(min-width: 48rem)",
    useCallback(() => setRailSheet(false), [])
  )

  const toggleRail = () => {
    const next = !railOpen
    setRailOpen(next)
    remember(RAIL_COOKIE, next)
  }

  const setPanel = useCallback((open: boolean) => {
    if (window.matchMedia(WIDE).matches) {
      setPanelOpen(open)
      remember(PANEL_COOKIE, open)
    } else {
      setNarrowOpen(open)
    }
  }, [])

  // Sent here to the panel: open it, whatever the width.
  useEffect(() => {
    if (openPanel) setPanel(true)
  }, [openPanel, setPanel])

  return (
    <div
      className={cn(
        "flex h-svh overflow-hidden bg-background text-foreground",
        className
      )}
      data-slot="workspace-shell"
    >
      <a
        className="sr-only z-10 rounded-lg bg-background px-3 py-2 font-medium text-sm ring-3 ring-ring focus:not-sr-only focus:absolute focus:m-2"
        href="#main"
      >
        Skip to content
      </a>

      {/* One copy of the rail at a time: while the sheet holds it, the inline
          one (hidden below md anyway) is not rendered, so no id repeats.
          Collapsed, it is inert, so nothing in it takes focus. */}
      {railSheet ? null : (
        <aside
          aria-label="Workspace"
          className={cn(
            "hidden shrink-0 flex-col overflow-hidden border-border bg-rail text-rail-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
            railOpen ? "w-60 border-r" : "w-0"
          )}
          data-state={railOpen ? "open" : "closed"}
          id="workspace-rail"
          inert={!railOpen}
        >
          <div className="flex min-h-0 w-60 flex-1 flex-col gap-4 overflow-y-auto p-3">
            {rail}
          </div>
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 px-2">
          <Sheet onOpenChange={setRailSheet} open={railSheet}>
            <SheetTrigger
              render={
                <Button
                  aria-label="Show menu"
                  className="md:hidden"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <ListIcon aria-hidden />
            </SheetTrigger>
            <SheetContent
              onClick={closeOnLink(() => setRailSheet(false))}
              side="left"
            >
              <SheetTitle className="sr-only">Workspace</SheetTitle>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 pt-12">
                {rail}
              </div>
            </SheetContent>
          </Sheet>

          <Button
            aria-controls="workspace-rail"
            aria-expanded={railOpen}
            aria-label={railOpen ? "Hide sidebar" : "Show sidebar"}
            className="hidden md:inline-flex"
            onClick={toggleRail}
            size="icon"
            variant="ghost"
          >
            <SidebarSimpleIcon aria-hidden />
          </Button>

          <div className="flex min-w-0 flex-1 items-center gap-0.5 md:ps-1">
            {renaming ? (
              <TitleEditor {...renaming} />
            ) : (
              <>
                {title ? (
                  <p
                    className="truncate font-medium text-sm"
                    data-slot="workspace-title"
                  >
                    {title}
                  </p>
                ) : null}
                {menu}
                {titleError ? (
                  <p
                    className="ms-2 truncate text-destructive text-xs"
                    role="alert"
                  >
                    {titleError}
                  </p>
                ) : null}
              </>
            )}
          </div>

          {notifications
            ? cloneElement(notifications, {
                "aria-label":
                  unread > 0
                    ? `Notifications, ${unread} unread`
                    : "Notifications",
                className: buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "relative",
                }),
                children: (
                  <>
                    <BellIcon aria-hidden />
                    {unread > 0 ? (
                      <span
                        aria-hidden
                        className={BADGE}
                        data-slot="unread-count"
                      >
                        {countLabel(unread)}
                      </span>
                    ) : null}
                  </>
                ),
              })
            : null}
        </header>

        <main
          className="min-h-0 flex-1 overflow-y-auto"
          // The page scrolls here, not the window: the router resets and
          // restores this element by its id.
          data-scroll-restoration-id="main"
          id="main"
        >
          {children}
        </main>

        <aside
          aria-label="Panel"
          className="absolute top-13 right-3 z-20 flex max-h-[calc(50svh+3rem)] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg"
          data-state={expanded ? "open" : "closed"}
          id="workspace-panel"
        >
          <button
            aria-controls={panelId}
            aria-expanded={expanded}
            className="flex min-h-11 w-full min-w-0 shrink-0 items-center gap-2 px-4 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
            onClick={() => setPanel(!expanded)}
            type="button"
          >
            <span className="min-w-0 flex-1">{panelLine}</span>
            <span className="sr-only">
              {expanded ? ", minimise the panel" : ", open the panel"}
            </span>
            <CaretDownIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                expanded && "rotate-180"
              )}
            />
          </button>
          {/* Kept mounted while minimised, so a half-written answer or a
              chosen tab survives it. The server renders it open from lg,
              where the cookie says so, and minimised below. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a listener for the links inside, which a keyboard activates with a click too. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above; Enter on a link is a click. */}
          <div
            className={cn(
              "min-h-0 flex-col gap-6 overflow-y-auto overscroll-contain border-border border-t p-4",
              wide
                ? panelOpen
                  ? "hidden lg:flex"
                  : "hidden"
                : narrowOpen
                  ? "flex"
                  : "hidden"
            )}
            id={panelId}
            onClick={wide ? undefined : closeOnLink(() => setNarrowOpen(false))}
          >
            {panel}
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * The padded column a page that is not the conversation renders into, so the
 * approvals, pipeline, staff and profile screens keep the frame they had.
 */
function WorkspacePage({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-5xl px-4 pt-2 pb-10 md:px-10",
        className
      )}
      data-slot="workspace-page"
      {...props}
    />
  )
}

type Renaming = {
  /** The title as it stands, to edit from. */
  value: string
  /** Saves the new title; a throw keeps the form open with its error. */
  onSave: (title: string) => Promise<void>
  onCancel: () => void
}

/**
 * The title as a one-field form: Enter or Save keeps it, Escape or Cancel
 * leaves it as it was. The words are checked here the way the api keeps
 * them, so a title of only spaces never leaves the browser.
 */
function TitleEditor({ value, onSave, onCancel }: Renaming) {
  const [text, setText] = useState(value)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  // A rename the owner saves or cancels hands focus back to the ··· button
  // that started it, which is back in the title bar a frame after this form
  // is gone. One that ends because they went elsewhere leaves focus alone.
  const form = useRef<HTMLFormElement>(null)
  const refocus = () => {
    const bar = form.current?.parentElement
    requestAnimationFrame(() =>
      bar
        ?.querySelector<HTMLElement>('[data-slot="conversation-actions"]')
        ?.focus()
    )
  }
  const cancel = () => {
    refocus()
    onCancel()
  }
  // The field takes any length; the title keeps what `titleText` keeps, and
  // says so before the owner saves, rather than cutting what they paste.
  const cut =
    text.replace(/\s+/g, " ").trim().length > (titleText(text) ?? "").length

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const title = titleText(text)
    if (!title) {
      setError("A title needs words.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await onSave(title)
      refocus()
    } catch {
      setError("That did not save. Try again.")
      setPending(false)
    }
  }

  return (
    <form
      aria-label="Rename conversation"
      className="relative flex min-w-0 flex-1 items-center gap-1.5"
      data-slot="title-editor"
      onSubmit={submit}
      ref={form}
    >
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label="Conversation title"
        autoFocus
        className="h-8 min-w-0 flex-1"
        disabled={pending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel()
        }}
        value={text}
      />
      <Button disabled={pending} size="sm" type="submit">
        {pending ? "Saving" : "Save"}
      </Button>
      <Button
        disabled={pending}
        onClick={cancel}
        size="sm"
        type="button"
        variant="ghost"
      >
        Cancel
      </Button>
      {cut && !error ? (
        <p
          className="absolute start-0 top-full z-10 mt-1 max-w-full rounded-md border border-border bg-popover px-2 py-1 text-muted-foreground text-xs shadow-sm"
          role="status"
        >
          Titles keep their first 120 characters.
        </p>
      ) : null}
      {error ? (
        // Below the bar, over the page: the bar has one row, and a phone has
        // no room in it for a second.
        <p
          className="absolute start-0 top-full z-10 mt-1 max-w-full rounded-md border border-border bg-popover px-2 py-1 text-destructive text-xs shadow-sm"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </form>
  )
}

/**
 * The conversation's ··· menu, for the shell's `menu` slot. `newChat` is the
 * link element to render the entry as, so the app passes its router's link
 * and this package still imports no router. Rename and archive show for a
 * stored conversation, the only kind the api can change.
 */
function ConversationMenu({
  newChat,
  onRename,
  onArchive,
}: {
  newChat: ReactElement
  onRename?: (() => void) | undefined
  onArchive?: (() => void) | undefined
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Conversation actions"
            data-slot="conversation-actions"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <DotsThreeIcon aria-hidden weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLinkItem render={newChat}>
          <NotePencilIcon aria-hidden />
          New chat
        </DropdownMenuLinkItem>
        {onRename ? (
          <DropdownMenuItem onClick={onRename}>
            <PencilSimpleIcon aria-hidden />
            Rename
          </DropdownMenuItem>
        ) : null}
        {onArchive ? (
          <DropdownMenuItem onClick={onArchive}>
            <ArchiveIcon aria-hidden />
            Archive
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ConversationMenu, WorkspacePage, WorkspaceShell }
