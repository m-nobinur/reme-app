// Makes the Domain Connect signing key pair, once. The private key goes to
// .env.domain-connect.local (gitignored) as DOMAIN_CONNECT_KEY, base64 of its
// PKCS #8 DER on one line: copy that line into .env.local and bootstrap sets
// the orchestrator secret. The public key is printed as the TXT records to add
// at _dck1.remeai.co.uk, where the template's syncPubKeyDomain points.
//
// A second run refuses: a new key breaks every apply link until the TXT
// records change with it. Rotating means a new label (_dck2) and KEY_HOST.
//
// Run: node infra/domain-connect/keygen.ts
import { generateKeyPairSync } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Under a TXT string's 255 characters; the spec numbers the pieces from 1. */
const CHUNK = 200

/** A 2048-bit RSA pair: the private key for the secret, the public key as TXT values. */
export function keyPair(): { privateKey: string; txt: string[] } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  const spki = publicKey.export({ format: "der", type: "spki" })
  const pieces = spki.toString("base64").match(new RegExp(`.{1,${CHUNK}}`, "g"))
  return {
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    txt: (pieces ?? []).map((d, i) => `p=${i + 1},a=RS256,d=${d}`),
  }
}

if (import.meta.main) {
  const file = join(
    import.meta.dirname,
    "..",
    "..",
    ".env.domain-connect.local"
  )
  if (existsSync(file)) {
    console.error(`${file} exists: the key is made already`)
    process.exit(1)
  }
  const { privateKey, txt } = keyPair()
  writeFileSync(file, `DOMAIN_CONNECT_KEY=${privateKey}\n`, { mode: 0o600 })
  console.log(`Private key written to ${file}`)
  console.log("Add each line as its own TXT record at _dck1.remeai.co.uk:")
  for (const value of txt) console.log(value)
}
