import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  ImagesIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react"
import type { UploadedAssets } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { askUploadView } from "@workspace/ui/lib/tool-state"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import {
  createContext,
  type DragEvent,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * The photo step of onboarding: drop photos or choose them, see them, take
 * any back out, then upload. Nothing leaves the browser until the owner
 * presses Upload photos; the card then sends them, and answers the call with
 * what the server stored. Skip for now answers it with nothing. Once
 * answered or skipped it shows nothing: the owner's reply after it says
 * what they sent.
 */

/** Stores the photos and answers what was stored, or throws a sentence for the owner. */
export type UploadPhotos = (files: File[]) => Promise<UploadedAssets>

const UploadContext = createContext<UploadPhotos | null>(null)

/** Gives the upload card the app's way to store photos. */
export const UploadPhotosProvider = UploadContext.Provider

const NO_UPLOAD =
  "Photos cannot be uploaded here. Skip for now and add them later."

/** One chosen photo: the fields `checkPhotos` reads, and its preview. */
type Picked = {
  key: string
  file: File
  url: string
  name: string
  type: string
  size: number
}

const AskUpload: ToolCallMessagePartComponent = (props) => {
  const view = askUploadView(props)
  const upload = useContext(UploadContext)
  const id = useId()
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusWhenIdle(waiting, running, cardRef)
  const [picked, setPicked] = useState<Picked[]>([])
  const [refused, setRefused] = useState<string[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [over, setOver] = useState(false)

  // Previews are object URLs, freed when a photo leaves or the card goes.
  const urls = useRef(new Set<string>())
  useEffect(() => {
    const held = urls.current
    return () => {
      for (const url of held) URL.revokeObjectURL(url)
    }
  }, [])

  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-md" data-slot="ask-upload">
        <p
          className={cn(
            "text-sm",
            view.state === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {view.state === "cancelled"
            ? "You replied in the chat instead."
            : view.message}
        </p>
      </div>
    )
  }

  const { input } = view

  const add = (files: FileList | null) => {
    if (!files || sending) return
    setFailed(null)
    const added = Array.from(files, (file) => ({
      key: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
      file,
      url: "",
      name: file.name,
      type: file.type,
      size: file.size,
    }))
    const checked = checkPhotos(picked, added, input)
    setRefused(checked.refused)
    setPicked(
      checked.kept.map((each) => {
        if (each.url) return each
        const url = URL.createObjectURL(each.file)
        urls.current.add(url)
        return { ...each, url }
      })
    )
  }

  const remove = (key: string) => {
    const gone = picked.find((each) => each.key === key)
    if (gone) {
      URL.revokeObjectURL(gone.url)
      urls.current.delete(gone.url)
    }
    setPicked((now) => now.filter((each) => each.key !== key))
    setRefused([])
  }

  const send = async () => {
    if (!upload) {
      setFailed(NO_UPLOAD)
      return
    }
    setSending(true)
    setFailed(null)
    try {
      const stored = await upload(picked.map((each) => each.file))
      props.addResult({ answer: "uploaded", assets: stored.assets })
    } catch (error) {
      setFailed(
        error instanceof Error && error.message
          ? error.message
          : "The photos did not upload. Try again."
      )
      setSending(false)
    }
  }

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setOver(false)
    add(event.dataTransfer.files)
  }

  return (
    <div
      className="my-3 flex max-w-xl flex-col gap-3"
      data-slot="ask-upload"
      ref={cardRef}
    >
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-border border-dashed bg-card px-4 py-6 text-center transition-colors duration-150",
          "hover:border-primary/50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring",
          over && "border-primary bg-primary/5",
          sending && "pointer-events-none opacity-60"
        )}
        onDragLeave={() => setOver(false)}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDrop={drop}
      >
        <ImagesIcon aria-hidden className="size-6 text-primary" />
        <span className="font-medium text-sm">
          Drop photos here or choose them
        </span>
        <span className="text-muted-foreground text-xs" id={`${id}-limits`}>
          {typesText(input.accept)}, up to {sizeText(input.max_bytes)} each,{" "}
          {input.max_files} at most
        </span>
        <input
          accept={input.accept.join(",")}
          aria-describedby={`${id}-limits`}
          className="sr-only"
          disabled={sending}
          multiple={input.max_files > 1}
          onChange={(event) => {
            add(event.currentTarget.files)
            // The same file can be chosen again after it is taken out.
            event.currentTarget.value = ""
          }}
          type="file"
        />
      </label>
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
      {picked.length > 0 ? (
        <ul
          aria-label="Photos to upload"
          className="grid grid-cols-3 gap-2 sm:grid-cols-4"
        >
          {picked.map((each) => (
            <li className="relative" key={each.key}>
              <img
                alt={each.file.name}
                className="aspect-square w-full rounded-xl border border-border object-cover"
                src={each.url}
              />
              <Button
                aria-label={`Remove ${each.file.name}`}
                className="absolute top-1 right-1 size-7 rounded-full"
                disabled={sending}
                onClick={() => remove(each.key)}
                size="icon"
                type="button"
                variant="secondary"
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {failed ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {failed}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={picked.length === 0 || sending}
          onClick={send}
          size="sm"
          type="button"
        >
          {sending ? (
            <SpinnerGapIcon aria-hidden className="animate-spin" />
          ) : (
            <UploadSimpleIcon aria-hidden />
          )}
          {sending ? "Uploading" : "Upload photos"}
        </Button>
        {input.skippable ? (
          <Button
            disabled={sending}
            onClick={() => props.addResult({ answer: "skipped" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Skip for now
          </Button>
        ) : null}
        <span className="text-muted-foreground text-xs" role="status">
          {sending
            ? `Uploading ${picked.length === 1 ? "1 photo" : `${picked.length} photos`}`
            : picked.length > 0
              ? `${picked.length} of ${input.max_files} chosen`
              : ""}
        </span>
      </div>
    </div>
  )
}
AskUpload.displayName = "AskUpload"

export { AskUpload }
