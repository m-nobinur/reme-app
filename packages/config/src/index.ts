import { z } from "zod"

/**
 * Every environment variable the stack reads, with the shape it must have.
 * Add a variable here and to `.env.example` in the same change: `pnpm doctor`
 * reports against this schema, so a variable missing from it is unchecked.
 */
export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres connection string"),
  /**
   * The pooled endpoint, when there is one. Optional: only the tenancy suite
   * reads it, to measure what a transaction pooler does to a session-scoped
   * setting. Never used by migrations, which refuse a `-pooler` host.
   */
  DATABASE_URL_POOLED: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres connection string")
    .optional(),
  /** Use the docker-compose Postgres instead of a Neon branch. */
  NEON_OFFLINE: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parses and returns the environment, or throws naming every variable that is
 * missing or malformed. Call it once at boot so a bad environment fails there
 * rather than at first use.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env
): Env {
  // A blank line in a .env file means the variable was never filled in, so
  // treat "" as absent and let defaults apply.
  const present: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") present[name] = value
  }

  const result = envSchema.safeParse(present)
  if (result.success) return result.data

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0])
    return present[name] === undefined
      ? `  ${name} is not set`
      : `  ${name}: ${issue.message}`
  })

  throw new Error(
    `Environment is not usable:\n${problems.join("\n")}\n` +
      "Names and shapes are in .env.example; local values go in .env.local."
  )
}
