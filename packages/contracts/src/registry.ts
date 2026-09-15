import {
  ApprovalRequest,
  Assignment,
  InformationAnswer,
  InformationRequest,
} from "./assignment.ts"
import { ErrorEnvelope, FailureReport } from "./error.ts"
import { EventEnvelope } from "./event.ts"
import { FactRecord, FactSnapshot } from "./fact.ts"
import { CreateOrgRequest, Org, StaffDirectory, StaffMember } from "./org.ts"
import { CompletionReport, ProgressEvent, ValidationReport } from "./report.ts"
import { CapabilityCall, RuntimeSpec } from "./runtime.ts"
import { DeploymentManifest, SiteRevision } from "./site.ts"

/**
 * The contract surface, v0. Generation and the round-trip suite both read this
 * map, so a schema that is not here is not a contract: it emits no JSON
 * Schema, gets no OpenAPI component, and no test.
 */
export const contracts = {
  ApprovalRequest,
  Assignment,
  CapabilityCall,
  CompletionReport,
  CreateOrgRequest,
  DeploymentManifest,
  ErrorEnvelope,
  EventEnvelope,
  FactRecord,
  FactSnapshot,
  FailureReport,
  InformationAnswer,
  InformationRequest,
  Org,
  ProgressEvent,
  RuntimeSpec,
  SiteRevision,
  StaffDirectory,
  StaffMember,
  ValidationReport,
} as const

export type ContractName = keyof typeof contracts
