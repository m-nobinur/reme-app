import {
  AlarmIcon,
  BellIcon,
  BrainIcon,
  BuildingsIcon,
  ChatCircleTextIcon,
  FlowArrowIcon,
  GlobeIcon,
  NotePencilIcon,
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
import { railItemClass } from "@workspace/ui/components/app-shell"
import { SiteNameProvider } from "@workspace/ui/components/assistant/blueprint-card"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  type HistoryEntry,
  HistoryMenu,
} from "@workspace/ui/components/history-menu"
import { LogoMark } from "@workspace/ui/components/logo"
import {
  type NotificationEntry,
  NotificationMenu,
} from "@workspace/ui/components/notification-list"
import { Hint } from "@workspace/ui/components/tooltip"
import {
  ConversationMenu,
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import { useCallback, useEffect, useState } from "react"
import { lastChat } from "@/chat/history"
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
import {
  GoogleNotice,
  type GoogleResult,
  googleResult,
  useGoogleResult,
} from "@/lib/google-notice"
import {
  laterSeen,
  markSeen,
  notificationsOf,
  unreadCount,
} from "@/lib/notifications"
import { onboardingFor } from "@/lib/onboarding"
import { OwnerSettings } from "@/lib/owner-settings"
import { anchorOf } from "@/lib/reminders"
import { requireOwner } from "@/lib/tenant"
import { LiveWorkspaceProvider, useLiveWorkspaceState } from "@/lib/workspace"
import {
  PanelAnnouncer,
  useBrowserZone,
  usePanel,
  WorkspacePanel,
  WorkspacePanelLine,
} from "@/panel/workspace-panel"

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
  // `?google=` is where the Google connect callback sends the owner back.
  validateSearch: (
    search: Record<string, unknown>
  ): { google?: GoogleResult } => {
    const google = googleResult(search.google)
    return google ? { google } : {}
  },
  component: AppLayout,
})

/**
 * The rail's sections after the chat. The business is named for the
 * organisation, so its label is filled in where the name is known.
 */
const SECTIONS = [
  { to: "/app/website", label: "Website", icon: GlobeIcon },
  { to: "/app/profile", label: null, icon: BuildingsIcon },
  { to: "/app/staff", label: "Staff", icon: UsersThreeIcon },
  { to: "/app/pipeline", label: "Pipeline", icon: FlowArrowIcon },
] as const

