import { AuthAside } from "@workspace/ui/components/auth-aside"
import { Button } from "@workspace/ui/components/button"
import {
  ClosingCta,
  Control,
  Faq,
  Features,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
} from "@workspace/ui/components/landing"
import { Logo } from "@workspace/ui/components/logo"
import { MorningSummary } from "@workspace/ui/components/morning-summary"
import type { CatalogEntry } from "./entries"

const cta = <Button size="lg">Create your account</Button>

/** The front page and the sign-in panel, section by section. */
const landingCatalog: CatalogEntry[] = [
  {
    name: "AuthAside",
    render: () => <AuthAside className="min-h-[32rem]" />,
  },
  {
    name: "MorningSummary",
    render: () => <MorningSummary className="max-w-md" />,
  },
  {
    name: "SiteHeader",
    render: () => (
      <SiteHeader
        actions={<Button variant="ghost">Sign in</Button>}
        brand={<Logo />}
        nav={[
          { href: "#features", label: "Features" },
          { href: "#how", label: "How it works" },
        ]}
      />
    ),
  },
  { name: "Hero", render: () => <Hero actions={cta} /> },
  { name: "Features", render: () => <Features /> },
  { name: "Steps", render: () => <Steps /> },
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
