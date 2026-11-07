/**
 * `pnpm --filter api whatsapp:dev-account <orgId>`: writes Meta's test number
 * from `apps/api/.dev.vars` into the org as its WhatsApp account
 * (`source: dev`), so the chat flow runs locally without Embedded Signup. A
 * second run rewrites the same row. `--templates` also creates the update
 * template on the test WABA, for Meta to review.
 */
import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { parseEnv } from "node:util"
import { orgs, pgCode, tenancy, whatsappAccounts } from "@workspace/db"
import { sealToken } from "../src/channels/token.ts"
import { ensureTemplates } from "../src/channels/whatsapp/templates.ts"

const fail = (message: string): never => {
  console.error(`whatsapp:dev-account: ${message}`)
  process.exit(1)
}

const [orgId = "", flag] = process.argv.slice(2)
if (
  !/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(orgId) ||
  (flag !== undefined && flag !== "--templates")
) {
  fail("usage: pnpm --filter api whatsapp:dev-account <orgId> [--templates]")
}

let vars: Record<string, string | undefined> = {}
try {
  vars = parseEnv(
    readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  )
} catch {
  fail("no apps/api/.dev.vars.")
}
const NEEDED = [
  "CHANNEL_TOKEN_KEY",
  "WHATSAPP_DEV_TOKEN",
  "WHATSAPP_DEV_PHONE_NUMBER_ID",
  "WHATSAPP_DEV_WABA_ID",
  "WHATSAPP_DEV_NUMBER",
] as const
const missing = NEEDED.filter((name) => !vars[name])
if (missing.length > 0) fail(`set ${missing.join(", ")} in apps/api/.dev.vars.`)

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(new URL("../../../.env.local", import.meta.url))
  } catch {
    // No .env.local. The line below says what is missing.
  }
}
const url = process.env.DATABASE_URL ?? fail("no DATABASE_URL in .env.local.")

const kit = tenancy(url)
try {
  const name = await kit.withOrg({ orgId }, async (db) => {
    const [org] = await db.select({ name: orgs.name }).from(orgs)
    if (!org) return fail(`no org ${orgId}.`)
    const account = {
      wabaId: String(vars.WHATSAPP_DEV_WABA_ID),
      phoneNumberId: String(vars.WHATSAPP_DEV_PHONE_NUMBER_ID),
      displayNumber: `+${String(vars.WHATSAPP_DEV_NUMBER).replace(/\D/g, "")}`,
      displayName: org.name.slice(0, 100),
      tokenCiphertext: await sealToken(
        vars,
        orgId,
        String(vars.WHATSAPP_DEV_TOKEN)
      ),
      source: "dev" as const,
      coexistence: false,
      status: "active" as const,
    }
    await db
      .insert(whatsappAccounts)
      .values({ orgId, ...account })
      .onConflictDoUpdate({ target: whatsappAccounts.orgId, set: account })
    return org.name
  })
  console.log(
    `whatsapp:dev-account: ${vars.WHATSAPP_DEV_NUMBER} is ${name}'s number.`
  )
  if (flag) {
    await ensureTemplates(
      {
        phoneNumberId: String(vars.WHATSAPP_DEV_PHONE_NUMBER_ID),
        token: String(vars.WHATSAPP_DEV_TOKEN),
      },
      String(vars.WHATSAPP_DEV_WABA_ID)
    )
    console.log("whatsapp:dev-account: the update template is on the WABA.")
  }
} catch (error) {
  if (pgCode(error) === "23505") {
    fail(
      "another org holds this test number. Remove its whatsapp_accounts row first."
    )
  }
  throw error
} finally {
  await kit.close()
}
