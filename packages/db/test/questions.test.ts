import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { waitedOn } from "../src/questions.ts"

/**
 * One query shape per mode, so a prepared plan for one build keeps its
 * primary-key lookup: a `$1 is null or a.id = $1` filter would make a
 * generic plan scan every assignment.
 */
async function sent(assignmentId?: string) {
  let query: SQL | undefined
  const db = {
    execute: async (q: SQL) => {
      query = q
      return []
    },
  }
  await waitedOn(db as never, assignmentId)
  return new PgDialect().sqlToQuery(query as SQL)
}

describe("waitedOn's query", () => {
  it("looks one build up by id alone", async () => {
    const id = "3c4d5e6f-7081-4c8d-9e0f-3a4b5c6d7e8f"
    const { sql, params } = await sent(id)
    expect(sql).toMatch(/where a\.id = \$1::uuid\s*$/)
    expect(sql).not.toMatch(/is null and|a\.state =/)
    expect(params).toEqual([id])
  })

  it("reads every blocked build with no parameter", async () => {
    const { sql, params } = await sent()
    expect(sql).toMatch(/where a\.state = 'blocked_on_information'/)
    expect(params).toEqual([])
  })
})

describe("waitedOn's query for /workspace", () => {
  it("orders by when each question was asked, then by build, for a stable list", async () => {
    const { sql } = await sent()
    expect(sql).toMatch(/order by q\.payload->>'requested_at', a\.id\s*$/)
  })

  it("leaves answered questions out in the query when asked to", async () => {
    let query: SQL | undefined
    const db = {
      execute: async (q: SQL) => {
        query = q
        return []
      },
    }
    await waitedOn(db as never, undefined, { unanswered: true })
    const { sql } = new PgDialect().sqlToQuery(query as SQL)
    expect(sql).toMatch(/and answered\.payload is null/)
    expect((await sent()).sql).not.toMatch(/answered\.payload is null/)
  })
})
