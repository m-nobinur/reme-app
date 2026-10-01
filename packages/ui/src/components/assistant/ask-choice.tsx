import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  CheckCircleIcon,
  EyedropperIcon,
  ShuffleIcon,
} from "@phosphor-icons/react"
import type { AskChoiceInput } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import {
  AA,
  hexColour,
  nextShown,
  textOn,
  whiteContrast,
} from "@workspace/ui/lib/colour"
import { askChoiceView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type FormEvent, useId, useRef, useState } from "react"

/**
 * A question onboarding answers from a short list: the industry, the
 * assistant's pronouns and tone, whether to build the site, and its
 * template, colours, type and pages. The question is the text part above;
 * the card is the options, as native radios or checkboxes so the arrow keys
 * and the screen reader know the group. Colour, type and template options
 * show what they are, drawn from the option's own data. A long list shows
 * the call's `initial` few and brings in others on Show others; a colour
 * card's Other is a colour picker. Nothing is sent until the owner presses
 * Continue. Once answered or skipped it shows nothing: the owner's reply
 * after it says what they picked.
 */

type Option = AskChoiceInput["options"][number]

/** The value the "Other" choice carries in the form. Not an option id. */
const OTHER = "__other__"

/**
 * A small wireframe of each starter template, in theme tokens: what the
 * three layouts do differently, the header, the hero and what follows it,
 * readable at a glance. Unknown ids draw the classic one.
 */
function TemplateSketch({ id }: { id: string }) {
  const block = "fill-muted-foreground/25"
  const ink = "fill-foreground/75"
  return (
    <svg
      aria-hidden
      className="h-auto w-full rounded-xl border border-border bg-background"
      data-template={id}
      viewBox="0 0 120 84"
    >
      {id === "modern" ? (
        <>
          <rect className={ink} height="4" rx="1" width="18" x="51" y="6" />
          <rect className={block} height="2" rx="1" width="40" x="40" y="13" />
          <rect className={ink} height="5" rx="1" width="60" x="30" y="22" />
          <rect className={block} height="2" rx="1" width="40" x="40" y="30" />
          <rect
            className="fill-primary"
            height="4"
            rx="2"
            width="16"
            x="52"
            y="35"
          />
          {[6, 44, 82].map((x) => (
            <rect
              className={block}
              height="16"
              key={x}
              rx="3"
              width="32"
              x={x}
              y="46"
            />
          ))}
          {[6, 44, 82].map((x) => (
            <rect
              className="fill-primary/15"
              height="12"
              key={x}
              rx="3"
              width="32"
              x={x}
              y="67"
            />
          ))}
        </>
      ) : id === "bold" ? (
        <>
          <rect className="fill-foreground" height="44" width="120" />
          <rect
            className="fill-background"
            height="4"
            rx="1"
            width="18"
            x="6"
            y="6"
          />
          {[64, 76, 88].map((x) => (
            <rect
              className="fill-background/50"
              height="2"
              key={x}
              rx="1"
              width="9"
              x={x}
              y="7"
            />
          ))}
          <rect
            className="fill-primary"
            height="6"
            rx="1"
            width="14"
            x="100"
            y="5"
          />
          <rect
            className="fill-background"
            height="6"
            rx="1"
            width="56"
            x="8"
            y="17"
          />
          <rect
            className="fill-background"
            height="6"
            rx="1"
            width="42"
            x="8"
            y="25"
          />
          <rect
            className="fill-primary"
            height="4"
            rx="1"
            width="16"
            x="8"
            y="35"
          />
          <rect className="fill-primary" height="13" width="120" y="44" />
          {[10, 50, 90].map((x) => (
            <rect
              className="fill-primary-foreground"
              height="5"
              key={x}
              rx="1"
              width="12"
              x={x}
              y="48"
            />
          ))}
          {[6, 44, 82].map((x) => (
            <rect
              className="fill-card stroke-foreground"
              height="18"
              key={x}
              rx="1"
              strokeWidth="1.2"
              width="32"
              x={x}
              y="61"
            />
          ))}
        </>
      ) : (
        <>
          <rect className={ink} height="4" rx="1" width="18" x="6" y="5" />
          {[62, 74, 86].map((x) => (
            <rect
              className={block}
              height="2"
              key={x}
              rx="1"
              width="9"
              x={x}
              y="6"
            />
          ))}
          <rect
            className="fill-primary"
            height="6"
            rx="1"
            width="12"
            x="102"
            y="4"
          />
          <rect className="fill-primary/10" height="36" width="120" y="13" />
          <rect className={ink} height="5" rx="1" width="40" x="8" y="20" />
          <rect className={ink} height="5" rx="1" width="30" x="8" y="27" />
          <rect className={block} height="2" rx="1" width="34" x="8" y="35" />
          <rect
            className="fill-primary"
            height="4"
            rx="1"
            width="14"
            x="8"
            y="40"
          />
          <rect
            className="fill-primary/25"
            height="28"
            rx="3"
            width="46"
            x="66"
            y="17"
          />
          <circle className="fill-primary" cx="99" cy="36" r="6" />
          {[6, 44, 82].map((x) => (
            <rect
              className="fill-card stroke-border"
              height="22"
              key={x}
              rx="2"
              width="32"
              x={x}
              y="55"
            />
          ))}
        </>
      )}
    </svg>
  )
}

