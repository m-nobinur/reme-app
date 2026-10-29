import { createContext, useContext } from "react"

/**
 * What the chat's cards read from the live workspace, so a card drawn before
 * the owner connected something never offers to connect it again. Without a
 * provider each card draws from its own tool output.
 */
export type LiveCards = {
  /** Signed in to Google now; null when the workspace does not say. */
  googleConnected: boolean | null
  /** Whether the website is live on this domain now. */
  domainLive: (name: string) => boolean
}

const LiveCardsContext = createContext<LiveCards | null>(null)

/** Gives the chat's cards the workspace's live connections. */
export const LiveCardsProvider = LiveCardsContext.Provider

export const useLiveCards = () => useContext(LiveCardsContext)
