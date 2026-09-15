import { describe, expect, it } from "vitest"
import { FacadeError } from "../src/errors.ts"
import {
  bashRefusal,
  guard,
  guardedTools,
  observer,
  pathRefusal,
} from "../src/hooks.ts"

const policy = {
  siteRoot: "/workspace/site",
  readOnlyRoots: ["/opt/astro"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("hook timeouts", () => {
  it("refuses a guard that sleeps past the timeout, fail closed", async () => {
    const started = Date.now()
    await expect(
      guard("pre_tool_call", () => sleep(6_000), 200)
    ).rejects.toMatchObject({
      code: "hook.refused",
      detail: { hook: "pre_tool_call", reason: "timeout" },
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("refuses a guard that throws, and lets a clean guard through", async () => {
    await expect(
      guard("pre_model_call", async () => {
        throw new Error("no")
      })
    ).rejects.toMatchObject({ detail: { reason: "error" } })
    await expect(guard("pre_model_call", async () => 42)).resolves.toBe(42)
  })

  it("lets an observer fail open", async () => {
    await expect(
      observer("post_tool_call", () => sleep(6_000), 100)
    ).resolves.toBeUndefined()
    await expect(observer("post_tool_call", async () => "seen")).resolves.toBe(
      "seen"
    )
  })
})

describe("the pre_tool_call policy", () => {
  it("refuses bash that leaves the site or touches .agents", () => {
    expect(bashRefusal("cat /etc/passwd", policy)).toMatch(/outside the site/)
    expect(bashRefusal("cd .. && ls", policy)).toMatch(/\.\. segment/)
    expect(bashRefusal("cat ../../secret", policy)).toMatch(/\.\. segment/)
    expect(bashRefusal("echo x > .agents/skills/a/SKILL.md", policy)).toMatch(
      /\.agents/
    )
    expect(bashRefusal("cd /workspace/other; ls", policy)).toMatch(
      /outside the site/
    )
    expect(bashRefusal("cd src; cd /workspace/other", policy)).toMatch(
      /outside the site/
    )
  })

  it("allows bash inside the site, the toolchain and the scratch dir", () => {
    expect(bashRefusal("pnpm astro build", policy)).toBeNull()
    expect(
      bashRefusal("ln -s /opt/astro/node_modules node_modules", policy)
    ).toBeNull()
    expect(bashRefusal("ls /workspace/site/src > /tmp/out", policy)).toBeNull()
    expect(
      bashRefusal("git -c user.name=reme commit -m 'x'", policy)
    ).toBeNull()
  })

  it("refuses write and edit paths outside the site", () => {
    const resolve = (p: string) =>
      p.startsWith("/") ? p : `/workspace/site/${p}`
    expect(pathRefusal("src/pages/index.astro", policy, resolve)).toBeNull()
    expect(pathRefusal("/workspace/site/x.ts", policy, resolve)).toBeNull()
    expect(pathRefusal("/workspace/x.ts", policy, resolve)).toMatch(/outside/)
    expect(pathRefusal("../x.ts", policy, resolve)).toMatch(/\.\. segment/)
    expect(pathRefusal(".agents/skills/x/SKILL.md", policy, resolve)).toMatch(
      /\.agents/
    )
  })
})

describe("the guarded tool set", () => {
  const calls: string[] = []
  const sandbox = {
    cwd: "/workspace/site",
    resolvePath: (p: string) =>
      p.startsWith("/") ? p : `/workspace/site/${p}`,
    exec: async (command: string) => {
      calls.push(command)
      return { stdout: "ok", stderr: "", exitCode: 0 }
    },
    readFile: async () => "",
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async (path: string) => {
      calls.push(`write ${path}`)
    },
    stat: async () => ({ isFile: true, isDirectory: false }),
    readdir: async () => [],
    exists: async () => true,
    mkdir: async () => undefined,
    rm: async () => undefined,
  }
  // The adapter is structural; the six tools only touch the verbs above.
  const tools = guardedTools(policy)(sandbox as never, { subagents: {} })
  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name)
    if (!found) throw new Error(`no ${name}`)
    return found
  }

  it("keeps the six tools, in flue's names", () => {
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(["bash", "edit", "glob", "grep", "read", "write"])
    )
  })

  it("refuses a bash call that leaves the site before it runs", async () => {
    await expect(
      tool("bash").execute("call-1", { command: "cat /etc/passwd" })
    ).rejects.toBeInstanceOf(FacadeError)
    expect(calls).not.toContain("cat /etc/passwd")
  })

  it("runs a bash call inside the site", async () => {
    await tool("bash").execute("call-2", { command: "pnpm astro check" })
    expect(calls).toContain("pnpm astro check")
  })

  it("refuses a write outside the site before it writes", async () => {
    await expect(
      tool("write").execute("call-3", {
        path: "/workspace/.agents/skills/x/SKILL.md",
        content: "x",
      })
    ).rejects.toMatchObject({ code: "tool.refused" })
    expect(calls.some((c) => c.startsWith("write /workspace/.agents"))).toBe(
      false
    )
  })
})
