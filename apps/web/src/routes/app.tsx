import {
  BuildingsIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  FlowArrowIcon,
  NotePencilIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import {
  createFileRoute,
  Link,
  Outlet,
  useMatches,
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

function AppLayout() {
  const { owner, orgs, active, panelOpen, workspace } = Route.useLoaderData()
  const waiting = workspace?.attention ?? null
  // The conversation owns its height and scroll; every other page is padded.
  const conversation = useMatches({
    select: (matches) => matches.some((match) => match.staticData.conversation),
  })
  const router = useRouter()

  return (
    <WorkspaceShell
      defaultPanelOpen={panelOpen}
      menu={conversation ? <ConversationMenu /> : undefined}
      panel={<Waiting items={waiting} />}
      panelCount={waiting?.length ?? 0}
      // Until conversations are stored, every one is a new chat.
      title={conversation ? "New chat" : undefined}
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
            // A fresh state on every click, so a click on /app is a new
            // navigation: the router reloads in place when both the address
            // and the state match, and the conversation would keep its thread.
            state={() => ({ chat: crypto.randomUUID() })}
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
                {/* A plain link, not a router one: the router preloads a
                    route on hover and focus, and /sign-out signs out in its
                    loader. */}
                <DropdownMenuLinkItem href="/sign-out">
                  Sign out
                </DropdownMenuLinkItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ThemeToggle className="shrink-0" />
          </div>
        </>
      }
    >
      {conversation ? (
        <Outlet />
      ) : (
        <WorkspacePage>
          <Outlet />
        </WorkspacePage>
      )}
    </WorkspaceShell>
  )
}

/** The conversation's ··· menu. Rename and archive join it once conversations are stored. */
function ConversationMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Conversation actions"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <DotsThreeIcon aria-hidden weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLinkItem
          render={
            <Link state={() => ({ chat: crypto.randomUUID() })} to="/app" />
          }
        >
          <NotePencilIcon aria-hidden />
          New chat
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const KIND = { approval: "Approval", question: "Question" } as const

/**
 * The panel until the live panel lands: what is waiting on the owner, from the
 * same attention list the approvals inbox reads.
 */
function Waiting({ items }: { items: AttentionItem[] | null }) {
  return (
    <section aria-labelledby="panel-waiting">
      <h2 className="mb-2 font-medium text-base" id="panel-waiting">
        Waiting on you
      </h2>
      {items === null ? (
        <p className="text-muted-foreground text-sm">
          This list could not be loaded. It will try again when you next open a
          page.
        </p>
      ) : items.length === 0 ? (
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
