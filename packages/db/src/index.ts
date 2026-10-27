// The one drizzle instance in the repo. An app that declares its own
// dependency on drizzle-orm gets a second copy resolved under a different peer
// set, and the two disagree about `SQL` in a way that only surfaces as a
// typecheck error about a private property. Callers take the tag from here.
export { asc, eq, type SQL, sql } from "drizzle-orm"
export { orgOpen, tombstone } from "./accounts.ts"
export {
  emailMessageId,
  type Posted,
  postAssistantMessage,
  postChangeAsked,
  postOwnerEmail,
  serverMessageId,
} from "./assistant-messages.ts"
export { activeDomainHost, domainHeldElsewhere } from "./domains.ts"
export {
  type DueStore,
  lowerNextDue,
  NEXT_DUE_KEY,
  type NextDue,
  readNextDue,
  type ScanMessage,
  WAKE_DELAY_MAX_S,
  type WakeQueue,
} from "./due.ts"
export {
  type AppendEvent,
  type AppendSessionEvent,
  appendEvent,
  appendSessionEvent,
  newUlid,
} from "./events.ts"
export {
  currentFact,
  currentFacts,
  factVersions,
  supersedeFact,
  supersedePrivateFact,
} from "./facts.ts"
export * from "./map.ts"
export { addPushSubscription, PUSH_SUBSCRIPTION_CAP } from "./push.ts"
export { type Waited, waitedOn } from "./questions.ts"
export {
  afterQuiet,
  ensureHeartbeat,
  HEARTBEAT_RULES,
  inQuiet,
  nextFor,
  nextRun,
  type Quiet,
  recomputeOrgJobs,
} from "./recurrence.ts"
export * from "./schema.ts"
export {
  chiefStaffId,
  ensureStartingTeam,
  rootStaffId,
  STAFF_CODE,
} from "./staff.ts"
export { steerByKey, steerKeyHash } from "./steers.ts"
export {
  addressPlan,
  CONNECT_DEADLINE_MS,
  type DomainFacts,
  type GoogleFacts,
  googlePlan,
  openTask,
  PURCHASE_HOLD_MS,
  putOff,
  readTasks,
  type StepWrite,
  setStep,
  syncTasks,
  type TaskPlan,
} from "./tasks.ts"
export type {
  Identity,
  OrgScopedDb,
  RecentDesign,
  Tenancy,
  TenantContext,
} from "./tenancy.ts"
// Named rather than a star, so what the tenancy kit exposes to the rest of the
// repo is a decision someone makes rather than whatever happens to be exported.
export {
  claimDueJobs,
  failureCode,
  listOrgIds,
  logFailure,
  nextDueAt,
  ORG_SETTING,
  pgCode,
  recentDesigns,
  resolveDomainHost,
  resolveOrg,
  resolveOrgBySlug,
  tenancy,
  USER_SETTING,
  withOrg,
} from "./tenancy.ts"
