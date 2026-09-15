import { describe, expect, it } from "vitest"
import { FacadeError } from "../src/errors.ts"
import {
  bashRefusal,
  boundResult,
  createTurnGate,
  guard,
  guardedTools,
  observer,
  pathRefusal,
  TOOL_RESULT_MAX_CHARS,
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
  const files: Record<string, string> = {
    "/workspace/site/src/site-config.ts":
      'export const site = {\n  name: "",\n  phone: "",\n}\n',
  }
  let stdout = "ok"
  const sandbox = {
    cwd: "/workspace/site",
    resolvePath: (p: string) =>
      p.startsWith("/") ? p : `/workspace/site/${p}`,
    exec: async (command: string) => {
      calls.push(command)
      return { stdout, stderr: "", exitCode: 0 }
    },
    readFile: async (p: string) =>
      files[p.startsWith("/") ? p : `/workspace/site/${p}`] ?? "",
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async (p: string, content: string) => {
      calls.push(`write ${p}`)
      files[p.startsWith("/") ? p : `/workspace/site/${p}`] = content
    },
    stat: async () => ({ isFile: true, isDirectory: false }),
    readdir: async () => [],
    exists: async () => true,
    mkdir: async () => undefined,
    rm: async () => undefined,
  }
  const build = () =>
    // The adapter is structural; the tools only touch the verbs above.
    guardedTools(policy, { git: "git" })(sandbox as never, {
      subagents: {},
    })
  const tools = build()
  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name)
    if (!found) throw new Error(`no ${name}`)
    return found
  }
  const text = (result: unknown) =>
    (result as { content: { text: string }[] }).content
      .map((c) => c.text)
      .join("")

  it("mounts flue's five tools, one edit and checkpoint, and runs every mutation in order", () => {
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(["bash", "checkpoint", "edit", "glob", "grep", "read", "write"])
    )
    for (const name of ["bash", "checkpoint", "edit", "write"]) {
      expect(tool(name).executionMode).toBe("sequential")
    }
    for (const name of ["glob", "grep", "read"]) {
      expect(tool(name).executionMode).toBeUndefined()
    }
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

  it("refuses a write or an edit outside the site before it touches a file", async () => {
    await expect(
      tool("write").execute("call-3", {
        path: "/workspace/.agents/skills/x/SKILL.md",
        content: "x",
      })
    ).rejects.toMatchObject({ code: "tool.refused" })
    await expect(
      tool("edit").execute("call-4", {
        path: "/workspace/other.ts",
        edits: [{ oldText: "a", newText: "b" }],
      })
    ).rejects.toMatchObject({ code: "tool.refused" })
    expect(calls.some((c) => c.startsWith("write /workspace/.agents"))).toBe(
      false
    )
  })

  it("applies a batch edit in one call and answers in Pi's words", async () => {
    const result = await tool("edit").execute("call-5", {
      path: "src/site-config.ts",
      edits: [
        { oldText: '  name: "",', newText: '  name: "Brightclean",' },
        { oldText: '  phone: "",', newText: '  phone: "+441632960000",' },
      ],
    })
    expect(text(result)).toBe(
      "Successfully replaced 2 block(s) in src/site-config.ts."
    )
    expect(files["/workspace/site/src/site-config.ts"]).toContain(
      '"+441632960000"'
    )
  })

  it("returns Pi's message for a missing anchor and writes nothing", async () => {
    const before = files["/workspace/site/src/site-config.ts"]
    await expect(
      tool("edit").execute("call-6", {
        path: "src/site-config.ts",
        edits: [
          { oldText: '  name: "Brightclean",', newText: "x" },
          { oldText: "  email: '',", newText: "y" },
        ],
      })
    ).rejects.toThrow(
      "Could not find edits[1] in src/site-config.ts. The oldText must match exactly including all whitespace and newlines."
    )
    expect(files["/workspace/site/src/site-config.ts"]).toBe(before)
  })

  it("checkpoints with a commit message that cannot leave its quotes", async () => {
    stdout = "abc1234"
    const result = await tool("checkpoint").execute("call-7", {
      summary: 'fill "phone" $(rm -rf /) `x`',
    })
    const commit = calls.at(-1) ?? ""
    expect(commit).toContain("git add -A")
    expect(commit).not.toMatch(/\$\(|`|fill "/)
    expect(text(result)).toContain("abc1234")
    stdout = "ok"
  })

  it("bounds a huge bash result before the model or the log sees it", async () => {
    stdout = "y".repeat(TOOL_RESULT_MAX_CHARS * 3)
    const result = await tool("bash").execute("call-8", { command: "ls" })
    expect(text(result).length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 400)
    stdout = "ok"
  })
})

describe("tool result bounds", () => {
  const long = (s: string) => ({
    content: [{ type: "text" as const, text: s }],
    details: {},
  })
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? "").join("")

  it("cuts a read at the head and says how to read on", () => {
    const out = text(
      boundResult("read", long("a".repeat(TOOL_RESULT_MAX_CHARS * 2)))
    )
    expect(out.startsWith("a".repeat(100))).toBe(true)
    expect(out).toMatch(/offset/)
    expect(out.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 400)
  })

  it("keeps the tail of bash and says where to put the rest", () => {
    const out = text(
      boundResult(
        "bash",
        long(
          `${"a".repeat(TOOL_RESULT_MAX_CHARS)}${"b".repeat(TOOL_RESULT_MAX_CHARS)}`
        )
      )
    )
    expect(out).toContain("b".repeat(100))
    expect(out).not.toContain("a".repeat(100))
    expect(out).toMatch(/\/tmp/)
  })

  it("says when glob stopped at flue's thousand, which flue does silently", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `src/f${i}.ts`).join(
      "\n"
    )
    expect(text(boundResult("glob", long(lines)))).toMatch(/first 1000/)
  })

  it("leaves a short result alone", () => {
    const r = long("small")
    expect(boundResult("grep", r)).toEqual(r)
  })
})

describe("the turn gate", () => {
  const ctx = {} as never
  const op = (toolName: string) => ({
    type: "tool" as const,
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
  })
  const done =
    (value = "ran") =>
    async () =>
      value

  it("refuses flue's task tool, so no subagent runs", async () => {
    const gate = createTurnGate()
    await expect(
      gate.interceptor(op("task"), ctx, done())
    ).rejects.toMatchObject({ code: "tool.refused" })
  })

  it("lets one terminal tool through and only reads after it", async () => {
    const gate = createTurnGate()
    let release: (v: string) => void = () => undefined
    const first = gate.interceptor(
      op("report_complete"),
      ctx,
      () =>
        new Promise<string>((r) => {
          release = r
        })
    )
    await expect(
      gate.interceptor(op("ask_chief"), ctx, done())
    ).rejects.toMatchObject({ code: "turn.over" })
    await expect(
      gate.interceptor(op("edit"), ctx, done())
    ).rejects.toMatchObject({ code: "turn.over" })
    await expect(gate.interceptor(op("read"), ctx, done("read"))).resolves.toBe(
      "read"
    )
    release("uploaded")
    await expect(first).resolves.toBe("uploaded")
    await expect(
      gate.interceptor(op("bash"), ctx, done())
    ).rejects.toMatchObject({ code: "turn.over" })
    gate.open()
    await expect(gate.interceptor(op("bash"), ctx, done())).resolves.toBe("ran")
  })

  it("reopens when the terminal tool fails, so the model can fix the build", async () => {
    const gate = createTurnGate()
    await expect(
      gate.interceptor(op("report_complete"), ctx, async () => {
        throw new Error("astro build failed")
      })
    ).rejects.toThrow("astro build failed")
    await expect(gate.interceptor(op("edit"), ctx, done())).resolves.toBe("ran")
  })

  it("passes model calls through untouched", async () => {
    const gate = createTurnGate()
    await gate.interceptor(op("report_complete"), ctx, done())
    await expect(
      gate.interceptor({ type: "model", turnId: "t" }, ctx, done("model"))
    ).resolves.toBe("model")
  })
})
