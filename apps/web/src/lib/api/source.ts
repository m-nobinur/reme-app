import { mockSource } from "./mock"
import type { OwnerDataSource } from "./types"

/**
 * The swap point. This is the only module in `apps/web` that names an
 * implementation of `OwnerDataSource`: every screen reads through the server
 * functions in `server.ts`, which read through this constant, so moving from
 * mocks to the real client is this one line and nothing else.
 *
 * When B5 publishes the read endpoints, `mockSource` becomes the client built
 * from the contracts package and `mock.ts` is deleted in the same PR. Nothing
 * adapts around it: an adapter that outlives the mock is a second seam.
 *
 * `api-seam.test.ts` fails if a second module imports `./mock`, because a seam
 * that is one module only until somebody takes a shortcut is not a seam.
 */
export const source: OwnerDataSource = mockSource
