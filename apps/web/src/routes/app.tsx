import {
  ArrowUpRightIcon,
  BuildingsIcon,
  CheckCircleIcon,
  FileTextIcon,
  FlowArrowIcon,
  GearSixIcon,
  NotePencilIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SparkleIcon,
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
import { AppNav, navLinkClass } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import {
  ConversationMenu,
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import { useEffect } from "react"
import {
  getWorkspaceFrame,
  pollWorkspace,
  updateConversation,
} from "@/lib/api/server"
import type { WorkspacePoll } from "@/lib/api/types"
import { retryOrgWrite } from "@/lib/auth/actions"
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
import { WorkspacePanel, WorkspacePanelLine } from "@/panel/workspace-panel"

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

/** The owner's own pages, in the profile menu above Account. */
const PROFILE_NAV = [
  { to: "/app/profile", label: "Business", icon: BuildingsIcon },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon },
] as const

/** Up to two initials for the profile button: "N Khan" is "NK". */
const initialsOf = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("")

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
    orgPending,
    panelOpen,
    railOpen,
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
  const onboarding = conversations?.find(
    (each) => each.kind === "onboarding" && !each.archived_at
  )
  const router = useRouter()
  // A signup whose organisation was not written: write it now, then read
  // every loader again under the session that carries it. Once per page
  // load, so a write that still fails waits for the next visit.
  useEffect(() => {
    if (!orgPending) return
    retryOrgWrite().then(
      (written) => (written ? router.invalidate() : undefined),
      () => undefined
    )
  }, [orgPending, router])
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
        defaultRailOpen={railOpen}
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
        notifications={<Link to="/app/notifications" />}
        panel={<WorkspacePanel />}
        panelLine={<WorkspacePanelLine />}
        title={stored ? conversationTitle(stored) : conversation}
        unread={unread}
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
              <li>
                <Link className={navLinkClass} to="/app/approvals">
                  <CheckCircleIcon aria-hidden />
                  Approvals
                </Link>
              </li>
            </AppNav>
            <div className="mt-auto flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      className="min-w-0 flex-1 justify-start gap-2 px-1.5"
                      data-slot="profile-menu"
                      size="sm"
                      variant="ghost"
                    />
                  }
                >
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[0.6875rem] text-primary-foreground"
                  >
                    {initialsOf(owner.name || owner.email)}
                  </span>
                  <span className="truncate">{owner.name || owner.email}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" side="top">
                  <div className="flex flex-col px-2.5 py-1.5">
                    <span className="truncate font-medium text-sm">
                      {owner.name || owner.email}
                    </span>
                    {owner.name ? (
                      <span className="truncate text-muted-foreground text-xs">
                        {owner.email}
                      </span>
                    ) : null}
                  </div>
                  <DropdownMenuSeparator />
                  {PROFILE_NAV.map((item) => (
                    <DropdownMenuLinkItem
                      key={item.to}
                      render={<Link to={item.to} />}
                    >
                      <item.icon aria-hidden />
                      {item.label}
                    </DropdownMenuLinkItem>
                  ))}
                  <DropdownMenuLinkItem render={<Link to="/app/account" />}>
                    <GearSixIcon aria-hidden />
                    Account
                  </DropdownMenuLinkItem>
                  <DropdownMenuSeparator />
                  {/* A plain link, not a router one: the router preloads a
                    route on hover and focus, and /sign-out signs out in its
                    loader. */}
                  <DropdownMenuLinkItem href="/sign-out">
                    <SignOutIcon aria-hidden />
                    Sign out
                  </DropdownMenuLinkItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Help"
                      className="shrink-0"
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <QuestionIcon aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" side="top">
                  {onboarding ? (
                    <DropdownMenuLinkItem
                      render={
                        <Link params={{ id: onboarding.id }} to="/app/c/$id" />
                      }
                    >
                      <SparkleIcon aria-hidden />
                      Getting started
                    </DropdownMenuLinkItem>
                  ) : null}
                  <DropdownMenuLinkItem
                    render={
                      <Link
                        state={() => ({ chat: crypto.randomUUID() })}
                        to="/app"
                      />
                    }
                  >
                    <NotePencilIcon aria-hidden />
                    Ask Reme for help
                  </DropdownMenuLinkItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLinkItem
                    href="/privacy"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ShieldCheckIcon aria-hidden />
                    Privacy
                    <ArrowUpRightIcon
                      aria-hidden
                      className="ms-auto text-muted-foreground"
                    />
                  </DropdownMenuLinkItem>
                  <DropdownMenuLinkItem
                    href="/terms"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <FileTextIcon aria-hidden />
                    Terms
                    <ArrowUpRightIcon
                      aria-hidden
                      className="ms-auto text-muted-foreground"
                    />
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
