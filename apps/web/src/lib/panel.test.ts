import type { Conversation, Reminder } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { type PanelInput, pageOf, panelFor } from "./panel"

const ONBOARDING = "00000000-0000-4000-8000-00000000000a"
const CHAT = "00000000-0000-4000-8000-00000000000b"
const HOST = "fixture-clean.example.invalid"
/** 10:00 in London. */
const NOW = new Date("2026-10-01T09:00:00.000Z")
const ZONE = "Europe/London"

const ROUTES = {
  home: "/app/_conversation/",
  chat: "/app/_conversation/c/$id",
  website: "/app/website",
  reminders: "/app/reminders",
  approvals: "/app/approvals",
  staff: "/app/staff",
}

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  ...EMPTY_WORKSPACE,
  ...over,
})

const build = (state: string, version: number | null = null) =>
  ({
    assignment_id: `build-${state}`,
    goal: "Add Saturday hours",
    state,
    revision: version ? { version } : null,
    created_at: "2026-10-01T08:58:00.000Z",
  }) as unknown as Workspace["builds"][number]

const approval = (version: number, expiresAt: string | null = null) =>
  ({
    kind: "approval",
    id: `approval-${version}`,
    version,
    expiresAt,
  }) as unknown as AttentionItem

const question = (raisedBy: string, raisedById: string | null = null) =>
  ({
    kind: "question",
    id: `question-${raisedBy}`,
    title: "Weekday hours",
    raisedBy,
    raisedById,
    expiresAt: null,
  }) as unknown as AttentionItem

const note = (id: string, title: string, due_at: string | null): Reminder => ({
  id,
  title,
  due_at,
  done_at: null,
  source: "owner",
  conversation_id: null,
  created_at: "2026-09-26T10:00:00.000Z",
  updated_at: "2026-09-26T10:00:00.000Z",
})

const onboardingChat = {
  id: ONBOARDING,
  kind: "onboarding",
  archived_at: null,
} as unknown as Conversation

const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  route: ROUTES.home,
  conversation: undefined,
  workspace: workspace(),
  business: "Fixture Clean",
  conversations: [],
  activity: [],
  names: {},
  now: NOW,
  zone: ZONE,
  ...over,
})

const live = (over: Partial<Workspace> = {}) =>
  workspace({ live: 3, host: HOST, ...over })

describe("pageOf", () => {
  it("names each page, and tells the getting-started chat apart", () => {
    expect(pageOf(ROUTES.home, undefined, null)).toBe("home")
    expect(pageOf(ROUTES.chat, CHAT, ONBOARDING)).toBe("chat")
    expect(pageOf(ROUTES.chat, ONBOARDING, ONBOARDING)).toBe("onboarding")
    expect(pageOf(ROUTES.website, undefined, null)).toBe("website")
    expect(pageOf(ROUTES.reminders, undefined, null)).toBe("reminders")
    expect(pageOf(ROUTES.approvals, undefined, null)).toBe("approvals")
    expect(pageOf(ROUTES.staff, undefined, null)).toBe("elsewhere")
    expect(pageOf(undefined, undefined, null)).toBe("elsewhere")
  })
})

describe("when the panel hides", () => {
  it("hides on pages with nothing under way, waiting or due", () => {
    for (const route of [ROUTES.staff, ROUTES.approvals, ROUTES.reminders]) {
      expect(panelFor(input({ route, workspace: live() }))).toBeNull()
      expect(panelFor(input({ route }))).toBeNull()
    }
  })

  it("leaves a new owner's Website page to its own empty state", () => {
    expect(panelFor(input({ route: ROUTES.website }))).toBeNull()
    expect(
      panelFor(input({ route: ROUTES.website, business: null }))
    ).toBeNull()
  })

  it("shows elsewhere while a build runs, and on reminders while one is ahead", () => {
    expect(
      panelFor(
        input({
          route: ROUTES.staff,
          workspace: live({ builds: [build("implementing", 4)] }),
        })
      )
    ).not.toBeNull()
    expect(
      panelFor(
        input({
          route: ROUTES.reminders,
          workspace: live({
            reminderNotes: [note("a", "Order cloths", null)],
          }),
        })
      )
    ).not.toBeNull()
  })
})

