import { describe, expect, it, vi } from "vitest"

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))

const { pickLane } = await import("../src/quick.ts")
const { pickSlot, regenerateSlot, SLOT_DAILY_CAP } = await import(
  "../src/photo-quick.ts"
)

const ORG = "10000001-0000-4000-8000-000000000000"
const slot = (id: string, section: string) => ({
  id,
  page: "home",
  section,
  aspect: "4:3",
  resolution: "1K",
  subject: `a sunlit ${id}`,
  alt: `The ${id}`,
  source: "generated",
  asset_id: "20000001-0000-4000-8000-000000000000",
})
const SLOTS = [slot("hero_room", "hero"), slot("kitchen", "service_cards")]
const BRIEF = { industry: "cleaning", imageStyle: "airy", palette: "sage" }

/** A kit whose first read is the photos event and whose second is the day's tries. */
const kit = (payload: unknown, tries: number) => {
  const answers = [[{ payload }], [{ n: String(tries) }]]
  return { withOrg: async () => answers.shift() } as never
}

const bucket = () => {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    get: async (key: string) => {
      const b = objects.get(key)
      return b ? { arrayBuffer: async () => b.buffer as ArrayBuffer } : null
    },
    put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, uploaded: new Date() })),
      truncated: false,
    }),
  }
}

const fetcher = (async (url: string) =>
  url.endsWith("/chat/completions")
    ? new Response("down", { status: 503 })
    : Response.json({
        data: [{ b64_json: btoa("png"), media_type: "image/png" }],
      })) as unknown as typeof fetch

const disk = (files: string[]) => {
  const written: string[] = []
  return {
    written,
    exec: async (command: string) => ({
      exitCode: 0,
      stdout: command.startsWith("ls") ? files.join("\n") : "",
      stderr: "",
    }),
    writeFile: async (path: string) => void written.push(path),
  }
}

const run = (
  goal: string,
  tries: number,
  files: string[],
  sites = bucket()
) => {
  const sandbox = disk(files)
  return {
    sandbox,
    sites,
    done: regenerateSlot({
      env: { OPENROUTER_API_KEY: "k", SITES: sites },
      kit: kit({ slots: SLOTS, brief: BRIEF, regenerated: null }, tries),
      sandbox,
      orgId: ORG,
      assignmentId: "30000001-0000-4000-8000-000000000000",
      goal,
      fetch: fetcher,
    }),
  }
}

describe("pickLane", () => {
  it("runs photo on the quick lane now", () => {
    expect(pickLane("site.revise", "photo").lane).toBe("quick")
    expect(pickLane("site.build", "photo").lane).toBe("full")
  })
})

describe("pickSlot", () => {
  it("takes the slot the words name by id, then by section, and nothing ambiguous", () => {
    const slots = SLOTS as never
    expect(pickSlot(slots, "Try another photo for kitchen")?.id).toBe("kitchen")
    expect(pickSlot(slots, "new hero photo please")?.id).toBe("hero_room")
    expect(pickSlot(slots, "change the photos")).toBeNull()
    expect(pickSlot([SLOTS[1]] as never, "another one")?.id).toBe("kitchen")
  })
})

describe("regenerateSlot", () => {
  it("draws a new picture over the old file and moves the slot to the new asset", async () => {
    const { done, sandbox } = run("Try another photo for kitchen", 0, [
      "kitchen.png",
    ])
    const out = await done
    expect(sandbox.written).toEqual([
      "/workspace/site/src/assets/generated/kitchen.png",
    ])
    expect(out.path).toBe("src/assets/generated/kitchen.png")
    expect(out.photos.regenerated).toBe("kitchen")
    const next = out.photos.slots.find((s) => s.id === "kitchen")
    expect(next?.asset_id).not.toBe(SLOTS[1].asset_id)
  })

  it("stops at the daily cap without drawing", async () => {
    const { done, sites } = run("kitchen", SLOT_DAILY_CAP, ["kitchen.png"])
    await expect(done).rejects.toThrow("slot cap")
    expect(sites.objects.size).toBe(0)
  })

  it("falls through when the file type would change or the slot has no file", async () => {
    await expect(run("kitchen", 0, ["kitchen.jpg"]).done).rejects.toThrow(
      "another file type"
    )
    await expect(run("kitchen", 0, []).done).rejects.toThrow("no file on disk")
  })
})
