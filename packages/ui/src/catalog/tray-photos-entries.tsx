import {
  type AskDesignInput,
  type Asset,
  PALETTES,
  type ReviewedPhotos,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
} from "@workspace/contracts"
import { TrayFrame } from "@workspace/ui/components/assistant/question-tray"
import {
  type PhotosAnswer,
  TrayPhotos,
} from "@workspace/ui/components/assistant/tray-photos"
import {
  type TrayPageProps,
  type TrayServices,
  TrayServicesProvider,
} from "@workspace/ui/components/assistant/tray-services"
import { useEffect, useRef, useState } from "react"
import type { CatalogEntry } from "./entries"

/**
 * The design tray's photos page in each state, for a made-up business. The
 * states past the first upload are reached the way the owner reaches them:
 * a photo is chosen on load, and the fake services answer, wait forever or
 * refuse. Nothing here is a real photo or a real review.
 */

/** A stand-in photo: grey shapes, so the page reads in either theme. */
const scene = (shapes: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill-opacity=".1"/>${shapes}</svg>`
  )}`

const SCENES = [
  scene(
    '<rect x="0" y="70" width="120" height="50" fill-opacity=".3"/><rect x="20" y="20" width="44" height="34" fill-opacity=".2"/>'
  ),
  scene(
    '<circle cx="60" cy="58" r="30" fill-opacity=".25"/><rect x="0" y="96" width="120" height="24" fill-opacity=".3"/>'
  ),
  scene(
    '<rect x="14" y="14" width="92" height="92" rx="10" fill-opacity=".2"/><rect x="34" y="34" width="52" height="52" fill-opacity=".25"/>'
  ),
  scene(
    '<path d="M0 120 L50 40 L80 80 L100 60 L120 120 Z" fill-opacity=".3"/>'
  ),
]

const asset = (n: number, name: string, use?: Asset["use"]): Asset => ({
  id: `0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d${String(n).padStart(2, "0")}`,
  name,
  content_type: "image/jpeg",
  bytes: 240_000,
  alt: `${name.replace(".jpg", "")} after a clean`,
  ...(use ? { use } : {}),
})

const KITCHEN = asset(1, "Kitchen.jpg", "hero")
const OVEN = asset(2, "Oven.jpg", "work")
const BATHROOM = asset(3, "Bathroom.jpg", "work")
const STAIRS = asset(4, "Stairs.jpg", "work")
const BLURRED = asset(5, "IMG_2041.jpg")

const QUESTION: AskDesignInput["questions"][number] = {
  id: "photos",
  question: "Add photos of your work",
  visual: "photos",
  card: {
    step: "template",
    options: [
      { id: "upload", label: "Upload photos", hint: null, visual: null },
      { id: "create", label: "Create them for me", hint: null, visual: null },
    ],
    multiple: false,
    preselected: [],
    other: null,
    skippable: false,
  },
  upload: {
    accept: ["image/jpeg", "image/png", "image/webp"],
    max_files: UPLOAD_MAX_FILES,
    max_bytes: UPLOAD_MAX_BYTES,
    skippable: false,
  },
}

/** The first review: two needs filled, one more work photo wanted, one blurred. */
const REVIEW: ReviewedPhotos = {
  photos: [
    { asset: KITCHEN, usable: true, note: null },
    { asset: OVEN, usable: true, note: null },
    { asset: BATHROOM, usable: true, note: null },
    { asset: BLURRED, usable: false, note: "Too blurred to use on a website." },
  ],
  missing: [
    { need: "work", count: 1 },
    { need: "team", count: 1 },
  ],
}

const STOPS = PALETTES[0]
  ?.swatches as unknown as TrayPageProps<PhotosAnswer>["stops"]

const never = () => new Promise<never>(() => undefined)
const wait = <T,>(value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), 400))

const services = (overrides: Partial<TrayServices> = {}): TrayServices => ({
  upload: (files) =>
    wait({
      assets: files.map((file, index) => ({
        ...asset(10 + index, file.name),
      })),
    }),
  reviewPhotos: () => wait(REVIEW),
  paletteFromImage: never,
  drawLogos: never,
  logoRounds: never,
  keepLogo: never,
  imageUrl: (id) => SCENES[Number(id.slice(-2)) % SCENES.length] ?? "",
  ...overrides,
})

/**
 * One state of the page, in the tray's frame with Next enabled as the page
 * settles. `choose` picks photos on load, as the owner would.
 */
function PhotosState({
  title,
  given = services(),
  answer,
  held,
  choose = 0,
  width,
}: {
  title: string
  given?: TrayServices
  answer?: PhotosAnswer
  held?: Asset[]
  choose?: number
  width?: string
}) {
  const [now, setNow] = useState(answer)
  const root = useRef<HTMLDivElement>(null)
  const chosen = useRef(false)
  useEffect(() => {
    const input =
      root.current?.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input || choose === 0 || chosen.current) return
    chosen.current = true
    const files = new DataTransfer()
    for (const name of ["Kitchen.jpg", "Oven.jpg", "Bathroom.jpg"].slice(
      0,
      choose
    )) {
      files.items.add(new File(["x"], name, { type: "image/jpeg" }))
    }
    input.files = files.files
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, [choose])
  return (
    <section className={`flex max-w-2xl flex-col gap-3 ${width ?? ""}`}>
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <div ref={root}>
        <TrayServicesProvider value={given}>
          <TrayFrame
            collapsed={false}
            onCollapsedChange={() => undefined}
            page={{ index: 4, total: 6 }}
            question={QUESTION.question ?? ""}
            skip={{ label: "Skip all", onSkip: () => undefined }}
            submit={{
              label: "Next",
              onSubmit: () => undefined,
              disabled: now === undefined,
            }}
          >
            <TrayPhotos
              answer={now}
              businessName="Mop & Pail Cleaning"
              onAnswer={setNow}
              question={held ? { ...QUESTION, held } : QUESTION}
              stops={STOPS}
              toolCallId="design_photos"
            />
          </TrayFrame>
        </TrayServicesProvider>
      </div>
    </section>
  )
}

const trayPhotosCatalog: CatalogEntry[] = [
  {
    name: "TrayPhotos",
    render: () => (
      <div className="flex flex-col gap-10">
        <PhotosState title="Nothing yet: the guide" />
        <PhotosState
          answer={{ photos: [], create: true }}
          title="Create them for me, chosen"
        />
        <PhotosState
          choose={3}
          given={services({ upload: never })}
          title="Uploading"
        />
        <PhotosState
          choose={3}
          given={services({ reviewPhotos: never })}
          title="Reading the photos"
        />
        <PhotosState choose={3} title="Read: one more needed, one unusable" />
        <PhotosState
          choose={3}
          given={services({
            reviewPhotos: () =>
              Promise.reject(
                new Error("Your photos could not be read. Try again.")
              ),
          })}
          title="Reading failed"
        />
        <PhotosState
          held={[KITCHEN, OVEN, BATHROOM, STAIRS]}
          title="After a reload, every needed photo in"
        />
        <PhotosState choose={3} title="Phone width" width="max-w-[22.5rem]" />
      </div>
    ),
  },
]

export { trayPhotosCatalog }
