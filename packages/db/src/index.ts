// The one drizzle instance in the repo. An app that declares its own
// dependency on drizzle-orm gets a second copy resolved under a different peer
// set, and the two disagree about `SQL` in a way that only surfaces as a
// typecheck error about a private property. Callers take the tag from here.
export { sql } from "drizzle-orm"
export * from "./map.ts"
export * from "./schema.ts"
export type { OrgScopedDb, Tenancy, TenantContext } from "./tenancy.ts"
// Named rather than a star, so what the tenancy kit exposes to the rest of the
// repo is a decision someone makes rather than whatever happens to be exported.
export {
  closeTenancy,
  ORG_SETTING,
  tenancy,
  USER_SETTING,
  withOrg,
} from "./tenancy.ts"
