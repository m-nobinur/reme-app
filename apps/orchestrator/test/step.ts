import type { WorkflowStep } from "cloudflare:workers"

/**
 * A Workflow step that runs each body at once, as a first run does, and
 * records the names. A wait ends with `event`, or times out without one.
 */
export function stepped(event?: { type: string }) {
  const names: string[] = []
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      return ((typeof a === "function" ? a : b) as () => Promise<unknown>)()
    },
    waitForEvent: async (name: string) => {
      names.push(name)
      if (event) return { ...event, payload: {}, timestamp: new Date() }
      throw new Error("timed out")
    },
  }
  return Object.assign(step as unknown as WorkflowStep, { names })
}
