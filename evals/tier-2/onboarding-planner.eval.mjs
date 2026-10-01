import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { priceOf } from "../../apps/api/src/cos/agent.ts"
import {
  again,
  applied,
  buildCall,
  built,
  cardAnswer,
  contactFields,
  ended,
  onboardingStep,
  opening,
  progressOf,
  typedAnswer,
} from "../../apps/api/src/onboarding.ts"
import {
  buildMissing,
  DEFAULT_ONBOARDING_MODEL,
  plannerModel,
  planParts,
  planTurn,
  REQUIRED,
  sayProblems,
} from "../../apps/api/src/onboarding-agent.ts"
import models from "../../packages/facade/src/models/openrouter.models.json" with {
  type: "json",
}
import { PERSONAS, SKIPPER } from "../onboarding-personas.mjs"

/**
 * Tier 2 (§16.3), live: the onboarding planner against the real model, over
 * owners who answer the way real ones do (a long first message, one word,
 * typos, a correction, a side question, "you choose", an injection). The
 * planner is the api's own module and the conversation is simulated with
 * the api's own pure functions, the same ones `chat.ts` calls, so what is
 * scored here is what an owner would get, minus the database. A second,
 * cheap model plays the owner for the open questions, from a sheet; cards
 * are answered by rule from the same sheet. Both are seeded, so two runs
 * are comparable, not identical.
 *
 * What it asserts, per owner: the build started (or, for the owner who
 * skips the website, the manual path closed), the contact details and names
 * are the owner's exactly, every required fact is held, no message reached
 * the owner with a rate, currency, link or dash, no build started before the
 * checklist allowed it, the quote form asks business-specific questions and
 * never the contact details, and it took at most `MAX_TURNS` owner turns.
 * It prints every transcript so a person can read the tone, and a table per
 * model: owners passed, fallbacks, first plans refused, cost per onboarding
 * and call latency.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *     evals/tier-2/onboarding-planner.eval.mjs
 *
 * `ONBOARDING_EVAL_MODELS` (comma list, default the api's default),
 * `ONBOARDING_EVAL_PERSONAS` (comma list of ids, default all) and
 * `ONBOARDING_EVAL_CAP_USD` (default 3) narrow a run. Skipped without
 * `OPENROUTER_API_KEY`, so `pnpm eval` runs everywhere.
 */

const MAX_TURNS = 24
const OWNER_MODEL = "z-ai/glm-5.3-flash"
const CAP_USD = Number(process.env.ONBOARDING_EVAL_CAP_USD ?? 3)
// Not passed through turbo: a task that saw the key would run the facade's live tests.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
const KEY = process.env.OPENROUTER_API_KEY ?? ""

let spent = 0

/** The owner simulator: one chat completion, seeded, spending from the same key. */
async function ownerSays(persona, lines, shown) {
  const routing = models.find((m) => m.id === OWNER_MODEL).compat
    .openRouterRouting
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OWNER_MODEL,
      provider: routing,
      usage: { include: true },
      reasoning: { effort: "low" },
      temperature: 0.4,
      seed: 11,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `You play a small business owner setting up an AI assistant for your business, in a chat. Stay in character.\n\nYour sheet:\n${persona.sheet}\n\nHow you write: ${persona.style}\n\nAnswer only what the assistant just asked, from your sheet. If it asks something your sheet does not cover, give a short plausible answer in character, but never invent contact details. Never mention being a simulation. Reply with your message text only.`,
        },
        {
          role: "user",
          content: `The conversation so far:\n${lines
            .slice(-12)
            .map((l) => `${l.from}: ${l.text}`)
            .join(
              "\n"
            )}\n\nThe assistant's latest message:\n${shown}\n\nWrite your reply.`,
        },
      ],
    }),
  })
  const body = await res.json()
  if (!res.ok)
    throw new Error(
      `owner simulator: ${res.status} ${JSON.stringify(body).slice(0, 200)}`
    )
  spent += body.usage?.cost ?? 0
  return String(body.choices?.[0]?.message?.content ?? "").trim() || "ok"
}

const counter = (prefix) => {
  let n = 0
  return () => `${prefix}${++n}`
}

