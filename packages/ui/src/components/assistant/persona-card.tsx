import { makeAssistantDataUI } from "@assistant-ui/react"
import { type PersonaCard, PRONOUNS, TONES } from "@workspace/contracts"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { presetLabel } from "@workspace/ui/lib/tool-state"

/**
 * The assistant as the owner just set it up (`data-persona`), in the reply
 * to the assistant set-up: its face, its name, then pronouns and tone.
 */
function PersonaCardPart({ data }: { data: PersonaCard }) {
  return (
    <section
      aria-label="Your assistant"
      className="my-3 flex w-fit max-w-full items-center gap-3 rounded-2xl border border-border bg-card py-3 ps-3 pe-5 text-card-foreground"
      data-slot="persona-card"
    >
      <AssistantAvatar className="size-12" id={data.avatar} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{data.name}</span>
        <span className="text-muted-foreground text-sm">
          {presetLabel(PRONOUNS, data.pronouns)} ·{" "}
          {presetLabel(TONES, data.tone)}
        </span>
      </div>
    </section>
  )
}

export const PersonaCardUI = makeAssistantDataUI<PersonaCard>({
  name: "persona",
  render: PersonaCardPart,
})
