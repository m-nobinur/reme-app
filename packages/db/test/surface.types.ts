import type * as db from "../src/index.ts"

/**
 * `withOrg` is the only door to a database handle (§9.2, eng guide §4.2).
 *
 * The rule is that a raw query outside it does not typecheck, and it holds
 * structurally rather than by convention: nothing on the package surface
 * returns a handle, so there is no value to call `.select()` on. `connect`
 * stays behind the package boundary, reachable only from the migration and
 * seed scripts that sit next to it.
 *
 * There is no test runner here on purpose. `tsc --noEmit` is the runner, and it
 * runs on every PR: if `connect` is ever re-exported, the directive below has
 * nothing to suppress and typecheck fails with an unused `@ts-expect-error`.
 */

// @ts-expect-error `connect` must not be reachable from the package surface.
export type ConnectIsNotOnTheSurface = typeof db.connect

/** The door that is meant to exist. Fails if the export is ever dropped. */
export type WithOrgIsOnTheSurface = typeof db.withOrg
