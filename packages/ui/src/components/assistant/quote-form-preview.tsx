import type { QuoteField } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field } from "@workspace/ui/components/field"
import { Input, inputStyles } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import { useId, useState } from "react"

/**
 * The request form as customers meet it, in the app's own look: the contact
 * questions the site always asks, then each question by type. The words are
 * the starter site's defaults (`site-config.ts`), since the site's brand may
 * not be chosen yet. The controls work so the owner can try them, but nothing
 * is sent or kept: the form is not submitted and closing it forgets the
 * answers. It opens as a modal, and as a sheet from the bottom on a phone.
 */

const WORDS = {
  details: "Your details",
  request: "Your request",
  name: "Your name",
  email: "Email address",
  phone: "Phone number",
  choose: "Choose one",
  photoLinks: "Links to photos, one per line",
  optional: "optional",
  submit: "Send quote request",
}

const CONTACT: QuoteField[] = [
  question("name", WORDS.name, "text", true),
  question("email", WORDS.email, "email", true),
  question("phone", WORDS.phone, "tel", false),
]

function question(
  key: string,
  label: string,
  type: QuoteField["type"],
  required: boolean
): QuoteField {
  return { key, label, type, required, hint: null, options: null }
}

/** The browser's input type, where it differs from the question's. */
const INPUT_TYPE: Partial<Record<QuoteField["type"], string>> = {
  datetime: "datetime-local",
}

const AUTOCOMPLETE: Partial<Record<QuoteField["type"], string>> = {
  email: "email",
  tel: "tel",
}

const TEXTAREA = cn(inputStyles, "h-auto min-h-20 py-2")

/** A question's label, with the word the site adds when it can be left out. */
function Label({ field }: { field: QuoteField }) {
  return (
    <>
      {field.label}
      {field.required ? null : (
        <>
          {" "}
          <span className="ms-0.5 text-muted-foreground text-xs">
            {WORDS.optional}
          </span>
        </>
      )}
    </>
  )
}

/** A radio or checkbox group: a native fieldset, so the browser walks and announces it. */
function Choices({ field, id }: { field: QuoteField; id: string }) {
  const hintId = `${id}-hint`
  return (
    <fieldset
      aria-describedby={field.hint ? hintId : undefined}
      className="flex flex-col gap-2"
    >
      <legend className="mb-2 text-sm">
        <Label field={field} />
      </legend>
      <div className="flex flex-col">
        {field.options?.map((option) => (
          <label
            className="flex min-h-9 cursor-pointer items-center gap-2 text-sm"
            key={option}
          >
            <input
              className="size-4 accent-primary"
              name={field.key}
              type={field.type === "radio" ? "radio" : "checkbox"}
              value={option}
            />
            {option}
          </label>
        ))}
      </div>
      {field.hint ? (
        <p className="text-muted-foreground text-xs" id={hintId}>
          {field.hint}
        </p>
      ) : null}
    </fieldset>
  )
}

/** One question as its type draws it. */
function Question({ field, scope }: { field: QuoteField; scope: string }) {
  const id = `${scope}-${field.key}`
  if (field.type === "radio" || field.type === "checkbox") {
    return <Choices field={field} id={id} />
  }
  return (
    <Field hint={field.hint} id={id} label={<Label field={field} />}>
      {(wiring) => {
        if (field.type === "textarea") {
          return (
            <textarea
              {...wiring}
              className={TEXTAREA}
              maxLength={2000}
              name={field.key}
              rows={5}
            />
          )
        }
        if (field.type === "select") {
          return (
            <select
              {...wiring}
              className={inputStyles}
              defaultValue=""
              name={field.key}
            >
              <option value="">{WORDS.choose}</option>
              {field.options?.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          )
        }
        if (field.type === "photos") {
          return (
            <div className="flex flex-col gap-2">
              <Input
                {...wiring}
                accept="image/jpeg,image/png,image/webp"
                multiple
                name={field.key}
                type="file"
              />
              <label
                className="text-muted-foreground text-xs"
                htmlFor={`${id}-links`}
              >
                {WORDS.photoLinks}
              </label>
              <textarea
                className={cn(TEXTAREA, "min-h-14")}
                id={`${id}-links`}
                maxLength={2000}
                name={`${field.key}_links`}
                rows={2}
              />
            </div>
          )
        }
        return (
          <Input
            {...wiring}
            autoComplete={AUTOCOMPLETE[field.type]}
            maxLength={field.type === "text" ? 200 : undefined}
            min={field.type === "number" ? 0 : undefined}
            name={field.key}
            type={INPUT_TYPE[field.type] ?? field.type}
          />
        )
      }}
    </Field>
  )
}

function Group({
  legend,
  fields,
  scope,
}: {
  legend: string
  fields: QuoteField[]
  scope: string
}) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-3 font-medium text-sm">{legend}</legend>
      {fields.map((field) => (
        <Question field={field} key={field.key} scope={scope} />
      ))}
    </fieldset>
  )
}

/**
 * The "Preview form" button and the modal it opens. "Looks good" in the
 * modal runs `onConfirm`, the same call as the card's own, and the modal
 * closes first so a refusal shows on the card.
 */
function QuoteFormPreview({
  fields,
  onConfirm,
}: {
  fields: QuoteField[]
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  const scope = useId()
  return (
    <>
      <Button
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        size="xs"
        type="button"
        variant="ghost"
      >
        Preview form
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          className={cn(
            "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl",
            "max-h-[min(46rem,calc(100dvh-2rem))]",
            // A phone's sheet rises from the bottom edge instead of fading in the middle.
            "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:data-ending-style:translate-y-full max-sm:data-starting-style:translate-y-full max-sm:data-ending-style:scale-100 max-sm:data-starting-style:scale-100"
          )}
        >
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle>Form preview</DialogTitle>
            <DialogDescription>
              This is how customers see your form. Try the questions as they
              would.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto border-border border-t px-5 py-5"
            noValidate
            onSubmit={(event) => event.preventDefault()}
          >
            <Group
              fields={CONTACT}
              legend={WORDS.details}
              scope={`${scope}-c`}
            />
            <Group
              fields={fields}
              legend={WORDS.request}
              scope={`${scope}-q`}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button disabled type="submit">
                {WORDS.submit}
              </Button>
              <p className="text-muted-foreground text-xs">
                This is a preview, so nothing is sent or saved.
              </p>
            </div>
          </form>
          <div className="flex flex-wrap justify-end gap-2 border-border border-t px-5 py-4">
            <Button
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
              type="button"
            >
              Looks good
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export { QuoteFormPreview }
