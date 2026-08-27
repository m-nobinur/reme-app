import {
  ChatCircleIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  HouseIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router"
import {
  AppNav,
  AppShell,
  navLinkClass,
} from "@workspace/ui/components/app-shell"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { listOwnerOrgs } from "@/lib/org"
import { requireOwner } from "@/lib/tenant"

export const Route = createFileRoute("/app")({
  // The authentication guard, in this loader and specifically not in
  // `beforeLoad`: that runs on the client during hydration, where the server
  // session is not readable. Every page under /app is behind it, so a new
  // route is protected by where it lives rather than by remembering.
  loader: async ({ location }) => {
    const owner = await requireOwner(location.href)
    return { owner, orgs: await listOwnerOrgs() }
  },
  component: AppLayout,
})

const NAV = [
  { to: "/app", label: "Dashboard", icon: HouseIcon, exact: true },
  { to: "/app/chat", label: "Chat", icon: ChatCircleIcon, exact: false },
  {
    to: "/app/approvals",
    label: "Approvals",
    icon: CheckCircleIcon,
    exact: false,
  },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon, exact: false },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon, exact: false },
  { to: "/app/account", label: "Account", icon: UserCircleIcon, exact: false },
] as const

function AppLayout() {
  const { orgs } = Route.useLoaderData()
  const pathname = useLocation({ select: (location) => location.pathname })

  return (
    <AppShell
      sidebar={
        <>
          <div className="flex items-end gap-2">
            <OrgSwitcher className="min-w-0 flex-1" orgs={orgs} />
            <ThemeToggle className="shrink-0" />
          </div>
          <AppNav activeKey={pathname} aria-label="Main">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  activeOptions={{ exact: item.exact }}
                  className={navLinkClass}
                  to={item.to}
                >
                  <item.icon aria-hidden />
                  {item.label}
                </Link>
              </li>
            ))}
          </AppNav>
        </>
      }
    >
      <Outlet />
    </AppShell>
  )
}
