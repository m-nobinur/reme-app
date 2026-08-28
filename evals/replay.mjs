import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

/**
 * Replay and hashing for recorded model sessions.
 *
 * §17 asks one thing of this layer: the same session log derives the same
 * context hash. Everything else in the eval scaffold is built on that, because
 * a scenario scored against a context that drifts between runs is scoring
 * noise. The facade and its `deriveContext` (§10.6) do not exist yet, so the
 * fold below is the whole of it: a recorded chunk stream in, the model-visible
 * state of the session out.
 */

/**
 * Reads a recorded fixture. Line 1 is the header, every other line is one
 * recorded chunk tagged with the turn it belongs to.
 */
export function loadFixture(path) {
  const [head, ...rest] = readFileSync(path, "utf8").trimEnd().split("\n")
  const header = JSON.parse(head)
  const turns = new Map(header.turns.map((name) => [name, []]))
  for (const line of rest) {
    const { turn, chunk } = JSON.parse(line)
    turns.get(turn).push(chunk)
  }
  return { ...header, turns }
}

/** The chunks of a session, in order, across the turns it is composed of. */
function sessionChunks(fixture, turnNames) {
  return turnNames.flatMap((name) => fixture.turns.get(name))
}

/**
 * Folds a recorded chunk stream into the model-visible state of the session:
 * the parts a client renders and the next model call would be handed.
 *
 * Determinism here is a design constraint rather than an accident. Parts leave
 * in the order the stream opened them; the two maps are lookup only and are
 * never iterated, so no hash depends on Map ordering. Nothing reads a clock, a
 * random source or the environment, and no arithmetic runs, so two folds over
 * the same input can only differ if this function does.
 */
export function deriveContext(chunks) {
  const parts = []
  const byText = new Map()
  const byCall = new Map()

  const openText = (type, id) => {
    const part = { type, id, text: "" }
    parts.push(part)
    byText.set(`${type}:${id}`, part)
    return part
  }

  const openCall = (toolCallId, toolName) => {
    const part = { type: "tool", toolCallId, toolName, state: "pending" }
    parts.push(part)
    byCall.set(toolCallId, part)
    return part
  }

  for (const chunk of chunks) {
    switch (chunk.type) {
      case "text-start":
        openText("text", chunk.id)
        break
      case "reasoning-start":
        openText("reasoning", chunk.id)
        break
      case "text-delta":
      case "reasoning-delta": {
        const kind = chunk.type === "text-delta" ? "text" : "reasoning"
        const key = `${kind}:${chunk.id}`
        const part = byText.get(key) ?? openText(kind, chunk.id)
        part.text += chunk.delta
        break
      }
      case "tool-input-start":
        openCall(chunk.toolCallId, chunk.toolName).state = "input-streaming"
        break
      case "tool-input-available": {
        const part =
          byCall.get(chunk.toolCallId) ??
          openCall(chunk.toolCallId, chunk.toolName)
        part.input = chunk.input
        part.state = "input-available"
        break
      }
      case "tool-approval-request": {
        const part = byCall.get(chunk.toolCallId) ?? openCall(chunk.toolCallId)
        // §7.3: an approval binds to the input above it and to nothing else.
        // Keeping both in one part is what lets an eval assert that.
        part.approval = { approvalId: chunk.approvalId, reason: chunk.reason }
        part.state = "approval-requested"
        break
      }
      case "tool-output-available": {
        const part = byCall.get(chunk.toolCallId) ?? openCall(chunk.toolCallId)
        part.output = chunk.output
        part.state = "output-available"
        break
      }
      case "tool-output-denied": {
        const part = byCall.get(chunk.toolCallId) ?? openCall(chunk.toolCallId)
        part.state = "output-denied"
        break
      }
      default:
        // start, start-step, finish-step and finish are framing. They carry no
        // model-visible state, and folding them in would make the hash depend
        // on how a turn was chunked rather than on what it said.
        break
    }
  }

  return { parts }
}

/**
 * JSON with every object key sorted and every undefined dropped, so the order
 * a value's keys were assigned in cannot move a hash.
 */
export function canonical(value) {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const body = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
  return `{${body.join(",")}}`
}

/** The hash a fixture is pinned to, over the derived context of every session. */
export function replay(fixture) {
  const derived = {}
  for (const [name, turnNames] of Object.entries(fixture.sessions)) {
    derived[name] = deriveContext(sessionChunks(fixture, turnNames))
  }
  const digest = createHash("sha256").update(canonical(derived)).digest("hex")
  return `sha256:${digest}`
}
