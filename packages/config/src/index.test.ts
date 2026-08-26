import assert from "node:assert/strict"
import { test } from "node:test"
import { parseEnv } from "./index.ts"

const valid = { DATABASE_URL: "postgresql://localhost:5432/reme" }

test("returns the parsed environment", () => {
  assert.deepEqual(parseEnv(valid), {
    DATABASE_URL: valid.DATABASE_URL,
    NEON_OFFLINE: false,
  })
})

test("NEON_OFFLINE=1 selects the local database", () => {
  assert.equal(parseEnv({ ...valid, NEON_OFFLINE: "1" }).NEON_OFFLINE, true)
})

test("names a variable that is not set", () => {
  assert.throws(() => parseEnv({}), /DATABASE_URL is not set/)
})

test("a blank value is not set, not malformed", () => {
  assert.throws(
    () => parseEnv({ DATABASE_URL: "", NEON_OFFLINE: "" }),
    /DATABASE_URL is not set/
  )
})

test("names a variable that is malformed", () => {
  assert.throws(
    () => parseEnv({ ...valid, DATABASE_URL: "mysql://localhost/reme" }),
    /DATABASE_URL: must be a postgres connection string/
  )
})

test("names every problem at once", () => {
  assert.throws(
    () => parseEnv({ NEON_OFFLINE: "yes" }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /DATABASE_URL is not set/)
      assert.match(message, /NEON_OFFLINE:/)
      return true
    }
  )
})
