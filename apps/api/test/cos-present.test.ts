import { COS_TOOLS } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  activeTools,
  cosPrefix,
  DESCRIPTIONS,
  INSTRUCTIONS,
  savedWithReply,
} from "../src/cos/agent.ts"

const OWNER_SET = ["Card", "Fact", "Table", "Steps", "Checklist", "Text"]

const presented = (text: string, more: string[] = []) => ({
  text,
  toolCalls: [
    { toolName: "present" },
    ...more.map((toolName) => ({ toolName })),
  ],
  toolResults: [
    { output: { outcome: "presented" } },
    ...more.map(() => ({ output: { outcome: "saved" } })),
  ],
})

describe("present", () => {
  it("sends a schema that names only the owner's components", async () => {
    const { tools } = await cosPrefix()
    const schema = tools.find((t) => t.name === "present")?.input_schema as {
      properties: { _type: { enum: string[] } } & Record<string, unknown>
      $defs: { node: { properties: Record<string, unknown> } }
    }
    expect(schema.properties._type.enum).toEqual(OWNER_SET)
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "_key",
        "_type",
        "children",
        "columns",
        "items",
        "label",
        "rows",
        "steps",
        "text",
        "title",
        "value",
      ].sort()
    )
    // No action, form, image or link prop can reach the chat.
    expect(JSON.stringify(schema)).not.toMatch(/_action|src|href|html|asForm/i)
    expect(schema.$defs.node.properties).toEqual(schema.properties)
  })

  it("checks a call's tree only for its type and size", () => {
    const input = COS_TOOLS.present.input
    expect(input.safeParse({ _type: "Card", children: [] }).success).toBe(true)
    expect(input.safeParse({ title: "no type" }).success).toBe(false)
    expect(
      input.safeParse({ _type: "Text", text: "x".repeat(8_001) }).success
    ).toBe(false)
  })

  it("is offered on the owner's turns in both modes, never on an unasked one", () => {
    expect(activeTools("ask")).toContain("present")
    expect(activeTools("act")).toContain("present")
    expect(activeTools("act", true)).not.toContain("present")
  })

  it("ends the turn on a step that presented beside its words", () => {
    expect(savedWithReply(presented("Here's how they compare."))).toBe(true)
    expect(savedWithReply(presented("Noted.", ["memory"]))).toBe(true)
    // With no words yet, the next step writes them.
    expect(savedWithReply(presented(""))).toBe(false)
    // A read beside it still needs a step to answer from.
    expect(
      savedWithReply({
        text: "Let me check.",
        toolCalls: [{ toolName: "present" }, { toolName: "get_facts" }],
        toolResults: [
          { output: { outcome: "presented" } },
          { output: { business: {} } },
        ],
      })
    ).toBe(false)
  })

  it("says in the core when to present rather than write", () => {
    expect(INSTRUCTIONS).toMatch(
      /compare options, or for steps or a checklist[^\n]*show it with present: it reads at a glance on a phone/
    )
    expect(DESCRIPTIONS.present).toMatch(/Write your line first/)
  })
})
