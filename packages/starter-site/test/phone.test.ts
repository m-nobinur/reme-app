import { expect, it } from "vitest"
import { phoneText } from "../src/phone"

it("groups a UK number by its area code length", () => {
  expect(phoneText("+441175550142")).toBe("0117 555 0142")
  expect(phoneText("+441212345678")).toBe("0121 234 5678")
  expect(phoneText("+442079460000")).toBe("020 7946 0000")
  expect(phoneText("+441632960123")).toBe("01632 960123")
  expect(phoneText("+447700900123")).toBe("07700 900123")
  expect(phoneText("+443001234567")).toBe("0300 123 4567")
  expect(phoneText("+448001234567")).toBe("0800 123 4567")
})

it("shows a UK number as dialled at home, a US one nationally and any other as stored", () => {
  expect(phoneText("+447700900123")).toBe("07700 900123")
  expect(phoneText("+442079460000")).toBe("020 7946 0000")
  expect(phoneText("+12065550104")).toBe("(206) 555-0104")
  // Not a North American number plan shape: left as stored.
  expect(phoneText("+11065550104")).toBe("+11065550104")
  expect(phoneText("+1206555")).toBe("+1206555")
  expect(phoneText("+353861234567")).toBe("+353861234567")
})
