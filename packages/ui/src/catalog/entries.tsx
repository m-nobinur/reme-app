import { HouseIcon } from "@phosphor-icons/react"
import { Alert } from "@workspace/ui/components/alert"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { BrandMark } from "@workspace/ui/components/brand-mark"
import { Button } from "@workspace/ui/components/button"
import { CodeInput } from "@workspace/ui/components/code-input"
import { ConnectRow, ConnectRows } from "@workspace/ui/components/connect-row"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { Field } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { LoadingState } from "@workspace/ui/components/loading-state"
import { Logo, LogoMark } from "@workspace/ui/components/logo"
import {
  PasswordField,
  StrengthBar,
} from "@workspace/ui/components/password-field"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { DoneIcon } from "@workspace/ui/components/status-line"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import type { PasswordVerdict } from "@workspace/ui/lib/password-policy"
import type { ReactNode } from "react"
import { assistantCatalog } from "./assistant-entries"
import { landingCatalog } from "./landing-entries"
import { notificationCatalog } from "./notification-entries"
import { panelCatalog } from "./panel-entries"
import { productCatalog } from "./product-entries"
import { statusLineCatalog } from "./status-line-entries"
import { trayCatalog } from "./tray-entries"
import { trayPhotosCatalog } from "./tray-photos-entries"
import { workspaceCatalog } from "./workspace-entries"

type CatalogEntry = {
  /** The exported component's own name. The drift test matches on it. */
  name: string
  render: () => ReactNode
}

const noop = () => undefined

/** Two fixed points on the meter, so the snapshot is a picture and not a race. */
const FIXTURE_VERDICTS: Record<"weak" | "strong", PasswordVerdict> = {
  weak: {
    score: 1,
    meetsLength: true,
    meetsStrength: false,
    acceptable: false,
    suggestions: [],
    scored: true,
  },
  strong: {
    score: 4,
    meetsLength: true,
    meetsStrength: true,
    acceptable: true,
    suggestions: [],
    scored: true,
  },
}

/**
 * Every primitive in the package, rendered once. The a11y scan and the visual
 * snapshot both read this list, so a primitive that is missing here has neither.
 * `test/catalog.spec.ts` fails when a component file exports something this
 * array does not name.
 *
 * A plain array rather than Storybook: the two consumers are a headless browser
 * and a person reading the page, and neither needs a framework to get that.
 */
