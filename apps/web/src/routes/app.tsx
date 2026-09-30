import {
  AlarmIcon,
  ArrowUpRightIcon,
  BuildingsIcon,
  ChatCircleDotsIcon,
  ChatCircleTextIcon,
  FileTextIcon,
  FlowArrowIcon,
  GearSixIcon,
  GlobeIcon,
  HouseIcon,
  MoonIcon,
  NotePencilIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SparkleIcon,
  SunIcon,
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
import { buttonVariants } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  type HistoryEntry,
  HistoryMenu,
} from "@workspace/ui/components/history-menu"
import {
  type NotificationEntry,
  NotificationMenu,
} from "@workspace/ui/components/notification-list"
import {
  toggleTheme,
  useDarkTheme,
} from "@workspace/ui/components/theme-toggle"
import { Hint } from "@workspace/ui/components/tooltip"
import {
  ConversationMenu,
  WorkspacePage,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { formatDate } from "@workspace/ui/lib/format"
import { useEffect, useState } from "react"
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
  laterSeen,
  markSeen,
  notificationsOf,
  unreadCount,
} from "@/lib/notifications"
import { onboardingFor } from "@/lib/onboarding"
import { anchorOf } from "@/lib/reminders"
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

/**
 * What "Ask Reme for help" sends as the first message of a new chat: short,
 * so it reads as the owner's own question in the thread.
 */
const HELP_PROMPT =
  "What can you help me with? Suggest a few things you could do for my business right now."

/** How many notifications the bell's menu lists before "View all". */
const MENU_ITEMS = 6

/**
 * The theme switch in the profile menu, named for what it switches to. The
 * menu stays open, so the owner sees the change and can switch back.
 */
function ThemeItem() {
  const dark = useDarkTheme()
  return (
    <DropdownMenuItem closeOnClick={false} onClick={toggleTheme}>
      {dark ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
      {dark ? "Light theme" : "Dark theme"}
    </DropdownMenuItem>
  )
}

/** The organisation's initials on a rounded square, where its name goes. */
function OrgMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground font-semibold text-[0.6875rem] text-background"
      data-slot="mark"
    >
      {initialsOf(name)}
    </span>
  )
}

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
  const orgName = active?.name ?? "No organisation"
  const ownerName = owner.name || owner.email
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
      <WorkspaceShell
        defaultPanelOpen={panelOpen}
        defaultRailOpen={railOpen}
        openPanel={press}
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
          />
        }
        panel={<WorkspacePanel />}
        panelLine={<WorkspacePanelLine />}
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
            <Hint label={orgName} side="right">
              <Link className={railItemClass} to="/app/profile">
                <OrgMark name={orgName} />
                <span className="truncate font-medium" data-slot="rail-label">
                  {orgName}
                </span>
              </Link>
            </Hint>
            <nav aria-label="Main" className="flex flex-col gap-1">
              <Hint label="Home" side="right">
                {/* Home is the new-chat screen, so it starts one as "New
                    chat" does, and is current only on the bare address. */}
                <Link
                  activeOptions={{ exact: true }}
                  className={railItemClass}
                  state={() => ({ chat: crypto.randomUUID() })}
                  to="/app"
                >
                  <HouseIcon aria-hidden />
                  <span data-slot="rail-label">Home</span>
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
              <Hint label="Website" side="right">
                <Link className={railItemClass} to="/app/website">
                  <GlobeIcon aria-hidden />
                  <span data-slot="rail-label">Website</span>
                </Link>
              </Hint>
              <Hint label="Reminders" side="right">
                <Link className={railItemClass} to="/app/reminders">
                  <AlarmIcon aria-hidden />
                  <span data-slot="rail-label">Reminders</span>
                </Link>
              </Hint>
            </nav>
            <div className="mt-auto flex flex-col gap-1">
              <DropdownMenu>
                <Hint label="Help" side="right">
                  <DropdownMenuTrigger
                    render={
                      <button
                        aria-label="Help"
                        className={railItemClass}
                        type="button"
                      />
                    }
                  >
                    <QuestionIcon aria-hidden />
                    <span data-slot="rail-label">Help</span>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-56" side="right">
                  {onboarding ? (
                    <DropdownMenuLinkItem
                      render={
                        <Link params={{ id: onboarding }} to="/app/c/$id" />
                      }
                    >
                      <SparkleIcon aria-hidden />
                      Getting started
                    </DropdownMenuLinkItem>
                  ) : null}
                  <DropdownMenuLinkItem
                    render={
                      <Link
                        state={() => ({
                          chat: crypto.randomUUID(),
                          ask: HELP_PROMPT,
                        })}
                        to="/app"
                      />
                    }
                  >
                    <ChatCircleDotsIcon aria-hidden />
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
              <DropdownMenu>
                <Hint label={ownerName} side="right">
                  <DropdownMenuTrigger
                    render={
                      <button
                        aria-label={`Profile, ${ownerName}`}
                        className={railItemClass}
                        data-slot="profile-menu"
                        type="button"
                      />
                    }
                  >
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[0.6875rem] text-primary-foreground"
                      data-slot="mark"
                    >
                      {initialsOf(ownerName)}
                    </span>
                    <span className="truncate" data-slot="rail-label">
                      {ownerName}
                    </span>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-60" side="right">
                  <div className="flex flex-col px-2.5 py-1.5">
                    <span className="truncate font-medium text-sm">
                      {ownerName}
                    </span>
                    {owner.name ? (
                      <span className="truncate text-muted-foreground text-xs">
                        {owner.email}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                    <OrgMark name={orgName} />
                    <span className="truncate">{orgName}</span>
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
                  <ThemeItem />
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
