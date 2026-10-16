/** Tracing a contact detail a model proposed back to what the owner typed. */

/** The digits of `text`. */
const digits = (words: string) => words.replace(/\D/g, "")

/** Whether an E.164 number's national digits appear in what the owner typed. */
export function phoneFromOwner(e164: string, said: string): boolean {
  const all = digits(e164)
  const owner = digits(said)
  // The country code is one to three digits; the rest must be the owner's.
  return [1, 2, 3].some((cc) => {
    const national = all.slice(cc)
    return national.length >= 6 && owner.includes(national)
  })
}

/** Whether an address appears in what the owner typed. */
export const emailFromOwner = (address: string, said: string) =>
  said.toLowerCase().includes(address.toLowerCase())
