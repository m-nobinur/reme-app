import { appendFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DETAILS_KEYS } from "@workspace/contracts"
import { priceOf } from "../../apps/api/src/cos/agent.ts"
import {
  again,
  applied,
  buildCall,
  built,
  cardAnswer,
  contactFields,
  designDone,
  ended,
  onboardingStep,
  opening,
  progressOf,
  typedAnswer,
} from "../../apps/api/src/onboarding.ts"
import {
  askedSoFar,
  buildMissing,
  DEFAULT_ONBOARDING_MODEL,
  PLANNER,
  plannerModel,
  planParts,
  planTurn,
  REQUIRED,
  sayContext,
  sayProblems,
} from "../../apps/api/src/onboarding-agent.ts"
import { voiceProblems } from "../../apps/api/src/voice.ts"
import models from "../../packages/facade/src/models/openrouter.models.json" with {
  type: "json",
}
import {
  CONVERSATIONS,
  CORRECTS_TWICE,
  MISLEADING,
  PERSONAS,
  SKIPPER,
  SKIPS_EVERYTHING,
} from "../onboarding-personas.mjs"

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
 * The twelve conversations (`ONBOARDING_EVAL_PERSONAS=conversations`) also
 * hold four assertions each: no fact asked twice, no `voiceProblems` hit in
 * any line the owner reads, no question about a fact already held, and the
 * build starts within one turn of the design tray's last answer. Every
 * question the planner can ask is answered: the design tray (picked or
 * skipped), an open question (stated or skipped), a fact, details, a choice,
 * the photo upload (skipped) and the quote form (accepted).
 * It prints every transcript so a person can read the tone, and a table per
 * model: owners passed, fallbacks, first plans refused, cost per onboarding
 * and call latency.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *     evals/tier-2/onboarding-planner.eval.mjs
 *
 * `ONBOARDING_EVAL_MODELS` (comma list, default the api's default),
 * `ONBOARDING_EVAL_PERSONAS` (comma list of ids, or `conversations` for the
 * twelve; default all), `ONBOARDING_EVAL_CAP_USD` (default 3) and
 * `ONBOARDING_EVAL_RECORD` (a path: every line the owner read, per owner,
 * written as JSON for `evals/voice.mjs`) narrow or extend a run. Skipped without
 * `OPENROUTER_API_KEY`, so `pnpm eval` runs everywhere.
 */

const MAX_TURNS = 24
const OWNER_MODEL = "z-ai/glm-5.3-flash"
const CAP_USD = Number(process.env.ONBOARDING_EVAL_CAP_USD ?? 3)
// Not passed through turbo: a task that saw the key would run the facade's live tests.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
const KEY = process.env.OPENROUTER_API_KEY ?? ""

// biome-ignore lint/suspicious/noUndeclaredEnvVars: a file path, not read by any turbo task
const RECORD = process.env.ONBOARDING_EVAL_RECORD

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
  // The api takes at most 1000 characters of an open answer.
  return (
    String(body.choices?.[0]?.message?.content ?? "")
      .trim()
      .slice(0, 1000) || "ok"
  )
}

const counter = (prefix) => {
  let n = 0
  return () => `${prefix}${++n}`
}

/** The fact each choice step states, and the facts the design tray states (as `onboarding-agent.ts` counts them). */
const STEP_FACT = {
  industry: "business.industry",
  pronouns: "assistant.pronouns",
  tone: "assistant.tone",
  build_for_me: "site.build_mode",
  template: "site.template",
  palette: "site.palette",
  font: "site.font",
  pages: "site.pages",
}
const TRAY = ["site.palette", "site.font", "site.direction", "site.pages"]