describe("getting started", () => {
  const starting = workspace({
    missingFacts: ["business.phone", "hours.weekday"],
  })

  it("says what is left, and points back to the getting-started chat", () => {
    const panel = panelFor(
      input({ workspace: starting, conversations: [onboardingChat] })
    )
    expect(panel?.headline).toEqual([
      "Getting Fixture Clean ready for its first website.",
      "2 details to go before Reme can build it.",
    ])
    expect(panel?.steps?.map((step) => step.label)).toEqual([
      "Phone number",
      "Weekday hours",
      "Build your first version",
    ])
    expect(panel?.suggestions).toEqual([{ kind: "onboarding", id: ONBOARDING }])
    expect(panel?.line).toEqual({
      tone: "idle",
      lead: "Getting started,",
      detail: "2 details to go",
    })
  })

  it("counts rather than lists a long list, and offers no link to the chat it is in", () => {
    const panel = panelFor(
      input({
        route: ROUTES.chat,
        conversation: ONBOARDING,
        conversations: [onboardingChat],
        workspace: workspace({
          missingFacts: [
            "business.name",
            "business.phone",
            "business.email",
            "hours.weekday",
          ],
        }),
      })
    )
    expect(panel?.headline[1]).toBe("4 details to go before Reme can build it.")
    expect(panel?.suggestions).toEqual([])
  })

  it("says when the details are in", () => {
    const panel = panelFor(
      input({ route: ROUTES.website, conversations: [onboardingChat] })
    )
    expect(panel?.headline[1]).toBe(
      "Reme has every detail it needs. Finish getting started to build the site."
    )
    expect(panel?.line.detail).toBe("your details are in")
  })

  it("offers a new website where there is no getting-started chat", () => {
    const panel = panelFor(input())
    expect(panel?.headline).toEqual([
      "Fixture Clean has no website yet.",
      "Ask Reme in a chat to build one for you to review.",
    ])
    expect(panel?.suggestions).toEqual([{ kind: "start-website" }])
    expect(panel?.line.lead).toBe("Let's get your website started")
  })

  it("asks an account with no business to name one", () => {
    const panel = panelFor(input({ business: null }))
    expect(panel?.headline).toEqual([
      "Name your business and Reme can start on its website.",
    ])
    expect(panel?.steps).toBeNull()
    expect(panel?.suggestions).toEqual([{ kind: "name-business" }])
    expect(panel?.line).toEqual({
      tone: "idle",
      lead: "Name your business",
      detail: "to get started",
    })
  })
})

describe("in a chat", () => {
  const chat = (over: Partial<Workspace>) =>
    panelFor(
      input({ route: ROUTES.chat, conversation: CHAT, workspace: live(over) })
    )

  it("says what the build is doing while the owner chats", () => {
    const panel = chat({ builds: [build("validating", 4)] })
    expect(panel?.headline).toEqual([
      "Reme is building version 4 while you chat.",
      "Keep chatting. Nothing goes live until you approve it.",
    ])
    expect(panel?.build?.state).toBe("validating")
    expect(panel?.line).toEqual({
      tone: "working",
      lead: "Building version 4,",
      detail: "checking the site",
    })
    expect(chat({ builds: [build("release_candidate", 4)] })?.headline).toEqual(
      ["Reme is publishing version 4 now."]
    )
  })

  it("calls the assistant by the name the owner gave it", () => {
    const named = { assistantName: "Ava" }
    expect(
      chat({ ...named, builds: [build("validating", 4)] })?.headline[0]
    ).toBe("Ava is building version 4 while you chat.")
    expect(chat(named)?.headline[1]).toBe(
      "Ask Ava to change a page, check what needs you, or set a reminder."
    )
    expect(
      panelFor(input({ workspace: workspace(named), business: null }))?.headline
    ).toEqual(["Name your business and Ava can start on its website."])
  })

  it("puts a review first, and leaves changes to the review's own button", () => {
    const panel = chat({ attention: [approval(4)] })
    expect(panel?.headline).toEqual([
      "Version 4 is ready for your review.",
      "Approve it here, or say what to change.",
    ])
    expect(panel?.suggestions).toEqual([{ kind: "visit-site", host: HOST }])
  })

  it("names who asked a question, from the directory", () => {
    const panel = panelFor(
      input({
        route: ROUTES.chat,
        conversation: CHAT,
        workspace: live({ attention: [question("Reme", "staff-sam")] }),
        names: { "staff-sam": "Sam" },
      })
    )
    expect(panel?.headline).toEqual([
      "Sam asked about weekday hours.",
      "Answer here and the build carries on.",
    ])
    expect(panel?.line).toEqual({
      tone: "live",
      lead: "Sam",
      detail: "has a question for you",
    })
  })

  it("says what the owner can ask next once all is quiet", () => {
    const panel = chat({})
    expect(panel?.headline).toEqual([
      "Version 3 of your website is live.",
      "Ask Reme to change a page, check what needs you, or set a reminder.",
    ])
    expect(panel?.suggestions).toEqual([
      { kind: "request-change" },
      { kind: "visit-site", host: HOST },
    ])
  })
})

