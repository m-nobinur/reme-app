import type { Tenancy } from "@workspace/db"

/**
 * A tenancy with no database behind it: `withinCap` reads `spent` dollars
 * for the day, and every event inserted lands in `rows`.
 */
export function ledger(spent = 0) {
  const rows: { type: string; payload: Record<string, unknown> }[] = []
  const db = {
    execute: async () => [{ spent }],
    insert: () => ({
      values: async (row: (typeof rows)[number]) => {
        rows.push(row)
      },
    }),
  }
  const kit = {
    withOrg: async (_at: unknown, run: (db: unknown) => unknown) => run(db),
  } as unknown as Tenancy
  return { kit, rows }
}
