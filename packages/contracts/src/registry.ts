import {
  ApprovalDecision,
  ApprovalRequest,
  Assignment,
  InformationAnswer,
  InformationRequest,
} from "./assignment.ts"
import {
  Conversation,
  ConversationHistory,
  ConversationList,
  ConversationMessage,
  ConversationPatch,
} from "./conversation.ts"
import { ErrorEnvelope, FailureReport } from "./error.ts"
import { EventEnvelope } from "./event.ts"
import { FactRecord, FactSnapshot } from "./fact.ts"
import { CreateOrgRequest, Org, StaffDirectory, StaffMember } from "./org.ts"
import {
  ActivityFeed,
  AnswerRequest,
  AttentionItem,
  BuildSummary,
  DecisionRequest,
  FactList,
  FactValue,
  OwnerChangeRequest,
  PreviewLink,
  SetFactsRequest,
  TextAnswerSchema,
  WorkspaceStatus,
} from "./owner.ts"
import { CompletionReport, ProgressEvent, ValidationReport } from "./report.ts"
import { CapabilityCall, RuntimeSpec } from "./runtime.ts"
import {
  ComponentManifest,
  DeploymentManifest,
  PreviewClaim,
  SiteFields,
  SitePointer,
  SiteRevision,
} from "./site.ts"

/**
 * The contract surface, v0. Generation and the round-trip suite both read this
 * map, so a schema that is not here is not a contract: it emits no JSON
 * Schema, gets no OpenAPI component, and no test.
 */
export const contracts = {
  ActivityFeed,
  AnswerRequest,
  ApprovalDecision,
  ApprovalRequest,
  Assignment,
  AttentionItem,
  BuildSummary,
  CapabilityCall,
  CompletionReport,
  ComponentManifest,
  Conversation,
  ConversationHistory,
  ConversationList,
  ConversationMessage,
  ConversationPatch,
  CreateOrgRequest,
  DecisionRequest,
  DeploymentManifest,
  ErrorEnvelope,
  EventEnvelope,
  FactList,
  FactRecord,
  FactSnapshot,
  FactValue,
  FailureReport,
  InformationAnswer,
  InformationRequest,
  Org,
  OwnerChangeRequest,
  PreviewClaim,
  PreviewLink,
  ProgressEvent,
  RuntimeSpec,
  SetFactsRequest,
  SiteFields,
  SitePointer,
  SiteRevision,
  StaffDirectory,
  StaffMember,
  TextAnswerSchema,
  ValidationReport,
  WorkspaceStatus,
} as const

export type ContractName = keyof typeof contracts
