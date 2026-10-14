import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import {
  BlueprintIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
} from "@phosphor-icons/react"
import type { Blueprint } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { useComposeWith } from "@workspace/ui/hooks/use-composer-input"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import {
  CHANGE_PREFIX,
  changedRows,
  directionLabel,
  generatedLine,
  pageRows,
  pairOfBlueprint,
  paletteName,
  paletteStops,
} from "@workspace/ui/lib/blueprint"
import { CARD_SURFACE } from "@workspace/ui/lib/card"
import { faceCss, faceStack, previewFaces } from "@workspace/ui/lib/font-faces"
import { blueprintReviewView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react"

/**
 * The plan the owner reads before anything is built: an icon, "Blueprint" and
 * the site's name, always shown, over a "Review feature plan" collapsible of
 * two pages, the feature plan and the design. "Build it" starts the build; "Change something" puts the owner
 * in the composer with a prefix to finish, and the message they send is the
 * answer (`change`), which re-plans. A re-plan draws the same card with the
 * rows that differ from the plan before marked "Changed". Read-only, with no
 * actions, it is the copy the panel keeps of what the site was built from.
 * The pair is set in its own faces, loaded only while the design page shows.
 */

/** The site's name, which a Blueprint does not carry. The app provides it. */
const SiteNameContext = createContext<string | null>(null)
export const SiteNameProvider = SiteNameContext.Provider

const PAGE_TITLES = ["Feature plan", "Design"] as const

/** A row's mark when a re-plan changed it. Text, not colour alone. */
function Changed({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl",
        on && "-mx-2 bg-primary/10 px-2 py-1 ring-1 ring-primary/30"
      )}
      data-changed={on || undefined}
    >
      {/* The text wraps in its own column; the tag stays at the end of the row. */}
      <div className="min-w-0 flex-1">{children}</div>
      {on ? (
        <span className="shrink-0 whitespace-nowrap font-medium text-primary text-xs leading-5">
          Changed
        </span>
      ) : null}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex @lg:grid @lg:grid-cols-[6.5rem_minmax(0,1fr)] flex-col @lg:gap-3 gap-1">
      <dt className="@lg:pt-0.5 font-medium text-muted-foreground text-xs">
        {label}
      </dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function Features({
  blueprint,
  changed,
}: {
  blueprint: Blueprint
  changed: Set<string>
}) {
  return (
    <ul aria-label="Features" className="flex flex-col gap-1.5">
      {blueprint.features.map((feature) => (
        <li key={feature}>
          <Changed on={changed.has(`feature:${feature}`)}>
            <span className="inline-flex items-start gap-2 text-sm">
              <CheckIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-primary"
              />
              <span>{feature}</span>
            </span>
          </Changed>
        </li>
      ))}
    </ul>
  )
}

function Design({
  blueprint,
  changed,
  photoDirection,
}: {
  blueprint: Blueprint
  changed: Set<string>
  photoDirection: string | undefined
}) {
  const stops = paletteStops(blueprint.palette)
  const pair = pairOfBlueprint(blueprint.fonts)
  // Only this pair's two faces, so the card fetches two files, not fourteen.
  const faces = previewFaces().filter(
    (f) =>
      (f.family === pair.display && f.weight === pair.weight) ||
      (f.family === pair.body && f.weight === 400)
  )
  return (
    <dl className="flex flex-col gap-3">
      <style>{faceCss(faces)}</style>
      <Row label="Direction">
        <Changed on={changed.has("direction")}>
          {directionLabel(blueprint.direction)}
        </Changed>
      </Row>
      <Row label="Colours">
        <Changed on={changed.has("palette")}>
          <span className="flex items-center gap-3">
            {/* The site's own colours, whatever the app's theme, with a hairline so a white stop shows. */}
            <span
              aria-hidden
              className="flex h-7 w-32 shrink-0 overflow-hidden rounded-lg ring-1 ring-foreground/15"
            >
              {stops.map((color) => (
                <span
                  className="h-full flex-1"
                  key={color}
                  style={{ backgroundColor: color }}
                />
              ))}
            </span>
            <span className="min-w-0 truncate">
              {paletteName(blueprint.palette)}
            </span>
          </span>
        </Changed>
      </Row>
      <Row label="Lettering">
        <Changed on={changed.has("fonts")}>
          <span className="flex flex-col">
            <span
              className="truncate text-lg leading-tight"
              style={{
                fontFamily: faceStack(pair.display),
                fontWeight: pair.weight,
              }}
            >
              Title · {pair.display}
            </span>
            <span
              className="truncate text-muted-foreground"
              style={{ fontFamily: faceStack(pair.body) }}
            >
              Body · {pair.body}
            </span>
          </span>
        </Changed>
      </Row>
      <Row label="Pages">
        <ol className="flex flex-col gap-1.5">
          {pageRows(blueprint).map((page) => (
            <li key={page.key}>
              <Changed on={changed.has(page.key)}>
                <span className="font-medium">{page.label}</span>
                <span className="text-foreground/75">
                  {" "}
                  · {page.sections.join(", ")}
                </span>
              </Changed>
            </li>
          ))}
        </ol>
      </Row>
      <Row label="Photos">
        <Changed on={changed.has("photos")}>
          {photoDirection ? <p>{photoDirection}</p> : null}
          <p className={photoDirection ? "text-muted-foreground" : undefined}>
            {generatedLine(blueprint)}
          </p>
        </Changed>
      </Row>
    </dl>
  )
}

export type BlueprintCardProps = {
  blueprint: Blueprint
  /** The plan this one replaces, for the "Changed" marks on a re-plan. */
  previous?: Blueprint | null
  /** The business's name; falls back to the provider's, then "Your website". */
  name?: string
  /** One line on the photo style, from the direction. */
  photoDirection?: string
  /** No actions: the panel's copy of what the site was built from. */
  readOnly?: boolean
  defaultOpen?: boolean
  className?: string
  onBuild?: () => void
  /** Called after the owner is handed to the composer. */
  onChange?: () => void
}

export function BlueprintCard({
  blueprint,
  previous,
  name,
  photoDirection,
  readOnly = false,
  defaultOpen = true,
  className,
  onBuild,
  onChange,
}: BlueprintCardProps) {
  const provided = useContext(SiteNameContext)
  const site = name ?? provided ?? "Your website"
  const compose = useComposeWith()
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [page, setPage] = useState(0)
  const [writing, setWriting] = useState(false)
  const changed = changedRows(previous, blueprint)
  const last = PAGE_TITLES.length - 1
  const go = (to: number) => setPage(Math.min(last, Math.max(0, to)))
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        CARD_SURFACE,
        "@container my-3 flex max-w-2xl flex-col",
        className
      )}
      data-slot="blueprint-card"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
        >
          <BlueprintIcon className="size-5" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm" id={`${id}-title`}>
          <span className="font-medium">Blueprint</span>
          <span className="text-muted-foreground"> · {site}</span>
        </h3>
      </div>
      <Collapsible className="mt-4" onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-2xl border border-border px-3 py-2 text-left font-medium text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring">
          <span className="min-w-0 flex-1">Review feature plan</span>
          <CaretDownIcon
            aria-hidden
            className={cn("size-4 shrink-0", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-4 pt-4">
            <h4 className="font-medium text-sm">{PAGE_TITLES[page]}</h4>
            {page === 0 ? (
              <Features blueprint={blueprint} changed={changed} />
            ) : (
              <Design
                blueprint={blueprint}
                changed={changed}
                photoDirection={photoDirection}
              />
            )}
            <div className="flex items-center gap-1">
              <Button
                aria-disabled={page === 0 || undefined}
                aria-label={`Previous: ${PAGE_TITLES[0]}`}
                className="aria-disabled:opacity-40"
                onClick={() => go(page - 1)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <CaretLeftIcon aria-hidden />
              </Button>
              {/* Announced politely, so a screen reader hears which page it is on. */}
              <span
                aria-live="polite"
                className="min-w-12 text-center text-muted-foreground text-sm tabular-nums"
              >
                <span aria-hidden>
                  {page + 1} / {PAGE_TITLES.length}
                </span>
                <span className="sr-only">
                  {PAGE_TITLES[page]}, page {page + 1} of {PAGE_TITLES.length}
                </span>
              </span>
              <Button
                aria-disabled={page === last || undefined}
                aria-label={`Next: ${PAGE_TITLES[last]}`}
                className="aria-disabled:opacity-40"
                onClick={() => go(page + 1)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <CaretRightIcon aria-hidden />
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {readOnly ? null : (
        <>
          {/* Always in reach: the owner can build without opening the plan. */}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <Button
              onClick={() => {
                setWriting(true)
                compose(CHANGE_PREFIX)
                onChange?.()
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Change something
            </Button>
            <Button onClick={onBuild} size="sm" type="button">
              Build it
            </Button>
          </div>
          <p
            className={cn(
              "mt-3 text-muted-foreground text-xs",
              writing ? null : "sr-only"
            )}
            role="status"
          >
            {writing
              ? "Write what to change in the message box below and send it. Your message updates this plan."
              : ""}
          </p>
        </>
      )}
    </section>
  )
}

/** The plan before the one at `toolCallId`, in the thread, for the "Changed" marks. */
function usePreviousPlan(toolCallId: string): Blueprint | null {
  return useAuiState((s) => {
    type Call = { toolCallId: string; args: { blueprint?: Blueprint } }
    const plans = s.thread.messages
      .flatMap((m) => m.content as readonly { type: string }[])
      .filter(
        (p): p is { type: "tool-call" } & Call =>
          p.type === "tool-call" &&
          (p as { toolName?: string }).toolName === "review_blueprint"
      )
    const at = plans.findIndex((p) => p.toolCallId === toolCallId)
    return at > 0 ? (plans[at - 1]?.args.blueprint ?? null) : null
  })
}

const ReviewBlueprint: ToolCallMessagePartComponent = (props) => {
  const view = blueprintReviewView(props)
  useRevealWaiting(view.state === "pending")
  const previous = usePreviousPlan(props.toolCallId)
  if (view.state === "answered") return null
  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-2xl" data-slot="blueprint-card">
        <p
          className={cn(
            "text-sm",
            view.state === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {view.state === "error"
            ? view.message
            : "You replied in the chat instead."}
        </p>
      </div>
    )
  }
  return (
    <BlueprintCard
      blueprint={view.input.blueprint}
      onBuild={() => props.addResult({ decision: "build" })}
      previous={previous}
    />
  )
}
ReviewBlueprint.displayName = "ReviewBlueprint"

export { ReviewBlueprint }
