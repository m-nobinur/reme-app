// `pnpm model`: list the models each agent can run on.
// `pnpm model <cos|developer|fallback> <id> [--production]`: switch one.
//
// Both agents read their model from the environment: the Chief of Staff from
// the api's `COS_MODEL`, the Developer from the orchestrator's
// `REME_MODEL_DEFAULT` and `REME_MODEL_FALLBACK`. This sets that value as a
// Worker secret, which takes effect on the next request without a deploy.
// It refuses an id missing from `openrouter.models.json`: the CoS would fall
// back to its script without a price, and a Developer build would fail. To add
// a model, put its id in `packages/facade/src/models/openrouter.ids.json`, run
// `pnpm --filter @workspace/facade models`, and deploy that first.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { bad, ok, repoRoot } from "./lib.mjs"

const ROLES = {
  cos: { app: "api", name: "COS_MODEL", prefix: "" },
  developer: {
    app: "orchestrator",
    name: "REME_MODEL_DEFAULT",
    prefix: "openrouter/",
  },
  fallback: {
    app: "orchestrator",
    name: "REME_MODEL_FALLBACK",
    prefix: "openrouter/",
  },
}

const models = JSON.parse(
  readFileSync(
    `${repoRoot}packages/facade/src/models/openrouter.models.json`,
    "utf8"
  )
)
const ids = models.map((m) => m.id)
const [role, id] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const production = process.argv.includes("--production")

if (!role) {
  console.log("Models with a price (packages/facade/src/models):")
  for (const m of models)
    console.log(
      `  ${m.id.padEnd(34)} $${m.cost.input} in / $${m.cost.output} out per million, at the routing cap`
    )
  console.log(
    "\nUsage: pnpm model <cos|developer|fallback> <id> [--production]"
  )
  console.log("Defaults: cos and developer deepseek/deepseek-v4.1-flash,")
  console.log("fallback x-ai/grok-4.6. Staging unless --production.")
  process.exit(0)
}

const target = ROLES[role]
if (!target) {
  bad(`unknown role "${role}": use cos, developer or fallback`)
  process.exit(1)
}
const bare = id?.replace(/^openrouter\//, "")
if (!bare || !ids.includes(bare)) {
  bad(`"${id ?? ""}" has no price in openrouter.models.json`)
  console.log(`  Known: ${ids.join(", ")}`)
  process.exit(1)
}

const value = `${target.prefix}${bare}`
const args = ["--filter", target.app, "exec", "wrangler", "secret", "put"]
args.push(target.name, ...(production ? ["--env", "production"] : []))
try {
  execFileSync("pnpm", args, {
    cwd: repoRoot,
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "0" },
  })
} catch {
  bad(`wrangler secret put ${target.name} failed, see its output above`)
  process.exit(1)
}
ok(`${role} now runs on ${value} in ${production ? "production" : "staging"}`)
