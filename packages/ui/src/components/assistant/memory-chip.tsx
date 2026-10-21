import { makeAssistantDataUI } from "@assistant-ui/react"
import { BrainIcon } from "@phosphor-icons/react"
import type { MemoryChip } from "@workspace/contracts"

const WORDS = {
  added: (text: string) => text,
  changed: (text: string) => `${text} (updated)`,
  removed: (text: string) => `removed "${text}"`,
} as const

/** One change in a few words, the owner's own line in it. */
export const memoryChangeText = (change: MemoryChip["changes"][number]) =>
  WORDS[change.kind](change.text)

/** What a chip says: each change in a few words. */
export const memoryChipText = ({ changes }: MemoryChip) =>
  `Saved to memory: ${changes.map(memoryChangeText).join("; ")}`

/**
 * The line under a reply that says what the assistant remembered since the
 * owner last looked (`data-memory`). The page it links to has the undo.
 */
function MemoryChipPart({ data }: { data: MemoryChip }) {
  return (
    <p
      className="mb-2 flex items-start gap-2 text-muted-foreground text-sm"
      data-slot="memory-chip"
    >
      <BrainIcon aria-hidden className="mt-0.5 shrink-0" />
      <span className="wrap-break-word min-w-0">
        {memoryChipText(data)}.{" "}
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
