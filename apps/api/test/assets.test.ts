import {
  ErrorEnvelope,
  FactList,
  UPLOAD_MAX_BYTES,
  UploadedAssets,
} from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanName, sniff, uploadKey } from "../src/assets.ts"
import { owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
])
const SVG = new TextEncoder().encode(
  "<svg xmlns='http://www.w3.org/2000/svg'/>"
)

describe("an uploaded photo's type and name", () => {
  it("reads the type from the bytes: JPEG, PNG and WebP only", () => {
    expect(sniff(JPEG)).toBe("image/jpeg")
    expect(sniff(PNG)).toBe("image/png")
    expect(sniff(WEBP)).toBe("image/webp")
    expect(sniff(SVG)).toBeNull()
    expect(sniff(new TextEncoder().encode("GIF89a"))).toBeNull()
    expect(sniff(new Uint8Array())).toBeNull()
  })

  it("keeps the file's own name without folders, markup or its old extension", () => {
    expect(cleanName("C:\\photos\\Our van (2024).JPG", "image/jpeg")).toBe(
      "Our van 2024.jpg"
    )
    expect(cleanName("../../<script>x</script>.png", "image/png")).toBe(
      "script.png"
    )
    expect(cleanName("   ", "image/webp")).toBe("photo.webp")
    expect(cleanName(`${"a".repeat(300)}.png`, "image/png")).toHaveLength(104)
  })
})

const url = process.env.DATABASE_URL

/** An R2 stand-in that keeps what it was sent. */
const bucket = () => {
  const objects = new Map<string, { bytes: number; type?: string }>()
  return {
    objects,
    put: async (
      key: string,
      value: Uint8Array,
      options?: { httpMetadata?: { contentType?: string } }
    ) => {
      objects.set(key, {
        bytes: value.byteLength,
        type: options?.httpMetadata?.contentType,
      })
      return {}
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
  }
}

describe.skipIf(!url)("POST /assets, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch

  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  const form = (
    files: { bytes: Uint8Array; name: string; type?: string }[]
  ) => {
    const body = new FormData()
    for (const f of files) {
      body.append(
        "files",
        new File([f.bytes], f.name, { type: f.type ?? "image/jpeg" })
      )
    }
    return body
  }

  const upload = (
    who: Awaited<ReturnType<typeof owner>>,
    sites: ReturnType<typeof bucket>,
    body: FormData,
    key: string | null = crypto.randomUUID()
  ) =>
    who.call(stubOrchestrator(), "/assets", {
      method: "POST",
      body,
      headers: key ? { "idempotency-key": key } : {},
      bindings: { SITES: sites },
    })

  const codeOf = async (response: Response) =>
    ErrorEnvelope.parse(await response.json()).code

  const uploads = async (who: Awaited<ReturnType<typeof owner>>) =>
    FactList.parse(
      await (await who.call(stubOrchestrator(), "/facts")).json()
    ).facts.find((f) => f.key === "media.uploads")?.value as
      | { items: { id: string }[] }
      | undefined

  it("stores each photo under the org, lists it in media.uploads, and replays a retry", async () => {
    const who = await owner(kit, url as string, "assets-store")
    const sites = bucket()
    const files = [
      { bytes: JPEG, name: "van.jpg" },
      // The client's type is ignored: these bytes are a PNG.
      { bytes: PNG, name: "team.jpg", type: "image/jpeg" },
    ]
    const response = await upload(who, sites, form(files), "key-1")
    expect(response.status).toBe(201)
    const { assets } = UploadedAssets.parse(await response.json())
    expect(assets.map((a) => [a.name, a.content_type])).toEqual([
      ["van.jpg", "image/jpeg"],
      ["team.png", "image/png"],
    ])
    expect([...sites.objects.keys()].sort()).toEqual(
      assets.map((a) => uploadKey(who.orgId, a.id)).sort()
    )
    expect((await uploads(who))?.items.map((a) => a.id)).toEqual(
      assets.map((a) => a.id)
    )
    // The same key again writes the same two, not two more.
    const again = await upload(who, sites, form(files), "key-1")
    expect(UploadedAssets.parse(await again.json()).assets).toEqual(assets)
    expect((await uploads(who))?.items).toHaveLength(2)
    expect(sites.objects.size).toBe(2)
  })

  it("refuses a file that is not a JPEG, PNG or WebP, whatever it claims", async () => {
    const who = await owner(kit, url as string, "assets-type")
    const sites = bucket()
    const response = await upload(
      who,
      sites,
      form([{ bytes: SVG, name: "logo.jpg", type: "image/jpeg" }])
    )
    expect(response.status).toBe(415)
    expect(await codeOf(response)).toBe("assets.type")
    expect(sites.objects.size).toBe(0)
    expect(await uploads(who)).toBeUndefined()
  })

  it("refuses a photo over the size cap, an empty form and a missing key", async () => {
    const who = await owner(kit, url as string, "assets-size")
    const sites = bucket()
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1)
    big.set(JPEG)
    const large = await upload(
      who,
      sites,
      form([{ bytes: big, name: "big.jpg" }])
    )
    expect(large.status).toBe(413)
    expect(await codeOf(large)).toBe("assets.too_large")
    const empty = await upload(who, sites, new FormData())
    expect(empty.status).toBe(400)
    const keyless = await upload(
      who,
      sites,
      form([{ bytes: JPEG, name: "a.jpg" }]),
      null
    )
    expect(keyless.status).toBe(400)
    expect(await codeOf(keyless)).toBe("idempotency_key.missing")
    expect(sites.objects.size).toBe(0)
  })

  it("holds an org to twelve photos in all", async () => {
    const who = await owner(kit, url as string, "assets-count")
    const sites = bucket()
    const ten = Array.from({ length: 10 }, (_, i) => ({
      bytes: JPEG,
      name: `p${i}.jpg`,
    }))
    expect((await upload(who, sites, form(ten))).status).toBe(201)
    const three = ten.slice(0, 3)
    const over = await upload(who, sites, form(three))
    expect(over.status).toBe(409)
    expect(await codeOf(over)).toBe("assets.too_many")
    expect(sites.objects.size).toBe(10)
    expect((await upload(who, sites, form(three.slice(0, 2)))).status).toBe(201)
    expect((await uploads(who))?.items).toHaveLength(12)
  })

  it("keeps one org's photos out of another's list and bucket path", async () => {
    const one = await owner(kit, url as string, "assets-one")
    const other = await owner(kit, url as string, "assets-other")
    const sites = bucket()
    const response = await upload(
      one,
      sites,
      form([{ bytes: WEBP, name: "a.webp" }])
    )
    const [asset] = UploadedAssets.parse(await response.json()).assets
    expect(await uploads(other)).toBeUndefined()
    expect([...sites.objects.keys()]).toEqual([
      uploadKey(one.orgId, asset?.id as string),
    ])
  })
})

