import { MoonIcon, SunIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import type { ComponentProps } from "react"

const THEME_STORAGE_KEY = "reme-theme"

/**
 * Applies the stored theme before first paint. It has to run as a blocking
 * inline script in `<head>`: React cannot set the class early enough, so a
 * dark-mode reader would get a white flash on every navigation that reloads.
 */
const themeInitScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||(t===null&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

/**
 * Flips the `dark` class on the document and remembers the choice. The icons
 * swap through the same `dark:` variant as everything else, so the button is
 * correct on the server render with no client state to hydrate.
 */
function ThemeToggle(props: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Switch theme"
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
