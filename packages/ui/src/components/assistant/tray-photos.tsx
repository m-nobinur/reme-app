import {
  CheckCircleIcon,
  CheckSquareIcon,
  CircleDashedIcon,
  CircleIcon,
  MagicWandIcon,
  SpinnerGapIcon,
  SquareIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react"
import { type Asset, PHOTO_NEEDS, type PhotoNeed } from "@workspace/contracts"
import {
  DropTile,
  Fold,
  Summary,
  sentence,
  TRAY_TILE,
  Ways,
} from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayPageProps,
  useTrayServices,
} from "@workspace/ui/components/assistant/tray-services"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"

/**
 * The photos question of the design tray, asked as yes or no. No leaves the
 * photos to the assistant and moves on. Yes folds the pair into a summary
 * row and opens the upload: three lines say what the site needs and tick
 * off as the owner's photos are read against them. Photos upload as soon as
 * they are chosen, then the assistant reads them: each fills a need or, if
 * unusable, says why. What is still missing the owner adds, or leaves to the
 * assistant with Create the rest. The answer is set whenever it is settled:
 * nothing missing, or create chosen.
 */

type PhotosAnswer = { photos: Asset[]; create: boolean }

/** One photo as the page holds it: a usable one fills its `use`. */
type Held = { asset: Asset; usable: boolean; note: string | null }

const NEED_WORDS: Record<PhotoNeed, string> = {
  hero: "One wide shot of a finished job",
  work: "Three of your work, one for each main service",
  team: "You or your team, if you like",
}

/** How many more each need takes, from the usable photos' `use`. */
const missingOf = (photos: readonly Held[]) =>
  PHOTO_NEEDS.map((need) => ({
    need,
    more: Math.max(
      0,
      need.count -
        photos.filter((each) => each.usable && each.asset.use === need.id)
          .length
    ),
  }))

/** The answer the page's state settles on, or none while something is missing. */
function answerOf(
  photos: readonly Held[],
  create: boolean
): PhotosAnswer | undefined {
  const usable = photos.filter((each) => each.usable).map((each) => each.asset)
  const short = missingOf(photos).some(
    ({ need, more }) => !need.optional && more > 0
  )
  if (short) return create ? { photos: usable, create: true } : undefined
  return usable.length > 0 ? { photos: usable, create: false } : undefined
}

/** The photos the page opens with: its own answer, else what the org holds. */
const startOf = (answer: PhotosAnswer | undefined, held: Asset[] = []) =>
  (answer?.photos ?? held.filter((asset) => asset.use)).map((asset) => ({
    asset,
    usable: true,
    note: null,
  }))

const count = (n: number) => (n === 1 ? "1 photo" : `${n} photos`)

