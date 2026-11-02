import { describe, expect, it } from "vitest"
import { emailAllowed, parseAccessList } from "../src/index.ts"

const LIST = parseAccessList(
  "mnkhan1997@gmail.com, *@jadeandsterling.com, nobinkhan.me@gmail.com"
)
const allowed = (email: string) => emailAllowed(email, LIST)

describe("access list", () => {
  it("allows everyone when there is no list", () => {
    expect(parseAccessList(undefined)).toBeNull()
    expect(parseAccessList("  ")).toBeNull()
    expect(emailAllowed("anyone@example.com", null)).toBe(true)
  })

  it.each([
    "mnkhan1997@gmail.com",
    "MnKhan1997@Gmail.com",
    "mnkhan1997+tuser@gmail.com",
    "mnkhan1997+a+b@gmail.com",
    "m.nkhan.1997@gmail.com",
    "m.nkhan.1997+test@googlemail.com",
    "nobinkhan.me@gmail.com",
    "nobinkhanme@gmail.com",
    "n.o.b.i.n.khan.me+x@gmail.com",
    "anyone@jadeandsterling.com",
    "A.B+c@JadeAndSterling.com",
  ])("allows %s", (email) => {
    expect(allowed(email)).toBe(true)
  })

  it.each([
    "mnkhan199@gmail.com",
    "mnkhan19970@gmail.com",
    "someone@gmail.com",
    "+tag@gmail.com",
    "mnkhan1997@gmail.com.evil.com",
    "mnkhan1997@evil.com",
    "x@jadeandsterling.com.au",
    "x@sub.jadeandsterling.com",
    "x@notjadeandsterling.com",
    "x@jadeandsterling.com@evil.com",
    '"x@jadeandsterling.com"@evil.com',
    "mnkhan1997@gmail.com\nevil@evil.com",
    "mnkhan1997@gmail.com,evil@evil.com",
    "mnkhan1997@gmail.com.",
    "",
    "mnkhan1997",
    "@gmail.com",
  ])("refuses %j", (email) => {
    expect(allowed(email)).toBe(false)
  })

  it("matches other domains exactly, plus tags included", () => {
    const list = parseAccessList("owner@example.com")
    expect(emailAllowed("owner@example.com", list)).toBe(true)
    expect(emailAllowed("owner+x@example.com", list)).toBe(false)
    expect(emailAllowed("o.wner@example.com", list)).toBe(false)
  })

  it("allows no one when a list has no usable entry", () => {
    expect(emailAllowed("a@gmail.com", parseAccessList("not an email"))).toBe(
      false
    )
  })
})
