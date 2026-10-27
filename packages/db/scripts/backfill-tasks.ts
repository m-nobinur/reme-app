/**
 * `pnpm tasks:backfill`: gives every org that already has a domain or a
 * Google connection its owner tasks, through `syncTasks`, the same mapping
 * each write site calls. Idempotent, so a second run writes nothing new; run
 * it once per database after migration 0025. A script rather than SQL in the
 * migration so the mapping exists once.
 */
import { connectionString } from "../src/client.ts"
import { syncTasks } from "../src/tasks.ts"
import { listOrgIds, tenancy } from "../src/tenancy.ts"

const kit = tenancy(connectionString())
try {
  const ids = await listOrgIds(kit)
  for (const orgId of ids)
    await kit.withOrg({ orgId }, (db) => syncTasks(db, orgId))
  console.log(`synced tasks for ${ids.length} org(s)`)
} finally {
  await kit.close()
}
