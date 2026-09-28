import {
  ArchiveIcon,
  DotsThreeIcon,
  ListIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react"
import { countLabel } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
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
import { PANEL_COOKIE } from "@workspace/ui/lib/panel"
import { titleText } from "@workspace/ui/lib/title"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/** A year: the choice is a preference, not a session. */
const PANEL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function rememberPanel(open: boolean) {
  // biome-ignore lint/suspicious/noDocumentCookie: one preference the server has to read on the next request, which the Cookie Store API cannot promise in every browser this app supports.
  document.cookie = `${PANEL_COOKIE}=${open ? "open" : "closed"}; path=/; max-age=${PANEL_COOKIE_MAX_AGE}; samesite=lax`
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
 * inline again, so the rail or panel it holds is never missing from both.
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

/** A count drawn on a toggle's corner. */
const BADGE =
  "absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[0.8125rem] text-primary-foreground tabular-nums leading-none"

/**
 * The owner workspace: a 15rem rail, the conversation, and a 20rem panel.
 *
 * Below `md` the rail is a sheet from the left, and below `lg` the panel is a
 * sheet from the right. Both toggles sit top right. `panelCount` is what the
 * panel is waiting on the owner for; the phone toggle shows it, because there
 * the panel is out of sight. The rail and the panel are slots, so this package
 * still imports no router. `title` and `menu` name the page in the top bar,
 * which on a phone is the only place it is named above the fold.
 */
function WorkspaceShell({
  rail,
  panel,
  panelCount = 0,
  railCount = 0,
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
  /** Plain text, never markup: a title can be the owner's or the model's words. */
  title?: string | undefined
  /** The page's ··· menu, drawn beside the title. */
  menu?: ReactNode
  /** While set, the title is a form that renames it, in place of the title and menu. */
  renaming?: Renaming | undefined
  /** Why the last action on the title failed, such as an archive. */
  titleError?: string | undefined
  panelCount?: number
  /** What the rail holds unread; the phone's menu toggle shows it. */
  railCount?: number
  defaultPanelOpen?: boolean
  /**
   * The owner followed a link to the panel: it opens when this turns true,
   * even if they had closed it.
   */
  openPanel?: boolean
  children: ReactNode
  className?: string
}) {
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen)
  const [railSheet, setRailSheet] = useState(false)
  const [panelSheet, setPanelSheet] = useState(false)
  // Tailwind's `md` and `lg`, the widths the sheets hand back to the layout.
  useCloseAt(
    "(min-width: 48rem)",
    useCallback(() => setRailSheet(false), [])
  )
  useCloseAt(
    "(min-width: 64rem)",
    useCallback(() => setPanelSheet(false), [])
  )

  const togglePanel = () => {
    const next = !panelOpen
    setPanelOpen(next)
    rememberPanel(next)
  }

  // Sent here to the panel: open it inline from `lg`, as its sheet below.
  useEffect(() => {
    if (!openPanel) return
    if (window.matchMedia("(min-width: 64rem)").matches) {
      setPanelOpen(true)
      rememberPanel(true)
    } else {
      setPanelSheet(true)
    }
  }, [openPanel])

  const waiting =
    panelCount > 0 ? `Show panel, ${panelCount} waiting on you` : "Show panel"

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
          one (hidden below md anyway) is not rendered, so no id repeats. */}
      {railSheet ? null : (
        <aside
          aria-label="Workspace"
          className="hidden w-60 shrink-0 flex-col border-border border-r bg-rail text-rail-foreground md:flex"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
            {rail}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 px-2">
          <Sheet onOpenChange={setRailSheet} open={railSheet}>
            <SheetTrigger
              render={
                <Button
                  aria-label={
                    railCount > 0
                      ? `Show menu, ${railCount} unread notifications`
                      : "Show menu"
                  }
                  className="relative md:hidden"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <ListIcon aria-hidden />
              {railCount > 0 ? (
                <span aria-hidden className={BADGE} data-slot="rail-count">
                  {countLabel(railCount)}
                </span>
              ) : null}
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

          <div className="flex min-w-0 flex-1 items-center gap-0.5 md:ps-2">
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

          <Button
            aria-controls="workspace-panel"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? "Hide panel" : "Show panel"}
            className="hidden lg:inline-flex"
            onClick={togglePanel}
            size="icon"
            variant="ghost"
          >
            <SidebarSimpleIcon aria-hidden className="-scale-x-100" />
          </Button>

          <Sheet onOpenChange={setPanelSheet} open={panelSheet}>
            <SheetTrigger
              render={
                <Button
                  aria-label={waiting}
                  className="relative lg:hidden"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <SidebarSimpleIcon aria-hidden className="-scale-x-100" />
              {panelCount > 0 ? (
                <span aria-hidden className={BADGE} data-slot="panel-count">
                  {panelCount}
                </span>
              ) : null}
            </SheetTrigger>
            <SheetContent onClick={closeOnLink(() => setPanelSheet(false))}>
              <SheetTitle className="sr-only">Panel</SheetTitle>
              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 pt-12">
                {panel}
              </div>
            </SheetContent>
          </Sheet>
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
      </div>

      {panelSheet ? null : (
        <aside
          aria-label="Panel"
          className={cn(
            "hidden w-80 shrink-0 flex-col border-border border-l bg-rail text-rail-foreground",
            panelOpen && "lg:flex"
          )}
          id="workspace-panel"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            {panel}
          </div>
        </aside>
      )}
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
  // Saved or not, a rename hands focus back to the ··· button that started
  // it, which is back in the title bar by the time this form is gone.
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const bar = form.current?.parentElement
    return () => {
      bar
        ?.querySelector<HTMLElement>('[data-slot="conversation-actions"]')
        ?.focus()
    }
  }, [])

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
        maxLength={120}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel()
        }}
        value={text}
      />
      <Button disabled={pending} size="sm" type="submit">
        {pending ? "Saving" : "Save"}
      </Button>
      <Button
        disabled={pending}
        onClick={onCancel}
        size="sm"
        type="button"
        variant="ghost"
      >
        Cancel
      </Button>
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
