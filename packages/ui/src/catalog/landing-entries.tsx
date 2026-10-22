import { AVATARS } from "@workspace/contracts"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { AuthAside } from "@workspace/ui/components/auth-aside"
import { Button } from "@workspace/ui/components/button"
import {
  Assistant,
  ClosingCta,
  Control,
  Enquiries,
  Faq,
  Hero,
  Pipeline,
  Setup,
  SiteFooter,
  SiteHeader,
  Website,
  Workforce,
} from "@workspace/ui/components/landing"
import {
  ChatWidget,
  FlowDiagram,
  Frame,
  HeroStage,
  LeadHistory,
  OnboardingChat,
  ProductWindow,
  QuoteRequest,
  WebsitePreview,
} from "@workspace/ui/components/landing-visuals"
import { Logo } from "@workspace/ui/components/logo"
import {
  Persona,
  PersonaAvatar,
  PersonaStage,
  SpeechBubble,
} from "@workspace/ui/components/persona"
import type { CatalogEntry } from "./entries"

const cta = <Button size="lg">Create your account</Button>

/** The front page and the sign-in panel, section by section. */
const landingCatalog: CatalogEntry[] = [
  {
    name: "AuthAside",
    render: () => <AuthAside className="min-h-[40rem]" />,
  },
  { name: "Persona", render: () => <Persona className="size-48" /> },
  { name: "PersonaAvatar", render: () => <PersonaAvatar /> },
  {
    name: "AssistantAvatar",
    render: () => (
      <div className="flex flex-col gap-4">
        {["size-20", "size-10", "size-6"].map((size) => (
          <div className="flex flex-wrap gap-3" key={size}>
            {AVATARS.map((avatar, at) => (
              <AssistantAvatar
                className={size}
                delay={at * 0.9}
                id={avatar.id}
                key={avatar.id}
              />
            ))}
          </div>
        ))}
      </div>
    ),
  },
  {
    name: "SpeechBubble",
    render: () => (
      <SpeechBubble
        arrival="enter"
        className="mt-8 max-w-sm"
        text="I'll look after your enquiries so you can get on with the work."
        title="Hi, I'm Reme."
      />
    ),
  },
  {
    name: "PersonaStage",
    render: () => <PersonaStage className="w-72" />,
  },
  {
    name: "SiteHeader",
    render: () => (
      <SiteHeader
        actions={<Button variant="ghost">Sign in</Button>}
        brand={<Logo />}
        nav={[
          { href: "#assistant", label: "The assistant" },
          { href: "#how", label: "How it works" },
        ]}
      />
    ),
  },
  { name: "Hero", render: () => <Hero actions={cta} /> },
  { name: "HeroStage", render: () => <HeroStage /> },
  { name: "Assistant", render: () => <Assistant /> },
  { name: "ProductWindow", render: () => <ProductWindow /> },
  { name: "Workforce", render: () => <Workforce /> },
  { name: "FlowDiagram", render: () => <FlowDiagram /> },
  { name: "Enquiries", render: () => <Enquiries /> },
  { name: "ChatWidget", render: () => <ChatWidget /> },
  { name: "Setup", render: () => <Setup /> },
  { name: "OnboardingChat", render: () => <OnboardingChat /> },
  { name: "Pipeline", render: () => <Pipeline /> },
  { name: "QuoteRequest", render: () => <QuoteRequest /> },
  { name: "LeadHistory", render: () => <LeadHistory /> },
  { name: "Website", render: () => <Website /> },
  { name: "WebsitePreview", render: () => <WebsitePreview /> },
  {
    name: "Frame",
    render: () => (
      <Frame caption="An empty frame" className="h-40 max-w-sm">
        <div className="h-full rounded-[1.25rem] bg-background" />
      </Frame>
    ),
  },
  { name: "Control", render: () => <Control /> },
  { name: "Faq", render: () => <Faq /> },
  { name: "ClosingCta", render: () => <ClosingCta actions={cta} /> },
  {
    name: "SiteFooter",
    render: () => (
      <SiteFooter
        brand={<Logo />}
        columns={[
          { title: "Product", links: <span>How it works</span> },
          { title: "Legal", links: <span>Privacy</span> },
        ]}
      />
    ),
  },
]

export { landingCatalog }