describe.skipIf(!url)("GET /photos/:id, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch

  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  const id = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
  /** A bucket holding one generated photo, under `org`. */
  const holding = (org: string) => {
    const key = `generated/${org}/${id}.webp`
    return {
      get: async (asked: string) =>
        asked === key
          ? {
              body: new Blob([WEBP]).stream(),
              httpMetadata: { contentType: "image/webp" },
            }
          : null,
    }
  }
  const read = (
    who: Awaited<ReturnType<typeof owner>>,
    sites: ReturnType<typeof holding>,
    path = `/photos/${id}`
  ) => who.call(stubOrchestrator(), path, { bindings: { SITES: sites } })

  it("serves the org's own photo with its type, cached for good", async () => {
    const who = await owner(kit, url as string, "photos-own")
    const response = await read(who, holding(who.orgId))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(response.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP)
  })

  it("answers 404 for another org's photo, the same as for none", async () => {
    const one = await owner(kit, url as string, "photos-one")
    const other = await owner(kit, url as string, "photos-other")
    const response = await read(other, holding(one.orgId))
    expect(response.status).toBe(404)
    expect(await codeOf(response)).toBe("photo.not_found")
  })

  it("serves nothing for a path that is not an asset id", async () => {
    const who = await owner(kit, url as string, "photos-path")
    for (const path of [`/photos/${id}.webp`, "/photos/..%2Fsecret"]) {
      expect((await read(who, holding(who.orgId), path)).status, path).toBe(404)
    }
  })
})

const codeOf = async (response: Response) =>
  ErrorEnvelope.parse(await response.json()).code