const catalog: CatalogEntry[] = [
  {
    name: "Button",
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Button>Approve</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button aria-label="Dashboard" size="icon">
          <HouseIcon aria-hidden />
        </Button>
      </div>
    ),
  },
  {
    name: "Input",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <label className="text-sm" htmlFor="catalog-input">
          Business name
        </label>
        <Input id="catalog-input" placeholder="Business name" />
        <Input
          aria-label="Read only"
          defaultValue="Filled"
          id="catalog-input-filled"
          readOnly
        />
        <Input
          aria-invalid
          aria-label="Disabled and invalid"
          disabled
          id="catalog-input-disabled"
        />
      </div>
    ),
  },
  {
    name: "Field",
    render: () => (
      <div className="flex max-w-sm flex-col gap-4">
        <Field
          autoComplete="email"
          id="catalog-field-email"
          label="Work email"
          type="email"
        />
        <Field
          hint="At least 10 characters."
          id="catalog-field-password"
          label="Password"
          type="password"
        />
        <Field
          error="The provided password does not meet the minimum length requirements."
          id="catalog-field-invalid"
          label="New password"
          type="password"
        />
      </div>
    ),
  },
  {
    name: "CodeInput",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <Field id="catalog-code" label="Six-digit code">
          <CodeInput
            aria-describedby="catalog-code-hint"
            defaultValue="481502"
            id="catalog-code"
          />
        </Field>
      </div>
    ),
  },
  {
    name: "Alert",
    render: () => (
      <div className="flex max-w-md flex-col gap-3">
        <Alert variant="error">That email or password is not right.</Alert>
        <Alert variant="info">
          We sent a six-digit code to the address you gave us.
        </Alert>
        <Alert variant="success">Your password has been changed.</Alert>
      </div>
    ),
  },
  {
    name: "AuthCard",
    render: () => (
      <AuthCard
        brand="Reme"
        className="min-h-0 rounded-3xl border border-border"
        description="Use the email address your account was set up with."
        footer="New here? Create an account"
        title="Sign in"
      >
        <AuthForm>
          <Field
            autoComplete="email"
            id="catalog-auth-email"
            label="Email"
            type="email"
          />
          <Field
            autoComplete="current-password"
            id="catalog-auth-password"
            label="Password"
            type="password"
          />
          <Button type="button">Sign in</Button>
        </AuthForm>
      </AuthCard>
    ),
  },
  {
    name: "AuthForm",
    render: () => (
      <AuthForm className="max-w-sm">
        <Field id="catalog-authform-email" label="Email" type="email" />
        <Button type="button">Send the link</Button>
      </AuthForm>
    ),
  },
  {
    name: "Logo",
    render: () => (
      <div className="flex flex-wrap items-center gap-6">
        <Logo />
        <Logo className="text-lg" />
      </div>
    ),
  },
  {
    name: "LogoMark",
    render: () => (
      <div className="flex flex-wrap items-end gap-4 text-primary">
        <LogoMark className="size-5" />
        <LogoMark className="size-8" />
        <LogoMark className="size-12" />
      </div>
    ),
  },
  // Every vendored mark, and the globe for a brand no library has.
  {
    name: "BrandMark",
    render: () => (
      <div className="flex flex-wrap gap-3">
        {[
          "Google Search Console",
          "Cloudflare",
          "GoDaddy",
          "Namecheap",
          "Squarespace",
          "Wix",
          "IONOS",
          "Gandi",
          "Porkbun",
          "Hostinger",
          "123-reg",
        ].map((name) => (
          <BrandMark key={name} name={name} />
        ))}
      </div>
    ),
  },
  {
    name: "ConnectRow",
    render: () => (
      <div className="flex max-w-md flex-col gap-3">
        <ConnectRow
          href="#dns"
          line="Open your DNS settings"
          name="123-reg"
          newTab
        />
        <ConnectRow
          href="#google"
          line="Show up when people near you search"
          name="Google Search Console"
        />
      </div>
    ),
  },
  {
    name: "ConnectRows",
    render: () => (
      <div className="max-w-md">
        <ConnectRows heading="Other places to buy it">
          <ConnectRow
            href="#cloudflare"
            line="Search for sparkleclean.co.uk"
            name="Cloudflare"
            newTab
          />
          <ConnectRow
            href="#godaddy"
            line="Search for sparkleclean.co.uk"
            name="GoDaddy"
            newTab
          />
        </ConnectRows>
      </div>
    ),
  },
  {
    name: "PasswordField",
    render: () => (
      <div className="flex max-w-sm flex-col gap-4">
        <PasswordField
          autoComplete="current-password"
          hint="The password you sign in with."
          id="catalog-password"
          label="Password"
          name="catalog-password"
          placeholder="Your password"
        />
        <PasswordField
          autoComplete="new-password"
          error="That password is not strong enough. Try a longer one."
          id="catalog-password-invalid"
          label="New password"
          name="catalog-password-invalid"
          placeholder="At least 10 characters"
        />
      </div>
    ),
  },
  {
    // The bar on its own, in both of the answers it has. It is driven from a
    // literal verdict rather than by typing into a field, because the snapshot
    // has to be the same picture on every run and scoring is asynchronous.
    name: "StrengthBar",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <StrengthBar verdict={FIXTURE_VERDICTS.weak} />
        <StrengthBar verdict={FIXTURE_VERDICTS.strong} />
      </div>
    ),
  },
  {
    name: "SubmitButton",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <SubmitButton pendingLabel="Signing in…" type="button">
          Sign in
        </SubmitButton>
        <SubmitButton pending pendingLabel="Signing in…" type="button">
          Sign in
        </SubmitButton>
      </div>
    ),
  },
  {
    name: "Skeleton",
    render: () => (
      <div className="flex max-w-sm flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 rounded-3xl" />
      </div>
    ),
  },
  {
    name: "LoadingState",
    render: () => <LoadingState className="max-w-sm" />,
  },
  {
    name: "EmptyState",
    render: () => (
      <EmptyState
        action={<Button variant="outline">Try again</Button>}
        description="Approval requests appear here as Reme raises them."
        icon={<DoneIcon />}
        title="Nothing waiting on you"
      />
    ),
  },
  {
    name: "ListFilter",
    render: () => (
      <ListFilter label="Filter staff" onValueChange={noop} value="cleaner" />
    ),
  },
  {
    name: "ThemeToggle",
    render: () => <ThemeToggle />,
  },
  {
    name: "PageHeader",
    render: () => (
      <PageHeader
        actions={<Button variant="outline">Add someone</Button>}
        description="The people and the AI roles that make up your organisation."
        title="Staff"
      />
    ),
  },
  ...workspaceCatalog,
  ...panelCatalog,
  ...statusLineCatalog,
  ...notificationCatalog,
  ...productCatalog,
  ...assistantCatalog,
  ...trayCatalog,
  ...trayPhotosCatalog,
  ...landingCatalog,
]

export type { CatalogEntry }
export { catalog }
