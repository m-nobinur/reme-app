import { describe, expect, it } from "vitest"
import { canonical, canonicalHash } from "../src/canonical.ts"
import { FacadeError } from "../src/errors.ts"
import { TOOL_RESULT_MAX_CHARS } from "../src/hooks.ts"
import {
  loggableSpec,
  modelRouting,
  ROLES,
  type Role,
  resolveRuntime,
  roleOf,
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

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(FacadeError)
    return error as FacadeError
  }
  throw new Error("did not throw")
}

describe("canonical", () => {
  it("is key-order independent and drops undefined", () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(
      canonical({ a: [2, { c: undefined, d: 3 }], b: 1 })
    )
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it("hashes the same value the same way twice", () => {
    expect(canonicalHash({ x: 1 })).toBe(canonicalHash({ x: 1 }))
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }))
  })
})

describe("the runtime spec", () => {
  it("signs and verifies, and the log copy carries no signature", () => {
    const spec = signSpec(unsigned(), KEY)
    expect(spec.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(verifySpec(spec, KEY)).toMatchObject({ spec_id: uuid(1) })
    expect("signature" in loggableSpec(spec)).toBe(false)
  })

  it("refuses a widened spec: one changed field breaks the signature", () => {
    const spec = signSpec(unsigned(), KEY)
    const widened = {
      ...spec,
      tool_manifest: [...spec.tool_manifest, "site.publish"],
    }
    expect(refusal(() => verifySpec(widened, KEY))).toMatchObject({
      code: "spec.signature_invalid",
      errorClass: "security",
    })
  })

  it("refuses a spec signed with another key, and a spec past its expiry", () => {
    const spec = signSpec(unsigned(), KEY)
    expect(refusal(() => verifySpec(spec, "another-key")).code).toBe(
      "spec.signature_invalid"
    )
    const stale = signSpec(unsigned("2026-01-01T00:00:00.000Z"), KEY)
    expect(refusal(() => verifySpec(stale, KEY))).toMatchObject({
      code: "spec.expired",
      errorClass: "permission",
    })
  })

  it("refuses a malformed spec before looking at the signature", () => {
    expect(refusal(() => verifySpec({ nope: true }, KEY)).code).toBe(
      "spec.malformed"
    )
    expect(refusal(() => verifySpec(unsigned(), "")).code).toBe(
      "spec.key_missing"
    )
  })

  it("resolves to a frozen hook set with the routing the spec carries", () => {
    const spec = signSpec(unsigned(), KEY)
    const runtime = resolveRuntime(spec, KEY)
    expect(runtime.model).toBe("openrouter/anthropic/claude-sonnet-5.5")
    expect(runtime.fallback).toBe("openrouter/x-ai/grok-4.6")
    expect(runtime.tools).toEqual(["site.edit", "site.checkpoint"])
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.isFrozen(runtime.tools)).toBe(true)
  })
})

describe("the roles", () => {
  it("are all read from an issued spec, each at the table's model, effort and cap", () => {
    const spec = signSpec(unsigned(), KEY)
    const got = Object.fromEntries(
      (Object.keys(ROLES) as Role[]).map((r) => [r, roleOf(spec, r)])
    )
    const sonnet = "openrouter/anthropic/claude-sonnet-5.5"
    const haiku = "openrouter/anthropic/claude-haiku-5.5"
    expect(got).toEqual({
      plan: { model: sonnet, effort: "high", maxTokens: 32_000 },
      build: { model: sonnet, effort: "medium", maxTokens: 32_000 },
      page: { model: sonnet, effort: "medium", maxTokens: 16_000 },
      copy: { model: haiku, effort: "low", maxTokens: 8_000 },
      critic: { model: sonnet, effort: "medium", maxTokens: 4_000 },
      quick_copy: { model: haiku, effort: "low", maxTokens: 4_000 },
      quick_section: { model: sonnet, effort: "low", maxTokens: 16_000 },
    })
    expect(resolveRuntime(spec, KEY).effort).toBe("medium")
  })

  it("refuse a spec that does not route one", () => {
    const { page: _page, ...rest } = modelRouting({}, "A")
    const spec = signSpec({ ...unsigned(), model_routing: rest }, KEY)
    expect(refusal(() => roleOf(spec, "page")).code).toBe("spec.no_route")
  })
})

describe("the routing table", () => {
  it("reads its defaults from the environment and B from the fixed pair", () => {
    expect(modelRouting({}, "A").build?.model).toBe(
      "openrouter/anthropic/claude-sonnet-5.5"
    )
    expect(modelRouting({}, "B").build?.model).toBe(
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
    expect(routing.page?.model).toBe("openrouter/some/thing")
    expect(routing.fallback?.model).toBe("openrouter/other/thing")
  })
})

describe("the tool result bound", () => {
  it("stays under a tenth of the context policy, at a pessimistic 3 characters a token", () => {
    expect(TOOL_RESULT_MAX_CHARS / 3).toBeLessThanOrEqual(
      unsigned().context_policy.max_input_tokens / 10
    )
  })
})
