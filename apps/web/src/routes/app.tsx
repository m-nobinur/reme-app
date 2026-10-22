import {
  AlarmIcon,
  ChatCircleTextIcon,
  GlobeIcon,
  ListChecksIcon,
  NotePencilIcon,
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
import {
  ChatHistory,
  type HistoryEntry,
} from "@workspace/ui/components/history-menu"
import {
  type NotificationEntry,
  NotificationMenu,
} from "@workspace/ui/components/notification-list"
import { PipelineIcon } from "@workspace/ui/components/pipeline-icon"
import { Hint } from "@workspace/ui/components/tooltip"
import {
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import { SiteNameProvider } from "@workspace/ui/lib/site-name"
import { useCallback, useEffect, useId, useState } from "react"
import { lastChat } from "@/chat/history"
import { getWorkspaceFrame, pollWorkspace } from "@/lib/api/server"
import type { WorkspacePoll } from "@/lib/api/types"
import { retryOrgWrite } from "@/lib/auth/actions"
import { useAutoPanel } from "@/lib/auto-panel"
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
import { onboardingFor, settingUp } from "@/lib/onboarding"
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
    // No business we hold, and no signup write to retry: name it first. No
    // return address, so a new business lands in onboarding at /app.
    if (!frame.active && !frame.orgPending) {
      throw redirect({ to: "/name-your-business", search: {} })
    }
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

/** The rail's sections after the chat. */
const SECTIONS = [
  { to: "/app/website", label: "Website", icon: GlobeIcon },
  { to: "/app/pipeline", label: "Pipeline", icon: PipelineIcon },
  { to: "/app/reminders", label: "Reminders", icon: AlarmIcon },
  { to: "/app/tasks", label: "Tasks", icon: ListChecksIcon },
] as const

/** Why a new conversation waits for setup, in the rail's tooltip. */
const SETUP_FIRST =
  "Your assistant needs to know your business before it can help with anything else."

/** How many notifications the rail's bell lists before "View all". */
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
  const auto = useAutoPanel(live.workspace)
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
  // A new conversation has no activity to show beside it yet: the composer
  // takes the page, and the panel appears once the first message stores it.
  const showPanel = hasPanel && !(conversation && !id)
  // Getting started stays in the help menu until the first build.
  const onboarding = onboardingFor(live.workspace, conversations)
  const setupOpen = settingUp(live.workspace)
  const setupFirstId = useId()
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

  return (
    <LiveWorkspaceProvider value={live}>
      {/* The plan card in the panel names the business. */}
      <SiteNameProvider value={active?.name ?? null}>
        <WorkspaceShell
          autoPanel={auto.request}
          defaultPanelOpen={panelOpen}
          defaultRailOpen={railOpen}
          onPanelToggle={auto.toggled}
          openPanel={press}
          panel={showPanel ? <WorkspacePanel panel={panel} /> : null}
          panelLine={showPanel ? <WorkspacePanelLine panel={panel} /> : null}
          rail={
            <>
              <nav aria-label="Main" className="flex flex-col gap-2">
                {last ? (
                  // Hovering the link lists every conversation beside it.
                  <ChatHistory
                    current={id}
                    items={history}
                    trigger={
                      <Link
                        className={railItemClass}
                        params={{ id: last.id }}
                        to="/app/c/$id"
                      >
                        <ChatCircleTextIcon aria-hidden />
                        <span data-slot="rail-label">Chat</span>
                      </Link>
                    }
                  />
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
                {setupOpen ? (
                  <Hint
                    detail={SETUP_FIRST}
                    label="Finish setting up first"
                    side="right"
                  >
                    {/* Not until setup is done: the assistant needs the
                      business first. A button that does nothing, still
                      reachable, so a keyboard hears why. */}
                    <button
                      aria-describedby={setupFirstId}
                      aria-disabled="true"
                      className={`${railItemClass} cursor-default opacity-50`}
                      type="button"
                    >
                      <NotePencilIcon aria-hidden />
                      <span data-slot="rail-label">New conversation</span>
                      <span className="sr-only" id={setupFirstId}>
                        {SETUP_FIRST}
                      </span>
                    </button>
                  </Hint>
                ) : (
                  <Hint label="New conversation" side="right">
                    {/* The new-conversation screen is home, so this is current only on
                      the bare address, and a fresh state starts one each time. */}
                    <Link
                      activeOptions={{ exact: true }}
                      className={railItemClass}
                      state={() => ({ chat: crypto.randomUUID() })}
                      to="/app"
                    >
                      <NotePencilIcon aria-hidden />
                      <span data-slot="rail-label">New conversation</span>
                    </Link>
                  </Hint>
                )}
                {SECTIONS.map((item) => (
                  <Hint key={item.to} label={item.label} side="right">
                    <Link className={railItemClass} to={item.to}>
                      <item.icon aria-hidden />
                      <span className="truncate" data-slot="rail-label">
                        {item.label}
                      </span>
                    </Link>
                  </Hint>
                ))}
              </nav>
              <div className="mt-auto flex flex-col gap-2">
                <NotificationMenu
                  items={entries}
                  onOpenChange={markMenuSeen}
                  unread={unread}
                  viewAll={<Link to="/app/notifications" />}
                  zone={zone}
                />
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
