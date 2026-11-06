import {
  type GenerativeUILibrary,
  renderGenerativeUI,
} from "@assistant-ui/generative-ui/react"
import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon, CircleIcon } from "@phosphor-icons/react"
import { PRESENT_COMPONENTS } from "@workspace/contracts"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import type { ReactNode } from "react"
import type { z } from "zod"

type Name = keyof typeof PRESENT_COMPONENTS
type PropsOf<N extends Name> = z.infer<
  (typeof PRESENT_COMPONENTS)[N]["properties"]
>

/** The renderer checks only a node's name, so each node checks its own props: one that fails draws nothing. */
const checked = <N extends Name>(
  name: N,
  draw: (props: PropsOf<N>, children: ReactNode) => ReactNode
) => ({
  ...PRESENT_COMPONENTS[name],
  render: ({ children, ...props }: { children?: ReactNode }) => {
    const read = PRESENT_COMPONENTS[name].properties.safeParse(props)
    return read.success ? draw(read.data as PropsOf<N>, children) : null
  },
})

const LIBRARY = {
  Card: checked("Card", ({ title }, children) => (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground text-sm">
      {title ? <h3 className="font-medium">{title}</h3> : null}
      {children}
    </section>
  )),
  Fact: checked("Fact", ({ label, value }) => (
    <dl className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium">{value}</dd>
    </dl>
  )),
  Table: checked("Table", ({ columns, rows }) => (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
            <TableHead key={i}>{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
          <TableRow key={r}>
            {columns.map((_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
              <TableCell className="whitespace-normal" key={c}>
                {row[c] ?? ""}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )),
  Steps: checked("Steps", ({ steps }) => (
    <ol className="flex flex-col gap-2">
      {steps.map((step, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
        <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" key={i}>
          <span
            aria-hidden
            className="flex size-6 items-center justify-center rounded-full bg-muted font-medium text-xs"
          >
            {i + 1}
          </span>
          <span className="self-center">{step}</span>
        </li>
      ))}
    </ol>
  )),
  Checklist: checked("Checklist", ({ items }) => (
    <ul className="flex flex-col gap-2">
      {items.map(({ label, done }, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
        <li className="flex items-start gap-2" key={i}>
          {done ? (
            <CheckCircleIcon
              aria-hidden
              className="mt-px size-4.5 shrink-0 text-foreground"
              weight="fill"
            />
          ) : (
            <CircleIcon
              aria-hidden
              className="mt-px size-4.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className={done ? "text-muted-foreground" : undefined}>
            {label}
            <span className="sr-only">{done ? ", done" : ", to do"}</span>
          </span>
        </li>
      ))}
    </ul>
  )),
  Text: checked("Text", ({ text }) => <p>{text}</p>),
} satisfies GenerativeUILibrary

/**
 * A `present` call's tree, drawn from `PRESENT_COMPONENTS` with house
 * styles (#741). A name outside the vocabulary is dropped, never thrown.
 */
export const Present: ToolCallMessagePartComponent = ({ args, status }) => (
  <div className="my-3 max-w-xl text-sm" data-slot="present">
    {renderGenerativeUI(args, LIBRARY, {
      status: status.type === "running" ? "streaming" : "done",
    })}
  </div>
)
