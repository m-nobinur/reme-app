import type { ErrorEnvelope } from "@workspace/contracts"

/**
 * R4: every refusal the facade makes is typed. `code` and `class` are what
 * travels; `message` is for a log and never for a model.
 */
export class FacadeError extends Error {
  readonly code: string
  readonly errorClass: ErrorEnvelope["class"]
  readonly detail: Record<string, unknown>

  constructor(
    code: string,
    errorClass: ErrorEnvelope["class"],
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "FacadeError"
    this.code = code
    this.errorClass = errorClass
    this.detail = detail
  }
}
