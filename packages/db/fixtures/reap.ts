import { and, inArray, like, lt } from "drizzle-orm"
import { connect } from "../src/client.ts"
import { orgs, scheduledJobs } from "../src/schema.ts"

const LOCAL = /@(localhost|127\.0\.0\.1)[:/]/

/** Vitest global setup: drops the jobs of fixture orgs older than an hour on a local database, which come due and pile up past what a scan reaches. */
export default async function reapFixtureJobs() {
  if (!LOCAL.test(process.env.DATABASE_URL ?? "")) return
  const { sql: client, db } = connect()
  try {
    await db.delete(scheduledJobs).where(
      inArray(
        scheduledJobs.orgId,
        db
          .select({ id: orgs.id })
          .from(orgs)
          .where(
            and(
              like(orgs.name, "%(fixture)"),
              lt(orgs.createdAt, new Date(Date.now() - 60 * 60 * 1000))
            )
          )
      )
    )
  } finally {
    await client.end()
  }
}
