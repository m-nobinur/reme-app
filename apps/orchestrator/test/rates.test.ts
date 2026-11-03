import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  freshRate,
  parseEcb,
  RATE_KEY,
  RATE_MAX_DAYS,
  refreshRate,
} from "../src/rates.ts"

/** The ECB's daily file as fetched on 2026-11-03: USD 1.1179 and GBP 0.83358 per euro. */
const SAMPLE = readFileSync(
  new URL("./fixtures/ecb-eurofxref-daily.xml", import.meta.url),
  "utf8"
)
const POUNDS_PER_DOLLAR = 0.745666

function store(initial?: unknown) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(RATE_KEY, JSON.stringify(initial))
  const kv = {
    get: async (key: string) =>
      map.has(key) ? JSON.parse(map.get(key) as string) : null,
    put: async (key: string, value: string) => void map.set(key, value),
  } as unknown as KVNamespace
  return { kv, env: { SCHEDULE: kv }, map }
}

const held = (date: string, fetched_on = date) => ({
  usd_gbp: 0.75,
  date,
  fetched_on,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("parseEcb", () => {
  it("reads the date and divides the GBP rate by the USD rate, both per euro", () => {
    expect(parseEcb(SAMPLE)).toEqual({
      date: "2026-11-03",
      usd_gbp: POUNDS_PER_DOLLAR,
    })
  })

  it("reads double-quoted attributes too", () => {
    const quoted = SAMPLE.replaceAll("'", '"')
    expect(parseEcb(quoted)?.usd_gbp).toBe(POUNDS_PER_DOLLAR)
  })

  it.each([
    ["no GBP rate", SAMPLE.replace(/<Cube currency='GBP'[^>]*>/, "")],
    ["no USD rate", SAMPLE.replace(/<Cube currency='USD'[^>]*>/, "")],
    ["no date", SAMPLE.replace(/ time='[^']*'/, "")],
    ["a zero rate", SAMPLE.replace("rate='1.1179'", "rate='0'")],
    ["not the file", "<html>Access denied</html>"],
    ["nothing", ""],
  ])("is null for %s", (_, xml) => {
    expect(parseEcb(xml)).toBeNull()
  })
})

describe("freshRate", () => {
  const now = new Date("2026-11-06T09:00:00Z")

  it("is the stored rate while its date is at most 3 days old", async () => {
    expect(RATE_MAX_DAYS).toBe(3)
    expect(await freshRate(store(held("2026-11-06")).kv, now)).toBe(0.75)
    expect(await freshRate(store(held("2026-11-03")).kv, now)).toBe(0.75)
  })

  it("is undefined from the fourth day", async () => {
    expect(await freshRate(store(held("2026-11-02")).kv, now)).toBeUndefined()
  })

  it("is undefined with nothing stored", async () => {
    expect(await freshRate(store().kv, now)).toBeUndefined()
  })

  it.each([
    ["a rate of zero", { ...held("2026-11-06"), usd_gbp: 0 }],
    ["a rate that is text", { ...held("2026-11-06"), usd_gbp: "0.75" }],
    ["a date that is not one", held("yesterday")],
  ])("is undefined for %s", async (_, value) => {
    expect(await freshRate(store(value).kv, now)).toBeUndefined()
  })
})

describe("refreshRate", () => {
  const serve = (response: Response) => {
    const fetched = vi.fn(async (_url: string) => response)
    vi.stubGlobal("fetch", fetched)
    return fetched
  }
  const logged = () =>
    vi.spyOn(console, "error").mockImplementation(() => undefined)

  it("fetches the ECB file when nothing is stored, at any hour, and keeps the rate, its date and the day", async () => {
    const fetched = serve(new Response(SAMPLE))
    const { env, map } = store()
    await refreshRate(env, new Date("2026-11-04T03:00:00Z"))
    expect(fetched).toHaveBeenCalledOnce()
    expect(fetched.mock.calls[0]?.[0]).toBe(
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
    )
    expect(JSON.parse(map.get(RATE_KEY) ?? "null")).toEqual({
      usd_gbp: POUNDS_PER_DOLLAR,
      date: "2026-11-03",
      fetched_on: "2026-11-04",
    })
  })

  it("fetches once a day: not again on the day it fetched, nor before 16:00 UTC", async () => {
    const fetched = serve(new Response(SAMPLE))
    await refreshRate(
      store(held("2026-11-03", "2026-11-04")).env,
      new Date("2026-11-04T20:00:00Z")
    )
    await refreshRate(
      store(held("2026-11-03", "2026-11-03")).env,
      new Date("2026-11-04T15:00:00Z")
    )
    expect(fetched).not.toHaveBeenCalled()
  })

  it("fetches from 16:00 UTC on a day it has not", async () => {
    const fetched = serve(new Response(SAMPLE))
    await refreshRate(
      store(held("2026-11-03", "2026-11-03")).env,
      new Date("2026-11-04T16:00:00Z")
    )
    expect(fetched).toHaveBeenCalledOnce()
  })

  it("keeps the old rate and logs the status when the ECB answers an error", async () => {
    const log = logged()
    serve(new Response("down", { status: 503 }))
    const { env, map } = store(held("2026-11-03", "2026-11-03"))
    const before = map.get(RATE_KEY)
    await refreshRate(env, new Date("2026-11-04T17:00:00Z"))
    expect(map.get(RATE_KEY)).toBe(before)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      rate: "usd_gbp",
      code: "ecb.503",
    })
  })

  it("stores nothing from a file it cannot read, and does not throw when the fetch fails", async () => {
    const log = logged()
    const { env, map } = store()
    serve(new Response("<html></html>"))
    await refreshRate(env, new Date("2026-11-04T17:00:00Z"))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline")
      })
    )
    await refreshRate(env, new Date("2026-11-04T18:00:00Z"))
    expect(map.size).toBe(0)
    expect(log).toHaveBeenCalledTimes(2)
  })
})
