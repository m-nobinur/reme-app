import {
  BellIcon,
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
  redirect,
  useLocation,
  useMatches,
  useMatchRoute,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router"
import type { Conversation } from "@workspace/contracts"
import {
  AppNav,
  NavCount,
  navLinkClass,
} from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import {
  ConversationMenu,
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import {
  getWorkspaceFrame,
  pollWorkspace,
  updateConversation,
} from "@/lib/api/server"
import type { WorkspacePoll } from "@/lib/api/types"
import {
  archiveConversation,
  saveTitle,
  titleToEdit,
  useMenuState,
} from "@/lib/conversation-actions"
import { notificationsOf, unreadCount } from "@/lib/notifications"
import { onboardingFor } from "@/lib/onboarding"
import { requireOwner } from "@/lib/tenant"
import { LiveWorkspaceProvider, useLiveWorkspaceState } from "@/lib/workspace"
import { WorkspacePanel } from "@/panel/workspace-panel"

export const Route = createFileRoute("/app")({
  // The authentication guard, in this loader and specifically not in
  // `beforeLoad`: that runs on the client during hydration, where the server
  // session is not readable. Every page under /app is behind it, so a new
  // route is protected by where it lives rather than by remembering.
  loader: async ({ location }) => {
    const owner = await requireOwner(location.href)
    const frame = await getWorkspaceFrame()
    // A new owner lands in onboarding. Here rather than in the index route,
    // which has no loader of its own (a second one on the same navigation
    // races on a cold dev server). Only the bare address: "New chat" carries
    // a state and still opens a new chat.
    const onboarding = onboardingFor(frame.workspace, frame.conversations)
    if (
      onboarding &&
      /^\/app\/?$/.test(location.pathname) &&
      !location.state.chat
    ) {
      throw redirect({
        to: "/app/c/$id",
        params: { id: onboarding },
        replace: true,
      })
    }
    return { owner, ...frame }
  },
  component: AppLayout,
})

const NAV = [
  { to: "/app/notifications", label: "Notifications", icon: BellIcon },
  { to: "/app/approvals", label: "Approvals", icon: CheckCircleIcon },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon },
  { to: "/app/profile", label: "Business", icon: BuildingsIcon },
] as const

/** The panel's poll, through the server, with the tag it last saw. */
const readWorkspace = async (etag: string | null): Promise<WorkspacePoll> => {
  const poll = await pollWorkspace({ data: { etag } })
  return poll.changed ? poll.workspace : "unchanged"
}

/** What the rail and the top bar call a conversation. */
const conversationTitle = (conversation: Conversation) =>
  conversation.title ??
  (conversation.kind === "onboarding"
    ? "Getting started"
    : `Chat from ${formatDate(conversation.created_at)}`)

function AppLayout() {
  const {
    owner,
    active,
    panelOpen,
    workspace,
    conversations,
    activity,
    seenAt,
  } = Route.useLoaderData()
  const live = useLiveWorkspaceState(workspace, readWorkspace)
  // Nothing is unread on the page that lists it, even before the next
  // frame read picks up the cookie that page wrote.
  const reading = useMatchRoute()({ to: "/app/notifications" })
  const unread = reading
    ? 0
    : unreadCount(
        notificationsOf(live.workspace?.attention ?? [], activity ?? []),
        seenAt
      )
  // The conversation route's own title, or undefined on every other page.
  const conversation = useMatches({
    select: (matches) =>
      matches.find((match) => match.staticData.conversation)?.staticData
        .conversation,
  })
  const { id } = useParams({ strict: false })
  const stored = conversations?.find((each) => each.id === id)
  const router = useRouter()
  const navigate = useNavigate()
  const openPanel = useLocation({ select: (at) => at.state.panel === true })
  const { renaming, setRenaming, failed, setFailed } = useMenuState(id)
  const archive = async (target: Conversation) => {
    setFailed(null)
    const archived = await archiveConversation(target.id, {
      // One key per press: a retry of this press replays it, a later press
      // is its own request.
      update: (each) =>
        updateConversation({
          data: { id: each, archived: true, key: crypto.randomUUID() },
        }),
      stillOn: (each) => router.state.location.pathname === `/app/c/${each}`,
      leave: async () => {
        await navigate({ to: "/app", state: { chat: crypto.randomUUID() } })
      },
    })
    if (archived) await router.invalidate()
    else setFailed(target.id)
  }

  return (
    <LiveWorkspaceProvider value={live}>
      <WorkspaceShell
        defaultPanelOpen={panelOpen}
        openPanel={openPanel}
        menu={
          conversation ? (
            <ConversationMenu
              newChat={
                <Link state={() => ({ chat: crypto.randomUUID() })} to="/app" />
              }
              onArchive={stored ? () => archive(stored) : undefined}
              onRename={
                stored
                  ? () => {
                      setFailed(null)
                      setRenaming(stored.id)
                    }
                  : undefined
              }
            />
          ) : undefined
        }
        panel={<WorkspacePanel />}
        panelCount={live.workspace?.attention.length ?? 0}
        railCount={unread}
        title={stored ? conversationTitle(stored) : conversation}
        titleError={
          stored && failed === stored.id
            ? "That did not archive. Try again."
            : undefined
        }
        renaming={
          stored && renaming === stored.id
            ? {
                value: titleToEdit(stored),
                onSave: async (title) => {
                  await saveTitle(stored, title, (each, next) =>
                    updateConversation({
                      data: { id: each, title: next, key: crypto.randomUUID() },
                    })
                  )
                  await router.invalidate()
                  setRenaming(null)
                },
                onCancel: () => setRenaming(null),
              }
            : undefined
        }
        rail={
          <>
            <p
              className="truncate px-2 font-medium text-sm"
              title={active?.name}
            >
              {active?.name ?? "No organisation"}
            </p>
            <Link
              activeOptions={{ exact: true }}
              className={navLinkClass}
              // A fresh state on every click: on /app already, the address
              // does not change, and the state is what says "start again".
              state={() => ({ chat: crypto.randomUUID() })}
              to="/app"
            >
              <NotePencilIcon aria-hidden />
              New chat
            </Link>
            {conversations?.some((each) => !each.archived_at) ? (
              <AppNav aria-label="Chats">
                {conversations
                  .filter((each) => !each.archived_at)
                  .map((each) => (
                    <li key={each.id}>
                      <Link
                        className={navLinkClass}
                        params={{ id: each.id }}
                        to="/app/c/$id"
                      >
                        <span className="truncate">
                          {conversationTitle(each)}
                        </span>
                      </Link>
                    </li>
                  ))}
              </AppNav>
            ) : null}
            <AppNav aria-label="Main">
              {NAV.map((item) => (
                <li key={item.to}>
                  <Link className={navLinkClass} to={item.to}>
                    <item.icon aria-hidden />
                    {item.label}
                    {item.to === "/app/notifications" ? (
                      <NavCount count={unread} />
                    ) : null}
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
    </LiveWorkspaceProvider>
  )
}
