import { apiSource } from "./client"
import type { OwnerDataSource } from "./types"

/**
 * The swap point. This is the only module in `apps/web` that names an
 * implementation of `OwnerDataSource`: every screen reads through the server
 * functions in `server.ts`, which read through this constant, so what the owner
 * screens are reading is this one line and nothing else.
 *
 * Nothing adapts around it: an adapter over the implementation would be a
 * second seam.
 *
 * `client.test.ts` reads every file under `src/` and fails if any module other
 * than this one imports an implementation, because a seam that is one module
 * only until somebody takes a shortcut is not a seam.
 */
export const source: OwnerDataSource = apiSource
