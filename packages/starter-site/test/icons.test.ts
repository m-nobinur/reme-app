import { describe, expect, test } from "vitest"
import { ICONS, iconFindings, iconFor, iconPath } from "../src/icons"

describe("the icon set", () => {
  test("holds phosphor path data, one key per icon", () => {
    const entries = Object.entries(ICONS)
    expect(entries.length).toBeGreaterThanOrEqual(90)
    for (const [name, d] of entries) {
      expect(d, name).toMatch(/^M[\d.,\s\-MLHVCSQTAZmlhvcsqtaz]+$/)
    }
    // Each path is drawn once: a copy under a second key is a wasted name.
    expect(new Set(Object.values(ICONS)).size).toBe(entries.length)
  })

  test("covers the trades a site may be for", () => {
    for (const name of [
      "calendar",
      "checkCircle",
      "shieldCheck",
      "clock",
      "mapPin",
      "phone",
      "chatCircle",
      "star",
      "sparkle",
      "ruler",
      "wrench",
      "paintBrush",
      "tree",
      "flower",
      "truck",
      "users",
      "handshake",
      "heart",
      "medal",
    ])
      expect(iconPath(name), name).toBeTypeOf("string")
  })
})

describe("iconFor", () => {
  test("keeps a name the set holds", () => {
    expect(iconFor("key", "Fully insured")).toBe("key")
  })

  test("reads an empty or unknown name from the item's words", () => {
    expect(iconFor("", "Fully insured and bonded")).toBe("shieldCheck")
    expect(iconFor("rocket", "Trading since 2009")).toBe("calendarCheck")
    expect(iconFor("", "Lawn care and hedge trimming")).toBe("plant")
    expect(iconFor("", "Airport transfers")).toBe("airplaneTakeoff")
    expect(iconFor("", "Wills and probate")).toBe("fileText")
    expect(iconFor("", "Something nothing names")).toBe("checkCircle")
  })

  test("does not match a short word inside a longer one", () => {
    expect(iconFor("", "Letter boxes polished")).toBe("sparkle")
    expect(iconFor("", "Careful with antiques")).not.toBe("carProfile")
  })

  test("passes over an icon the section already shows", () => {
    const taken = new Set(["users", "broom"])
    expect(iconFor("", "Our own employed cleaners", "checkCircle", taken)).toBe(
      "checkCircle"
    )
    expect(
      iconFor("", "Fully insured", "checkCircle", new Set(["shieldCheck"]))
    ).toBe("checkCircle")
  })
})

describe("iconFindings", () => {
  test("names each icon field that is not in the set, and nothing else", () => {
    expect(
      iconFindings({
        service1Icon: "house",
        service2Icon: "rocket",
        service3Icon: "",
        valueProp1Icon: "Sparkles",
        service1Name: "rocket",
      })
    ).toEqual([
      'site-config: service2Icon "rocket" is not an icon in src/icons.ts; name one of its ICONS keys',
      'site-config: valueProp1Icon "Sparkles" is not an icon in src/icons.ts; name one of its ICONS keys',
    ])
  })
})
