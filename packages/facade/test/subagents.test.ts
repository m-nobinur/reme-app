import {
  createAssistantMessageEventStream,
  createProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import {
  type FlueObservation,
  init,
  instrument,
  observe,
  useAgentStart,
  useModel,
  useSandbox,
  useSubagent,
} from "@flue/runtime"
import { start } from "@flue/runtime/node"
import { afterAll, expect, it } from "vitest"
import { createBudgetGuard } from "../src/budget.ts"
import {
  createMutationQueue,
  createTurnGate,
  guardedTools,
} from "../src/hooks.ts"

/**
 * BA1's "done when", on flue itself rather than on the gate alone: a lead
 * fans out two subagents in one batch over one sandbox, the platform
 * replaces the container under one of them, the lead's next delivery sends
 * that one again, and the budget holds every child's spend. The model is
 * pi's faux provider, scripted per session and priced per call.
 */

const SITE = "/workspace/site"
const disk: Record<string, string> = {
  [`${SITE}/src/pages/index.astro`]: "<h1>Home</h1>\n",
  [`${SITE}/src/pages/about.astro`]: "<h1>About</h1>\n",
}
const latch = () => {
  let open: () => void = () => undefined
  const shut = new Promise<void>((r) => {
    open = r
  })
  return { shut, open }
}
const childBStarted = latch()
const childAEdited = latch()
let replaceContainer = true
const abs = (p: string) => (p.startsWith("/") ? p : `${SITE}/${p}`)
const sandbox = {
  cwd: SITE,
  resolvePath: abs,
  exec: async (command: string) => {
    if (command.includes("refresh-about")) {
      // Wait until the sibling has written, so the cut lands mid-fan-out.
      await childAEdited.shut
      if (replaceContainer) {
        throw Object.assign(new Error("container replaced"), {
          code: "OPERATION_INTERRUPTED",
        })
      }
    }
    return { stdout: "ok", stderr: "", exitCode: 0 }
  },
  readFile: async (p: string) => {
    const found = disk[abs(p)]
    if (found === undefined) throw new Error(`ENOENT ${p}`)
    return found
  },
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async (p: string, content: string) => {
    // Child A cannot write until child B has started: only a parallel
    // fan-out gets past this; a sequential one would hang here.
    if (abs(p).endsWith("index.astro")) await childBStarted.shut
    disk[abs(p)] = content
    if (abs(p).endsWith("index.astro")) childAEdited.open()
  },
  stat: async () => ({ isFile: true, isDirectory: false }),
  readdir: async () => [],
  exists: async (p: string) => abs(p) in disk,
  mkdir: async () => undefined,
  rm: async () => undefined,
}

const interrupts: string[] = []
const cancelled: { taskId: string; reason: string }[] = []
const gate = createTurnGate({
  onInterrupt: (r) => interrupts.push(r),
  interruptNow: (error) =>
    (error as { code?: string }).code === "OPERATION_INTERRUPTED"
      ? "sandbox.updating"
      : null,
  onCancel: (taskId, reason) => cancelled.push({ taskId, reason }),
})
const budget = createBudgetGuard({ capUsd: 20, onEvent: () => undefined })
const turns: { taskId?: string; cost: number }[] = []
const taskStarts: string[] = []

observe((observation: FlueObservation) => {
  void budget.instrumentation.observe(observation, {} as never)
  const o = observation as {
    type: string
    taskId?: string
    response?: { usage?: { cost: { total: number } } }
  }
  if (o.type === "turn") {
    turns.push({ taskId: o.taskId, cost: o.response?.usage?.cost.total ?? 0 })
  }
  if (o.type === "task_start") taskStarts.push(String(o.taskId))
})
instrument({
  key: Symbol.for("reme.test.subagents"),
  observe: () => undefined,
  interceptor: (operation, ctx, next) =>
    gate.interceptor(operation, ctx, () =>
      budget.instrumentation.interceptor(operation, ctx, next)
    ),
  dispose: () => undefined,
})

/** What the model is asked, as text: every message, the system one included. */
const said = (context: TranscriptContext) => JSON.stringify(context.messages)
const LEAD = "You are the lead builder."
const PRICE = { lead: 0.01, child: 0.02 }

/** One scripted step for every call: who is asking decides the answer. */
const script = (context: TranscriptContext) => {
  const text = said(context)
  const last = context.messages.at(-1)
  const afterTool = last?.role === "toolResult"
  if (!text.includes(LEAD)) {
    const page = text.includes("PAGE:index") ? "index" : "about"
    if (afterTool) return fauxAssistantMessage(`${page} done`)
    if (page === "index") {
      return fauxAssistantMessage(
        fauxToolCall("edit", {
          path: "src/pages/index.astro",
          edits: [
            { oldText: "<h1>Home</h1>", newText: "<h1>Spotless homes</h1>" },
          ],
        })
      )
    }
    childBStarted.open()
    return fauxAssistantMessage([
      fauxToolCall("bash", { command: "echo refresh-about" }),
      fauxToolCall("edit", {
        path: "src/pages/about.astro",
        edits: [{ oldText: "<h1>About</h1>", newText: "<h1>About us</h1>" }],
      }),
    ])
  }
  const task = (page: string) =>
    fauxToolCall("task", {
      agent: "page",
      prompt: `PAGE:${page} Edit src/pages/${page}.astro as told.`,
    })
  if (afterTool) return fauxAssistantMessage(fauxText("Stopping for now."))
  if (text.includes("run.interrupted"))
    return fauxAssistantMessage(task("about"))
  return fauxAssistantMessage([task("index"), task("about")])
}

const core = createFauxCore({ provider: "faux", models: [{ id: "m" }] })
core.setResponses(Array.from({ length: 40 }, () => script))
const priced = (call: typeof core.stream) =>
  ((model, context, options) => {
    const inner = call(model, context, options)
    const outer = createAssistantMessageEventStream()
    const cost = said(context).includes(LEAD) ? PRICE.lead : PRICE.child
    void (async () => {
      for await (const event of inner) {
        if (event.type === "done") event.message.usage.cost.total = cost
        outer.push(event)
      }
      outer.end(await inner.result())
    })()
    return outer
  }) as typeof core.stream
const provider = createProvider({
  id: "faux",
  auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
  models: core.models,
  api: { stream: priced(core.stream), streamSimple: priced(core.streamSimple) },
})

function Page() {
  return "You edit the one page your task names and reply with one line."
}
function Lead() {
  useModel("faux/m")
  useSandbox(
    {
      createSandbox: async () => sandbox as never,
      tools: guardedTools(
        { siteRoot: SITE },
        {
          git: "git",
          mutations: createMutationQueue(),
          fromChild: gate.fromChild,
        }
      ),
    },
    { cwd: SITE }
  )
  useSubagent({ name: "page", description: "Builds one page.", agent: Page })
  useAgentStart(() => gate.open())
  return LEAD
}

const flue = await start({
  agents: [{ agent: Lead, name: "lead" }],
  providers: [provider],
})
afterAll(() => flue.stop())

it("runs two children in parallel over one sandbox, resumes the cut one, and charges both to one budget", async () => {
  const lead = init(Lead, { id: "assignment-1" })
  await lead.read(await lead.dispatch("Build the site."))

  // The container went under child B; the gate ended the lead's turn and
  // named B, while A's edit had already landed.
  expect(interrupts).toEqual(["sandbox.updating"])
  expect(cancelled).toHaveLength(1)
  expect(cancelled[0]?.reason).toBe("sandbox.updating")
  expect(disk[`${SITE}/src/pages/index.astro`]).toContain("Spotless homes")
  expect(disk[`${SITE}/src/pages/about.astro`]).toBe("<h1>About</h1>\n")
  const [first, second] = taskStarts
  expect(cancelled[0]?.taskId).toBe(second)
  expect(first).not.toBe(second)

  // The resume: the next delivery reopens the gate and sends B again.
  replaceContainer = false
  await lead.read(await lead.dispatch("run.interrupted: continue."))
  expect(disk[`${SITE}/src/pages/about.astro`]).toBe("<h1>About us</h1>\n")
  expect(taskStarts).toHaveLength(3)

  // One budget: every child's turn is in the guard's spend.
  const childTurns = turns.filter((t) => t.taskId)
  const byTask = new Set(childTurns.map((t) => t.taskId))
  expect(byTask).toEqual(new Set(taskStarts))
  const childCost = childTurns.reduce((s, t) => s + t.cost, 0)
  const leadCost = turns
    .filter((t) => !t.taskId)
    .reduce((s, t) => s + t.cost, 0)
  expect(childCost).toBeGreaterThan(0)
  expect(budget.spent()).toBeCloseTo(leadCost + childCost, 10)
}, 20_000)
