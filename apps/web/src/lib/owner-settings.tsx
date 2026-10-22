import {
  ArrowUpRightIcon,
  BellIcon,
  BrainIcon,
  BuildingsIcon,
  GearSixIcon,
  GlobeIcon,
  GoogleLogoIcon,
  MoonIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SunIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import { Link } from "@tanstack/react-router"
import { railItemClass } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DefinitionList } from "@workspace/ui/components/definition-list"
import {
  Settings,
  SettingsContent,
  type SettingsSection,
  SettingsTrigger,
} from "@workspace/ui/components/settings-dialog"
import {
  toggleTheme,
  useDarkTheme,
} from "@workspace/ui/components/theme-toggle"
import { Hint } from "@workspace/ui/components/tooltip"
import type { ReactNode } from "react"
import { PushControl } from "@/lib/push-control"
import { useLiveWorkspace } from "@/lib/workspace"

/**
 * What "Ask Reme for help" sends as the first message of a new chat: short,
 * so it reads as the owner's own question in the thread.
 */
const HELP_PROMPT =
  "What can you help me with? Suggest a few things you could do for my business right now."

const LINK = buttonVariants({ variant: "outline" })

/** Up to two initials for the avatar: "N Khan" is "NK". */
const initialsOf = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("")

function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-4 max-w-prose text-muted-foreground">{children}</p>
}

function ThemeButton() {
  const dark = useDarkTheme()
  return (
    <Button onClick={toggleTheme} variant="outline">
      {dark ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
      {dark ? "Light theme" : "Dark theme"}
    </Button>
  )
}

/** A page in a new tab, as the help menu opened them. */
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={LINK} href={href} rel="noreferrer" target="_blank">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowUpRightIcon aria-hidden />
    </a>
  )
}

/**
 * The owner's avatar at the foot of the rail, and the settings it opens.
 * Every page holds what the app already had in the profile and help menus;
 * the account and notifications pages are linked rather than moved.
 */
export function OwnerSettings({
  owner,
  orgName,
  unread,
  onboarding,
}: {
  owner: { name: string; email: string; role: string | null }
  orgName: string
  unread: number
  /** The onboarding conversation, while it still has steps. */
  onboarding: string | null | undefined
}) {
  const ownerName = owner.name || owner.email
  const { workspace } = useLiveWorkspace()
  const sections: SettingsSection[] = [
    {
      id: "general",
      label: "General",
      icon: <GearSixIcon aria-hidden />,
      content: (
        <div className="flex flex-col items-start gap-6">
          <DefinitionList
            items={[
              {
                id: "name",
                term: "Name",
                description: owner.name || "Not set",
              },
              { id: "email", term: "Email", description: owner.email },
              { id: "business", term: "Business", description: orgName },
              // A role is issued by an organisation, so it stays empty until one exists.
              {
                id: "role",
                term: "Role",
                description: owner.role ?? "None yet",
              },
            ]}
          />
          <ThemeButton />
          <Link className={LINK} to="/app/account">
            Account and deletion
          </Link>
        </div>
      ),
    },
    {
      id: "business",
      label: "Business",
      icon: <BuildingsIcon aria-hidden />,
      content: (
        <>
          <Lead>
            What Reme knows about {orgName}, and where each fact came from.
          </Lead>
          <Link className={LINK} to="/app/profile">
            Open the business page
          </Link>
        </>
      ),
    },
    {
      id: "staff",
      label: "Staff",
      icon: <UsersThreeIcon aria-hidden />,
      content: (
        <>
          <Lead>
            The people and the AI roles that make up your organisation.
          </Lead>
          <Link className={LINK} to="/app/staff">
            Open the staff page
          </Link>
        </>
      ),
    },
    {
      id: "memory",
      label: "Memory",
      icon: <BrainIcon aria-hidden />,
      content: (
        <>
          <Lead>
            What Reme remembers about you and how you like to work. It reads
            these lines at the start of every conversation.
          </Lead>
          <Link className={LINK} to="/app/memory">
            Open memory
          </Link>
        </>
      ),
    },
    {
      id: "website",
      label: "Website and domain",
      icon: <GlobeIcon aria-hidden />,
      content: (
        <>
          <Lead>
            {workspace?.host
              ? `Your website is at ${workspace.host}.`
              : "Your website has no address yet."}{" "}
            To use a domain of your own, ask Reme in the chat.
          </Lead>
          <Link className={LINK} to="/app/website">
            Open the website page
          </Link>
        </>
      ),
    },
    {
      id: "google",
      label: "Google",
      icon: <GoogleLogoIcon aria-hidden />,
      content: (
        <>
          <Lead>
            Google will ask you to let Reme see how your website shows up in
            search and to add it to Search Console. Connected already? This
            switches the account.
          </Lead>
          {/* A plain link: the connect flow is a server route, not a page. */}
          <a className={LINK} href="/api/google/start">
            Connect Google
          </a>
        </>
      ),
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: <BellIcon aria-hidden />,
      content: (
        <>
          <Lead>
            {unread > 0 ? `${unread} unread. ` : "Nothing unread. "}
            Questions and approvals waiting on you, and what happened to your
            site in the last 30 days.
          </Lead>
          <Link className={LINK} to="/app/notifications">
            See all notifications
          </Link>
          <div className="mt-6">
            <PushControl />
          </div>
        </>
      ),
    },
    {
      id: "help",
      label: "Help & support",
      icon: <QuestionIcon aria-hidden />,
      content: (
        <div className="flex flex-col items-start gap-3">
          <Link
            className={LINK}
            state={() => ({ chat: crypto.randomUUID(), ask: HELP_PROMPT })}
            to="/app"
          >
            Ask Reme for help
          </Link>
          {onboarding ? (
            <Link className={LINK} params={{ id: onboarding }} to="/app/c/$id">
              Getting started
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      id: "legal",
      label: "Legal info",
      icon: <ShieldCheckIcon aria-hidden />,
      content: (
        <div className="flex flex-wrap gap-3">
          <External href="/privacy">Privacy</External>
          <External href="/terms">Terms</External>
        </div>
      ),
    },
  ]

  return (
    <Settings>
      <Hint label={ownerName} side="right">
        <SettingsTrigger
          render={
            <button
              className={railItemClass}
              data-slot="profile-menu"
              type="button"
            />
          }
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs"
            data-slot="mark"
          >
            {initialsOf(ownerName)}
          </span>
          <span className="truncate" data-slot="rail-label">
            <span className="sr-only">Settings, </span>
            {ownerName}
          </span>
        </SettingsTrigger>
      </Hint>
      {/* A plain address: /sign-out signs out in its loader, so a router
          link's preload on hover would end the session. */}
      <SettingsContent sections={sections} signOutHref="/sign-out" />
    </Settings>
  )
}
