import { rmSync } from "node:fs"
import { expect, test as teardown } from "@playwright/test"
import {
  deleteProbeUser,
  forgetIds,
  reapProbeOrgs,
  rememberedIds,
  STORAGE_STATE,
} from "./workos"

/**
 * Staging WorkOS holds no users but the development owners (`qa/e2e/workos.ts`
 * names them), so the run that added one takes it away again. Asserted rather than fired and forgotten. The delete is confirmed by
 * reading the account back and requiring a 404.
 *
 * It checks only the accounts this run created. A global "no users exist" check
 * would be stronger and is wrong here, because two runs of this suite against
 * the same environment would each fail on the other's live account.
 */

teardown("the probe account is gone", async () => {
  const ids = rememberedIds()
  expect(
    ids.length,
    "the setup project recorded no account to delete"
  ).toBeGreaterThan(0)

  for (const id of ids) {
    expect(
      await deleteProbeUser(id),
      `${id} still exists after the delete`
    ).toBe(true)
  }

  forgetIds()
  // A `@live` run that timed out deleted its user here and never reached
  // its own org delete; the next run's cleanup takes the org.
  await reapProbeOrgs()
  // The sealed session cookie outlives the account it belonged to. It is dead
  // either way, and a live credential is not something to leave lying in a
  // working tree.
  rmSync(STORAGE_STATE, { force: true })
})
