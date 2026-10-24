import {
  ErrorEnvelope,
  FactList,
  UPLOAD_MAX_BYTES,
  UploadedAssets,
} from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  cleanName,
  readPhoto,
  readRevisionPicture,
  sniff,
  uploadKey,
} from "../src/assets.ts"
import type { Owner } from "../src/changes.ts"
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

describe("GET /revisions/:id/:picture", () => {
  const rev = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b"
  const keys = [
    `sites/org-a/${rev}/screenshots/home-1440.png`,
    `sites/org-a/${rev}/screenshots/home-390.png`,
    `sites/org-a/${rev}/dist/icon-192.png`,
  ]
  const asked: unknown[] = []
  const env = (images: boolean) =>
    ({
      SITES: {
        get: async (key: string) =>
          keys.includes(key)
            ? { key, body: new Blob([new Uint8Array(9)]).stream() }
            : null,
      },
      IMAGES: images
        ? {
            input: (stream: ReadableStream) => {
              void stream.cancel()
              const handle = {
                transform: (t: unknown) => {
                  asked.push(t)
                  return handle
                },
                output: async () => ({
                  image: () => new Blob([new Uint8Array(1)]).stream(),
                  contentType: () => "image/webp",
                }),
              }
              return handle
            },
          }
        : undefined,
    }) as unknown as Env
  const mine = { orgId: "org-a" } as Owner

  it("cuts a screenshot to its first screen, at most 1200 wide, cached for good", async () => {
    for (const picture of ["home-1440", "home-390"]) {
      const response = await readRevisionPicture(env(true), mine, rev, picture)
      expect(response.headers.get("content-type")).toBe("image/webp")
      expect(response.headers.get("cache-control")).toContain("immutable")
      await response.arrayBuffer()
    }
    expect(asked).toEqual([
      { width: 1200, height: 750, fit: "cover", gravity: "top" },
      { width: 390, height: 244, fit: "cover", gravity: "top" },
    ])
  })

  it("serves the icon and, with no binding, the screenshot as stored", async () => {
    for (const picture of ["icon", "home-1440"]) {
      const response = await readRevisionPicture(env(false), mine, rev, picture)
      expect(response.headers.get("content-type")).toBe("image/png")
      expect((await response.arrayBuffer()).byteLength).toBe(9)
    }
  })

  it("is a 404 for another org's version and for one not shot yet", async () => {
    const theirs = { orgId: "org-b" } as Owner
    expect(
      (await readRevisionPicture(env(true), theirs, rev, "icon")).status
    ).toBe(404)
    expect(
      (await readRevisionPicture(env(true), mine, rev, "home-768")).status
    ).toBe(404)
  })
})

describe("GET /photos/:id's thumbnail", () => {
  const id = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
  const ORIGINAL = new Uint8Array(2000)
  const THUMB = new Uint8Array([1, 2, 3])
  const upload = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
  const logo = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
  const mine = { orgId: "org-a" } as Owner
  const stored: Record<string, Record<string, string>> = {
    [`generated/org-a/${id}.png`]: {},
    [`uploads/org-a/${upload}`]: {},
    [`generated/org-a/${logo}.png`]: { use: "logo" },
  }
  const sites = {
    get: async (key: string) =>
      key in stored
        ? {
            key,
            body: new Blob([ORIGINAL]).stream(),
            httpMetadata: { contentType: "image/png" },
            customMetadata: stored[key],
          }
        : null,
  }
  /** An Images binding that answers a tiny WebP and records the width asked. */
  const asked: unknown[] = []
  const images = {
    input: (stream: ReadableStream) => {
      void stream.cancel()
      const handle = {
        transform: (t: unknown) => {
          asked.push(t)
          return handle
        },
        output: async () => ({
          image: () => new Blob([THUMB]).stream(),
          contentType: () => "image/webp",
        }),
      }
      return handle
    },
  }
  const env = (extra: object) => ({ SITES: sites, ...extra }) as unknown as Env
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer())

  it("is the small WebP, cached for good", async () => {
    const response = await readPhoto(env({ IMAGES: images }), mine, id)
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(response.headers.get("cache-control")).toContain("immutable")
    expect(await bytes(response)).toEqual(THUMB)
    expect(asked).toEqual([{ width: 320 }])
  })

  it("serves an owner's upload and a drawn logo at the tray's 512 px", async () => {
    asked.length = 0
    for (const each of [upload, logo]) {
      const response = await readPhoto(env({ IMAGES: images }), mine, each)
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    expect(asked).toEqual([{ width: 512 }, { width: 512 }])
    const theirs = await readPhoto(
      env({ IMAGES: images }),
      { orgId: "org-b" } as Owner,
      upload
    )
    expect(theirs.status).toBe(404)
  })

  it("is the original where there is no binding", async () => {
    const response = await readPhoto(env({}), mine, id)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(await bytes(response)).toEqual(ORIGINAL)
  })

  it("is the original when the binding refuses the bytes", async () => {
    const refusing = {
      input: () => ({
        transform: () => ({ output: async () => Promise.reject(new Error()) }),
      }),
    }
    const response = await readPhoto(env({ IMAGES: refusing }), mine, id)
    expect(await bytes(response)).toEqual(ORIGINAL)
  })

  it("is a 404 for another org, binding or not", async () => {
    const response = await readPhoto(
      env({ IMAGES: images }),
      { orgId: "org-b" } as Owner,
      id
    )
    expect(response.status).toBe(404)
  })
})

const url = process.env.DATABASE_URL

/** An R2 stand-in that keeps what it was sent. */
const bucket = () => {
  const objects = new Map<
    string,
    { bytes: number; type?: string; file: boolean }
  >()
  return {
    objects,
    put: async (
      key: string,
      value: Uint8Array | File,
      options?: { httpMetadata?: { contentType?: string } }
    ) => {
      objects.set(key, {
        bytes: value instanceof File ? value.size : value.byteLength,
        type: options?.httpMetadata?.contentType,
        file: value instanceof File,
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

  it("hands the bucket the uploaded file itself, not a copy of its bytes", async () => {
    const who = await owner(kit, url as string, "assets-file")
    const sites = bucket()
    const response = await upload(
      who,
      sites,
      form([{ bytes: JPEG, name: "van.jpg" }])
    )
    expect(response.status).toBe(201)
    expect([...sites.objects.values()]).toEqual([
      { bytes: JPEG.byteLength, type: "image/jpeg", file: true },
    ])
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
              key,
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
