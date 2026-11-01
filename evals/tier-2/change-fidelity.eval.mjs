import { appendFileSync } from "node:fs"
import { fidelity, fold, visibleText } from "../rubric/fidelity.mjs"

/**
 * Tier 2, live: the change-request set from the site quality design (§6),
 * each sent as the briefed `site.revise` the assistant would send, against
 * the published brightclean site, and scored on fidelity: every acceptance
 * check judged passed on the built pages, nothing changed off its targets,
 * and the owner's own words on the page as they gave them. Then the
 * later-change checks: a story survives a redesign word for word, a removed
 * service leaves every place it showed, a new phone reaches every page, and
 * an undo puts the page back. Every preview is cancelled, so nothing
 * publishes; facts a check changes are put back after it.
 *
 *   ORCHESTRATOR_URL=... ORCHESTRATOR_TOKEN=... pnpm eval --tier 2
 *
 * Skipped, not failed, without an orchestrator or a published site.
 */

const ORG = "brightclean"
const SETTLED = new Set([
  "preview_ready",
  "blocked_on_information",
  "blocked_on_approval",
  "failed",
  "cancelled",
])
const TIMEOUT_MS = 15 * 60 * 1000
const SPEND_CAP_USD = 3
const STORY =
  "We started in 2019 with one van and a list of three regular homes. Five years on, the same two of us still check every job before we leave."
const PHONE = "+441174960999"

const base = (process.env.ORCHESTRATOR_URL ?? "").replace(/\/$/, "")
const token = process.env.ORCHESTRATOR_TOKEN ?? ""

class Refused extends Error {
  constructor(status, code, path) {
    super(`${status} ${code} on ${path}`)
    this.code = code
  }
}

