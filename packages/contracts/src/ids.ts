import { z } from "zod"

/**
 * A provider makes these, in its own shape, such as `functions.ask_fact:0`.
 * The server looks one up among its own pending calls, so the pattern only
 * bounds size and characters: printable ASCII, no spaces. Internal:
 * `index.ts` does not re-export this file.
 */
export const ToolCallId = z.string().regex(/^[\x21-\x7E]{1,128}$/)
