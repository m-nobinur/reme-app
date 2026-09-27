import { z } from "zod"
import { ErrorEnvelope } from "./error.ts"

/**
 * A tool's refusal, as the model reads it: the class, the code and the
 * owner-safe message, capped at 500 characters. Closed, with no `detail`,
 * so a refusal cannot carry a tenancy id or a signed URL to the model. The
 * api maps every error onto it and never passes an envelope through.
 * Internal: `index.ts` does not re-export this file.
 */
export const Refused = z.strictObject({
  outcome: z.literal("refused"),
  error: z.strictObject({
    class: ErrorEnvelope.shape.class,
    code: ErrorEnvelope.shape.code,
    message: z.string().min(1).max(500),
  }),
})
