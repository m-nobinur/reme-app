import { z } from "zod"

/**
 * Text with something in it. A regex rather than `.trim()`, which the JSON
 * Schema cannot say. Internal: `index.ts` does not re-export this file.
 */
export const Text = (max: number) => z.string().min(1).max(max).regex(/\S/)
