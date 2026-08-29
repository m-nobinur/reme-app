import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react"
import { Field } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  lengthOnlyVerdict,
  PASSWORD_POLICY,
  type PasswordVerdict,
  STRENGTH_LABELS,
  scorePassword,
} from "@workspace/ui/lib/password-policy"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * The toggle's accessible name, hoisted out of the JSX rather than written
 * inline as a ternary. Inline, the two strings sit either side of a colon, and
 * `.githooks/secret-scan` reads that as the keyword, a colon and a long quoted
 * value — the shape of a committed credential. The gate is right to be blunt
 * about that shape; this is the cheaper side of the trade.
 */
const TOGGLE_LABEL = ["Show password", "Hide password"] as const

/**
 * The four segments under the field.
 *
 * Two colours, not five, because there are only two answers a person can act
 * on: this will be accepted, or it will not. A green-to-red ramp would give a
 * refused password a hopeful amber, which is the same lie a meter that scores
 * generously tells. Segments fill with the zxcvbn score so the distance left to
 * travel is still visible.
 *
 * Decoration only. `aria-hidden`, because the label and warning beneath it say
 * the same thing in words, and a screen reader should hear it once.
 */
function StrengthBar({ verdict }: { verdict: PasswordVerdict }) {
  return (
    <span aria-hidden className="mt-1 flex gap-1">
      {[1, 2, 3, 4].map((step) => (
        <span
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-200",
            step <= verdict.score
              ? verdict.acceptable
                ? "bg-primary"
                : "bg-destructive"
              : "bg-border"
          )}
          key={step}
        />
      ))}
    </span>
  )
}

/**
 * A password input with the two things a person needs and one they should not
 * have to ask for: whether they can see what they typed, and whether what they
 * typed will be accepted.
 *
 * Uncontrolled. The value lives in the DOM and is read from the form on submit,
 * which is what makes typing before hydration survive it: a controlled input
 * hydrates back to its React state and throws away whatever was typed into the
 * markup first. The local copy below exists only to score, and is seeded from
 * the DOM on mount for exactly that reason.
 *
 * `strength` is opt-in. It belongs on a password being chosen and not on one
 * being recalled: rating the password someone already has is noise, and on a
 * sign-in form it also spends a megabyte of dictionary to tell them nothing.
 */
function PasswordField({
  label,
  id,
  name,
  hint,
  error,
  strength = false,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "id" | "type"> & {
  label: string
  id: string
  name: string
  hint?: ReactNode
  error?: string
  /** Renders the meter, and holds it to the policy the environment enforces. */
  strength?: boolean
}) {
  const [visible, setVisible] = useState(false)
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const [verdict, setVerdict] = useState<PasswordVerdict | null>(null)
  // Scoring walks a dictionary, so it runs behind the keystroke rather than in
  // front of it. The input never waits on the meter.
  const deferred = useDeferredValue(value)
  const meterId = useId()

  // A value typed into the server-rendered markup is already in the DOM by the
  // time this runs. Without it the meter reads empty for a password that is not.
  useEffect(() => {
    if (inputRef.current?.value) {
      setValue(inputRef.current.value)
    }
  }, [])

  useEffect(() => {
    if (!strength || deferred.length === 0) {
      setVerdict(null)
      return
    }
    let current = true
    // Something to show while the dictionary is still arriving: the length rule
    // needs no dictionary and is half the policy.
    setVerdict((shown) => shown ?? lengthOnlyVerdict(deferred))
    // Fire and forget on purpose, and it cannot reject: the dictionary import
    // has its own catch, and a scorer that fell over anyway must not take the
    // form down with it. WorkOS is the authority on strength either way.
    void scorePassword(deferred).then((next) => {
      if (current) {
        setVerdict(next)
      }
    })
    return () => {
      current = false
    }
  }, [deferred, strength])

  return (
    <Field
      className={className}
      error={error}
      hint={
        strength ? (
          <>
            {hint}
            {verdict ? (
              <span
                // Described-by and live at once, which is the behaviour wanted
                // from one node: read when the field takes focus, and read again
                // when the verdict changes under typing.
                aria-live="polite"
                className="mt-1.5 block"
                id={meterId}
              >
                <StrengthBar verdict={verdict} />
                <span className="mt-1 block">
                  <span
                    className={cn(
                      "font-medium",
                      verdict.acceptable
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {verdict.meetsLength
                      ? verdict.scored
                        ? STRENGTH_LABELS[verdict.score]
                        : "Checking"
                      : `${PASSWORD_POLICY.minLength - deferred.length} more character${PASSWORD_POLICY.minLength - deferred.length === 1 ? "" : "s"} needed`}
                  </span>
                  {verdict.warning ? ` ${verdict.warning}` : null}
                  {!verdict.warning && verdict.suggestions.length > 0
                    ? ` ${verdict.suggestions[0]}`
                    : null}
                </span>
              </span>
            ) : null}
          </>
        ) : (
          hint
        )
      }
      id={id}
      label={label}
    >
      {(wiring) => (
        <span className="relative block">
          <Input
            {...wiring}
            {...props}
            className="pr-11"
            name={name}
            onChange={(event) => {
              setValue(event.target.value)
              props.onChange?.(event)
            }}
            ref={inputRef}
            type={visible ? "text" : "password"}
          />
          <button
            aria-controls={wiring.id}
            // Both, on purpose. The state is what `aria-pressed` is for, and
            // the name is what a person navigating by control list hears; a bare
            // icon with a fixed label leaves one of the two wrong at all times.
            aria-pressed={visible}
            className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
            onClick={() => setVisible((shown) => !shown)}
            // Never a submit. Inside a form, a button with no type is one.
            type="button"
          >
            {visible ? (
              <EyeSlashIcon aria-hidden className="size-4" />
            ) : (
              <EyeIcon aria-hidden className="size-4" />
            )}
            <span className="sr-only">{TOGGLE_LABEL[visible ? 1 : 0]}</span>
          </button>
        </span>
      )}
    </Field>
  )
}

export { PasswordField, StrengthBar }
