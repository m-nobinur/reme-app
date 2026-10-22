import { makeAssistantDataUI } from "@assistant-ui/react"
import type { ChangeAsked } from "@workspace/contracts"
import { Done } from "@workspace/ui/components/assistant/decision"
import { CHANGE_ASKED_NEXT, changeAsked } from "@workspace/ui/lib/activity-copy"
import { cn, META } from "@workspace/ui/lib/utils"

/**
 * A change the owner asked for in the panel (`data-change_asked`), already
 * under way: their words in one resolved line, and where the result will show.
 */
function ChangeAskedPart({ data }: { data: ChangeAsked }) {
  return (
    <section
      className="my-3 flex max-w-md flex-col gap-1"
      data-slot="change-asked"
    >
      <Done>
        <span className="break-words">{changeAsked(data.text)}</span>
      </Done>
      <p className={cn(META, "pl-6")}>{CHANGE_ASKED_NEXT}</p>
    </section>
  )
}

export const ChangeAskedUI = makeAssistantDataUI<ChangeAsked>({
  name: "change_asked",
  render: ChangeAskedPart,
})
