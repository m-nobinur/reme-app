import {
  ChatCircleIcon,
  FileTextIcon,
  type Icon,
  ShieldCheckIcon,
} from "@phosphor-icons/react"
import { PersonaStage, SpeechBubble } from "@workspace/ui/components/persona"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

const PROMISES: { icon: Icon; text: string }[] = [
  { icon: ChatCircleIcon, text: "Replies day and night" },
  { icon: FileTextIcon, text: "Quote requests handled" },
  { icon: ShieldCheckIcon, text: "Big calls stay yours" },
]

/**
 * The right-hand panel of every page in the sign-in flow: Reme itself, saying
 * hello, and what it does in three lines.
 *
 * There is no testimonial and no customer strip, because there is nobody to
 * quote yet and a stand-in would read as real.
 *
 * It sits on the app's second neutral with a hairline between it and the form,
 * so it never becomes the brightest thing on a dark page.
 *
 * Hidden below `lg`: on a phone the form is the page.
 */
function AuthAside({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      aria-label="About Reme"
      className={cn(
        "relative hidden overflow-hidden border-border border-l bg-rail text-rail-foreground lg:flex lg:flex-col lg:justify-center lg:p-12 xl:p-20",
        className
      )}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
        {/* The hello sits by Reme's head, tail down to it, as on the front
            page; it arrives once with the page instead of waiting for hover. */}
        <PersonaStage className="w-64 xl:w-72">
          <SpeechBubble
            arrival="enter"
            className="absolute top-[-14%] left-[67%] w-72"
            text="I'll look after your enquiries so you can get on with the work."
            title="Hi, I'm Reme."
          />
        </PersonaStage>

        <h2 className="mt-10 text-balance font-medium text-3xl leading-[1.15] tracking-[-0.025em]">
          Win the jobs you used to miss.
        </h2>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          Every enquiry answered in minutes, every quote followed up, and only
          the decisions that need you.
        </p>

        <ul className="mt-10 grid w-full grid-cols-3 gap-4 border-border border-t pt-6 text-sm">
          {PROMISES.map((item) => (
            <li className="flex flex-col items-center gap-2" key={item.text}>
              <item.icon aria-hidden className="size-5 text-primary" />
              {item.text}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

export { AuthAside }
