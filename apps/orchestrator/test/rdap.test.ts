import { afterEach, describe, expect, it, vi } from "vitest"
import { rdapLookup } from "../src/rdap.ts"

// Shapes recorded read-only on 2026-10-27 from IANA and the two registries.
const BOOTSTRAP = {
  services: [
    [["uk"], ["https://rdap.nominet.uk/uk/"]],
    [["com"], ["https://rdap.verisign.com/com/v1/"]],
  ],
}
const registrar = (fn: string) => ({
  entities: [
    { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", ""]]] },
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["version", {}, "text", "4.0"],
          ["fn", {}, "text", fn],
        ],
      ],
    },
  ],
})

/** A Workers cache as a map, and a fetch answering the routes given. */
function stub(routes: Record<string, () => Response>) {
  const kept = new Map<string, Response>()
  vi.stubGlobal("caches", {
    default: {
      match: async (r: Request) => kept.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void kept.set(r.url, res),
    },
  })
  const fetched = vi.fn(async (url: string) => {
    const route = routes[String(url)]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route()
  })
  vi.stubGlobal("fetch", fetched)
  return fetched
}

const bootstrap = () => Response.json(BOOTSTRAP)

afterEach(() => vi.unstubAllGlobals())

describe("rdapLookup", () => {
  it("reads the registrar of a registered name and tidies its legal name", async () => {
    stub({
      "https://data.iana.org/rdap/dns.json": bootstrap,
      "https://rdap.nominet.uk/uk/domain/sparkle.co.uk": () =>
        Response.json(registrar("123-Reg Limited t/a 123-reg")),
    })
    expect(await rdapLookup("sparkle.co.uk")).toEqual({
      registered: true,
      registrar: "123-reg",
    })
  })

  it("reads 404 as free", async () => {
    stub({
      "https://data.iana.org/rdap/dns.json": bootstrap,
      "https://rdap.verisign.com/com/v1/domain/free.com": () =>
        new Response("{}", { status: 404 }),
    })
    expect(await rdapLookup("free.com")).toEqual({ registered: false })
  })

  it("asks the registry once a day, and never keeps a 404", async () => {
    const fetched = stub({
      "https://data.iana.org/rdap/dns.json": bootstrap,
      "https://rdap.verisign.com/com/v1/domain/kept.com": () =>
        Response.json(registrar("NameCheap, Inc.")),
      "https://rdap.verisign.com/com/v1/domain/free.com": () =>
        new Response("{}", { status: 404 }),
    })
    await rdapLookup("kept.com")
    await rdapLookup("kept.com")
    await rdapLookup("free.com")
    await rdapLookup("free.com")
    // The bootstrap once, kept.com once, free.com each time.
    expect(fetched).toHaveBeenCalledTimes(4)
  })

  it("is null for an ending IANA lists no server for", async () => {
    stub({ "https://data.iana.org/rdap/dns.json": bootstrap })
    expect(await rdapLookup("sparkle.xyz")).toBeNull()
  })

  it("fails on a rate limit instead of calling the name free", async () => {
    stub({
      "https://data.iana.org/rdap/dns.json": bootstrap,
      "https://rdap.nominet.uk/uk/domain/busy.co.uk": () =>
        new Response("{}", { status: 429 }),
    })
    await expect(rdapLookup("busy.co.uk")).rejects.toThrow("rdap.unavailable")
  })
})
