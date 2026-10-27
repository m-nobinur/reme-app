/**
 * `pnpm tasks:backfill`: gives every org that already has a domain or a
 * Google connection its owner tasks, through `syncTasks`, the same mapping
 * each write site calls. A domain already active was served before tasks
 * existed, so its `loads` step is marked done here, the one place that may
 * without the probe's check. Idempotent, so a second run writes nothing new;
 * run it once per database after migration 0025. A script rather than SQL in
 * the migration so the mapping exists once.
 */
import { sql } from "drizzle-orm"
import { connectionString } from "../src/client.ts"
import { syncTasks } from "../src/tasks.ts"
import { listOrgIds, tenancy } from "../src/tenancy.ts"

const kit = tenancy(connectionString())
try {
  const ids = await listOrgIds(kit)
  for (const orgId of ids)
    await kit.withOrg({ orgId }, async (db) => {
      await syncTasks(db, orgId)
      const served = await db.execute(sql`
        update task_steps s set state = 'done', changed_at = now(),
          evidence = '{"served": "before owner tasks"}'::jsonb
        from owner_tasks t
        where s.task_id = t.id and t.kind = 'address' and s.step = 'loads'
          and s.state <> 'done' and exists (select 1 from domains d
            where d.state = 'active' and d.name = t.detail->>'name')
        returning s.task_id`)
      // Closes the tasks whose last step that was.
      if (served.length > 0) await syncTasks(db, orgId)
    })
  console.log(`synced tasks for ${ids.length} org(s)`)
} finally {
  await kit.close()
}
