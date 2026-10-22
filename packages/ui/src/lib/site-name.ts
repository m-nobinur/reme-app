import { createContext, useContext } from "react"

/** The business's name, which a tool call does not carry. The app provides it. */
const SiteNameContext = createContext<string | null>(null)

export const SiteNameProvider = SiteNameContext.Provider

export const useSiteName = () => useContext(SiteNameContext)
