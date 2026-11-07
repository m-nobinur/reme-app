import type { SaveDesignAnswer } from "@workspace/ui/components/assistant/ask-design"
import type { UploadPhotos } from "@workspace/ui/components/assistant/ask-upload"
import type { AnswerBuildQuestion } from "@workspace/ui/components/assistant/build-questions"
import type { DomainPurchase } from "@workspace/ui/components/assistant/buy-domain"
import type { CosTools } from "@workspace/ui/components/assistant/cos-tools"
import type { TrayServices } from "@workspace/ui/components/assistant/tray-services"
import type { LiveCards } from "@workspace/ui/lib/live-cards"
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react"

/**
 * What the chat's cards call on the app. A card whose service is not given
 * offers nothing it cannot do here, which is how the catalog draws them.
 */
export type ChatServices = {
  saveDesignAnswer?: SaveDesignAnswer | undefined
  uploadPhotos?: UploadPhotos | undefined
  domainPurchase?: DomainPurchase | undefined
  answerBuildQuestion?: AnswerBuildQuestion | undefined
  cosTools?: CosTools | undefined
  /** Marks a card's yes, by its approval id, as the tap that saves a grant. */
  alwaysAllow?: ((approvalId: string) => void) | undefined
  tray?: TrayServices | undefined
  liveCards?: LiveCards | undefined
}

const ChatServicesContext = createContext<ChatServices>({})

/** Gives the chat's cards the app's services, over any given above it. */
export function ChatServicesProvider({
  value,
  children,
}: {
  value: ChatServices
  children?: ReactNode
}) {
  const outer = useContext(ChatServicesContext)
  const merged = useMemo(() => ({ ...outer, ...value }), [outer, value])
  return createElement(ChatServicesContext, { value: merged }, children)
}

/** One of the app's services, or null where it was not given. */
export const useChatService = <K extends keyof ChatServices>(name: K) =>
  useContext(ChatServicesContext)[name] ?? null