function TrayPhotos({
  question,
  answer,
  onAnswer,
  onNext,
}: TrayPageProps<PhotosAnswer>) {
  const services = useTrayServices()
  const limits = question.upload
  const [photos, setPhotos] = useState<Held[]>(() =>
    startOf(answer, question.held)
  )
  const [create, setCreate] = useState(answer?.create ?? false)
  const [path, setPath] = useState<"upload" | "create" | null>(() =>
    photos.length > 0 ? "upload" : answer?.create ? "create" : null
  )
  const [reopened, setReopened] = useState(false)
  // Stored but not read yet: while the reading runs, or after it failed, when Try again reads them.
  const [unread, setUnread] = useState<Asset[]>([])
  const [busy, setBusy] = useState<
    { doing: "uploading" | "reading"; n: number } | undefined
  >()
  const [refused, setRefused] = useState<string[]>([])
  const [failed, setFailed] = useState<string | null>(null)

  const settle = (nextPhotos: Held[], nextCreate: boolean) => {
    setPhotos(nextPhotos)
    setCreate(nextCreate)
    onAnswer(answerOf(nextPhotos, nextCreate))
  }

  // Every photo is read again with the new ones, so the needs are shared out across all of them.
  const read = async (kept: Held[], added: Asset[]) => {
    if (!services) return
    setBusy({ doing: "reading", n: kept.length + added.length })
    setUnread(added)
    try {
      const review = await services.reviewPhotos([
        ...kept.map((each) => each.asset.id),
        ...added.map((asset) => asset.id),
      ])
      setUnread([])
      settle(review.photos, create)
    } catch (error) {
      setFailed(sentence(error, "Your photos could not be read. Try again."))
    } finally {
      setBusy(undefined)
    }
  }

  const add = async (files: File[]) => {
    if (!limits || busy) return
    setFailed(null)
    if (!services) {
      setFailed("Photos cannot be uploaded here. Choose No to have them made.")
      return
    }
    const checked = checkPhotos<{ name: string; type: string; size: number }>(
      [...photos.map((each) => each.asset), ...unread].map((asset) => ({
        name: asset.name,
        type: asset.content_type,
        size: asset.bytes,
      })),
      files,
      limits
    )
    setRefused(checked.refused)
    const chosen = checked.kept.filter((each) => each instanceof File)
    if (chosen.length === 0) return
    setBusy({ doing: "uploading", n: chosen.length })
    try {
      const stored = await services.upload(chosen)
      await read(photos, [...unread, ...stored.assets])
    } catch (error) {
      setFailed(sentence(error, "The photos did not upload. Try again."))
      setBusy(undefined)
    }
  }

  const remove = (gone: string) => {
    setRefused([])
    settle(
      photos.filter((each) => each.asset.id !== gone),
      create
    )
  }

  const usable = photos.filter((each) => each.usable)
  const unusable = photos.filter((each) => !each.usable)
  const missing = missingOf(photos)
  const short = missing.some(({ need, more }) => !need.optional && more > 0)
  const started = photos.length > 0

  // Leaving them to the assistant is the way past, so the tray moves on as Next would.
  const leave = () => {
    const chosen = answerOf(photos, true)
    if (onNext && chosen) {
      setCreate(true)
      onNext(chosen)
    } else settle(photos, true)
  }

  const pick = (way: "upload" | "create") => {
    if (busy) return
    setPath(way)
    setReopened(false)
    if (way === "create") leave()
    else if (create) settle(photos, false)
  }

  const [uploadOption, createOption] = question.card.options
  const choiceOpen = path !== "upload" || reopened
  const createRest = short && usable.length > 0

  return (
    <div className="-my-1.5 flex shrink-0 flex-col">
      <Fold open={!choiceOpen}>
        <Summary label="Photos" onOpen={() => setReopened(true)}>
          <span className="truncate">{uploadOption?.label}</span>
        </Summary>
      </Fold>
      <Fold open={choiceOpen}>
        <Ways
          label={question.question ?? "Your photos"}
          onPick={pick}
          // Again on Yes folds the pair; again on No moves on again.
          onRepick={(way) => (way === "upload" ? setReopened(false) : leave())}
          picked={path}
          ways={[
            {
              way: "upload",
              label: uploadOption?.label ?? "Yes, I have photos",
              hint: "Upload a few shots of your work",
              icon: <UploadSimpleIcon aria-hidden />,
            },
            {
              way: "create",
              label: createOption?.label ?? "No, create them for me",
              hint: "Made to fit your business, swap any time",
              icon: <MagicWandIcon aria-hidden />,
            },
          ]}
        />
      </Fold>

      <Fold open={path === "upload"}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
            <ul
              aria-label="What your site needs"
              className="flex flex-col gap-2"
            >
              {missing.map(({ need, more }) => {
                const done = started && more === 0 && !busy
                return (
                  <li
                    className="flex items-center gap-2.5 text-sm"
                    key={need.id}
                  >
                    {done ? (
                      <CheckCircleIcon
                        aria-hidden
                        className="size-5 shrink-0 text-primary"
                        weight="fill"
                      />
                    ) : need.optional ? (
                      <CircleDashedIcon
                        aria-hidden
                        className="size-5 shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <CircleIcon
                        aria-hidden
                        className="size-5 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      {NEED_WORDS[need.id]}
                    </span>
                    {done ? <span className="sr-only">Done</span> : null}
                    {started && !done && !busy && !need.optional ? (
                      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                        {more} more
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <p className="border-border border-t pt-2.5 text-muted-foreground text-xs">
              Sharp, well-lit photos you took yourself work best.
            </p>
          </div>

          {usable.length + unread.length > 0 || busy?.doing === "uploading" ? (
            <ul aria-label="Your photos" className="flex flex-wrap gap-2">
              {usable.map(({ asset }) => (
                <li className="relative size-16" key={asset.id}>
                  <img
                    alt={asset.alt ?? asset.name}
                    className="size-full rounded-lg border border-border bg-muted object-cover"
                    src={services?.imageUrl(asset.id)}
                  />
                  <Button
                    aria-label={`Remove ${asset.name}`}
                    className="absolute top-0.5 right-0.5 size-6 rounded-full"
                    disabled={Boolean(busy)}
                    onClick={() => remove(asset.id)}
                    size="icon"
                    type="button"
                    variant="secondary"
                  >
                    <XIcon aria-hidden className="size-3.5" />
                  </Button>
                </li>
              ))}
              {unread.map((asset) => (
                <li className="size-16" key={asset.id}>
                  <img
                    alt={asset.name}
                    className="size-full rounded-lg border border-border bg-muted object-cover opacity-60"
                    src={services?.imageUrl(asset.id)}
                  />
                </li>
              ))}
              {busy?.doing === "uploading"
                ? Array.from({ length: busy.n }, (_, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stand-ins with nothing to tell apart
                    <li className="size-16" key={index}>
                      <Skeleton className="size-full rounded-lg border border-border bg-card" />
                    </li>
                  ))
                : null}
            </ul>
          ) : null}

          {unusable.length > 0 ? (
            <ul
              aria-label="Photos we cannot use"
              className="flex flex-col gap-2"
            >
              {unusable.map(({ asset, note }) => (
                <li
                  className="flex items-center gap-3 rounded-xl border border-border bg-card p-2"
                  key={asset.id}
                >
                  <img
                    alt={asset.alt ?? asset.name}
                    className="size-10 shrink-0 rounded-md bg-muted object-cover opacity-60"
                    src={services?.imageUrl(asset.id)}
                  />
                  <span className="min-w-0 flex-1 text-[0.8125rem]">
                    {note ?? "This one will not work on the site."}
                  </span>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => remove(asset.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {busy ? (
            <p
              aria-live="polite"
              className="flex items-center gap-2 text-muted-foreground text-sm"
            >
              <SpinnerGapIcon aria-hidden className="size-4 animate-spin" />
              {busy.doing === "uploading"
                ? `Uploading ${count(busy.n)}`
                : `Reading your ${busy.n === 1 ? "photo" : "photos"}`}
            </p>
          ) : null}
          {refused.length > 0 ? (
            <ul
              className="flex flex-col gap-1 text-[0.8125rem] text-destructive"
              role="alert"
            >
              {refused.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {failed ? (
            <div className="flex items-center gap-3" role="alert">
              <p className="min-w-0 flex-1 text-[0.8125rem] text-destructive">
                {failed}
              </p>
              {unread.length > 0 ? (
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setFailed(null)
                    void read(photos, unread)
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="grid @md:grid-cols-2 grid-cols-1 gap-3 empty:hidden">
            {limits && photos.length + unread.length < limits.max_files ? (
              <div
                className={cn(
                  "grid",
                  busy && "pointer-events-none opacity-60",
                  !createRest && "@md:col-span-2"
                )}
              >
                <DropTile
                  accept={limits.accept}
                  help={`${typesText(limits.accept)}, up to ${sizeText(limits.max_bytes)} each`}
                  icon={<UploadSimpleIcon />}
                  multiple={limits.max_files > 1}
                  onFiles={(files) => void add(files)}
                  title={
                    started
                      ? "Add more photos"
                      : "Drop photos here or choose them"
                  }
                />
              </div>
            ) : null}
            {createRest ? (
              <label
                className={cn(
                  TRAY_TILE,
                  busy && "pointer-events-none opacity-60"
                )}
              >
                <input
                  checked={create}
                  className="sr-only"
                  disabled={Boolean(busy)}
                  onChange={() => (create ? settle(photos, false) : leave())}
                  type="checkbox"
                />
                <span className="flex items-center gap-1.5 font-medium text-sm">
                  Create the rest
                  {create ? (
                    <CheckSquareIcon
                      aria-hidden
                      className="ml-auto size-5 shrink-0"
                      weight="fill"
                    />
                  ) : (
                    <SquareIcon
                      aria-hidden
                      className="ml-auto size-5 shrink-0 text-muted-foreground"
                    />
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  Only the ones still missing, used beside yours.
                </span>
              </label>
            ) : null}
          </div>
        </div>
      </Fold>
    </div>
  )
}

/**
 * The answer the org's held photos already give, so a reload goes past a
 * photos question they settle.
 */
const heldPhotosAnswer = (held?: Asset[]) =>
  answerOf(startOf(undefined, held), false)

export type { PhotosAnswer }
export { answerOf as photosAnswerOf, heldPhotosAnswer, TrayPhotos }
