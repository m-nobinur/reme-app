import {
  AlarmIcon,
  BellIcon,
  BuildingsIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  GearSixIcon,
  GlobeIcon,
  MoonIcon,
  NotePencilIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignOutIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { railItemClass } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DefinitionList } from "@workspace/ui/components/definition-list"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { EmptyState } from "@workspace/ui/components/empty-state"
import {
  type HistoryEntry,
  HistoryMenu,
} from "@workspace/ui/components/history-menu"
import { LogoMark } from "@workspace/ui/components/logo"
import {
  Settings,
  SettingsContent,
  type SettingsSection,
  SettingsTrigger,
} from "@workspace/ui/components/settings-dialog"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { toggleTheme } from "@workspace/ui/components/theme-toggle"
import { Hint } from "@workspace/ui/components/tooltip"
import {
  ConversationMenu,
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { type ReactNode, useState } from "react"
import { BellSample } from "./notification-entries"
import { SamplePanel, SamplePanelLine } from "./panel-entries"

/**
 * Catalog entries for the owner workspace frame. The shell renders at a fixed
 * height here so it fits in a catalog section; `?entry=WorkspaceShell` renders
 * it alone, which is what the viewport suite loads at phone, tablet and desktop
 * widths. Everything is invented: Brightclean is a fixture organisation.
 */

type Entry = { name: string; render: () => ReactNode }

const PROFILE_NAV = [
  { href: "#business", label: "Business", icon: BuildingsIcon },
  { href: "#staff", label: "Staff", icon: UsersThreeIcon },
  { href: "#pipeline", label: "Pipeline", icon: FlowArrowIcon },
  { href: "#account", label: "Account", icon: GearSixIcon },
]

function AccountMenu() {
  return (
    <DropdownMenu>
      <Hint label="Sam Fixture" side="right">
        <DropdownMenuTrigger
          render={
            <button
              aria-label="Profile, Sam Fixture"
              className={railItemClass}
              type="button"
            />
          }
        >
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[0.6875rem] text-primary-foreground"
            data-slot="mark"
          >
            SF
          </span>
          <span className="truncate" data-slot="rail-label">
            Sam Fixture
          </span>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-56" side="right">
        {PROFILE_NAV.map((item) => (
          <DropdownMenuLinkItem href={item.href} key={item.href}>
            <item.icon aria-hidden />
            {item.label}
          </DropdownMenuLinkItem>
        ))}
        <DropdownMenuItem closeOnClick={false} onClick={toggleTheme}>
          <MoonIcon aria-hidden />
          Switch theme
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="#sign-out">
          <SignOutIcon aria-hidden />
          Sign out
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const SETTINGS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <GearSixIcon aria-hidden />,
    content: (
      <div className="flex flex-col gap-6">
        <DefinitionList
          items={[
            { id: "name", term: "Name", description: "Sam Fixture" },
            { id: "email", term: "Email", description: "sam@example.com" },
            { id: "business", term: "Business", description: "Brightclean" },
          ]}
        />
        <div>
          <Button onClick={toggleTheme} variant="outline">
            <MoonIcon aria-hidden />
            Switch theme
          </Button>
        </div>
      </div>
    ),
  },
  {
    id: "website",
    label: "Website",
    icon: <GlobeIcon aria-hidden />,
    content: (
      <p className="text-muted-foreground">
        brightclean.example.com is live.{" "}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="#website"
        >
          Open the website page
        </a>
      </p>
    ),
  },
  {
    id: "help",
    label: "Help & support",
    icon: <QuestionIcon aria-hidden />,
    content: <p className="text-muted-foreground">Ask Reme in the chat.</p>,
  },
  {
    id: "legal",
    label: "Legal info",
    icon: <ShieldCheckIcon aria-hidden />,
    content: <p className="text-muted-foreground">Privacy and terms.</p>,
  },
]

/** The round avatar at the foot of the rail, which opens the settings. */
function SettingsSample() {
  return (
    <Settings>
      <Hint label="Sam Fixture" side="right">
        <SettingsTrigger
          render={
            <button
              aria-label="Settings, Sam Fixture"
              className={railItemClass}
              type="button"
            />
          }
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs"
            data-slot="mark"
          >
            SF
          </span>
          <span className="truncate" data-slot="rail-label">
            Sam Fixture
          </span>
        </SettingsTrigger>
      </Hint>
      <SettingsContent sections={SETTINGS} signOutHref="#sign-out" />
    </Settings>
  )
}

const RAIL_NAV = [
  { href: "#new", label: "New chat", icon: NotePencilIcon },
  { href: "#chat", label: "Chat", icon: ChatCircleTextIcon, current: true },
  { href: "#website", label: "Website", icon: GlobeIcon },
  { href: "#business", label: "Brightclean", icon: BuildingsIcon },
  { href: "#staff", label: "Staff", icon: UsersThreeIcon },
  { href: "#pipeline", label: "Pipeline", icon: FlowArrowIcon },
]

/**
 * The rail: the mark, a new chat and the app's sections, reminders under a
 * hairline, and the notifications and the owner's avatar at the foot.
 */
function Rail() {
  return (
    <>
      <span className="flex h-11 shrink-0 items-center px-2.5 text-foreground">
        <LogoMark />
      </span>
      <nav aria-label="Main" className="flex flex-col gap-1">
        {RAIL_NAV.map((item) => (
          <Hint key={item.href} label={item.label} side="right">
            <a
              aria-current={item.current ? "page" : undefined}
              className={railItemClass}
              href={item.href}
            >
              <item.icon aria-hidden />
              <span className="truncate" data-slot="rail-label">
                {item.label}
              </span>
            </a>
          </Hint>
        ))}
        <hr className="mx-2 my-2 border-border" />
        <Hint label="Reminders" side="right">
          <a className={railItemClass} href="#reminders">
            <AlarmIcon aria-hidden />
            <span data-slot="rail-label">Reminders</span>
          </a>
        </Hint>
      </nav>
      <div className="mt-auto flex flex-col gap-1">
        <Hint label="Notifications" side="right">
          <a
            aria-label="Notifications, 3 unread"
            className={railItemClass}
            href="#notifications"
          >
            <BellIcon aria-hidden />
            <span
              aria-hidden
              className="absolute start-7 top-2 size-2 rounded-full bg-destructive ring-2 ring-rail"
              data-slot="unread-dot"
            />
            <span data-slot="rail-label">Notifications</span>
          </a>
        </Hint>
        <SettingsSample />
      </div>
    </>
  )
}

/** The chats behind the clock: 30 of them, so "Load more" has work to do. */
const HISTORY: HistoryEntry[] = Array.from({ length: 30 }, (_, index) => ({
  id: `chat-${index}`,
  title:
    ["Weekend prices", "New oven cleaning page", "Reply to a review"][
      index % 3
    ] + (index > 2 ? ` ${Math.floor(index / 3) + 1}` : ""),
  at: new Date(Date.UTC(2026, 8, 30 - index)).toISOString(),
  // biome-ignore lint/a11y/useAnchorContent: the menu fills the link with the row.
  link: <a href={`#chat-${index}`} />,
}))

/** The top bar's icons before the bell: a new chat and the history. */
function TopActions() {
  return (
    <>
      <Hint label="New chat">
        <a
          aria-label="New chat"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          href="#new"
        >
          <NotePencilIcon aria-hidden />
        </a>
      </Hint>
      <HistoryMenu current="chat-0" items={HISTORY} />
    </>
  )
}

function ShellSample() {
  return (
    <WorkspaceShell
      actions={<TopActions />}
      className="h-[40rem] border border-border"
      notifications={<BellSample unread={3} />}
      panel={<SamplePanel />}
      panelLine={<SamplePanelLine />}
      rail={<Rail />}
    >
      <WorkspacePage>
        <h1 className="mb-6 font-semibold text-2xl">Approvals</h1>
        <EmptyState
          description="Approval requests appear here as Reme raises them."
          icon={<CheckCircleIcon />}
          title="Nothing waiting on you"
        />
      </WorkspacePage>
    </WorkspaceShell>
  )
}

/**
 * A stored conversation's top bar: the ··· menu renames it in place and
 * archives it. Saving "Will not save" fails, to show the form's error, and
 * the archive always fails here, to show the title bar's.
 */
function ConversationSample() {
  const [title, setTitle] = useState("Weekend prices")
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <WorkspaceShell
      className="h-[24rem] border border-border"
      menu={
        <ConversationMenu
          newChat={<a href="#new" />}
          onArchive={() => setError("That did not archive. Try again.")}
          onRename={() => {
            setError(undefined)
            setRenaming(true)
          }}
        />
      }
      panel={<SamplePanel />}
      panelLine={<SamplePanelLine />}
      rail={<Rail />}
      renaming={
        renaming
          ? {
              value: title,
              onSave: async (next) => {
                await new Promise((resolve) => setTimeout(resolve, 150))
                if (next === "Will not save") throw new Error("refused")
                setTitle(next)
                setRenaming(false)
              },
              onCancel: () => setRenaming(false),
            }
          : undefined
      }
      title={title}
      titleError={error}
    >
      <WorkspacePage>
        <p className="text-muted-foreground text-sm">The conversation.</p>
      </WorkspacePage>
    </WorkspaceShell>
  )
}

