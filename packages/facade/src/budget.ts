import type {
  FlueExecutionInterceptor,
  FlueInstrumentation,
  FlueObservation,
} from "@flue/runtime"
import { FacadeError } from "./errors.ts"

export type BudgetEvent = {
  type: "budget.warning" | "budget.exhausted"
  payload: { cap_usd: number; spent_usd: number; ratio: number }
}

export type BudgetGuard = {
  /** Install with flue's `instrument()`. */
  instrumentation: FlueInstrumentation
  /** Dollars spent so far, the snapshot's spend plus every `turn` since. */
  spent: () => number
}

/**
 * §13 "Budget exhaustion", §29.2: the pre-call check lives here, server
 * side, so no transport can bypass it. Spend is summed from `turn` events
 * (the leaf level, so nothing is counted twice) on top of the snapshot's
 * spend. The next model call past the cap is refused with a `resource`
 * error and a `budget.exhausted` event; crossing 80% emits one
 * `budget.warning`. The Workflow sees the refusal and parks the assignment.
 */
export function createBudgetGuard(options: {
  capUsd: number
  spentUsd?: number
  /**
   * What the assignment already spent before this guard existed, read from
   * the log once, before the first model call. A guard lives as long as its
   * isolate, and a conversation outlives many, so without this every
   * eviction would hand the model a fresh cap. A failed read refuses the
   * call and is retried on the next one: the guard fails closed.
   */
  spentBefore?: () => Promise<number>
  warnAt?: number
  onEvent: (event: BudgetEvent) => void
}): BudgetGuard {
  const warnAt = options.warnAt ?? 0.8
  let spent = options.spentUsd ?? 0
  let warned = spent >= warnAt * options.capUsd
  let seed: Promise<void> | undefined
  const seeded = () => {
    if (!options.spentBefore) return
    seed ??= options.spentBefore().then(
      (usd) => {
        spent += usd
        warned ||= spent >= warnAt * options.capUsd
      },
      (error: unknown) => {
        seed = undefined
        throw error
      }
    )
    return seed
  }

  const observe = (event: FlueObservation) => {
    if (event.type !== "turn") return
    spent += event.response.usage?.cost.total ?? 0
  }

  const interceptor: FlueExecutionInterceptor = async (
    operation,
    _ctx,
    next
  ) => {
    if (operation.type !== "model") return next()
    await seeded()
    const payload = {
      cap_usd: options.capUsd,
      spent_usd: spent,
      ratio: options.capUsd > 0 ? spent / options.capUsd : 1,
    }
    if (spent >= options.capUsd) {
      options.onEvent({ type: "budget.exhausted", payload })
      throw new FacadeError(
        "budget.exhausted",
        "resource",
        `model spend ${spent.toFixed(4)} USD has reached the cap of ${options.capUsd} USD`,
        payload
      )
    }
    if (!warned && spent >= warnAt * options.capUsd) {
      warned = true
      options.onEvent({ type: "budget.warning", payload })
    }
    return next()
  }

  return {
    instrumentation: {
      key: Symbol.for("reme.budget"),
      observe,
      interceptor,
      dispose() {
        // Nothing to flush: the spend lives in `spent`, read by the caller.
      },
    },
    spent: () => spent,
  }
}
