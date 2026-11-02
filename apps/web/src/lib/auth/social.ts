const KNOWN = ["GoogleOAuth"] as const

/**
 * The social sign-in providers turned on by `SOCIAL_SIGN_IN`, a comma-separated
 * Worker variable. Unset means none, so an environment that forgets it fails
 * closed. A name this app does not know is ignored, so the variable cannot
 * send an arbitrary provider to WorkOS.
 */
export function enabledProviders(raw: string | undefined): string[] {
  const asked = new Set((raw ?? "").split(",").map((name) => name.trim()))
  return KNOWN.filter((name) => asked.has(name))
}