/** The script rows `readScript` would read from these messages. */
function scriptRows(rows) {
  return rows.flatMap((row, i) => {
    if (row.role !== "assistant") return []
    const next = rows[i + 1]
    const reply = next?.role === "user" ? (next.parts[0]?.text ?? null) : null
    return row.parts
      .filter((p) => p.type.startsWith("tool-"))
      .map((p) => ({
        type: p.type,
        state: p.state,
        step: p.input?.key ?? p.input?.step ?? null,
        answer: p.output?.answer ?? null,
        choice: p.output?.ids?.[0] ?? null,
        reply: p.state === "output-error" ? reply : null,
      }))
  })
}

/** The card the tail's last step waits on. */
function waitingCard(tail) {
  if (tail?.role !== "assistant") return undefined
  const last = tail.parts.slice(
    tail.parts.map((p) => p.type).lastIndexOf("step-start")
  )
  return last.find(
    (p) =>
      [
        "tool-ask_fact",
        "tool-ask_choice",
        "tool-ask_upload",
        "tool-review_quote_form",
      ].includes(p.type) && p.state === "input-available"
  )
}

const percentile = (values, p) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]
}

const factOf = (facts, key) => facts.find((f) => f.key === key)?.value

/** One owner, onboarded by one model. */
async function onboard(persona, spec) {
  // `model@effort` sets the reasoning effort; the api's default is low.
  const [modelId, effort] = spec.split("@")
  const model = plannerModel(KEY, modelId, effort)
  const price = priceOf(modelId)
  const newId = counter("c")
  const sim = {
    rows: [],
    facts: [{ key: "business.name", value: { name: persona.signIn.orgName } }],
  }
  const email = `${persona.id}@owner.invalid`
  const onboardingOf = () => ({
    ...progressOf(scriptRows(sim.rows)),
    orgId: `00000000-0000-4000-8000-${String(persona.id.length).padStart(12, "0")}`,
    facts: sim.facts,
    orgName: persona.signIn.orgName,
    ownerName: persona.signIn.ownerName,
    ownerEmail: email,
  })
  const state = (o, pending, input) => ({
    onboarding: o,
    pending: pending ?? null,
    input,
    rows: sim.rows.slice(-12),
  })
  const put = (facts) => {
    for (const fact of facts) {
      sim.facts = [...sim.facts.filter((f) => f.key !== fact.key), fact]
    }
  }
  const calls = []
  const problems = []
  const says = []
  let fallbacks = 0
  let refusedFirst = 0
  let turns = 0
  let quoteChanged = false
  sim.rows.push({
    role: "assistant",
    parts: [{ type: "step-start" }, ...opening(onboardingOf(), newId)],
  })

  /** A built step: the fake orchestrator always starts it. */
  const start = (o, parts, said) => {
    const pending = buildCall(parts)
    if (!pending) return parts
    const missing = buildMissing(o)
    if (missing.length > 0 && !said.script)
      problems.push(`build started with ${missing.join(", ")} missing`)
    return [
      ...parts.filter((p) => p !== pending),
      ...built(
        o,
        pending,
        { outcome: "started", build: { fake: true } },
        said.text
      ),
    ]
  }

  /** The planner's turn, or the script's when it falls back. */
  const plan = async (s) => {
    const outcome = await planTurn(model, price, s)
    if (process.env.ONBOARDING_EVAL_VERBOSE) {
      for (const c of outcome.calls)
        console.log(
          `[${persona.id} ${turns}] ${c.ms}ms ${c.errors.join(" | ")}\n${c.raw}`
        )
    }
    for (const c of outcome.calls) {
      calls.push(c)
      spent += c.costUsd
    }
    if (outcome.calls[0]?.errors.length) refusedFirst += 1
    if (!outcome.ok) {
      fallbacks += 1
      problems.push(
        `turn ${turns} fell back (${outcome.reason}): ${outcome.calls
          .flatMap((c) => c.errors)
          .join(" | ")
          .slice(
            0,
            400
          )}\n    first answer: ${outcome.calls[0]?.raw.slice(0, 600)}`
      )
      return null
    }
    const { checked } = outcome
    put([...checked.stated, ...checked.chosen])
    says.push(checked.plan.say)
    for (const problem of sayProblems(checked.plan.say))
      problems.push(`say: ${problem}`)
    const parts = planParts(checked, s, newId)
    if (checked.plan.next.kind === "review_quote_form") {
      const contact = contactFields(checked.plan.next.fields)
      if (contact.length > 0)
        problems.push(
          `quote proposal with contact fields ${contact.map((f) => f.key)}`
        )
    }
    return start(checked.after, parts, { text: checked.plan.say.trim() })
  }

  const typed = async (words) => {
    const tail = sim.rows.at(-1)
    const card = waitingCard(tail)
    const o = onboardingOf()
    const s = state(o, card, { kind: "message", text: words })
    let step = await plan(s)
    if (card)
      Object.assign(card, { state: "output-error", errorText: "cancelled" })
    sim.rows.push({ role: "user", parts: [{ type: "text", text: words }] })
    if (!step) {
      const reply = card && typedAnswer(card, words)
      if (card && reply?.kind === "retry")
        step = again(card, reply.reason, o, newId)
      else {
        if (reply?.kind === "facts") put(reply.facts)
        const next = reply ? applied(o, reply) : o
        step = start(
          next,
          onboardingStep({ ...next, facts: sim.facts }, newId),
          { script: true }
        )
      }
    }
    sim.rows.push({
      role: "assistant",
      parts: [{ type: "step-start" }, ...step],
    })
  }

  const answered = async (card, output) => {
    const o = onboardingOf()
    const uploads = factOf(sim.facts, "media.uploads")?.items ?? []
    const meant = cardAnswer(card, output, uploads)
    if (!meant || meant.kind === "retry") {
      problems.push(`the simulator's answer to ${card.type} was refused`)
      return false
    }
    const current = applied(o, meant)
    let step = await plan(state(current, null, { kind: "card", card, output }))
    Object.assign(card, { state: "output-available", output })
    if (meant.kind === "facts") put(meant.facts)
    if (!step)
      step = start(
        current,
        onboardingStep({ ...current, facts: sim.facts }, newId),
        { script: true }
      )
    sim.rows.at(-1).parts.push({ type: "step-start" }, ...step)
    return true
  }

  const lines = () =>
    sim.rows.flatMap((r) =>
      r.parts
        .filter((p) => p.type === "text")
        .map((p) => ({
          from: r.role === "user" ? "Owner" : "Assistant",
          text: p.text,
        }))
    )

  while (turns < MAX_TURNS && !ended(onboardingOf())) {
    if (spent > CAP_USD) throw new Error(`spend cap $${CAP_USD} reached`)
    turns += 1
    const tail = sim.rows.at(-1)
    const card = waitingCard(tail)
    const shown = [
      ...tail.parts
        .filter((p) => p.type === "text")
        .slice(-1)
        .map((p) => p.text),
      ...(card ? [`[${describe(card)}]`] : []),
    ].join("\n")
    const scripted = persona.turns?.[turns]
    if (scripted) {
      await typed(scripted)
      continue
    }
    const act = card ? cardAction(persona, card, { quoteChanged }) : null
    if (act?.kind === "answer") {
      if (
        card.type === "tool-review_quote_form" &&
        act.output.answer === "changes"
      )
        quoteChanged = true
      if (card.type === "tool-ask_upload" && act.output.answer === "uploaded") {
        put([{ key: "media.uploads", value: { items: act.output.assets } }])
      }
      if (!(await answered(card, act.output))) break
      continue
    }
    await typed(act?.text ?? (await ownerSays(persona, lines(), shown)))
  }

  const end = onboardingOf()
  // What the owner ended with.
  const t = { ...persona.truth, ...(persona.truthAfter ?? {}) }
  if (persona.manual) {
    if (!ended(end)) problems.push("the manual path did not close")
    if (factOf(sim.facts, "site.build_mode")?.mode !== "manual")
      problems.push("site.build_mode is not manual")
    if (
      !says.some((s) =>
        /not (yet )?(in|part of) the app|isn't (in the app|ready|available)|not (ready|available) yet|doesn't exist yet|not built yet/i.test(
          s
        )
      )
    ) {
      problems.push("never said the builder is not in the app yet")
    }
  } else if (!end.offered) {
    problems.push(
      `no build after ${turns} owner turns; missing ${buildMissing(end).join(", ")}`
    )
  }
  const missing = REQUIRED.filter((k) => !sim.facts.some((f) => f.key === k))
  if (missing.length > 0)
    problems.push(`required facts missing: ${missing.join(", ")}`)
  if (factOf(sim.facts, "business.phone")?.e164 !== t.phone) {
    problems.push(
      `phone ${factOf(sim.facts, "business.phone")?.e164} is not ${t.phone}`
    )
  }
  if (factOf(sim.facts, "business.email")?.address?.toLowerCase() !== t.email) {
    problems.push(
      `email ${factOf(sim.facts, "business.email")?.address} is not ${t.email}`
    )
  }
  if (!t.name.test(factOf(sim.facts, "business.name")?.name ?? ""))
    problems.push("business name lost")
  const callMe = factOf(sim.facts, "owner.preferred_name")?.name ?? ""
  if (callMe.toLowerCase() !== t.callMe.toLowerCase())
    problems.push(`owner name ${callMe} is not ${t.callMe}`)
  if (
    t.assistant &&
    !t.assistant.test(factOf(sim.facts, "assistant.name")?.name ?? "")
  ) {
    problems.push(`assistant name ${factOf(sim.facts, "assistant.name")?.name}`)
  }
  // A trade off the list is kept in the owner's words, with the closest category or none.
  const industry = factOf(sim.facts, "business.industry")
  if (persona.industry && !persona.industry.test(industry?.name ?? "")) {
    problems.push(`industry ${JSON.stringify(industry)}`)
  }
  const form = factOf(sim.facts, "quote.form")?.fields
  if (!persona.manual) {
    if (form) {
      const text = form
        .map((f) => `${f.key} ${f.label} ${(f.options ?? []).join(" ")}`)
        .join(" | ")
      const hits = persona.quoteExpect.filter((re) => re.test(text)).length
      if (persona.quoteExpect.length > 0 && hits < 2)
        problems.push(`quote form not specific: ${text}`)
      if (contactFields(form).length > 0)
        problems.push("quote form asks contact details")
    } else if (!persona.quoteOptional) {
      problems.push("no quote form")
    } else if (end.offered && !end.closed.includes("quote_form")) {
      // Declined in words: the card closed, and the site keeps its default form.
      problems.push("the quote form was neither confirmed nor declined")
    }
    const photoAsk = sim.rows.flatMap((r) => {
      const i = r.parts.findIndex((p) => p.type === "tool-ask_upload")
      return i > 0 && r.parts[i - 1].type === "text"
        ? [r.parts[i - 1].text]
        : []
    })
    if (photoAsk.length > 0 && !photoAsk.some((s) => /logo/i.test(s)))
      problems.push("the photo question never mentions a logo")
  }
  return {
    persona: persona.id,
    modelId: spec,
    problems,
    calls,
    fallbacks,
    refusedFirst,
    turns,
    transcript: lines(),
    form,
  }
}

