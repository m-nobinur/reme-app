import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bounded,
  EXEC_CALL_MS,
  EXEC_GRACE_MS,
  FILE_CALL_MS,
  SandboxCallTimeout,
} from "../src/sandbox.ts"

/** A stand-in stub whose calls hang the first `hangs` times, then answer. */
function stub(hangs: number) {
  const calls: string[] = []
  const answer =
    (name: string, value: unknown) =>
    (..._args: unknown[]) => {
      calls.push(name)
      return calls.filter((c) => c === name).length <= hangs
        ? new Promise(() => undefined)
        : Promise.resolve(value)
    }
  return {
    calls,
    sandbox: bounded({
      exec: answer("exec", { exitCode: 0, stdout: "ok" }),
      readFile: answer("readFile", { content: "page" }),
      writeFile: answer("writeFile", undefined),
      getState: async () => ({ status: "running" }),
    }),
  }
}

describe("a sandbox call that never answers", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is tried once more after its deadline, and the second answer stands", async () => {
    vi.useFakeTimers()
    const { calls, sandbox } = stub(1)
    const read = sandbox.readFile("/workspace/site/dist/index.html")
    await vi.advanceTimersByTimeAsync(FILE_CALL_MS)
    expect(await read).toEqual({ content: "page" })
    expect(calls).toEqual(["readFile", "readFile"])
  })

  it("fails after the second deadline instead of holding the build", async () => {
    vi.useFakeTimers()
    const { calls, sandbox } = stub(2)
    const write = sandbox.writeFile("/workspace/site/src/site-config.ts", "x")
    const failed = expect(write).rejects.toBeInstanceOf(SandboxCallTimeout)
    await vi.advanceTimersByTimeAsync(2 * FILE_CALL_MS)
    await failed
    expect(calls).toEqual(["writeFile", "writeFile"])
  })

  it("gives a command its own timeout plus a grace, or the default", async () => {
    vi.useFakeTimers()
    const own = stub(1)
    const built = own.sandbox.exec("astro build", { timeout: 180_000 })
    await vi.advanceTimersByTimeAsync(180_000 + EXEC_GRACE_MS - 1)
    expect(own.calls).toEqual(["exec"])
    await vi.advanceTimersByTimeAsync(1)
    expect(await built).toMatchObject({ exitCode: 0 })
    const bare = stub(1)
    const ran = bare.sandbox.exec("git status")
    await vi.advanceTimersByTimeAsync(EXEC_CALL_MS + EXEC_GRACE_MS)
    expect(await ran).toMatchObject({ exitCode: 0 })
    expect(bare.calls).toEqual(["exec", "exec"])
  })

  it("never retries a call that failed for another reason, and passes the rest through", async () => {
    let tries = 0
    const sandbox = bounded({
      readFile: async (_path: string) => {
        tries++
        throw new Error("no such file")
      },
      getState: async () => ({ status: "running" }),
    })
    await expect(sandbox.readFile("/missing")).rejects.toThrow("no such file")
    expect(tries).toBe(1)
    expect(await sandbox.getState()).toEqual({ status: "running" })
  })
})
