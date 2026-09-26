import {
  BuildingsIcon,
  CheckCircleIcon,
  FlowArrowIcon,
  NotePencilIcon,
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
import { AppNav, navLinkClass } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { OrgSwitcher } from "@workspace/ui/components/org-switcher"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import {
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import { getWorkspaceFrame, selectOrg } from "@/lib/api/server"
import type { AttentionItem } from "@/lib/api/types"
import { requireOwner } from "@/lib/tenant"

export const Route = createFileRoute("/app")({
  // The authentication guard, in this loader and specifically not in
  // `beforeLoad`: that runs on the client during hydration, where the server
  // session is not readable. Every page under /app is behind it, so a new
  // route is protected by where it lives rather than by remembering.
  loader: async ({ location }) => {
    const owner = await requireOwner(location.href)
    return { owner, ...(await getWorkspaceFrame()) }
  },
  component: AppLayout,
})

const NAV = [
  { to: "/app/approvals", label: "Approvals", icon: CheckCircleIcon },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon },
  { to: "/app/profile", label: "Business", icon: BuildingsIcon },
] as const

/** The conversation owns its height and scroll; every other page is padded. */
const CONVERSATION = /^\/app(\/c\/[^/]+)?\/?$/

function AppLayout() {
  const { owner, orgs, active, panelOpen, waiting } = Route.useLoaderData()
  const pathname = useLocation({ select: (location) => location.pathname })
  const router = useRouter()

  return (
    <WorkspaceShell
      defaultPanelOpen={panelOpen}
      panel={<Waiting items={waiting} />}
      panelCount={waiting.length}
      rail={
        <>
          <OrgSwitcher
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
          <Link
            activeOptions={{ exact: true }}
            className={navLinkClass}
            to="/app"
          >
            <NotePencilIcon aria-hidden />
            New chat
          </Link>
          <AppNav aria-label="Main">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link className={navLinkClass} to={item.to}>
                  <item.icon aria-hidden />
                  {item.label}
                </Link>
              </li>
            ))}
          </AppNav>
          <div className="mt-auto flex items-center gap-1">
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
                <span className="truncate">{owner.name || owner.email}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top">
                <DropdownMenuLinkItem render={<Link to="/app/account" />}>
                  Account
                </DropdownMenuLinkItem>
                <DropdownMenuLinkItem render={<Link to="/sign-out" />}>
                  Sign out
                </DropdownMenuLinkItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ThemeToggle className="shrink-0" />
          </div>
        </>
      }
    >
      {CONVERSATION.test(pathname) ? (
        <Outlet />
      ) : (
        <WorkspacePage>
          <Outlet />
        </WorkspacePage>
      )}
    </WorkspaceShell>
  )
}

const KIND = { approval: "Approval", question: "Question" } as const

/**
 * The panel until the live panel lands: what is waiting on the owner, from the
 * same attention list the approvals inbox reads.
 */
function Waiting({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="panel-waiting">
      <h2 className="mb-2 font-medium text-base" id="panel-waiting">
        Waiting on you
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing right now. Questions and approvals from your team land here.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item) => {
            const expires = formatDate(item.expiresAt)
            return (
              <li className="py-2" key={item.id}>
                {item.kind === "approval" ? (
                  <Link
                    className="text-sm underline-offset-4 hover:underline"
                    to="/app/approvals"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <p className="text-sm">{item.title}</p>
                )}
                <p className="text-[0.8125rem] text-muted-foreground">
                  {KIND[item.kind as keyof typeof KIND]}
                  {expires ? `, expires ${expires}` : null}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
