import {
  BellIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  NotePencilIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import {
  AppNav,
  NavCount,
  navLinkClass,
} from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { SamplePanel } from "./panel-entries"

/**
 * Catalog entries for the owner workspace frame. The shell renders at a fixed
 * height here so it fits in a catalog section; `?entry=WorkspaceShell` renders
 * it alone, which is what the viewport suite loads at phone, tablet and desktop
 * widths. Everything is invented: Brightclean is a fixture organisation.
 */

type Entry = { name: string; render: () => ReactNode }

const NAV = [
  { href: "#notifications", label: "Notifications", icon: BellIcon },
  { href: "#approvals", label: "Approvals", icon: CheckCircleIcon },
  { href: "#pipeline", label: "Pipeline", icon: FlowArrowIcon },
  { href: "#staff", label: "Staff", icon: UsersThreeIcon },
]

function AccountMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="min-w-0 flex-1 justify-start"
            size="sm"
            variant="ghost"
          />
        }
      >
        <UserCircleIcon aria-hidden />
        <span className="truncate">Sam Fixture</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLinkItem href="#account">Account</DropdownMenuLinkItem>
        <DropdownMenuLinkItem href="#sign-out">Sign out</DropdownMenuLinkItem>
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
      <AppNav aria-label="Main">
        {NAV.map((item) => (
          <li key={item.href}>
            <a className={navLinkClass} href={item.href}>
              <item.icon aria-hidden />
              {item.label}
              {item.href === "#notifications" ? <NavCount count={3} /> : null}
            </a>
          </li>
        ))}
      </AppNav>
      <div className="mt-auto flex items-center gap-1">
        <AccountMenu />
        <ThemeToggle />
      </div>
    </>
  )
}

function ShellSample() {
  return (
    <WorkspaceShell
      className="h-[40rem] border border-border"
      panel={<SamplePanel />}
      panelCount={2}
      rail={<Rail />}
      railCount={3}
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

/**
 * A menu of actions and a choice of one. Closed here, like the account menu;
 * `thread.spec.ts` opens the same rows in the composer and scans them.
 */
function ChoiceMenuSample() {
  const [mode, setMode] = useState("act")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        Mode
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuItem>Change my website</DropdownMenuItem>
        <DropdownMenuRadioGroup onValueChange={setMode} value={mode}>
          <DropdownMenuRadioItem value="ask">Ask</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="act">Act</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
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
  { name: "DropdownMenuItem", render: () => <ChoiceMenuSample /> },
  { name: "DropdownMenuRadioGroup", render: () => <ChoiceMenuSample /> },
  { name: "DropdownMenuRadioItem", render: () => <ChoiceMenuSample /> },
]

export { workspaceCatalog }
