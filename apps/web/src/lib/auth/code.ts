/**
 * What is wrong with a one-time code, in our words rather than the browser's.
 *
 * The alternative was `required` and `pattern` on the input, which the browser
 * checks and reports through a bubble it words itself. Three pages take a code,
 * so the sentence lives here and each of them puts it on the field, where every
 * other error in this flow already appears.
 *
 * It answers only the two things that can be known without asking WorkOS. A code
 * that is six digits and still wrong comes back from the server as
 * `invalid_one_time_code`, which reads the same on the same field.
 */
export const CODE_LENGTH = 6

export function codeProblem(value: string): string | undefined {
  const entered = value.replace(/\D/g, "")
  if (entered.length === 0) {
    return `Enter the ${CODE_LENGTH}-digit code.`
  }
  if (entered.length < CODE_LENGTH) {
    return `That is ${entered.length} digit${entered.length === 1 ? "" : "s"}. The code is ${CODE_LENGTH}.`
  }
  return undefined
}