/** What an option looks like beside its label, from its own data. */
function Visual({ visual }: { visual: Option["visual"] }) {
  if (!visual) return null
  if (visual.kind === "template") return <TemplateSketch id={visual.id} />
  if (visual.kind === "font") {
    return (
      <span
        aria-hidden
        className="block truncate text-2xl leading-tight"
        style={{ fontFamily: visual.family }}
      >
        Aa Bb Cc
      </span>
    )
  }
  return (
    <span aria-hidden className="flex gap-1.5">
      {visual.colors.map((color) => (
        <span
          className="size-6 rounded-full border border-foreground/10"
          key={color}
          // Colour data from the call, never a literal in code.
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

/**
 * The Other of a colour card: the native picker and a text field that
 * share one value. The field takes a colour code, which the picker follows,
 * or words, which go as they are. A code gets a sample button and, when
 * white text would not read on it, a note saying so.
 */
function ColourField({
  label,
  placeholder,
  value,
  fallback,
  invalid,
  onChange,
}: {
  label: string
  placeholder: string
  value: string
  /** What the picker shows before the owner gives a code. */
  fallback: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  const hex = hexColour(value)
  const contrast = hex ? whiteContrast(hex) : null
  return (
    <div className="flex max-w-md flex-col gap-2">
      <label className="font-medium text-sm" htmlFor={`${id}-text`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          aria-label="Pick a colour"
          className="size-9 shrink-0 cursor-pointer rounded-full border border-border bg-transparent p-0.5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0"
          onChange={(event) => onChange(event.currentTarget.value)}
          type="color"
          value={hex ?? fallback}
        />
        <Input
          aria-describedby={hex ? `${id}-note` : undefined}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          id={`${id}-text`}
          maxLength={200}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
        />
      </div>
      {hex && contrast !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className="inline-flex h-8 items-center rounded-full border border-foreground/10 px-3 font-medium text-xs"
            // The owner's colour and the text that reads on it: data, not literals.
            style={{ backgroundColor: hex, color: textOn(hex) }}
          >
            Request a quote
          </span>
          <p
            className={cn(
              "text-xs",
              contrast < AA ? "text-foreground" : "text-muted-foreground"
            )}
            id={`${id}-note`}
          >
            {contrast < AA
              ? `White text is hard to read on this colour (${contrast.toFixed(1)}:1, ${AA}:1 needed). Your site will use a darker shade of it for text.`
              : `White text reads well on this colour (${contrast.toFixed(1)}:1).`}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Where a card starts, when it does not start fresh: the options shown and
 * the owner's own answer already open. The catalog draws the colour card's
 * states with it.
 */
type Start = { shown?: string[]; other?: string }

/**
 * The open card: the options as a native group, Other and its field, and
 * Continue. `onAnswer` gets the answer `AskChoiceOutput` takes.
 */
function ChoiceForm({
  input,
  onAnswer,
  start,
}: {
  input: AskChoiceInput
  onAnswer: (
    answer:
      | { answer: "chosen"; ids: string[]; other: string | null }
      | { answer: "skipped" }
  ) => void
  start?: Start
}) {
  const id = useId()
  const [picked, setPicked] = useState<string[]>(() =>
    start?.other !== undefined ? [OTHER] : input.preselected
  )
  const [other, setOther] = useState(start?.other ?? "")
  const [invalid, setInvalid] = useState<string | null>(null)
  const [shown, setShown] = useState(() => start?.shown ?? input.initial)
  const [seen, setSeen] = useState(() => shown ?? [])
  const [announced, setAnnounced] = useState("")

  const multiple = input.multiple
  const color = input.color === true && input.other !== null
  const options = shown
    ? shown.flatMap((each) => input.options.find((o) => o.id === each) ?? [])
    : input.options
  const pictured = input.options.some((o) => o.visual)
  const hinted = input.options.some((o) => o.hint)
  const layout =
    pictured || hinted
      ? cn(
          "grid gap-2",
          input.options.some((o) => o.visual?.kind === "template")
            ? "grid-cols-1 sm:grid-cols-3"
            : shown
              ? "grid-cols-2 sm:grid-cols-5"
              : "grid-cols-2 sm:grid-cols-3"
        )
      : "flex flex-wrap gap-2"
  const otherPicked = picked.includes(OTHER)

  const toggle = (value: string, on: boolean) => {
    setInvalid(null)
    setPicked((now) =>
      multiple
        ? on
          ? [...now, value]
          : now.filter((each) => each !== value)
        : on
          ? [value]
          : now
    )
  }

  const showOthers = () => {
    if (!shown) return
    const next = nextShown(
      input.options.map((o) => o.id),
      shown,
      seen
    )
    setShown(next.shown)
    setSeen(next.seen)
    setPicked((now) =>
      now.filter((each) => each === OTHER || next.shown.includes(each))
    )
    const labels = next.shown.map(
      (each) => input.options.find((o) => o.id === each)?.label ?? each
    )
    setAnnounced(
      `Showing ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}.`
    )
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const typed = otherPicked ? other.trim() : ""
    const words = color ? (hexColour(typed) ?? typed) : typed
    const ids = picked.filter((each) => each !== OTHER)
    if (otherPicked && !words) {
      setInvalid(
        color
          ? "Pick a colour or describe it first."
          : "Write your answer first."
      )
      return
    }
    if (color && words.startsWith("#") && !hexColour(words)) {
      setInvalid("A colour code is # and six digits or letters from a to f.")
      return
    }
    if (ids.length === 0 && !words) {
      setInvalid(multiple ? "Pick at least one." : "Pick one first.")
      return
    }
    onAnswer({ answer: "chosen", ids, other: words || null })
  }

  const option = (value: string, label: string, rest?: Option) => {
    const checked = picked.includes(value)
    return (
      <label
        className={cn(
          "relative flex cursor-pointer border border-border bg-card text-card-foreground transition-colors duration-150",
          "hover:border-primary/50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring",
          "has-[:checked]:border-primary has-[:checked]:bg-primary/5",
          pictured || hinted
            ? "flex-col gap-2 rounded-2xl p-3"
            : "min-h-9 items-center rounded-full px-4 text-sm",
          value === OTHER && color && "border-dashed"
        )}
        key={value}
      >
        <input
          checked={checked}
          className="sr-only"
          name={`${id}-choice`}
          onChange={(event) => toggle(value, event.currentTarget.checked)}
          type={multiple ? "checkbox" : "radio"}
          value={value}
        />
        {rest?.visual ? <Visual visual={rest.visual} /> : null}
        {value === OTHER && color ? (
          <EyedropperIcon
            aria-hidden
            className="size-6 text-muted-foreground"
          />
        ) : null}
        <span
          className={cn(
            "flex items-center gap-1.5",
            (pictured || hinted) && "font-medium text-sm"
          )}
        >
          {label}
          {checked && (pictured || hinted) ? (
            <CheckCircleIcon
              aria-hidden
              className="ml-auto size-4 shrink-0 text-primary"
              weight="fill"
            />
          ) : null}
        </span>
        {rest?.hint ? (
          <span className="text-muted-foreground text-xs">{rest.hint}</span>
        ) : null}
      </label>
    )
  }

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-muted-foreground text-xs">
          {multiple ? "Pick any that fit" : "Pick one"}
        </legend>
        <div className={layout}>
          {options.map((each) => option(each.id, each.label, each))}
          {input.other ? option(OTHER, input.other.label) : null}
        </div>
      </fieldset>
      {shown && shown.length < input.options.length ? (
        <div>
          <Button onClick={showOthers} size="sm" type="button" variant="ghost">
            <ShuffleIcon aria-hidden />
            {color ? "Show other colours" : "Show other options"}
          </Button>
          <p aria-live="polite" className="sr-only">
            {announced}
          </p>
        </div>
      ) : null}
      {input.other && otherPicked ? (
        color ? (
          <ColourField
            fallback={
              (input.options[0]?.visual?.kind === "swatches"
                ? input.options[0].visual.colors[0]
                : undefined) ?? ""
            }
            invalid={invalid !== null}
            label={input.other.label}
            onChange={(value) => {
              setInvalid(null)
              setOther(value)
            }}
            placeholder={input.other.placeholder}
            value={other}
          />
        ) : (
          <Input
            aria-invalid={invalid !== null || undefined}
            aria-label={input.other.label}
            className="max-w-md"
            maxLength={200}
            onChange={(event) => {
              setInvalid(null)
              setOther(event.currentTarget.value)
            }}
            placeholder={input.other.placeholder}
            value={other}
          />
        )
      ) : null}
      {invalid ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {invalid}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit">
          Continue
        </Button>
        {input.skippable ? (
          <Button
            onClick={() => onAnswer({ answer: "skipped" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Skip for now
          </Button>
        ) : null}
      </div>
    </form>
  )
}

const AskChoice: ToolCallMessagePartComponent = (props) => {
  const view = askChoiceView(props)
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusWhenIdle(waiting, running, cardRef)

  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-md" data-slot="ask-choice">
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

  return (
    <div
      className="my-3 flex max-w-2xl flex-col gap-2"
      data-slot="ask-choice"
      ref={cardRef}
    >
      <ChoiceForm input={view.input} onAnswer={props.addResult} />
    </div>
  )
}
AskChoice.displayName = "AskChoice"

export { AskChoice, ChoiceForm }
