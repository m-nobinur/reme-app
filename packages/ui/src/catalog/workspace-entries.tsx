import {
  AlarmIcon,
  BuildingsIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  GearSixIcon,
  GlobeIcon,
  ListChecksIcon,
  MoonIcon,
  NotePencilIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignOutIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { railItemClass } from "@workspace/ui/components/app-shell"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
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
  ChatHistory,
  type HistoryEntry,
} from "@workspace/ui/components/history-menu"
import { PipelineIcon } from "@workspace/ui/components/pipeline-icon"
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
import { Switch } from "@workspace/ui/components/switch"
import { toggleTheme } from "@workspace/ui/components/theme-toggle"
import { Hint } from "@workspace/ui/components/tooltip"
import {
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"
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
          render={<button className={railItemClass} type="button" />}
        >
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[0.6875rem] text-primary-foreground"
            data-slot="mark"
          >
            SF
          </span>
          <span className="truncate" data-slot="rail-label">
            <span className="sr-only">Profile, </span>
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
    content: <p className="text-muted-foreground">Ask Ellie in the chat.</p>,
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
          render={<button className={railItemClass} type="button" />}
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs"
            data-slot="mark"
          >
            SF
          </span>
          <span className="truncate" data-slot="rail-label">
            <span className="sr-only">Settings, </span>
            Sam Fixture
          </span>
        </SettingsTrigger>
      </Hint>
      <SettingsContent sections={SETTINGS} signOutHref="#sign-out" />
    </Settings>
  )
}

const RAIL_NAV = [
  { href: "#chat", label: "Chat", icon: ChatCircleTextIcon, current: true },
  { href: "#new", label: "New conversation", icon: NotePencilIcon },
  { href: "#website", label: "Website", icon: GlobeIcon },
  { href: "#pipeline", label: "Pipeline", icon: PipelineIcon },
  { href: "#reminders", label: "Reminders", icon: AlarmIcon },
  { href: "#tasks", label: "Tasks", icon: ListChecksIcon },
]

/**
 * The rail: the mark, a new conversation and the app's sections, and the
 * notifications and the owner's avatar at the foot.
 */
function Rail() {
  return (
    <>
      <nav aria-label="Main" className="flex flex-col gap-2">
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
      </nav>
      <div className="mt-auto flex flex-col gap-2">
        <BellSample unread={3} />
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
  // The first three are recent, one under each of the first headings; the
  // rest are fixed, so the list reads the same on any day.
  at:
    index < 3
      ? new Date(
          Date.now() - (index === 2 ? 3 : index) * 86_400_000
        ).toISOString()
      : new Date(Date.UTC(2026, 8, 30 - index)).toISOString(),
  // biome-ignore lint/a11y/useAnchorContent: the menu fills the link with the row.
  link: <a href={`#chat-${index}`} />,
}))

/** A named icon, as the rail and the top bar draw them. */
function HintSample() {
  return (
    <Hint label="New conversation">
      <a
        aria-label="New conversation"
        className={buttonVariants({ variant: "ghost", size: "icon" })}
        href="#new"
      >
        <NotePencilIcon aria-hidden />
      </a>
    </Hint>
  )
}

/** A page away from the conversation, where the panel floats as a pill. */
function ShellSample({ floating = false }: { floating?: boolean }) {
  return (
    <WorkspaceShell
      className="h-[40rem] border border-border"
      floating={floating}
      panel={<SamplePanel />}
      panelFooter={
        <a
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "grow"
          )}
          href="#chat"
        >
          <ChatCircleTextIcon aria-hidden />
          Go to conversation
        </a>
      }
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
    // Away from the conversation: a pill at the bottom right that keeps no room.
    name: "WorkspaceShell floating",
    render: () => <ShellSample floating />,
  },
  {
    // Floating with nothing under way: the assistant's face alone, a way to the chat.
    name: "WorkspaceShell floating idle",
    render: () => (
      <WorkspaceShell
        className="h-[24rem] border border-border"
        floating
        panel={null}
        panelIdle={
          <a
            className="flex size-11 items-center justify-center rounded-full border border-border bg-popover shadow-lg"
            href="#chat"
          >
            <AssistantAvatar className="size-6" id={null} sway />
            <span className="sr-only">Chat with Reme</span>
          </a>
        }
        panelLine={null}
        rail={<Rail />}
      >
        <WorkspacePage>
          <h1 className="mb-6 font-semibold text-2xl">Staff</h1>
        </WorkspacePage>
      </WorkspaceShell>
    ),
  },
  {
    // A page with nothing for the panel to say: no card, no space kept.
    name: "WorkspaceShell without a panel",
    render: () => (
      <WorkspaceShell
        className="h-[24rem] border border-border"
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
    // Opens on hover, beside the rail's link to the latest chat.
    name: "ChatHistory",
    render: () => (
      <div className="flex h-72 w-16 flex-col rounded-lg bg-rail p-2.5 text-rail-foreground">
        <ChatHistory
          current="chat-0"
          items={HISTORY}
          trigger={
            <a className={railItemClass} href="#chat-0">
              <ChatCircleTextIcon aria-hidden />
              <span data-slot="rail-label">Chat</span>
            </a>
          }
        />
      </div>
    ),
  },
  {
    name: "PipelineIcon",
    render: () => <PipelineIcon className="size-8 text-foreground" />,
  },
  { name: "Hint", render: () => <HintSample /> },
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
  {
    name: "Switch",
    render: () => (
      <div className="flex flex-col gap-3 text-sm">
        {(
          [
            ["switch-email", "Email me when a quote comes in", true, false],
            ["switch-text", "Text me as well", false, false],
            ["switch-call", "Call me, not offered yet", false, true],
          ] as const
        ).map(([id, label, on, disabled]) => (
          <div className="flex items-center gap-2" key={id}>
            <Switch defaultChecked={on} disabled={disabled} id={id} />
            <label htmlFor={id}>{label}</label>
          </div>
        ))}
      </div>
    ),
  },
  { name: "DropdownMenu", render: () => <MenuSample /> },
  { name: "DropdownMenuTrigger", render: () => <MenuSample /> },
  { name: "DropdownMenuContent", render: () => <MenuSample /> },
  { name: "DropdownMenuLinkItem", render: () => <MenuSample /> },
  { name: "DropdownMenuItem", render: () => <ActionMenuSample /> },
  { name: "DropdownMenuSeparator", render: () => <ActionMenuSample /> },
]

export { workspaceCatalog }
