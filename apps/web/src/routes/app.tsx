import {
  CheckCircleIcon,
  FlowArrowIcon,
  HouseIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link, Outlet } from "@tanstack/react-router"
import { AppShell, navLinkClass } from "@workspace/ui/components/app-shell"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { listOwnerOrgs } from "@/lib/org"

export const Route = createFileRoute("/app")({
  // The authentication guard belongs in this loader, and specifically not in
  // `beforeLoad`: that runs on the client during hydration, where the server
  // session is not readable. When sign-in exists, the check and its
  // `throw redirect(...)` go at the top of this function and nothing else in
  // the layout moves.
  loader: async () => ({ orgs: await listOwnerOrgs() }),
  component: AppLayout,
})

const NAV = [
  { to: "/app", label: "Dashboard", icon: HouseIcon, exact: true },
  {
    to: "/app/approvals",
    label: "Approvals",
    icon: CheckCircleIcon,
    exact: false,
  },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon, exact: false },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon, exact: false },
] as const

function AppLayout() {
  const { orgs } = Route.useLoaderData()

  return (
    <AppShell
      sidebar={
        <>
          <div className="flex items-end gap-2">
            <OrgSwitcher className="min-w-0 flex-1" orgs={orgs} />
            <ThemeToggle className="shrink-0" />
          </div>
          <nav aria-label="Main" className="min-w-0">
            <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
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
            </ul>
          </nav>
        </>
      }
    >
      <Outlet />
    </AppShell>
  )
}
