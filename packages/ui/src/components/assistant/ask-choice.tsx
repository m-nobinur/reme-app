import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import type { AskChoiceInput } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { askChoiceView, choiceText } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type FormEvent, useId, useRef, useState } from "react"

/**
 * A question onboarding answers from a short list: the industry, the
 * assistant's pronouns and tone, whether to build the site, and its
 * template, colours, type and pages. The question is the text part above;
 * the card is the options, as native radios or checkboxes so the arrow keys
 * and the screen reader know the group. Colour, type and template options
 * show what they are, drawn from the option's own data. Nothing is sent
 * until the owner presses Continue.
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

const AskChoice: ToolCallMessagePartComponent = (props) => {
  const view = askChoiceView(props)
  const id = useId()
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const formRef = useRef<HTMLFormElement>(null)
  useFocusWhenIdle(waiting, running, formRef)
  const [picked, setPicked] = useState<string[]>(() =>
    view.state === "pending" ? view.input.preselected : []
  )
  const [other, setOther] = useState("")
  const [invalid, setInvalid] = useState<string | null>(null)

  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-md" data-slot="ask-choice">
        {view.state === "answered" ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircleIcon
              aria-hidden
              className="size-4 shrink-0 text-primary"
            />
            <span className="min-w-0 break-words">
              {choiceText(view.input, view.output)}
            </span>
          </p>
        ) : (
          <p
            className={cn(
              "text-sm",
              view.state === "error"
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {view.state === "skipped"
              ? "Skipped. You can choose later."
              : view.state === "cancelled"
                ? "You replied in the chat instead."
                : view.message}
          </p>
        )}
      </div>
    )
  }

  const { input } = view
  const multiple = input.multiple
  const pictured = input.options.some((o) => o.visual)
  const hinted = input.options.some((o) => o.hint)
  const layout =
    pictured || hinted
      ? cn(
          "grid gap-2",
          input.options.some((o) => o.visual?.kind === "template")
            ? "grid-cols-1 sm:grid-cols-3"
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const words = otherPicked ? other.trim() : ""
    const ids = picked.filter((each) => each !== OTHER)
    if (otherPicked && !words) {
      setInvalid("Write your answer first.")
      return
    }
    if (ids.length === 0 && !words) {
      setInvalid(multiple ? "Pick at least one." : "Pick one first.")
      return
    }
    props.addResult({ answer: "chosen", ids, other: words || null })
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
            : "min-h-9 items-center rounded-full px-4 text-sm"
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
    <div className="my-3 flex max-w-2xl flex-col gap-2" data-slot="ask-choice">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={submit}
        ref={formRef}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-muted-foreground text-xs">
            {multiple ? "Pick any that fit" : "Pick one"}
          </legend>
          <div className={layout}>
            {input.options.map((each) => option(each.id, each.label, each))}
            {input.other ? option(OTHER, input.other.label) : null}
          </div>
        </fieldset>
        {input.other && otherPicked ? (
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
              onClick={() => props.addResult({ answer: "skipped" })}
              size="sm"
              type="button"
              variant="outline"
            >
              Skip for now
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  )
}
AskChoice.displayName = "AskChoice"

export { AskChoice }
