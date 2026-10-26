import { config } from "zod"

// Zod probes `new Function` on its first parse, which the CSP (lib/csp.ts)
// refuses and reports. Imported first, so the probe is skipped before any
// module parses at load; the jitless parser is what runs under the CSP anyway.
config({ jitless: true })