/** The facts a card asks for; none for a card that asks for no fact (photos, the quote form). */
function askedKeys(part) {
  const input = part.input ?? {}
  if (part.type === "tool-ask_fact") return input.key ? [input.key] : []
  if (part.type === "tool-ask_details") return DETAILS_KEYS[input.step] ?? []
  if (part.type === "tool-ask_choice")
    return STEP_FACT[input.step] ? [STEP_FACT[input.step]] : []
  if (part.type === "tool-ask_design") return TRAY
  if (part.type === "tool-ask_open") return [input.about]
  return []
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
        "tool-ask_details",
        "tool-ask_choice",
        "tool-ask_design",
        "tool-ask_open",
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
  // As `chat.ts` counts them: every card in the rows, and the planned questions in words.
  const askedNow = () =>
    askedSoFar(
      sim.rows.flatMap((r) =>
        r.parts
          .filter(
            (p) => p.type === "tool-ask_fact" || p.type === "tool-ask_choice"
          )
          .map((p) => ({
            type: p.type,
            step: p.input?.key ?? p.input?.step ?? null,
          }))
      ),
      plans
    )
  const onboardingOf = () => ({
    ...progressOf(scriptRows(sim.rows)),
    orgId: `00000000-0000-4000-8000-${String(persona.id.length).padStart(12, "0")}`,
    facts: sim.facts,
    orgName: persona.signIn.orgName,
    ownerName: persona.signIn.ownerName,
    ownerEmail: email,
    asked: askedNow(),
  })
  const state = (o, pending, input) => ({
    onboarding: o,
    pending: pending ?? null,
    input,
    rows: sim.rows.slice(-PLANNER.rows),
    asked: askedNow(),
  })
  const put = (facts) => {
    for (const fact of facts) {
      sim.facts = [...sim.facts.filter((f) => f.key !== fact.key), fact]
    }
  }
  const calls = []
  const firsts = []
  const plans = []
  const problems = []
  const says = []
  let fallbacks = 0
  let refusedFirst = 0
  const refusals = []
  let turns = 0
  let quoteChanged = false
  let trayTurn = null
  let buildTurn = null
  const asks = {}
  const flag = (problem) => {
    if (!problems.includes(problem)) problems.push(problem)
  }

  /**
   * Counts the questions a step asks. A card the owner left unanswered and
   * the step asks again is a retry, not a second question, so `pending`
   * names the keys to leave out. A fact already held is never asked.
   */
  const asked = (keys, pending = []) => {
    const fresh = keys.filter((k) => !pending.includes(k))
    if (fresh.length === 0) return
    if (fresh.every((k) => sim.facts.some((f) => f.key === k)))
      flag(`asked about ${fresh.join(", ")}, already held`)
    for (const k of fresh) {
      asks[k] = (asks[k] ?? 0) + 1
      if (asks[k] === 2) flag(`asked ${k} twice`)
    }
  }
  const askedIn = (parts, pending) => {
    for (const part of parts)
      if (part.type !== "tool-ask_open") asked(askedKeys(part), pending)
  }

  /** Every line the owner reads, planner or script, checked against the voice. */
  const spoken = (parts) => {
    const name = factOf(sim.facts, "assistant.name")?.name
    const assistantNamed = Boolean(name) && name.toLowerCase() !== "reme"
    for (const part of parts) {
      if (part.type !== "text") continue
      heard.push({ text: part.text, named: assistantNamed })
      const { hard, soft } = voiceProblems(part.text, { assistantNamed })
      for (const problem of [...hard, ...soft]) flag(`say: ${problem}`)
    }
  }
  const heard = []
  sim.rows.push({
    role: "assistant",
    parts: [{ type: "step-start" }, ...opening(onboardingOf(), newId)],
  })
  spoken(sim.rows[0].parts)

  /** A built step: the fake orchestrator always starts it. */
  const start = (o, parts, said) => {
    const pending = buildCall(parts)
    if (!pending) return parts
    buildTurn ??= turns
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
    // Streamed as the api streams it, so the first words' time is measured.
    const outcome = await planTurn(model, price, s, undefined, () => undefined)
    if (outcome.firstChunkMs !== null) firsts.push(outcome.firstChunkMs)
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
    if (outcome.calls[0]?.errors.length) {
      refusedFirst += 1
      refusals.push(...outcome.calls[0].errors)
    }
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
    const parts = planParts(checked, s, newId)
    put([...checked.stated, ...checked.chosen])
    says.push(checked.plan.say)
    plans.push(checked.plan)
    for (const problem of sayProblems(
      checked.plan.say,
      sayContext(checked.plan, s, checked.after)
    ))
      flag(`say: ${problem}`)
    // A re-docked card after a side question (answer_only) is not a new ask.
    if (checked.plan.next.kind === "ask_open") asked([checked.plan.next.about])
    else if (checked.plan.next.kind !== "answer_only")
      askedIn(parts, s.pending ? askedKeys(s.pending) : [])
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
        step = onboardingStep({ ...next, facts: sim.facts }, newId)
        askedIn(step, card ? askedKeys(card) : [])
        step = start(next, step, { script: true })
      }
    }
    spoken(step)
    sim.rows.push({
      role: "assistant",
      parts: [{ type: "step-start" }, ...step],
    })
  }

  const answered = async (card, output) => {
    const o = onboardingOf()
    const uploads = factOf(sim.facts, "media.uploads")?.items ?? []
    const meant = cardAnswer(card, output, uploads, sim.facts)
    if (!meant || meant.kind === "retry") {
      problems.push(`the simulator's answer to ${card.type} was refused`)
      return false
    }
    const current = applied(o, meant)
    // As `chat.ts` routes them: a card answer is the script's, with no
    // model call, except a quote form sent back with changes in words and
    // an open question answered in them.
    let step =
      output.answer === "changes" ||
      (output.answer === "stated" && typeof output.text === "string")
        ? await plan(state(current, null, { kind: "card", card, output }))
        : null
    Object.assign(card, { state: "output-available", output })
    if (meant.kind === "facts") put(meant.facts)
    if (!step) {
      step = onboardingStep({ ...current, facts: sim.facts }, newId)
      askedIn(step)
      step = start(current, step, { script: true })
    }
    spoken(step)
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

  // The turn the design tray stopped waiting, answered, skipped or settled by words.
  const noteTray = () => {
    const o = onboardingOf()
    if (trayTurn === null && (o.closed.includes("design") || designDone(o)))
      trayTurn = turns
  }

  while (turns < MAX_TURNS && !ended(onboardingOf())) {
    noteTray()
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
    let act = card ? cardAction(persona, card, { quoteChanged }) : null
    if (act?.kind === "open") {
      act = {
        kind: "answer",
        output: {
          answer: "stated",
          text: await ownerSays(persona, lines(), shown),
        },
      }
    }
    if (act?.kind === "answer") {
      if (
        card.type === "tool-review_quote_form" &&
        act.output.answer === "changes"
      )
        quoteChanged = true
      if (card.type === "tool-ask_design") {
        const held = factOf(sim.facts, "media.uploads")?.items ?? []
        put([{ key: "media.uploads", value: { items: [...held, LOGO] } }])
      }
      if (card.type === "tool-ask_upload" && act.output.answer === "uploaded") {
        put([{ key: "media.uploads", value: { items: act.output.assets } }])
      }
      if (!(await answered(card, act.output))) break
      continue
    }
    await typed(act?.text ?? (await ownerSays(persona, lines(), shown)))
  }

  noteTray()
  const end = onboardingOf()
  // The build follows the tray's last answer within one turn.
  if (trayTurn !== null && !persona.manual) {
    if (buildTurn === null)
      flag("the build never started after the design tray")
    else if (buildTurn - trayTurn > 1)
      flag(
        `the build started ${buildTurn - trayTurn} turns after the design tray (turn ${trayTurn} to ${buildTurn})`
      )
  }
  // What the owner ended with.
  const t = { ...persona.truth, ...(persona.truthAfter ?? {}) }
  if (persona.manual) {
    if (!ended(end)) problems.push("the manual path did not close")
    if (factOf(sim.facts, "site.build_mode")?.mode !== "manual")
      problems.push("site.build_mode is not manual")
    // Whoever said it: the builder answer is a card, which code answers.
    if (
      !lines().some(
        (l) =>
          l.from === "Assistant" &&
          /not (yet )?(in|part of) the app|not ready in the app|isn't (in the app|ready|available)|not (ready|available) yet|doesn't exist yet|not built yet|on its way|coming soon|\bnot\b[^.!?]{0,40}\byet/i.test(
            l.text
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
  if (
    t.assistant &&
    !t.assistant.test(factOf(sim.facts, "assistant.name")?.name ?? "")
  ) {
    problems.push(`assistant name ${factOf(sim.facts, "assistant.name")?.name}`)
  }
  // The trade comes from the owner, never from a misleading business name.
  if (persona.notTrade) {
    // The name itself may be said; a trade drawn from it may not.
    const name = (factOf(sim.facts, "business.name")?.name ?? "")
      .replace(/\s*\(.*\)$/, "")
      .toLowerCase()
    const wrong = says.filter((s) =>
      persona.notTrade.test(s.toLowerCase().split(name).join(""))
    )
    if (wrong.length > 0) problems.push(`said the wrong trade: ${wrong[0]}`)
  }
  // An optional detail the owner deferred is asked at most twice in all.
  for (const key of [
    "business.audience",
    "business.overview",
    "business.tagline",
  ]) {
    const times = plans.filter(
      (p) =>
        (p.next.kind === "ask_open" && p.next.about === key) ||
        (p.next.kind === "ask_fact" && p.next.key === key)
    ).length
    if (times > 2) problems.push(`asked ${key} ${times} times`)
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
    firsts,
    fallbacks,
    refusedFirst,
    refusals,
    turns,
    transcript: lines(),
    heard,
    form,
  }
}

function describe(card) {
  const input = card.input
  if (card.type === "tool-ask_choice")
    return `choice card ${input.step}: ${input.options.map((o) => o.label).join(" / ")}${input.other ? " / Something else" : ""}`
  if (card.type === "tool-ask_fact")
    return `form for ${input.key}${input.prefill ? `, prefilled ${JSON.stringify(input.prefill)}` : ""}`
  if (card.type === "tool-ask_design")
    return `design tray: ${input.questions.map((q) => q.id).join(", ")}`
  if (card.type === "tool-ask_open")
    return `open question about ${input.about}, skippable`
  if (card.type === "tool-ask_upload") return "photo upload, skippable"
  if (card.type === "tool-ask_details")
    return input.step === "contact"
      ? "form for the phone number and the email"
      : "form for the assistant's name, pronouns and tone"
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

const LOGO = {
  id: "5f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0e",
  name: "logo.png",
  content_type: "image/png",
  bytes: 3000,
  use: "logo",
}

/** What the owner does with a card, by the sheet's rules, or null to type. */
function cardAction(persona, card, { quoteChanged }) {
  const input = card.input
  const typed = (rule) =>
    rule?.startsWith("type:") ? { kind: "type", text: rule.slice(5) } : null
  if (persona.skipAll && input.skippable && card.type !== "tool-ask_design") {
    return { kind: "answer", output: { answer: "skipped" } }
  }
  if (card.type === "tool-ask_design") {
    if (persona.cards.design === "skip")
      return { kind: "answer", output: { answers: {}, skip_all: true } }
    // One option per question: the owner's own preset when the tray offers it, else the first; a ticked page set stays as the tray proposed it.
    const answers = Object.fromEntries(
      input.questions.map((q) => {
        if (q.visual === "logo") return [q.id, { logo: LOGO }]
        if (q.visual === "photos") return [q.id, { photos: [], create: true }]
        const ids = q.card.options.map((o) => o.id)
        const mine = [persona.cards[q.id], persona.cards[q.card.step]].find(
          (id) => id && ids.includes(id)
        )
        const pick = mine ?? q.card.preselected[0] ?? ids[0]
        return [
          q.id,
          q.card.multiple
            ? {
                choices: q.card.preselected.length
                  ? q.card.preselected
                  : [pick],
              }
            : { choice: pick },
        ]
      })
    )
    return { kind: "answer", output: { answers, skip_all: false } }
  }
  if (card.type === "tool-ask_open") {
    return input.skippable && (persona.cards.open === "skip" || persona.skipAll)
      ? { kind: "answer", output: { answer: "skipped" } }
      : { kind: "open" }
  }
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
      input.key === "business.phone"
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
  if (card.type === "tool-ask_details") {
    // Filled in as the owner's sheet has it; an owner with no name for the
    // assistant types instead, which is the planner's to read.
    const truth = { ...persona.truth, ...(persona.truthAfter ?? {}) }
    const preset = (rule) => (rule && !rule.startsWith("type:") ? rule : null)
    const named = truth.assistant?.source.replace(/^\w/, (c) => c.toUpperCase())
    const facts =
      input.step === "contact"
        ? [
            { key: "business.phone", value: { e164: truth.phone } },
            { key: "business.email", value: { address: truth.email } },
          ]
        : named
          ? [
              { key: "assistant.name", value: { name: named } },
              ...(preset(persona.cards.pronouns)
                ? [
                    {
                      key: "assistant.pronouns",
                      value: { id: persona.cards.pronouns },
                    },
                  ]
                : []),
              ...(preset(persona.cards.tone)
                ? [{ key: "assistant.tone", value: { id: persona.cards.tone } }]
                : []),
            ]
          : []
    return facts.length > 0
      ? { kind: "answer", output: { answer: "stated", facts } }
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
  const only = process.env.ONBOARDING_EVAL_PERSONAS?.split(",").flatMap((id) =>
    id === "conversations" ? CONVERSATIONS : [id]
  )
  const personas = [
    ...PERSONAS,
    ...MISLEADING,
    SKIPPER,
    SKIPS_EVERYTHING,
    CORRECTS_TWICE,
  ].filter((p) => !only || only.includes(p.id))
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
    "| Model | Owners passed | Fallback turns | First plans refused | Planner calls | $ per onboarding | Call p50 / p95 ms | First words p50 / p95 ms | Cached input | Owner turns (median) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for (const modelId of ids) {
    const mine = results.filter((r) => r.modelId === modelId)
    const calls = mine.flatMap((r) => r.calls)
    const cost =
      calls.reduce((t, c) => t + c.costUsd, 0) / Math.max(1, mine.length)
    const ms = calls.map((c) => c.ms)
    const firsts = mine.flatMap((r) => r.firsts)
    const input = calls.reduce((t, c) => t + c.usage.input_tokens, 0)
    const cached = calls.reduce((t, c) => t + c.usage.cached_input_tokens, 0)
    table.push(
      `| ${modelId} | ${mine.filter((r) => r.problems.length === 0).length} of ${mine.length} | ${mine.reduce((t, r) => t + r.fallbacks, 0)} | ${mine.reduce((t, r) => t + r.refusedFirst, 0)} | ${calls.length} | ${cost.toFixed(4)} | ${percentile(ms, 50)} / ${percentile(ms, 95)} | ${percentile(firsts, 50)} / ${percentile(firsts, 95)} | ${Math.round((100 * cached) / Math.max(1, input))}% | ${percentile(
        mine.map((r) => r.turns),
        50
      )} |`
    )
  }
  table.push(
    "",
    `Spent about $${spent.toFixed(3)} (planner and owner simulator, as billed).`
  )
  const tally = {}
  for (const reason of results.flatMap((r) => r.refusals))
    tally[reason.slice(0, 160)] = (tally[reason.slice(0, 160)] ?? 0) + 1
  table.push(
    "",
    "First-plan refusals by reason:",
    ...Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${String(n).padStart(4)}  ${reason}`)
  )
  console.log(table.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`)
  // What the owner read, for the voice eval: one entry per conversation.
  if (RECORD) {
    writeFileSync(
      RECORD,
      `${JSON.stringify(
        results.map((r) => ({
          persona: r.persona,
          model: r.modelId,
          says: r.heard,
        })),
        null,
        2
      )}\n`
    )
  }
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
