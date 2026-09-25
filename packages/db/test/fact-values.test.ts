import { FactValue } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { GOLDEN_ORGS } from "../fixtures/golden.ts"

/**
 * The owner's fact form writes `FactValue`, and the builder, the gates and the
 * mock UI read the golden facts. If the two disagree on a value's shape, an
 * owner-entered fact renders differently from a seeded one. Every golden fact
 * of a key `FactValue` knows has to parse as one, superseded versions
 * included, since those are values an owner once stated.
 */
const keys = new Set<string>(FactValue.options.map((o) => o.shape.key.value))
const golden = GOLDEN_ORGS.flatMap((org) =>
  org.facts
    .filter((f) => keys.has(f.key))
    .map((f) => [`${org.slug} ${f.key} v${f.version ?? 1}`, f] as const)
)

describe("golden facts as FactValue", () => {
  it("finds every one of them", () => {
    // Pinned, so a filter that matches nothing cannot pass by parsing nothing.
    expect(golden).toHaveLength(11)
  })

  it.each(golden)("%s parses", (_name, fact) => {
    expect(FactValue.parse({ key: fact.key, value: fact.value })).toEqual({
      key: fact.key,
      value: fact.value,
    })
  })
})
