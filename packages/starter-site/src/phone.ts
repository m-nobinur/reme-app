/**
 * A phone number as a customer reads it: UK numbers as dialled at home
 * ("07700 900123", "020 7946 0000"), any other as stored in E.164. The
 * `tel:` link keeps the E.164 form.
 */
// ponytail: UK grouping only; other countries need libphonenumber when one signs up
export function phoneText(e164: string): string {
  if (!e164.startsWith("+44")) return e164
  const national = `0${e164.slice(3)}`
  if (national.length !== 11) return national
  return national.startsWith("02")
    ? `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`
    : `${national.slice(0, 5)} ${national.slice(5)}`
}
