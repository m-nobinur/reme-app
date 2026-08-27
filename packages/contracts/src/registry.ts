import {
  ApprovalRequest,
  Assignment,
  InformationRequest,
} from "./assignment.ts"
import { ErrorEnvelope, FailureReport } from "./error.ts"
import { EventEnvelope } from "./event.ts"
import { FactRecord } from "./fact.ts"
import { CreateOrgRequest, Org, StaffDirectory, StaffMember } from "./org.ts"
import { CapabilityCall, RuntimeSpec } from "./runtime.ts"

/**
 * The contract surface, v0. Generation and the round-trip suite both read this
 * map, so a schema that is not here is not a contract: it emits no JSON
 * Schema, gets no OpenAPI component, and no test.
 */
export const contracts = {
  ApprovalRequest,
  Assignment,
  CapabilityCall,
  CreateOrgRequest,
  ErrorEnvelope,
  EventEnvelope,
  FactRecord,
  FailureReport,
  InformationRequest,
  Org,
  RuntimeSpec,
  StaffDirectory,
  StaffMember,
} as const

export type ContractName = keyof typeof contracts
