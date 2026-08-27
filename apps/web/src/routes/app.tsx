import {
  BuildingsIcon,
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
  useRouter,
} from "@tanstack/react-router"
import {
  AppNav,
  AppShell,
  navLinkClass,
} from "@workspace/ui/components/app-shell"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { getOrgContext, selectOrg } from "@/lib/api/server"
import { requireOwner } from "@/lib/tenant"

export const Route = createFileRoute("/app")({
  // The authentication guard, in this loader and specifically not in
  // `beforeLoad`: that runs on the client during hydration, where the server
  // session is not readable. Every page under /app is behind it, so a new
  // route is protected by where it lives rather than by remembering.
  loader: async ({ location }) => {
    const owner = await requireOwner(location.href)
    // The organisation list and the current selection, both resolved on the
    // server. This is what replaced the `listOwnerOrgs` placeholder.
    return { owner, ...(await getOrgContext()) }
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
  { to: "/app/profile", label: "Business", icon: BuildingsIcon, exact: false },
  { to: "/app/account", label: "Account", icon: UserCircleIcon, exact: false },
] as const

function AppLayout() {
  const { orgs, active } = Route.useLoaderData()
  const pathname = useLocation({ select: (location) => location.pathname })
  const router = useRouter()

  return (
    <AppShell
      sidebar={
        <>
          <div className="flex items-end gap-2">
            <OrgSwitcher
              className="min-w-0 flex-1"
              onChange={async (event) => {
                // The server decides. This posts the slug the owner picked and
                // then reloads every loader, so the screens read whatever
                // organisation the server resolved rather than what the select
                // now shows.
                await selectOrg({
                  data: { organisation: event.target.value },
                })
                await router.invalidate()
              }}
              // The option value is the slug, because that is what the server
              // accepts: an organisation id never travels through the client.
              orgs={orgs.map((org) => ({ id: org.slug, name: org.name }))}
              value={active?.slug ?? ""}
            />
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
