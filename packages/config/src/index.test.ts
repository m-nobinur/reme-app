import { expect, test } from "vitest"
import { parseEnv } from "./index.ts"

const valid = { DATABASE_URL: "postgresql://localhost:5432/reme" }

test("returns the parsed environment", () => {
  expect(parseEnv(valid)).toEqual({
    DATABASE_URL: valid.DATABASE_URL,
    NEON_OFFLINE: false,
  })
})

test("NEON_OFFLINE=1 selects the local database", () => {
  expect(parseEnv({ ...valid, NEON_OFFLINE: "1" }).NEON_OFFLINE).toBe(true)
})

test("names a variable that is not set", () => {
  expect(() => parseEnv({})).toThrow(/DATABASE_URL is not set/)
})

test("a blank value is not set, not malformed", () => {
  expect(() => parseEnv({ DATABASE_URL: "", NEON_OFFLINE: "" })).toThrow(
    /DATABASE_URL is not set/
  )
})

test("names a variable that is malformed", () => {
  expect(() =>
    parseEnv({ ...valid, DATABASE_URL: "mysql://localhost/reme" })
  ).toThrow(/DATABASE_URL: must be a postgres connection string/)
})

test("names every problem at once", () => {
  const parse = () => parseEnv({ NEON_OFFLINE: "yes" })
  expect(parse).toThrow(/DATABASE_URL is not set/)
  expect(parse).toThrow(/NEON_OFFLINE:/)
})
