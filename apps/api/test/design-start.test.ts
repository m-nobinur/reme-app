import {
  FONT_PAIRS,
  type FontPairId,
  LOGO_STYLES,
  LOGO_TYPES,
  type LogoStyle,
  LogoSuggestion,
  type LogoType,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  businessOf,
  DESIGN_QUESTIONS,
  type DesignStart,
  directionsFrom,
  pairsFrom,
  startFrom,
  suits,
  TABLE,
} from "../src/design-start.ts"
import { JEV } from "../src/jev.ts"

const flat = <T extends string>(list: readonly T[], at: number) =>
  Object.fromEntries(list.map((id) => [id, at])) as Record<T, number>

/** Jev's measured scores for Pruning Co, a tree surgeon in Leeds, on 2026-11-04. */
const PRUNING_TYPES: Record<LogoType, number> = {
  lockup: 2.81,
  icon: 2.39,
  wordmark: 0.94,
  monogram: 0.2,
  emblem: 1.46,
  abstract: 0.56,
}
const PRUNING_STYLES: Record<LogoStyle, number> = {
  minimal: 0.8,
  geometric: 1.17,
  gradient: 0.09,
  mascot: 0.26,
  hand_drawn: 2.8,
  luxury: 0.15,
  retro: 2.03,
  three_d: 0.17,
}

/** A start obeys the rules whatever made it. */
function holds(start: DesignStart) {
  expect(
    LogoSuggestion.shape.directions.safeParse(start.directions).success
  ).toBe(true)
  expect(start.directions.map((d) => d.type)).toContain("lockup")
  expect(new Set(start.directions.map((d) => d.style)).size).toBe(3)
  for (const d of start.directions) expect(suits(d.type, d.style)).toBe(true)
  const moods = start.fonts.map(
    (id) => FONT_PAIRS.find((pair) => pair.id === id)?.mood
  )
  expect(start.fonts).toHaveLength(4)
  expect(new Set(moods).size).toBe(4)
}

describe("the directions", () => {
  it("gives a tree surgeon its best types, lockup among them, each in a style that suits it", () => {
    expect(directionsFrom(PRUNING_TYPES, PRUNING_STYLES)).toEqual([
      { type: "lockup", style: "hand_drawn" },
      { type: "icon", style: "geometric" },
      // Retro is the emblem's own, so it goes there, not to the icon.
      { type: "emblem", style: "retro" },
    ])
  })

  it("always offers the safe lockup, even when it scores last", () => {
    const types = { ...flat(LOGO_TYPES, 2), lockup: 0 }
    expect(directionsFrom(types, PRUNING_STYLES).map((d) => d.type)).toContain(
      "lockup"
    )
  })

  it("offers abstract only when it leads every other type by a level", () => {
    const close = { ...flat(LOGO_TYPES, 1), abstract: 1.9 }
    expect(
      directionsFrom(close, PRUNING_STYLES).map((d) => d.type)
    ).not.toContain("abstract")
    const far = { ...flat(LOGO_TYPES, 1), abstract: 2.1 }
    expect(directionsFrom(far, PRUNING_STYLES).map((d) => d.type)).toContain(
      "abstract"
    )
  })

  it("never puts a mascot on a wordmark or monogram", () => {
    const types = {
      ...flat(LOGO_TYPES, 0),
      wordmark: 3,
      monogram: 2.9,
      lockup: 1,
    }
    const styles = { ...flat(LOGO_STYLES, 0), mascot: 3 }
    const picked = directionsFrom(types, styles)
    expect(picked.find((d) => d.style === "mascot")?.type).toBe("lockup")
  })
})

describe("the font pairs", () => {
  it("takes the best pair of each of the four best moods", () => {
    const fits = Object.fromEntries(
      FONT_PAIRS.map((pair, at) => [pair.id, at])
    ) as Record<FontPairId, number>
    const picked = pairsFrom(fits)
    expect(picked).toHaveLength(4)
    const moods = picked.map((id) => FONT_PAIRS.find((p) => p.id === id)?.mood)
    expect(new Set(moods).size).toBe(4)
    // The highest score leads.
    expect(picked[0]).toBe(FONT_PAIRS.at(-1)?.id)
  })
})

describe("a start from Jev's answers", () => {
  const answers = (confidence: number) =>
    Object.fromEntries(
      Object.keys(DESIGN_QUESTIONS).map((id, at) => [
        id,
        { score: (at * 7) % 4, confidence },
      ])
    )

  it("asks one score per type, style and font pair", () => {
    expect(Object.keys(DESIGN_QUESTIONS)).toHaveLength(
      LOGO_TYPES.length + LOGO_STYLES.length + FONT_PAIRS.length
    )
  })

  it("is made when every answer came and they are sure enough, under the rules", () => {
    const start = startFrom(answers(0.6))
    expect(start).not.toBeNull()
    holds(start as DesignStart)
  })

  it("is left to the table when unsure or an answer is missing", () => {
    expect(startFrom(answers(0.1))).toBeNull()
    const { type_icon: _, ...missing } = answers(0.6)
    expect(startFrom(missing)).toBeNull()
  })
})

describe("the table", () => {
  it("gives every industry a start under the same rules", () => {
    for (const start of Object.values(TABLE)) holds(start)
  })
})

describe("the business as Jev reads it", () => {
  it("counts the name's words and letters for the long-name signals", () => {
    const facts = [
      { key: "business.name", value: { name: "Pruning Co" } },
      {
        key: "business.industry",
        value: { name: "Tree surgery", category: "trades" },
      },
      { key: "business.offerings", value: { items: ["Felling"] } },
    ] as never
    expect(businessOf(facts, "")).toMatchObject({
      category: "trades",
      state: {
        business_name: "Pruning Co",
        name_length: "2 words, 9 letters",
        customers: "not given",
      },
    })
    expect(businessOf([], "Pruning Co")).toBeNull()
  })

  it("keeps the fixed questions first and the facts last in the request", async () => {
    let body = ""
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = String(init.body)
      return Response.json({ answers: {} })
    }) as unknown as typeof fetch
    const { jevDesign } = await import("../src/design-start.ts")
    await jevDesign("key", { business_name: "Pruning Co" }, fetchImpl)
    expect(body.indexOf('"questions"')).toBeLessThan(body.indexOf('"state"'))
    expect(JSON.parse(body).model).toBe(JEV.model)
  })
})
