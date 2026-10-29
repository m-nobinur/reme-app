import {
  makeAssistantDataUI,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import { BrainIcon } from "@phosphor-icons/react"
import {
  type MemoryChip,
  RememberInput,
  RememberOutput,
} from "@workspace/contracts"

const WORDS = {
  added: (text: string) => text,
  changed: (text: string) => `${text} (updated)`,
  removed: (text: string) => `removed "${text}"`,
} as const

type Change = Pick<MemoryChip["changes"][number], "kind" | "text">

/** One change in a few words, the owner's own line in it. */
export const memoryChangeText = (change: Change) =>
  WORDS[change.kind](change.text)

/** What a chip says: each change in a few words. */
export const memoryChipText = ({ changes }: { changes: readonly Change[] }) =>
  `Saved to memory: ${changes.map(memoryChangeText).join("; ")}`

/** What a saved `remember` call changed, or nothing for one that did not save. */
const remembered = (input: unknown, output: unknown): Change[] => {
  const call = RememberInput.safeParse(input)
  const saved = RememberOutput.safeParse(output)
  if (!call.success || saved.data?.outcome !== "saved") return []
  return call.data.operations.map((op) => ({
    kind:
      op.action === "add"
        ? "added"
        : op.action === "replace"
          ? "changed"
          : "removed",
    // A removal names a piece of its line; the next chip says the whole line.
    text: (op.action === "remove" ? op.match : op.text) ?? "",
  }))
}

/**
 * A saved `remember` call, said in the turn that made it, so the chip never
 * lands under the next message.
 */
export const Remembered: ToolCallMessagePartComponent = ({ args, result }) => {
  const changes = remembered(args, result)
  return changes.length ? <ChipLine changes={changes} /> : null
}

/**
 * The line under a reply that says what the assistant remembered since the
 * owner last looked (`data-memory`), less what a `remember` call in the
 * thread already said. The page it links to has the undo.
 */
function MemoryChipPart({ data }: { data: MemoryChip }) {
  // One string, so the selector's answer compares equal between renders.
  const said = useAuiState((s) =>
    s.thread.messages
      .flatMap((message) =>
        message.content.flatMap((part) =>
          part.type === "tool-call" && part.toolName === "remember"
            ? remembered(part.args, part.result).map((each) => each.text)
            : []
        )
      )
      .join("\n")
  )
  const changes = data.changes.filter(
    (change) =>
      !said.split("\n").some((text) => text && change.text.includes(text))
  )
  return changes.length ? <ChipLine changes={changes} /> : null
}

function ChipLine({ changes }: { changes: readonly Change[] }) {
  return (
    <p
      className="mb-2 flex items-start gap-2 text-muted-foreground text-sm"
      data-slot="memory-chip"
    >
      <BrainIcon aria-hidden className="mt-0.5 shrink-0" />
      <span className="wrap-break-word min-w-0">
        {memoryChipText({ changes })}.{" "}
        <a className="underline underline-offset-4" href="/app/memory">
          Review or undo
        </a>
      </span>
    </p>
  )
}

export const MemoryChipUI = makeAssistantDataUI<MemoryChip>({
  name: "memory",
  render: MemoryChipPart,
})
