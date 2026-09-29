import { MoonIcon, SunIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { type ComponentProps, useSyncExternalStore } from "react"

const THEME_STORAGE_KEY = "reme-theme"

/**
 * Applies the stored theme before first paint. It has to run as a blocking
 * inline script in `<head>`: React cannot set the class early enough, so a
 * dark-mode reader would get a white flash on every navigation that reloads.
 */
const themeInitScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||(t===null&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

/** Follows the `dark` class, whoever sets it: this button or the init script. */
const onThemeChange = (change: () => void) => {
  const observer = new MutationObserver(change)
  observer.observe(document.documentElement, { attributeFilter: ["class"] })
  return () => observer.disconnect()
}
const isDark = () => document.documentElement.classList.contains("dark")

/**
 * Flips the `dark` class on the document and remembers the choice. The icons
 * swap through the same `dark:` variant as everything else, so they are
 * correct on the server render. The pressed state is not known there, so it
 * is left off until the browser reads the class.
 */
function ThemeToggle(props: ComponentProps<typeof Button>) {
  const pressed = useSyncExternalStore(onThemeChange, isDark, () => undefined)
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Dark theme"
      aria-pressed={pressed}
      onClick={() => {
        const dark = document.documentElement.classList.toggle("dark")
        try {
          localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light")
        } catch {
          // Storage can be blocked; the theme still applies for this document.
        }
      }}
      {...props}
    >
      <SunIcon aria-hidden className="dark:hidden" />
      <MoonIcon aria-hidden className="hidden dark:block" />
    </Button>
  )
}

export { THEME_STORAGE_KEY, ThemeToggle, themeInitScript }
