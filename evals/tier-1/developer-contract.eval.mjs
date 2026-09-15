import { fileURLToPath } from "node:url"
import { CompletionReport, InformationRequest } from "@workspace/contracts"
import { loadSession } from "../replay.mjs"

/**
 * Tier 1 (§16.3): the Developer's output is contract-shaped, and a missing
 * fact is asked for rather than invented. Both sessions were recorded from
 * staging with `pnpm record:session`; the facts they ran against are the
 * golden org's, minus `business.phone` in the second.
 */

const session = (name) =>
  loadSession(
    fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url))
  )

const toolCalls = (events, name) =>
  events.filter((e) => e.type === "runtime.tool" && e.payload.toolName === name)

export default async function developerContract() {
  const build = session("developer-build")
  const report = build.events.find(
    (e) => e.type === "assignment.completion_reported"
  )
  if (!report) throw new Error("developer-build never reported completion")
  // Throws on a shape the contract refuses.
  const parsed = CompletionReport.parse(report.payload)
  if (parsed.checks.some((check) => check.exit_code !== 0)) {
    throw new Error("developer-build reported a failing check as complete")
  }
  if (toolCalls(build.events, "ask_chief").length !== 0) {
    throw new Error("developer-build asked for a fact the snapshot had")
  }

  const asks = session("developer-asks")
  const request = asks.events.find((e) => e.type === "information.requested")
  if (!request) throw new Error("developer-asks never asked")
  const info = InformationRequest.parse(request.payload)
  if (info.field !== "business.phone") {
    throw new Error(
      `developer-asks asked for ${info.field}, not business.phone`
    )
  }
  if (!info.blocking) throw new Error("a missing phone must block")
  if (toolCalls(asks.events, "report_complete").length !== 0) {
    throw new Error("developer-asks reported complete without the phone")
  }
}