function describe(card) {
  const input = card.input
  if (card.type === "tool-ask_choice")
    return `choice card ${input.step}: ${input.options.map((o) => o.label).join(" / ")}${input.other ? " / Something else" : ""}`
  if (card.type === "tool-ask_fact")
    return `form for ${input.key}${input.prefill ? `, prefilled ${JSON.stringify(input.prefill)}` : ""}`
  if (card.type === "tool-ask_upload") return "photo upload, skippable"
  if (card.type === "tool-review_quote_form")
    return `quote form proposal: ${input.fields.map((f) => `${f.label} (${f.type}${f.required ? ", required" : ""})`).join("; ")}`
  return card.type
}

const ASSETS = [
  {
    id: "3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c",
    name: "one.jpg",
    content_type: "image/jpeg",
    bytes: 1000,
  },
  {
    id: "4f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d",
    name: "two.jpg",
    content_type: "image/jpeg",
    bytes: 2000,
  },
]

/** What the owner does with a card, by the sheet's rules, or null to type. */
function cardAction(persona, card, { quoteChanged }) {
  const input = card.input
  const typed = (rule) =>
    rule?.startsWith("type:") ? { kind: "type", text: rule.slice(5) } : null
  if (card.type === "tool-ask_choice") {
    const rule = persona.cards[input.step]
    if (rule === undefined) {
      return input.step === "pages"
        ? {
            kind: "answer",
            output: { answer: "chosen", ids: input.preselected, other: null },
          }
        : null
    }
    return (
      typed(rule) ?? {
        kind: "answer",
        output: { answer: "chosen", ids: [rule], other: null },
      }
    )
  }
  if (card.type === "tool-ask_fact") {
    const truth = { ...persona.truth, ...(persona.truthAfter ?? {}) }
    const value =
      input.key === "owner.preferred_name"
        ? { name: truth.callMe }
        : input.key === "business.phone"
          ? { e164: truth.phone }
          : input.key === "business.email"
            ? { address: truth.email }
            : null
    return value
      ? {
          kind: "answer",
          output: { answer: "stated", fact: { key: input.key, value } },
        }
      : null
  }
  if (card.type === "tool-ask_upload") {
    const rule = persona.cards.upload ?? "skip"
    return (
      typed(rule) ?? {
        kind: "answer",
        output:
          rule === "upload"
            ? { answer: "uploaded", assets: ASSETS }
            : { answer: "skipped" },
      }
    )
  }
  if (card.type === "tool-review_quote_form") {
    const rule = persona.quote ?? "confirm"
    if (rule.startsWith("change:") && !quoteChanged) {
      return {
        kind: "answer",
        output: { answer: "changes", text: rule.slice(7) },
      }
    }
    return (
      typed(rule) ?? {
        kind: "answer",
        output: { answer: "confirmed", fields: input.fields },
      }
    )
  }
  return null
}

