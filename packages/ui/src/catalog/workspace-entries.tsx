import {
  CheckCircleIcon,
  FlowArrowIcon,
  NotePencilIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { AppNav, navLinkClass } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import {
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import type { ReactNode } from "react"

/**
 * Catalog entries for the owner workspace frame. The shell renders at a fixed
 * height here so it fits in a catalog section; `?entry=WorkspaceShell` renders
 * it alone, which is what the viewport suite loads at phone, tablet and desktop
 * widths. Everything is invented: Brightclean is a fixture organisation.
 */

type Entry = { name: string; render: () => ReactNode }

const NAV = [
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
      <OrgSwitcher orgs={[{ id: "brightclean", name: "Brightclean" }]} />
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

function Panel() {
  return (
    <section aria-labelledby="catalog-panel-waiting">
      <h2 className="mb-2 font-medium text-base" id="catalog-panel-waiting">
        Waiting on you
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        <li className="py-2">
          <a className="text-sm underline-offset-4 hover:underline" href="#v4">
            Approve and publish version 4
          </a>
          <p className="text-[0.8125rem] text-muted-foreground">
            Approval, expires 3 Oct 2026
          </p>
        </li>
        <li className="py-2">
          <p className="text-sm">What are your Saturday hours?</p>
          <p className="text-[0.8125rem] text-muted-foreground">
            Question, expires 4 Oct 2026
          </p>
        </li>
      </ul>
    </section>
  )
}

function ShellSample() {
  return (
    <WorkspaceShell
      className="h-[40rem] border border-border"
      panel={<Panel />}
      panelCount={2}
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

const workspaceCatalog: Entry[] = [
  { name: "WorkspaceShell", render: () => <ShellSample /> },
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
]

export { workspaceCatalog }
