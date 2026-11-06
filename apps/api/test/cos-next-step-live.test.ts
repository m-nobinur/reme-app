import {
  COS_TOOLS,
  type CosToolName,
  CosWorkspace,
  type OwnerTask,
  SKIP_DOMAIN,
} from "@workspace/contracts"
import { type JourneyInput, journeyOf } from "@workspace/db"
import { procedure } from "@workspace/skills"
import { generateText, isStepCount, type ModelMessage, tool } from "ai"
import { describe, expect, it } from "vitest"
import {
  contextOf,
  DEFAULT_MODEL,
  DESCRIPTIONS,
  INSTRUCTIONS,
  openrouterModel,
} from "../src/cos/agent.ts"
import { workspaceLabels } from "../src/cos/labels.ts"
import { openItems } from "../src/cos/notes.ts"

/**
 * Live: the next step after the domain is put off (#754), with the real
 * model, instructions, skills and open items note. Tools are stubs that
 * record what was called. It spends money, so it runs only with
 * `NEXT_STEP_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ""
const LIVE = process.env.NEXT_STEP_LIVE === "1" && KEY !== ""
const MODEL = process.env.COS_MODEL ?? DEFAULT_MODEL
const NOW = new Date("2026-11-06T10:00:00Z")
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString()

const facts = [
  { key: "business.name", value: { name: "DOX Cleaning" } },
  { key: "business.industry", value: { id: "cleaning", name: "Cleaning" } },
  { key: "service_area.text", value: { text: "Leeds and nearby" } },
]

const addressTask = (over: Partial<OwnerTask>): OwnerTask =>
  ({
    id: "33333333-3333-4333-8333-333333333333",
    kind: "address",
    state: "active",
    later_until: null,
    created_at: ago(10),
    done_at: null,
    detail: {},
    steps: [],
    ...over,
  }) as OwnerTask

const workspace = (tasks: OwnerTask[]) =>
  CosWorkspace.parse({
    site: { host: "dox-cleaning.remeai.co.uk", live_version: 1 },
    builds: [],
    questions: [],
    approvals: [],
    missing_facts: [],
    tasks,
    expected_seconds: {
      quick: { p50: 45, p95: 90 },
      full: { p50: 360, p95: 600 },
    },
  })

const skill = (name: string, part?: string) => {
  const found = procedure("cos", name)
  return part ? found?.parts.find((p) => p.name === part)?.body : found?.body
}

let spent = 0

async function turn({
  tasks,
  journey = {},
  loaded = [],
  history = [],
  said,
  profile = [],
}: {
  tasks: OwnerTask[]
  journey?: Partial<JourneyInput>
  loaded?: string[]
  history?: ModelMessage[]
  said: string
  profile?: string[]
}) {
  const model = openrouterModel(KEY, MODEL)
  if (!model) throw new Error(`no route for ${MODEL}`)
  const ws = workspace(tasks)
  const called: { name: string; input: unknown }[] = []
  const stub = (name: CosToolName, output: (input: never) => unknown) =>
    tool({
      description: DESCRIPTIONS[name],
      inputSchema: COS_TOOLS[name].input,
      execute: async (input: unknown) => {
        called.push({ name, input })
        return output(input as never)
      },
    })
  const state = journeyOf({
    tasks,
    website: { live: true, building: false, drafts: [] },
    now: NOW,
    ...journey,
  })
  const notes = openItems(ws, null, NOW, "Europe/London", state)
  const persona = {
    name: "Reme",
    pronouns: null,
    tone: null,
    owner: "Don",
    profile: profile.map((text) => ({
      id: crypto.randomUUID(),
      text,
      source: "owner_said" as const,
      at: ago(3),
    })),
  }
  const result = await generateText({
    model,
    system: INSTRUCTIONS,
    tools: {
      get_workspace: stub("get_workspace", () => workspaceLabels(ws)),
      put_off: stub("put_off", () => ({
        outcome: "put_off",
        until: "2026-11-13T10:00:00.000Z",
      })),
      connect_google: stub("connect_google", () => ({
        url: "https://staging.remeai.co.uk/api/google/start",
      })),
      offer_choices: stub("offer_choices", () => ({ outcome: "offered" })),
      skill_view: stub(
        "skill_view",
        ({ name, part }: { name: string; part?: string }) => ({
          outcome: "skill",
          name,
          ...(part && { part }),
          body: skill(name, part) ?? "",
          status: "Using my SEO skills",
        })
      ),
    },
    stopWhen: isStepCount(4),
    messages: [
      ...loaded.map((body) => ({ role: "user" as const, content: body })),
      {
        role: "user",
        content: contextOf(
          "act",
          ws,
          "Europe/London",
          NOW,
          undefined,
          persona,
          false,
          null,
          facts as never,
          false,
          null,
          [],
          [],
          notes
        ).text,
      },
      ...history,
      { role: "user", content: said },
    ],
  })
  spent +=
    ((result.totalUsage.inputTokens ?? 0) * 1 +
      (result.totalUsage.outputTokens ?? 0) * 5) /
    1_000_000
  const reply = result.steps
    .map((s) => s.text)
    .join(" ")
    .trim()
  console.log(`      ${said.slice(0, 40)} -> ${reply}`)
  console.log(
    `      calls: ${called.map((c) => `${c.name}${JSON.stringify(c.input)}`).join(" ")}; spent so far ~$${spent.toFixed(3)}`
  )
  return { reply, called, notes }
}

const googleMentions = (reply: string) =>
  (reply.match(/Search Console|Google/g) ?? []).length

describe.skipIf(!LIVE)(
  "the next step after not now, with the real model",
  () => {
    const NOT_YET: ModelMessage = {
      role: "assistant",
      content:
        "No problem, Don. Your website can go live on its free address for now. However, I recommend having your own domain: customers trust and remember it more easily. Would you like to see the domain names again?",
    }

    it("after the free address for now, puts the domain off and suggests Search Console once", async () => {
      const buying = addressTask({
        detail: { name: "doxcleaning.co.uk", origin: "buying_elsewhere" },
      })
      const { reply, called } = await turn({
        tasks: [buying],
        loaded: [
          skill("web-address") ?? "",
          skill("google-search") ?? "",
          skill("google-search", "connect") ?? "",
        ],
        history: [
          { role: "user", content: "I haven't bought doxcleaning.co.uk yet" },
          NOT_YET,
        ],
        said: `${SKIP_DOMAIN} and use the free address`,
      })
      const names = called.map((c) => c.name)
      expect(called.find((c) => c.name === "put_off")?.input).toMatchObject({
        kind: "address",
      })
      expect(names.filter((n) => n === "connect_google")).toHaveLength(1)
      expect(names.indexOf("put_off")).toBeLessThan(
        names.indexOf("connect_google")
      )
      expect(googleMentions(reply)).toBeGreaterThan(0)
      expect(googleMentions(reply)).toBeLessThanOrEqual(2)
    }, 180_000)

    const putOff = addressTask({ state: "later", later_until: ago(-3) })
    const back = {
      visit: {
        conversation: "11111111-1111-4111-8111-111111111111",
        recent: [
          {
            at: ago(2),
            conversation: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
      latches: [{ key: `google_offer:${ago(4)}`, at: ago(4) }],
    }

    let first = ""
    it("in a new sitting days later, brings Google back once after answering", async () => {
      const { reply, called, notes } = await turn({
        tasks: [putOff],
        journey: back,
        said: "Morning! Can you remind me what areas my website says we cover?",
      })
      expect(notes.join("\n")).toMatch(
        /still not connected and the owner is back/
      )
      first = reply
      expect(called.filter((c) => c.name === "connect_google")).toHaveLength(1)
      expect(reply).toMatch(/Leeds/)
      expect(googleMentions(reply)).toBeGreaterThan(0)
    }, 180_000)

    it("and not again on the next message of that sitting", async () => {
      const { reply, called, notes } = await turn({
        tasks: [putOff],
        journey: {
          visit: {
            conversation: "11111111-1111-4111-8111-111111111111",
            recent: [
              {
                at: new Date(NOW.getTime() - 60_000).toISOString(),
                conversation: "11111111-1111-4111-8111-111111111111",
              },
            ],
          },
          latches: [
            { key: `google_offer:${NOW.toISOString()}`, at: NOW.toISOString() },
            { key: `bring_back:${NOW.toISOString()}`, at: NOW.toISOString() },
          ],
        },
        history: [
          {
            role: "user",
            content:
              "Morning! Can you remind me what areas my website says we cover?",
          },
          { role: "assistant", content: first },
        ],
        said: "Thanks, that's all I needed.",
      })
      expect(notes.join("\n")).not.toMatch(/owner is back/)
      expect(called.filter((c) => c.name === "connect_google")).toHaveLength(0)
      expect(googleMentions(reply)).toBe(0)
    }, 180_000)

    it("says nothing about Google when the profile asks not to be reminded", async () => {
      const { reply, called } = await turn({
        tasks: [putOff],
        journey: back,
        profile: ["Asked: \"Don't remind me about Google, I'll do it myself\""],
        said: "Morning! Can you remind me what areas my website says we cover?",
      })
      expect(called.filter((c) => c.name === "connect_google")).toHaveLength(0)
      expect(googleMentions(reply)).toBe(0)
    }, 180_000)
  }
)