function SheetSample() {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>
        Open the sheet
      </SheetTrigger>
      <SheetContent>
        <div className="flex flex-col gap-3 p-4 pt-12">
          <SheetTitle>Waiting on you</SheetTitle>
          <p className="text-muted-foreground">Nothing is waiting on you.</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MenuSample() {
  return (
    <div className="flex max-w-60 rounded-lg bg-rail p-3 text-rail-foreground">
      <AccountMenu />
    </div>
  )
}

/** A menu of actions, with a hairline between its groups. Closed here. */
function ActionMenuSample() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        Actions
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuItem>Change my website</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Remind me</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const workspaceCatalog: Entry[] = [
  { name: "WorkspaceShell", render: () => <ShellSample /> },
  {
    // A page with nothing for the panel to say: no card, no space kept.
    name: "WorkspaceShell without a panel",
    render: () => (
      <WorkspaceShell
        actions={<TopActions />}
        className="h-[24rem] border border-border"
        notifications={<BellSample unread={0} />}
        panel={null}
        panelLine={null}
        rail={<Rail />}
      >
        <WorkspacePage>
          <h1 className="mb-6 font-semibold text-2xl">Staff</h1>
          <p className="text-muted-foreground text-sm">
            The page starts under the top bar, at every width.
          </p>
        </WorkspacePage>
      </WorkspaceShell>
    ),
  },
  {
    name: "HistoryMenu",
    render: () => (
      <div className="flex justify-end">
        <HistoryMenu current="chat-0" items={HISTORY} />
      </div>
    ),
  },
  {
    name: "HistoryMenu empty",
    render: () => (
      <div className="flex justify-end">
        <HistoryMenu items={[]} />
      </div>
    ),
  },
  { name: "Hint", render: () => <TopActions /> },
  { name: "ConversationRename", render: () => <ConversationSample /> },
  {
    name: "WorkspacePage",
    render: () => (
      <WorkspacePage className="border border-border">
        <p className="text-sm">
          The padded column every screen but the conversation renders into.
        </p>
      </WorkspacePage>
    ),
  },
  {
    name: "Settings",
    render: () => (
      <div className="flex max-w-60 rounded-lg bg-rail p-3 text-rail-foreground">
        <SettingsSample />
      </div>
    ),
  },
  { name: "SettingsTrigger", render: () => <SettingsSample /> },
  { name: "SettingsContent", render: () => <SettingsSample /> },
  { name: "Sheet", render: () => <SheetSample /> },
  { name: "SheetTrigger", render: () => <SheetSample /> },
  { name: "SheetContent", render: () => <SheetSample /> },
  { name: "SheetTitle", render: () => <SheetSample /> },
  { name: "DropdownMenu", render: () => <MenuSample /> },
  { name: "DropdownMenuTrigger", render: () => <MenuSample /> },
  { name: "DropdownMenuContent", render: () => <MenuSample /> },
  { name: "DropdownMenuLinkItem", render: () => <MenuSample /> },
  { name: "DropdownMenuItem", render: () => <ActionMenuSample /> },
  { name: "DropdownMenuSeparator", render: () => <ActionMenuSample /> },
]

export { workspaceCatalog }
