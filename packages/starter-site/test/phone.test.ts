import { expect, it } from "vitest"
import { phoneText } from "../src/phone"

it("shows a UK number as dialled at home, a US one nationally and any other as stored", () => {
  expect(phoneText("+447700900123")).toBe("07700 900123")
  expect(phoneText("+442079460000")).toBe("020 7946 0000")
  expect(phoneText("+12065550104")).toBe("(206) 555-0104")
  // Not a North American number plan shape: left as stored.
  expect(phoneText("+11065550104")).toBe("+11065550104")
  expect(phoneText("+1206555")).toBe("+1206555")
  expect(phoneText("+353861234567")).toBe("+353861234567")
})