/** How many notifications the bell's menu lists before "View all". */
const MENU_ITEMS = 6

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
  // What the panel says on this page; with nothing to say there is no panel.
  // A workspace that did not load still shows one, which says so.
  const panel = usePanel(live.workspace)
  const hasPanel = panel !== null || live.workspace === null
  const orgName = active?.name ?? "No organisation"
  const notifications = notificationsOf(
    live.workspace?.attention ?? [],
    activity ?? []
  )
  // Seen from the bell's menu here, ahead of the frame read that picks up
  // the cookie it wrote.
  const [seenHere, setSeenHere] = useState<string | null>(null)
  const seen = laterSeen(seenAt, seenHere)
  // Nothing is unread on the page that lists it, even before the next
  // frame read picks up the cookie that page wrote.
  const reading = useMatchRoute()({ to: "/app/notifications" })
  const unread = reading ? 0 : unreadCount(notifications, seen)
  // Closing the menu marks what it showed as seen. Not while a read failed:
  // an item it would have shown would be marked read unseen.
  const newest = notifications[0]?.raisedAt
  const zone = useBrowserZone()
  const markMenuSeen = (open: boolean) => {
    if (open || !active || !newest || !live.workspace || activity === null)
      return
    markSeen(active.id, newest)
    setSeenHere(newest)
  }
  // The conversation route's own title, or undefined on every other page.
  const conversation = useMatches({
    select: (matches) =>
      matches.find((match) => match.staticData.conversation)?.staticData
        .conversation,
  })
  const { id } = useParams({ strict: false })
  const stored = conversations?.find((each) => each.id === id)
  // Getting started stays in the help menu until the first build.
  const onboarding = onboardingFor(live.workspace, conversations)
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
  const clearGoogle = useCallback(
    () =>
      navigate({
        to: ".",
        search: (prev) => ({ ...prev, google: undefined }),
        replace: true,
      }),
    [navigate]
  )
  const [google, dismissGoogle] = useGoogleResult(
    Route.useSearch().google,
    clearGoogle
  )
  // A link here asked for the panel, or the bell's menu did.
  const arrived = useLocation({ select: (at) => at.state.panel })
  const [press, setPress] = useState(arrived)
  useEffect(() => {
    if (arrived) setPress(arrived)
  }, [arrived])
  const entries = notifications.slice(0, MENU_ITEMS).map(
    (item): NotificationEntry => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      at: item.raisedAt,
      unread: seen === null || Date.parse(item.raisedAt) > Date.parse(seen),
      // Questions and approvals are answered in the panel, where they wait;
      // reports and alerts are read in full on the notifications page.
      ...(item.kind === "approval" || item.kind === "question"
        ? {
            onSelect: () =>
              setPress({
                key: crypto.randomUUID(),
                focus: anchorOf[item.kind](item.id),
              }),
          }
        : { link: <Link to="/app/notifications" /> }),
    })
  )
  // The clock's list at the top right: every open chat, newest first.
  const history = (conversations ?? [])
    .filter((each) => !each.archived_at)
    .map(
      (each): HistoryEntry => ({
        id: each.id,
        title: conversationTitle(each),
        at: each.updated_at,
        link: <Link params={{ id: each.id }} to="/app/c/$id" />,
      })
    )
  // The rail's Chat icon: current only inside this conversation.
  const last = lastChat(conversations)
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
      {/* The plan card names the business wherever it shows: chat, panel, approvals. */}
      <SiteNameProvider value={active?.name ?? null}>
        <WorkspaceShell
          defaultPanelOpen={panelOpen}
          defaultRailOpen={railOpen}
          openPanel={press}
          menu={
            conversation ? (
              <ConversationMenu
                newChat={
                  <Link
                    state={() => ({ chat: crypto.randomUUID() })}
                    to="/app"
                  />
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
          actions={
            <>
              <Hint label="New chat">
                <Link
                  aria-label="New chat"
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                  // A fresh state on every click: on /app already, the address
                  // does not change, and the state is what says "start again".
                  state={() => ({ chat: crypto.randomUUID() })}
                  to="/app"
                >
                  <NotePencilIcon aria-hidden />
                </Link>
              </Hint>
              <HistoryMenu current={id} items={history} />
            </>
          }
          notifications={
            <NotificationMenu
              items={entries}
              onOpenChange={markMenuSeen}
              unread={unread}
              viewAll={<Link to="/app/notifications" />}
              zone={zone}
            />
          }
          panel={hasPanel ? <WorkspacePanel panel={panel} /> : null}
          panelLine={hasPanel ? <WorkspacePanelLine panel={panel} /> : null}
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
                        data: {
                          id: each,
                          title: next,
                          key: crypto.randomUUID(),
                        },
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
              <span className="flex h-11 shrink-0 items-center px-2.5 text-foreground">
                <LogoMark />
              </span>
              <nav aria-label="Main" className="flex flex-col gap-1">
                <Hint label="New chat" side="right">
                  {/* The new-chat screen is home, so this is current only on
                    the bare address, and a fresh state starts one each time. */}
                  <Link
                    activeOptions={{ exact: true }}
                    className={railItemClass}
                    state={() => ({ chat: crypto.randomUUID() })}
                    to="/app"
                  >
                    <NotePencilIcon aria-hidden />
                    <span data-slot="rail-label">New chat</span>
                  </Link>
                </Hint>
                {last ? (
                  <Hint label="Chat" side="right">
                    <Link
                      className={railItemClass}
                      params={{ id: last.id }}
                      to="/app/c/$id"
                    >
                      <ChatCircleTextIcon aria-hidden />
                      <span data-slot="rail-label">Chat</span>
                    </Link>
                  </Hint>
                ) : (
                  <Hint label="No chats yet" side="right">
                    {/* Nowhere to go yet, so no link: a button that does
                      nothing, still reachable, so a keyboard hears why. */}
                    <button
                      aria-disabled="true"
                      className={`${railItemClass} cursor-default opacity-50`}
                      type="button"
                    >
                      <ChatCircleTextIcon aria-hidden />
                      <span data-slot="rail-label">Chat</span>
                    </button>
                  </Hint>
                )}
                {SECTIONS.map((item) => (
                  <Hint
                    key={item.to}
                    label={item.label ?? orgName}
                    side="right"
                  >
                    <Link className={railItemClass} to={item.to}>
                      <item.icon aria-hidden />
                      <span className="truncate" data-slot="rail-label">
                        {item.label ?? orgName}
                      </span>
                    </Link>
                  </Hint>
                ))}
                <hr className="mx-2 my-2 border-border" />
                <Hint label="Reminders" side="right">
                  <Link className={railItemClass} to="/app/reminders">
                    <AlarmIcon aria-hidden />
                    <span data-slot="rail-label">Reminders</span>
                  </Link>
                </Hint>
                <Hint label="Memory" side="right">
                  <Link className={railItemClass} to="/app/memory">
                    <BrainIcon aria-hidden />
                    <span data-slot="rail-label">Memory</span>
                  </Link>
                </Hint>
              </nav>
              <div className="mt-auto flex flex-col gap-1">
                <Hint label="Notifications" side="right">
                  <Link
                    aria-label={
                      unread > 0
                        ? `Notifications, ${unread} unread`
                        : "Notifications"
                    }
                    className={railItemClass}
                    to="/app/notifications"
                  >
                    <BellIcon aria-hidden />
                    {unread > 0 ? (
                      <span
                        aria-hidden
                        className="absolute start-7 top-2 size-2 rounded-full bg-destructive ring-2 ring-rail"
                        data-slot="unread-dot"
                      />
                    ) : null}
                    <span data-slot="rail-label">Notifications</span>
                  </Link>
                </Hint>
                <OwnerSettings
                  onboarding={onboarding}
                  orgName={orgName}
                  owner={owner}
                  unread={unread}
                />
              </div>
            </>
          }
        >
          <GoogleNotice onDismiss={dismissGoogle} result={google} />
          {conversation ? (
            <Outlet />
          ) : (
            <WorkspacePage>
              <Outlet />
            </WorkspacePage>
          )}
        </WorkspaceShell>
      </SiteNameProvider>
      <PanelAnnouncer panel={panel} />
    </LiveWorkspaceProvider>
  )
}