export default async function run() {
  if (!KEY) {
    console.log("skip  onboarding-planner: no OPENROUTER_API_KEY")
    return
  }
  const ids = (
    process.env.ONBOARDING_EVAL_MODELS ?? DEFAULT_ONBOARDING_MODEL
  ).split(",")
  const only = process.env.ONBOARDING_EVAL_PERSONAS?.split(",")
  const personas = [...PERSONAS, SKIPPER].filter(
    (p) => !only || only.includes(p.id)
  )
  const results = []
  for (const modelId of ids) {
    if (!priceOf(modelId.split("@")[0]))
      throw new Error(`${modelId} has no price in the facade's table`)
    // One owner at a time per model, owners in parallel within a small batch.
    for (let i = 0; i < personas.length; i += 4) {
      const batch = await Promise.all(
        personas.slice(i, i + 4).map((p) => onboard(p, modelId))
      )
      for (const r of batch) {
        results.push(r)
        console.log(
          `\n=== ${r.persona} on ${r.modelId}: ${r.turns} owner turns, ${r.problems.length ? "FAIL" : "ok"}`
        )
        for (const line of r.transcript)
          console.log(`${line.from}: ${line.text}`)
        if (r.form)
          console.log(
            `Quote form: ${r.form.map((f) => `${f.label} [${f.type}${f.required ? "*" : ""}]`).join("; ")}`
          )
        for (const problem of r.problems) console.log(`  problem: ${problem}`)
      }
    }
  }
  const table = [
    "",
    "| Model | Owners passed | Fallback turns | First plans refused | Planner calls | $ per onboarding | Call p50 / p95 ms | Owner turns (median) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for (const modelId of ids) {
    const mine = results.filter((r) => r.modelId === modelId)
    const calls = mine.flatMap((r) => r.calls)
    const cost =
      calls.reduce((t, c) => t + c.costUsd, 0) / Math.max(1, mine.length)
    const ms = calls.map((c) => c.ms)
    table.push(
      `| ${modelId} | ${mine.filter((r) => r.problems.length === 0).length} of ${mine.length} | ${mine.reduce((t, r) => t + r.fallbacks, 0)} | ${mine.reduce((t, r) => t + r.refusedFirst, 0)} | ${calls.length} | ${cost.toFixed(4)} | ${percentile(ms, 50)} / ${percentile(ms, 95)} | ${percentile(
        mine.map((r) => r.turns),
        50
      )} |`
    )
  }
  table.push(
    "",
    `Spent about $${spent.toFixed(3)} (planner and owner simulator, as billed).`
  )
  console.log(table.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`)
  const failed = results.filter((r) => r.problems.length > 0)
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${results.length} onboardings failed: ${failed.map((r) => r.persona).join(", ")}`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(`FAIL  ${error.message}`)
    process.exit(1)
  })
}
