import { useCallback, useState } from "react"

/**
 * One form submit, with its three states.
 *
 * Every page in the flow needs the same thing: disable the button while the
 * request is in flight, keep the last result to render, and never leave the
 * button stuck if the request throws. Eight copies of that is how one of them
 * ends up without the `finally`.
 */
export function useSubmit<TInput, TResult>(
  action: (input: TInput) => Promise<TResult>
) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<TResult | null>(null)

  const run = useCallback(
    async (input: TInput) => {
      setPending(true)
      try {
        const next = await action(input)
        setResult(next)
        return next
      } finally {
        setPending(false)
      }
    },
    [action]
  )

  return { run, pending, result, setResult }
}
