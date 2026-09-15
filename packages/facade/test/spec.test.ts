import { describe, expect, it } from "vitest"
import { canonical, canonicalHash } from "../src/canonical.ts"
import { FacadeError } from "../src/errors.ts"
import {
  loggableSpec,
  modelRouting,
  resolveRuntime,
  signSpec,
  type UnsignedSpec,
  verifySpec,
} from "../src/spec.ts"

const KEY = "0123456789abcdef0123456789abcdef"
const uuid = (n: number) =>
  `10000001-0000-4000-8000-${String(n).padStart(12, "0")}`

const unsigned = (expiresAt = "2099-01-01T00:00:00.000Z"): UnsignedSpec => ({
  spec_id: uuid(1),
  org_id: uuid(2),
  staff_id: uuid(3),
  session_id: uuid(4),
  profile: "builder",
  model_routing: modelRouting({}, "A"),
  tool_manifest: ["site.edit", "site.checkpoint"],
  skill_refs: [],
  hook_set: ["pre_tool_call", "post_tool_call"],
  memory_namespaces: { read: ["org:x"], write: [] },
  context_policy: {
    max_input_tokens: 200_000,
    compaction_threshold_tokens: 150_000,
    include_fact_snapshot: true,
  },
  budget_snapshot: {
    model_usd_cap: 1,
    model_usd_spent: 0,
    tool_usd_cap: 0,
    tool_usd_spent: 0,
    period_ends_at: expiresAt,
  },
  sandbox_class: "standard-2",
  egress_allowlist: ["registry.npmjs.org"],
  supervisor_ref: null,
  issued_at: "2026-09-15T00:00:00.000Z",
  expires_at: expiresAt,
})

describe("canonical", () => {
  it("is key-order independent and drops undefined", () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(
      canonical({ a: [2, { c: undefined, d: 3 }], b: 1 })
    )
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it("hashes the same value the same way twice", async () => {
    expect(await canonicalHash({ x: 1 })).toBe(await canonicalHash({ x: 1 }))
    expect(await canonicalHash({ x: 1 })).not.toBe(
      await canonicalHash({ x: 2 })
    )
  })
})

describe("the runtime spec", () => {
  it("signs and verifies, and the log copy carries no signature", async () => {
    const spec = await signSpec(unsigned(), KEY)
    expect(spec.signature).toMatch(/^[0-9a-f]{64}$/)
    await expect(verifySpec(spec, KEY)).resolves.toMatchObject({
      spec_id: uuid(1),
    })
    expect("signature" in loggableSpec(spec)).toBe(false)
  })

  it("refuses a widened spec: one changed field breaks the signature", async () => {
    const spec = await signSpec(unsigned(), KEY)
    const widened = {
      ...spec,
      tool_manifest: [...spec.tool_manifest, "site.publish"],
    }
    await expect(verifySpec(widened, KEY)).rejects.toMatchObject({
      code: "spec.signature_invalid",
      errorClass: "security",
    })
  })

  it("refuses a spec signed with another key, and a spec past its expiry", async () => {
    const spec = await signSpec(unsigned(), KEY)
    await expect(verifySpec(spec, "another-key")).rejects.toMatchObject({
      code: "spec.signature_invalid",
    })
    const stale = await signSpec(unsigned("2026-01-01T00:00:00.000Z"), KEY)
    await expect(verifySpec(stale, KEY)).rejects.toMatchObject({
      code: "spec.expired",
      errorClass: "permission",
    })
  })

  it("refuses a malformed spec before looking at the signature", async () => {
    await expect(verifySpec({ nope: true }, KEY)).rejects.toBeInstanceOf(
      FacadeError
    )
    await expect(verifySpec({ nope: true }, KEY)).rejects.toMatchObject({
      code: "spec.malformed",
    })
    await expect(verifySpec(unsigned(), "")).rejects.toMatchObject({
      code: "spec.key_missing",
    })
  })

  it("resolves to a frozen hook set with the routing the spec carries", async () => {
    const spec = await signSpec(unsigned(), KEY)
    const runtime = await resolveRuntime(spec, KEY)
    expect(runtime.model).toBe("openrouter/deepseek/deepseek-v4.1-flash")
    expect(runtime.fallback).toBe("openrouter/x-ai/grok-4.6")
    expect(runtime.tools).toEqual(["site.edit", "site.checkpoint"])
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.isFrozen(runtime.tools)).toBe(true)
  })
})

describe("the routing table", () => {
  it("reads its defaults from the environment and B from the fixed pair", () => {
    expect(modelRouting({}, "A").implement?.model).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash"
    )
    expect(modelRouting({}, "B").implement?.model).toBe(
      "openrouter/z-ai/glm-5.3-flash"
    )
    const routing = modelRouting(
      {
        REME_MODEL_DEFAULT: "openrouter/some/thing",
        REME_MODEL_FALLBACK: "openrouter/other/thing",
      },
      "A"
    )
    expect(routing.plan?.model).toBe("openrouter/some/thing")
    expect(routing.compaction?.model).toBe("openrouter/some/thing")
    expect(routing.fallback?.model).toBe("openrouter/other/thing")
  })
})
