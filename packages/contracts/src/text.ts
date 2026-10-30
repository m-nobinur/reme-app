import { z } from "zod"

/**
 * Text with something in it. A regex rather than `.trim()`, which the JSON
 * Schema cannot say. Internal: `index.ts` does not re-export this file.
 */
export const Text = (max: number) => z.string().min(1).max(max).regex(/\S/)

/**
 * What a slow read is doing, in a few words of the owner's language, shown in
 * the chat while it runs. The runner strips it before the tool does.
 */
export const ToolStep = z.string().max(60).optional()