describe("on the Website page", () => {
  const published = {
    kind: "report",
    id: "published-3",
    title: "Published v3",
    raisedAt: "2026-09-30T14:30:00.000Z",
  } as unknown as AttentionItem

  it("gives the address, the last publish and what to do next", () => {
    const panel = panelFor(
      input({
        route: ROUTES.website,
        workspace: live(),
        activity: [published],
      })
    )
    expect(panel?.headline).toEqual([
      `Version 3 is live at ${HOST}. Published Wed 30 Sept, 3:30 pm.`,
      "Ask for a change and Reme builds a new version for you to review.",
    ])
    // The page has its own Request changes and link.
    expect(panel?.suggestions).toEqual([])
    expect(panel?.line).toEqual({
      tone: "live",
      lead: "Version 3 is live",
      detail: `at ${HOST}`,
    })
  })

  it("leaves the publish time out until the reader's zone is known", () => {
    const panel = panelFor(
      input({
        route: ROUTES.website,
        workspace: live(),
        activity: [published],
        zone: null,
      })
    )
    expect(panel?.headline[0]).toBe(`Version 3 is live at ${HOST}.`)
  })

  it("says what is coming to replace the live version", () => {
    const at = (over: Partial<Workspace>) =>
      panelFor(input({ route: ROUTES.website, workspace: live(over) }))
        ?.headline[1]
    expect(at({ builds: [build("implementing")] })).toBe(
      "Reme is building a new version. You review it before it replaces this one."
    )
    expect(at({ attention: [approval(4)] })).toBe(
      "Version 4 is ready to replace it once you approve."
    )
  })

  it("follows the first build before anything is live", () => {
    const panel = panelFor(
      input({
        route: ROUTES.website,
        workspace: workspace({ open: true, builds: [build("planning")] }),
      })
    )
    expect(panel?.headline).toEqual([
      "Reme is building your first version.",
      "You review it before it goes live.",
    ])
  })
})

describe("on the Reminders page", () => {
  const at = (notes: Reminder[], zone: string | null = ZONE) =>
    panelFor(
      input({
        route: ROUTES.reminders,
        workspace: live({ reminderNotes: notes }),
        zone,
      })
    )

  it("says what is due today, or when the next one is", () => {
    const today = at([
      note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
      note("b", "Send the quote", "2026-10-01T15:30:00.000Z"),
    ])
    expect(today?.headline).toEqual(["2 reminders today, the next at 2:00 pm."])
    expect(today?.line.lead).toBe("2 reminders today, the next at 2:00 pm")
    expect(today?.suggestions).toEqual([{ kind: "set-reminder" }])
    // What the page lists is not repeated as coming up.
    expect(today?.upcoming).toEqual([])

    expect(
      at([note("a", "Call the supplier", "2026-10-01T13:00:00.000Z")])?.headline
    ).toEqual(["One reminder today, at 2:00 pm."])
    expect(
      at([note("a", "Call the supplier", "2026-10-03T08:30:00.000Z")])?.headline
    ).toEqual(["Nothing due today. The next reminder is Sat 3 Oct, 9:30 am."])
    expect(at([note("a", "Order cloths", null)])?.headline).toEqual([
      "One reminder, with no time set.",
    ])
  })

  it("counts, without a day, until the reader's zone is known", () => {
    expect(
      at(
        [
          note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
          note("b", "Order cloths", null),
        ],
        null
      )?.headline
    ).toEqual(["2 reminders ahead."])
  })
})

