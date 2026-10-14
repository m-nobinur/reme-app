import { expect, it } from "vitest"
import { createPrefixWarmer } from "../src/warm.ts"

const model = { type: "model", turnId: "t" } as const

it("holds the siblings' first calls until the leader's response begins, and never again", async () => {
  const warm = createPrefixWarmer()
  const order: string[] = []
  let finish: () => void = () => undefined
  const leader = warm.interceptor(model, { taskId: "a" }, async () => {
    order.push("a starts")
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    order.push("a ends")
  })
  const sibling = warm.interceptor(model, { taskId: "b" }, async () => {
    order.push("b starts")
  })
  // The lead's own calls and tool calls never wait.
  await warm.interceptor(model, {}, async () => order.push("lead"))
  await warm.interceptor(
    { type: "tool", toolCallId: "x", toolName: "read" },
    { taskId: "b" },
    async () => order.push("b reads")
  )
  await Promise.resolve()
  expect(order).toEqual(["a starts", "lead", "b reads"])
  // Another child's stream releases no one; the leader's does.
  warm.observe({ type: "text_delta", taskId: "b" })
  await Promise.resolve()
  expect(order).not.toContain("b starts")
  warm.observe({ type: "thinking_start", taskId: "a" })
  await sibling
  expect(order).toEqual(["a starts", "lead", "b reads", "b starts"])
  // A sibling's second call goes straight through.
  await warm.interceptor(model, { taskId: "b" }, async () =>
    order.push("b again")
  )
  finish()
  await leader
  expect(order.at(-1)).toBe("a ends")
})

it("releases the siblings when the leader's call fails before it streams", async () => {
  const warm = createPrefixWarmer()
  const leader = warm.interceptor(model, { taskId: "a" }, async () => {
    throw new Error("provider down")
  })
  const sibling = warm.interceptor(model, { taskId: "b" }, async () => "b ran")
  await expect(leader).rejects.toThrow("provider down")
  await expect(sibling).resolves.toBe("b ran")
})
