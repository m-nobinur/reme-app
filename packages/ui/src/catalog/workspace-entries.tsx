import {
  BuildingsIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  GearSixIcon,
  NotePencilIcon,
  QuestionIcon,
  SignOutIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { AppNav, navLinkClass } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
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
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
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
      <DropdownMenuTrigger
        render={
          <Button
            className="min-w-0 flex-1 justify-start gap-2 px-1.5"
            size="sm"
            variant="ghost"
          />
        }
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[0.6875rem] text-primary-foreground"
        >
          SF
        </span>
        <span className="truncate">Sam Fixture</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" side="top">
        {PROFILE_NAV.map((item) => (
          <DropdownMenuLinkItem href={item.href} key={item.href}>
            <item.icon aria-hidden />
            {item.label}
          </DropdownMenuLinkItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="#sign-out">
          <SignOutIcon aria-hidden />
          Sign out
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Rail() {
  return (
    <>
      <p className="truncate px-2 font-medium text-sm">Brightclean</p>
      <a aria-current="page" className={navLinkClass} href="#new">
        <NotePencilIcon aria-hidden />
        New chat
      </a>
      <AppNav aria-label="Chats">
        <li>
          <a className={navLinkClass} href="#weekend-prices">
            <span className="truncate">Weekend prices</span>
          </a>
        </li>
      </AppNav>
      <div className="mt-auto flex items-center gap-1">
        <AccountMenu />
        <Button aria-label="Help" size="icon-sm" variant="ghost">
          <QuestionIcon aria-hidden />
        </Button>
        <ThemeToggle />
      </div>
    </>
  )
}

function ShellSample() {
  return (
    <WorkspaceShell
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
