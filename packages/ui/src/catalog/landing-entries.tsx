import { AuthAside } from "@workspace/ui/components/auth-aside"
import { Button } from "@workspace/ui/components/button"
import {
  ClosingCta,
  Control,
  Faq,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
  Team,
  Work,
} from "@workspace/ui/components/landing"
import { Logo } from "@workspace/ui/components/logo"
import { StaffTree } from "@workspace/ui/components/staff-tree"
import type { CatalogEntry } from "./entries"

const cta = <Button size="lg">Create your account</Button>

/** The front page and the sign-in panel, section by section. */
const landingCatalog: CatalogEntry[] = [
  {
    name: "AuthAside",
    render: () => <AuthAside className="min-h-[32rem]" />,
  },
  {
    name: "StaffTree",
    render: () => (
      <StaffTree
        className="max-w-xl [--ground:var(--background)] [--on:var(--primary)]"
        lead={{ name: "Chief of Staff", role: "Answers you, delegates" }}
        reports={[
          { name: "Developer", role: "Builds your website" },
          { name: "Client Services", role: "Talks to customers" },
          { name: "Growth", role: "Hire when ready", open: true },
        ]}
      />
    ),
  },
  {
    name: "SiteHeader",
    render: () => (
      <SiteHeader
        actions={<Button variant="ghost">Sign in</Button>}
        brand={<Logo />}
        nav={[
          { href: "#work", label: "What it does" },
          { href: "#how", label: "How it works" },
        ]}
      />
    ),
  },
  { name: "Hero", render: () => <Hero actions={cta} /> },
  { name: "Work", render: () => <Work /> },
  { name: "Steps", render: () => <Steps /> },
  { name: "Team", render: () => <Team /> },
  { name: "Control", render: () => <Control /> },
  { name: "Faq", render: () => <Faq /> },
  { name: "ClosingCta", render: () => <ClosingCta actions={cta} /> },
  {
    name: "SiteFooter",
    render: () => (
      <SiteFooter
        brand={<Logo />}
        links={
          <>
            <span>Privacy</span>
            <span>Terms</span>
          </>
        }
      />
    ),
  },
]

export { landingCatalog }
