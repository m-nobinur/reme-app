import { Blueprint } from "@workspace/contracts"
import { appendEvent, assignments, eq } from "@workspace/db"
import { describe, expect, it, vi } from "vitest"
import { freshOrg, kit } from "./fixture.ts"

vi.mock("../src/sandbox.ts", () => ({
  workKey: (ids: { assignmentId: string }) => `work/${ids.assignmentId}`,
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))

const { insertAssignment } = await import("../src/app.ts")
const { fallbackBlueprint } = await import("../src/planner.ts")
const { makePhotos } = await import("../src/photo-step.ts")

const PNG = btoa("not really a png")

/** An OpenRouter that draws every image it is asked for, counting the draws. */
function openrouter() {
  const drawn: string[] = []
  const fetcher = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    const messages = body.messages as { content: unknown }[] | undefined
    if (url.endsWith("/chat/completions")) {
      const text =
        messages && typeof messages[1]?.content !== "string"
          ? {
              geometry: 0,
              text: 0,
              anatomy: 0,
              clutter: 0,
              grade: 0,
              texture: 0,
              subject: 0,
              style: 0,
              note: "",
            }
          : { style: "Soft light.", subjects: {} }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(text) } }],
        usage: { cost: 0.0005 },
      })
    }
    drawn.push(String(body.prompt))
    return Response.json({
      data: [{ b64_json: PNG, media_type: "image/png" }],
      usage: { cost: 0.03 },
    })
  }) as unknown as typeof fetch
  return { drawn, fetcher }
}

function bucket(keys: string[]) {
  const objects = new Map<string, Uint8Array>(
    keys.map((k) => [k, new Uint8Array([1])])
  )
  return {
    objects,
    get: async (key: string) => {
      const bytes = objects.get(key)
      return bytes
        ? { arrayBuffer: async () => bytes.buffer as ArrayBuffer }
        : null
    },
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes)
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, uploaded: new Date() })),
      truncated: false,
    }),
  }
}

describe("the photo step on a retry", () => {
  it("places the photos the failed build drew and draws only the slots it did not", async () => {
    const orgId = await freshOrg(kit)
    const base = fallbackBlueprint({ facts: [], recent: [] })
    const first = base.images.find((s) => s.source === "generated")
    if (!first) throw new Error("the fallback plan draws nothing")
    const plan = {
      ...base,
      images: [
        first,
        { ...first, id: "service_1_card", section: "service_cards" },
        { ...first, id: "service_2_card", section: "service_cards" },
      ],
    } as Blueprint
    const slots = plan.images
    expect(plan.images.every((s) => s.source === "generated")).toBe(true)
    const [done, ...rest] = slots
    const key = `generated/${orgId}/${crypto.randomUUID()}.png`
    const created = async (retryOf: string | null, name: string) =>
      kit.withOrg({ orgId }, async (db) => {
        const made = await insertAssignment(db, orgId, name, true, {
          kind: "site.build",
          goal: "Build the site from the canonical facts.",
          model: "A",
          withhold: [],
          lane: "full",
          change_kind: null,
          ...(retryOf
            ? { retry_of: { assignment_id: retryOf, blueprint: plan } }
            : {}),
        })
        if (!("row" in made)) throw new Error("not created")
        await db
          .update(assignments)
          .set({ blueprint: plan })
          .where(eq(assignments.id, made.row.id))
        return made.row.id
      })
    const failed = await created(null, "first")
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: failed,
        staffId: null,
        type: "build.progress",
        payload: {
          stage: "photos",
          item: done?.id,
          total: slots.length,
          status: "generated",
          asset_id: crypto.randomUUID(),
          key,
          content_type: "image/png",
        },
      })
    )
    const retry = await created(failed, "second")
    const sites = bucket([key])
    const { drawn, fetcher } = openrouter()

    const step = await makePhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: sites },
      kit,
      ids: { orgId, assignmentId: retry },
      fetch: fetcher,
    })

    expect(drawn).toHaveLength(rest.length)
    expect(step.files.find((f) => f.slot_id === done?.id)).toMatchObject({
      status: "reused",
      key,
    })
    expect(step.generated).toBe(slots.length)
    expect(Blueprint.safeParse(plan).success).toBe(true)
  })
})
