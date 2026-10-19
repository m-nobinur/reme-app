/**
 * The password policy this environment actually enforces, and a scorer that
 * agrees with it.
 *
 * Both numbers were measured against WorkOS staging on 2026-08-29 rather than
 * read off a settings page, by offering candidate passwords to
 * `POST /user_management/users` and reading the refusal:
 *
 *   - 9 high-entropy characters are refused `password_too_short`, with
 *     "Please try a password with 10 or more characters". 10 are accepted.
 *   - `qwfpgjluyarn` (12, lowercase only, no digit or symbol) is accepted, so
 *     there are no character-class requirements.
 *   - `correcthorsebatterystaple` is accepted, so the breach corpus is not
 *     consulted.
 *   - `qwertyuiopasdf` (14) is refused `password_too_weak`, so length alone is
 *     not the rule.
 *
 * The strength half is zxcvbn, and WorkOS runs the same port we do: its refusal
 * text comes back as zxcvbn-ts's own English feedback, word for word
 * ("Repeated character patterns like \"abcabcabc\" are easy to guess."), which
 * the original Dropbox implementation words differently. Proven over a
 * thirty-password corpus clustered on both boundaries: `length >= 10 && score >= 3`
 * predicted accept or refuse correctly for all thirty, and the meter's warning
 * was WorkOS's own sentence in eleven of the thirteen refusals.
 *
 * A meter that calls a password strong and then watches the API refuse it is
 * worse than no meter, which is why this file scores rather than guesses.
 */

export const PASSWORD_POLICY = {
  /** Refused below this, whatever the strength. */
  minLength: 10,
  /** zxcvbn's 0 to 4. Refused below this, whatever the length. */
  minScore: 3,
} as const

export type PasswordScore = 0 | 1 | 2 | 3 | 4

export type PasswordVerdict = {
  score: PasswordScore
  meetsLength: boolean
  meetsStrength: boolean
  /** True when WorkOS would accept it. */
  acceptable: boolean
  /** zxcvbn's reason, which is the sentence WorkOS itself returns. */
  warning?: string
  suggestions: string[]
  /** False until the dictionary has loaded, when only length has been judged. */
  scored: boolean
}

/** What we can say before the dictionary is in memory: the length rule only. */
export function lengthOnlyVerdict(password: string): PasswordVerdict {
  return {
    score: 0,
    meetsLength: password.length >= PASSWORD_POLICY.minLength,
    meetsStrength: false,
    acceptable: false,
    suggestions: [],
    scored: false,
  }
}

type Zxcvbn = (password: string) => {
  score: number
  feedback: { warning: string | null; suggestions: string[] }
}

/**
 * The dictionaries are about a megabyte unpacked, so they are fetched once, on
 * demand, and never on the server.
 *
 * `import.meta.env.SSR` is a literal by the time Vite is done with it, so this
 * whole branch is removed from the server build and the word lists never reach
 * the Worker bundle that `pnpm size` measures.
 */
let loading: Promise<Zxcvbn | null> | null = null

function load(): Promise<Zxcvbn | null> {
  if (import.meta.env.SSR) {
    return Promise.resolve(null)
  }
  loading ??= Promise.all([
    import("@zxcvbn-ts/core"),
    import("@zxcvbn-ts/language-common"),
    import("@zxcvbn-ts/language-en"),
  ])
    .then(([core, common, en]) => {
      const factory = new core.ZxcvbnFactory({
        dictionary: { ...common.dictionary, ...en.dictionary },
        graphs: common.adjacencyGraphs,
        translations: en.translations,
      })
      return (password: string) => factory.check(password)
    })
    .catch(() => {
      // A blocked or failed chunk must not take the form down with it. The
      // length rule still applies, the field still submits, and WorkOS remains
      // the authority on strength either way.
      loading = null
      return null
    })
  return loading
}

export async function scorePassword(
  password: string
): Promise<PasswordVerdict> {
  const zxcvbn = await load()
  if (!zxcvbn) {
    return lengthOnlyVerdict(password)
  }
  const { score, feedback } = zxcvbn(password)
  const meetsLength = password.length >= PASSWORD_POLICY.minLength
  const meetsStrength = score >= PASSWORD_POLICY.minScore
  return {
    score: score as PasswordScore,
    meetsLength,
    meetsStrength,
    acceptable: meetsLength && meetsStrength,
    warning: feedback.warning ?? undefined,
    suggestions: feedback.suggestions,
    scored: true,
  }
}

/**
 * What the meter says out loud. Five zxcvbn scores, four labels: 0 and 1 are
 * both "Too weak" because the difference between them is not a difference a
 * person can act on, and the warning underneath carries the detail.
 */
export const STRENGTH_LABELS = [
  "Too weak",
  "Too weak",
  "Not strong enough",
  "Strong",
  "Very strong",
] as const