describe("on the Approvals page", () => {
  it("leaves reviews to the page, and still shows a question", () => {
    const panel = panelFor(
      input({
        route: ROUTES.approvals,
        workspace: live({ attention: [approval(4), question("Alex")] }),
      })
    )
    expect(panel?.waiting.map((item) => item.kind)).toEqual(["question"])
    expect(panel?.line.lead).toBe("Alex")
    expect(
      panelFor(
        input({
          route: ROUTES.approvals,
          workspace: live({ attention: [approval(4)] }),
        })
      )
    ).toBeNull()
  })
})

describe("what is coming up and what just happened", () => {
  it("lists closing reviews and reminders due within a day, soonest first", () => {
    const panel = panelFor(
      input({
        workspace: live({
          attention: [approval(4, "2026-10-02T08:00:00.000Z")],
          reminderNotes: [
            note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
            note("b", "Next week", "2026-10-08T13:00:00.000Z"),
            note("c", "Order cloths", null),
          ],
        }),
      })
    )
    expect(panel?.upcoming.map((item) => item.text)).toEqual([
      "Call the supplier",
      "Your review of version 4 closes",
    ])
    // No reminders before the reader's zone is known.
    expect(
      panelFor(
        input({
          zone: null,
          workspace: live({
            reminderNotes: [
              note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
            ],
          }),
        })
      )?.upcoming
    ).toEqual([])
  })

  it("shows the last day's publishes and alerts on Home, newest first", () => {
    const logged = (id: string, title: string, raisedAt: string) =>
      ({ kind: "report", id, title, raisedAt }) as unknown as AttentionItem
    const activity = [
      logged("old", "Published v2", "2026-09-28T09:00:00.000Z"),
      logged("v3", "Published v3", "2026-10-01T07:00:00.000Z"),
      logged("fail", "A build failed", "2026-10-01T08:00:00.000Z"),
    ]
    const home = panelFor(input({ workspace: live(), activity }))
    expect(home?.latest.map((item) => item.text)).toEqual([
      "A build failed",
      "Published v3",
    ])
    const chat = panelFor(
      input({
        route: ROUTES.chat,
        conversation: CHAT,
        workspace: live(),
        activity,
      })
    )
    expect(chat?.latest).toEqual([])
  })
})

describe("the one line", () => {
  const line = (over: Partial<Workspace>, names = {}) =>
    panelFor(input({ workspace: workspace(over), names }))?.line

  it("says what is most pressing", () => {
    // A build waiting on the owner is not being worked on, and a review
    // comes before a question.
    expect(
      line({
        live: 2,
        builds: [build("blocked_on_approval", 3)],
        attention: [approval(3), question("Reme")],
      })
    ).toEqual({
      tone: "live",
      lead: "Version 3 is ready",
      detail: "for your review",
    })
    expect(line({ attention: [approval(3), approval(4)], open: true })).toEqual(
      {
        tone: "idle",
        lead: "2 versions are ready",
        detail: "for your review",
      }
    )
    expect(
      line({ live: 2, attention: [question("A"), question("B")] })
    ).toEqual({ tone: "live", lead: "2 questions", detail: "for you" })
    expect(line({ live: 1 })).toEqual({
      tone: "live",
      lead: "Your website is live",
      detail: "on version 1",
    })
    expect(line({ open: true, builds: [build("paused")] })).toEqual({
      tone: "idle",
      lead: "Your first website",
      detail: "is under way",
    })
    expect(line({ builds: [build("queued")], open: true })?.lead).toBe(
      "Your first website"
    )
    expect(line({ live: 2, builds: [build("briefing")] })).toEqual({
      tone: "working",
      lead: "Building a new version,",
      detail: "reading your brief",
    })
  })
})

describe("suggestions", () => {
  it("offers at most three, and nothing the app cannot do", () => {
    const kinds = new Set([
      "name-business",
      "onboarding",
      "start-website",
      "request-change",
      "visit-site",
      "set-reminder",
    ])
    for (const route of Object.values(ROUTES)) {
      for (const each of [
        live(),
        workspace(),
        live({ attention: [approval(4)] }),
      ]) {
        const found = panelFor(input({ route, workspace: each }))?.suggestions
        expect(found?.length ?? 0).toBeLessThanOrEqual(3)
        for (const suggestion of found ?? []) {
          expect(kinds.has(suggestion.kind)).toBe(true)
        }
      }
    }
  })
})