async function call(method, path, body) {
  const url = new URL(`${base}${path}`)
  url.searchParams.set("org", ORG)
  const headers = { authorization: `Bearer ${token}` }
  if (body) headers["content-type"] = "application/json"
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID()
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Refused(res.status, json.code ?? "", path)
  return json
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pages of a site by route: a preview through its signed link's cookie, or the published host. */
async function pagesOf(url, routes) {
  const origin = new URL(url).origin
  const opened = await fetch(url, { redirect: "manual" })
  const cookie = (opened.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ")
  const get = (path) =>
    fetch(new URL(path, origin), { headers: { cookie } }).then((r) =>
      r.ok ? r.text() : ""
    )
  const wanted =
    routes === "all"
      ? [...(await get("/sitemap.xml")).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
          (m) => new URL(m[1]).pathname
        )
      : routes
  const pages = {}
  for (const route of wanted.length ? wanted : ["/"])
    pages[route] = await get(route)
  pages["/sitemap.xml"] = await get("/sitemap.xml")
  return pages
}

/** A service page's route on the published home page whose slug matches. */
const serviceRoute = (html, match) =>
  [...html.matchAll(/href="(\/services\/[a-z0-9-]+\/)"/g)]
    .map((m) => m[1])
    .find((route) => match.test(route)) ?? null

const pageOf = (route) =>
  route === "/" ? "home" : route.replace(/^\/|\/$/g, "")

/** One briefed revise, watched to where it settles, read back, and its cost. */
async function revise(goal, label, brief, draft) {
  const created = await call("POST", "/assignments", {
    kind: "site.revise",
    model: "A",
    goal,
    label,
    brief: { ...brief, owner_words: goal },
    ...(draft ? { draft_revision_id: draft } : {}),
  })
  const id = created.assignment_id
  const started = Date.now()
  let state = created.state
  while (!SETTLED.has(state) && Date.now() - started < TIMEOUT_MS) {
    await sleep(10_000)
    state = (await call("GET", `/assignments/${id}`)).assignment.state
  }
  const { events } = await call("GET", `/assignments/${id}/events`)
  const last = (type) => events.filter((e) => e.type === type).at(-1)?.payload
  const report = last("assignment.completion_reported")
  const cost = events
    .filter((e) => e.type === "runtime.turn")
    .reduce((n, e) => n + (e.payload.response?.usage?.cost?.total ?? 0), 0)
  const link =
    state === "preview_ready"
      ? (await call("GET", `/assignments/${id}/preview`)).url
      : null
  return {
    id,
    state,
    seconds: Math.round((Date.now() - started) / 1000),
    cost,
    checks: last("change.checked")?.checks ?? [],
    blocks: report?.blocks ?? [],
    revision: report?.revision_id ?? null,
    link,
  }
}

const cancel = (id) =>
  call("POST", `/assignments/${id}/cancel`, {}).catch(() => undefined)

/** The design's five requests, each with the brief the assistant would write. */
const CASES = (home) => {
  const deep = serviceRoute(home, /deep/)
  const tenancy = serviceRoute(home, /tenancy|move/)
  return [
    {
      name: "add our story to About",
      goal: "Add our story to the About page",
      label: "your About page",
      brief: {
        edit_type: "add_section",
        targets: [{ page: "about" }],
        content: `## Our story\n\n${STORY}`,
        placement: "after the About page's first section",
        acceptance: [
          "The About page has a section headed Our story",
          `The About page says, word for word: ${STORY}`,
        ],
      },
      verbatim: STORY,
      routes: ["/about/"],
    },
    deep && {
      name: "make the deep clean page richer",
      goal: "Make the deep clean page richer",
      label: "your deep clean page",
      brief: {
        edit_type: "add_content",
        targets: [{ page: pageOf(deep) }],
        content:
          "What a deep clean usually covers, room by room, as a checklist labelled typical: the kitchen (inside the oven, hob, extractor, cupboard fronts), the bathroom (limescale, grout, behind the toilet), living areas (skirting boards, light switches, under furniture) and bedrooms (under beds, wardrobe tops).",
        placement: "after the page's first section",
        acceptance: [
          "The deep clean page has a room-by-room checklist of what a deep clean covers",
          "The checklist says it is what a deep clean typically covers",
        ],
      },
      routes: [deep],
    },
    {
      name: "move the FAQ above services",
      goal: "Move the FAQ above the services",
      label: "your home page",
      brief: {
        edit_type: "move",
        targets: [{ page: "home" }],
        placement:
          "the questions section directly before the services section on home",
        acceptance: [
          "On the home page the questions section comes before the services section",
          "Every section the home page had is still on it",
        ],
      },
      routes: ["/"],
    },
    tenancy && {
      name: "add a table of what end of tenancy covers",
      goal: "Add a table of what end of tenancy covers",
      label: "your end of tenancy page",
      brief: {
        edit_type: "add_content",
        targets: [{ page: pageOf(tenancy) }],
        content:
          "A table with columns Room and What we clean, one row each for the kitchen, the bathroom, the living room and the bedrooms, labelled as what an end of tenancy clean typically covers.",
        placement: "after the page's first section",
        acceptance: [
          "The end of tenancy page has a table of what an end of tenancy clean covers",
          "The table has a row for the kitchen and a row for the bathroom",
        ],
      },
      routes: [tenancy],
    },
    {
      name: "put the phone number in the header",
      goal: "Put the phone number in the header",
      label: "your header",
      brief: {
        edit_type: "update_content",
        targets: [],
        acceptance: [
          "The header on the home page shows the business phone number",
          "The header's phone number is a link that calls it",
        ],
      },
      routes: ["/"],
      also: [],
    },
  ].filter(Boolean)
}

/** Restate a fact, returning what to put back. */
async function restate(key, value) {
  const { facts } = await call("GET", "/assignments/facts")
  const was = facts.find((f) => f.key === key)?.value
  await call("POST", "/assignments/facts", { facts: [{ key, value }] })
  return was
}

/** The later-change checks; each returns a problem or null. */
const LATER = [
  {
    name: "a story survives a redesign word for word",
    run: async () => {
      const was = await restate("site.content", {
        items: [
          { id: "story", page: "about", title: "Our story", markdown: STORY },
        ],
      })
      try {
        const made = await revise("Give the site a new look", "the look", {
          edit_type: "redesign",
          targets: [],
          acceptance: [
            "The site has a different layout or palette from before",
            `The About page still says, word for word: ${STORY}`,
          ],
        })
        try {
          if (!made.link)
            return { ...made, problem: `settled in ${made.state}` }
          const pages = await pagesOf(made.link, ["/about/"])
          return {
            ...made,
            problem: fold(visibleText(pages["/about/"])).includes(fold(STORY))
              ? null
              : "the story is not on the About page word for word",
          }
        } finally {
          await cancel(made.id)
        }
      } finally {
        if (was) await restate("site.content", was)
      }
    },
  },
  {
    name: "a new phone reaches every page",
    run: async () => {
      const was = await restate("business.phone", PHONE)
      try {
        const made = await revise(
          "Update the phone number everywhere",
          "your phone number",
          {
            edit_type: "update_content",
            targets: [],
            acceptance: [
              "Every page that shows a phone number shows +44 117 496 0999",
              "No page shows the old phone number",
            ],
          }
        )
        try {
          if (!made.link)
            return { ...made, problem: `settled in ${made.state}` }
          const pages = await pagesOf(made.link, "all")
          const missing = Object.entries(pages)
            .filter(([route]) => route !== "/sitemap.xml")
            .filter(([, html]) => !html.includes(`tel:${PHONE}`))
            .map(([route]) => route)
          return {
            ...made,
            problem: missing.length
              ? `no new phone on ${missing.join(", ")}`
              : null,
          }
        } finally {
          await cancel(made.id)
        }
      } finally {
        if (was) await restate("business.phone", was)
      }
    },
  },
  {
    name: "a removed service leaves every place it showed",
    run: async (home) => {
      const route =
        serviceRoute(home, /oven|window|carpet/) ?? serviceRoute(home, /./)
      if (!route) return { problem: "the published site has no service page" }
      const { facts } = await call("GET", "/assignments/facts")
      const offerings = facts.find((f) => f.key === "business.offerings")?.value
      const slug = route.split("/")[2]
      const items = offerings?.items ?? []
      const gone = items.find((i) =>
        fold(i.name ?? "")
          .replace(/\s+/g, "-")
          .includes(slug.split("-")[0])
      )
      if (!gone) return { problem: `no offering matches ${route}` }
      await restate("business.offerings", {
        ...offerings,
        items: items.filter((i) => i !== gone),
      })
      try {
        const made = await revise(
          `Remove ${gone.name} from the site`,
          gone.name,
          {
            edit_type: "remove",
            targets: [{ page: pageOf(route) }, { page: "services" }],
            acceptance: [
              `No page links to ${route}`,
              `The services page no longer lists ${gone.name}`,
            ],
          }
        )
        try {
          if (!made.link)
            return { ...made, problem: `settled in ${made.state}` }
          const pages = await pagesOf(made.link, ["/", "/services/"])
          const left = Object.entries(pages)
            .filter(
              ([, html]) =>
                html.includes(route) || html.includes(`"${gone.name}"`)
            )
            .map(([at]) => at)
          return {
            ...made,
            problem: left.length
              ? `${gone.name} still shows on ${left.join(", ")}`
              : null,
          }
        } finally {
          await cancel(made.id)
        }
      } finally {
        await restate("business.offerings", offerings)
      }
    },
  },
  {
    name: "undo puts the page back",
    run: async (home) => {
      const order = (html) =>
        [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
          visibleText(m[1]).trim()
        )
      const moved = await revise(
        "Move the FAQ above the services",
        "your home page",
        {
          edit_type: "move",
          targets: [{ page: "home" }],
          placement:
            "the questions section directly before the services section",
          acceptance: [
            "On the home page the questions section comes before the services section",
            "Every section the home page had is still on it",
          ],
        }
      )
      try {
        if (!moved.revision)
          return { ...moved, problem: `the move settled in ${moved.state}` }
        const undone = await revise(
          "Undo the last change",
          "your home page",
          {
            edit_type: "move",
            targets: [{ page: "home" }],
            placement:
              "every section back in the order it had before the last change",
            acceptance: [
              "On the home page the services section comes before the questions section",
              "Every section the home page had is still on it",
            ],
          },
          moved.revision
        )
        try {
          if (!undone.link)
            return { ...undone, problem: `the undo settled in ${undone.state}` }
          const pages = await pagesOf(undone.link, ["/"])
          const same =
            JSON.stringify(order(pages["/"])) === JSON.stringify(order(home))
          return {
            ...undone,
            cost: moved.cost + undone.cost,
            problem: same
              ? null
              : "the home page's sections are not in their old order",
          }
        } finally {
          await cancel(undone.id)
        }
      } finally {
        await cancel(moved.id)
      }
    },
  },
]

export default async function changeFidelity() {
  if (!base || !token) {
    console.log(
      "      skipped: ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN name no orchestrator"
    )
    return
  }
  const site = await call("GET", "/assignments/site").catch((error) => {
    if (error instanceof Refused) return null
    throw error
  })
  if (!site?.host || !site.active) {
    console.log(`      skipped: ${ORG} has no published site to change`)
    return
  }
  const home = await (await fetch(`https://${site.host}/`)).text()
  const rows = []
  let spent = 0
  for (const c of CASES(home)) {
    if (spent > SPEND_CAP_USD) break
    const made = await revise(c.goal, c.label, c.brief)
    try {
      const pages = made.link ? await pagesOf(made.link, c.routes) : {}
      const scored =
        made.state === "preview_ready"
          ? fidelity({ ...c, ...made, pages })
          : { passed: false, problems: [`settled in ${made.state}`] }
      rows.push({
        name: c.name,
        ...made,
        problem: scored.problems.join("; ") || null,
      })
    } finally {
      await cancel(made.id)
    }
    spent += made.cost
  }
  for (const check of LATER) {
    if (spent > SPEND_CAP_USD) {
      rows.push({ name: "(stopped)", problem: "spend cap" })
      break
    }
    const row = await check.run(home)
    rows.push({ name: check.name, ...row })
    spent += row.cost ?? 0
  }

  const failed = rows.filter((r) => r.problem)
  const lines = [
    "## Tier 2: change fidelity on staging",
    "",
    `${rows.length - failed.length} of ${rows.length} passed, cost $${spent.toFixed(4)} of a $${SPEND_CAP_USD.toFixed(2)} cap.`,
    "",
    "| Request | Settled in | Seconds | Checks passed | Cost | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${[
          r.name,
          r.state ?? "",
          r.seconds ?? "",
          r.checks
            ? `${r.checks.filter((c) => c.passed).length}/${r.checks.length}`
            : "",
          r.cost === undefined ? "" : `$${r.cost.toFixed(4)}`,
          r.problem ? `FAILED ${r.problem}` : "ok",
        ].join(" | ")} |`
    ),
    "",
  ]
  console.log(lines.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
  }
  if (failed.length > 0) {
    throw new Error(failed.map((r) => `${r.name}: ${r.problem}`).join("; "))
  }
}
