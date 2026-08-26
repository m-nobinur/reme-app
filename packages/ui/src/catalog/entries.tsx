import {
  CheckCircleIcon,
  HouseIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import {
  AppNav,
  AppShell,
  navLinkClass,
  PageHeader,
} from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { Input } from "@workspace/ui/components/input"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { LoadingState } from "@workspace/ui/components/loading-state"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import type { ReactNode } from "react"

type CatalogEntry = {
  /** The exported component's own name. The drift test matches on it. */
  name: string
  render: () => ReactNode
}

const noop = () => undefined

/** The golden orgs from the seed plan. Both are unmistakably invented. */
const FIXTURE_ORGS = [
  { id: "brightclean", name: "Brightclean" },
  { id: "mopandbucket", name: "Mop and Bucket" },
]

const NAV = [
  { href: "/app", label: "Dashboard", icon: HouseIcon },
  { href: "/app/approvals", label: "Approvals", icon: CheckCircleIcon },
  { href: "/app/staff", label: "Staff", icon: UsersThreeIcon },
]

/**
 * Every primitive in the package, rendered once. The a11y scan and the visual
 * snapshot both read this list, so a primitive that is missing here has neither.
 * `test/catalog.spec.ts` fails when a component file exports something this
 * array does not name.
 *
 * A plain array rather than Storybook: the two consumers are a headless browser
 * and a person reading the page, and neither needs a framework to get that.
 */
const catalog: CatalogEntry[] = [
  {
    name: "Button",
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Button>Approve</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button aria-label="Dashboard" size="icon">
          <HouseIcon aria-hidden />
        </Button>
      </div>
    ),
  },
  {
    name: "Input",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <label className="text-sm" htmlFor="catalog-input">
          Business name
        </label>
        <Input id="catalog-input" placeholder="Business name" />
        <Input
          aria-label="Read only"
          defaultValue="Filled"
          id="catalog-input-filled"
          readOnly
        />
        <Input
          aria-invalid
          aria-label="Disabled and invalid"
          disabled
          id="catalog-input-disabled"
        />
      </div>
    ),
  },
  {
    name: "Skeleton",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 rounded-3xl" />
      </div>
    ),
  },
  {
    name: "LoadingState",
    render: () => <LoadingState className="max-w-sm" />,
  },
  {
    name: "EmptyState",
    render: () => (
      <EmptyState
        action={<Button variant="outline">Try again</Button>}
        description="Approval requests appear here as Reme raises them."
        icon={<CheckCircleIcon />}
        title="Nothing waiting on you"
      />
    ),
  },
  {
    name: "ListFilter",
    render: () => (
      <ListFilter label="Filter staff" onValueChange={noop} value="cleaner" />
    ),
  },
  {
    name: "OrgSwitcher",
    render: () => (
      <div className="flex max-w-xs flex-col gap-4 rounded-3xl bg-sidebar p-3 text-sidebar-foreground">
        <OrgSwitcher orgs={FIXTURE_ORGS} />
      </div>
    ),
  },
  {
    name: "ThemeToggle",
    render: () => <ThemeToggle />,
  },
  {
    name: "PageHeader",
    render: () => (
      <PageHeader
        actions={<Button variant="outline">Add someone</Button>}
        description="The people and the AI roles that make up your organisation."
        title="Staff"
      />
    ),
  },
  {
    name: "AppNav",
    render: () => (
      <div className="max-w-60 rounded-3xl bg-sidebar p-3">
        <AppNav activeKey="/app" aria-label="Catalog">
          {NAV.map((item) => (
            <li key={item.href}>
              <a
                aria-current={item.href === "/app" ? "page" : undefined}
                className={navLinkClass}
                href={item.href}
              >
                <item.icon aria-hidden />
                {item.label}
              </a>
            </li>
          ))}
        </AppNav>
      </div>
    ),
  },
  {
    name: "AppShell",
    render: () => (
      <AppShell
        className="min-h-0 rounded-3xl border border-border"
        sidebar={
          <>
            <OrgSwitcher orgs={FIXTURE_ORGS} />
            <AppNav activeKey="/app" aria-label="Shell">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    aria-current={item.href === "/app" ? "page" : undefined}
                    className={navLinkClass}
                    href={item.href}
                  >
                    <item.icon aria-hidden />
                    {item.label}
                  </a>
                </li>
              ))}
            </AppNav>
          </>
        }
      >
        <PageHeader
          description="What Reme did, what it is waiting on you for, and what it wants to do next."
          title="Dashboard"
        />
        <EmptyState
          description="Nothing has run yet. Activity appears here once an organisation is connected."
          title="No activity yet"
        />
      </AppShell>
    ),
  },
]

export type { CatalogEntry }
export { catalog }
