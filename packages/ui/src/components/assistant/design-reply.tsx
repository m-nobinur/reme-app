import type { AskDesignInput, AskDesignOutput } from "@workspace/contracts"
import { useTrayServices } from "@workspace/ui/components/assistant/tray-services"
import { faceCss, faceStack, previewFaces } from "@workspace/ui/lib/font-faces"
import { designAnswers } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

type Picked = ReturnType<typeof designAnswers>[number]

/** A light tint of the bubble's own colour, so a chip never reads as a hole in it in either theme. */
const TINT = "bg-foreground/4"

const CHIP = cn(
  "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-foreground/10 px-2.5 text-sm",
  TINT
)

/** A palette's four colours, small, beside its name. */
function Swatch({ colors }: { colors: readonly string[] }) {
  return (
    <span
      aria-hidden
      className="flex h-4 w-6 shrink-0 overflow-hidden rounded-sm border border-border"
    >
      {colors.map((color, at) => (
        <span
          className="flex-1"
          // biome-ignore lint/suspicious/noArrayIndexKey: two stops may share a colour
          key={at}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

/** One answer as a chip: the logo's picture, a palette's colours, a pair in its own face, else its words. */
function Chip({ picked }: { picked: Picked }) {
  const services = useTrayServices()
  const { answer, question, text } = picked
  const option =
    "choice" in answer
      ? question.card.options.find((o) => o.id === answer.choice)
      : undefined
  const visual = option?.visual
  let lead: ReactNode = null
  let style: { fontFamily: string; fontWeight: number } | undefined
  let faces: ReactNode = null
  if ("logo" in answer && services) {
    return (
      <span className={cn(CHIP, "ps-1")}>
        <img
          alt=""
          className={cn("size-6 rounded-full object-contain p-0.5", TINT)}
          src={services.imageUrl(answer.logo.id)}
        />
        {text}
      </span>
    )
  }
  if ("palette" in answer) {
    const { paper, tint, primary, ink } = answer.palette.stops
    lead = <Swatch colors={[paper, tint, primary, ink]} />
  } else if (visual?.kind === "swatches") {
    lead = <Swatch colors={visual.colors} />
  } else if (visual?.kind === "font_pair") {
    // The display face at the one weight its preview file holds.
    const face = previewFaces().find((each) => each.family === visual.display)
    if (face) {
      style = { fontFamily: faceStack(face.family), fontWeight: face.weight }
      faces = <style>{faceCss([face])}</style>
    }
  }
  return (
    <span className={CHIP}>
      {faces}
      {lead}
      <span className="truncate" style={style}>
        {text}
      </span>
    </span>
  )
}

/**
 * A finished design tray as the owner's reply: one compact bubble of small
 * chips, the logo as a thumbnail, each palette with its colours, the font
 * pair in its own face, and the rest as their words.
 */
export function DesignReply({
  input,
  output,
}: {
  input: AskDesignInput
  output: AskDesignOutput
}) {
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {designAnswers(input, output).map((picked) => (
        <Chip key={picked.question.id} picked={picked} />
      ))}
    </span>
  )
}
